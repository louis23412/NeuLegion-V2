// Headless core test for HiveMindController + HiveMind, executed inside a
// browser Worker via test/browser/harness.js.
//
// Mirrors production usage: a fresh controller is constructed per getSignal
// call (worker.js does exactly this), all sharing the same on-disk state dir.

import { __ensureSql } from '../shims/better-sqlite3.js';
import HiveMindController from '../../../src/hivemind/hiveMindController.js';
import HiveMind from '../../../src/hivemind/hiveMind.js';

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function makeCandles(n, { start = 100, seed = 1, trend = 0, vol = 1, startIdx = 0 } = {}) {
    const rnd = mulberry32(seed);
    const candles = [];
    let price = start;
    const baseTs = Date.parse('2024-01-01T00:00:00Z');
    for (let i = 0; i < n; i++) {
        const open = price;
        price = Math.max(0.5, price + trend * price + (rnd() - 0.5) * 2 * vol);
        const close = price;
        const high = Math.max(open, close) + rnd() * vol;
        const low = Math.min(open, close) - rnd() * vol;
        candles.push({
            timestamp: new Date(baseTs + (startIdx + i) * 60000).toISOString(),
            open: Number(open.toFixed(4)),
            high: Number(high.toFixed(4)),
            low: Number(low.toFixed(4)),
            close: Number(close.toFixed(4)),
            volume: Math.round(1000 + rnd() * 5000),
        });
    }
    return candles;
}

const PRICE = { atrFactor: 2, stopFactor: 1, minPriceMovement: 0.0025, maxPriceMovement: 0.05 };

function finiteKeys(obj, keys) {
    const bad = [];
    for (const k of keys) {
        if (typeof obj[k] !== 'number' || !Number.isFinite(obj[k])) bad.push(`${k}=${obj[k]}`);
    }
    return bad;
}

export async function run() {
    await __ensureSql();
    const checks = [];
    const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });

    // ---- A. fresh controller: short input is rejected cleanly -----------------
    try {
        const c = new HiveMindController('A', 'state/core-A', 120, 4, 'positive', 1, PRICE, true);
        const r = c.getSignal(makeCandles(5, { seed: 9 }), 1);
        check('short input returns error object', r && r.error, JSON.stringify(r));
    } catch (e) {
        check('short input returns error object', false, e.stack);
    }

    // ---- B. warmup + directional invariants ----------------------------------
    const cache = makeCandles(260, { seed: 3, trend: 0.0004, vol: 0.8 });
    let pos = null; let neg = null;
    try {
        for (let i = 40; i <= cache.length; i++) {
            const slice = cache.slice(0, i);
            pos = new HiveMindController('B', 'state/core-B', 120, 4, 'positive', 1, PRICE, true).getSignal(slice, 1, 0.025, 0.025, [], []);
            neg = new HiveMindController('C', 'state/core-C', 120, 4, 'negative', 1, PRICE, true).getSignal(slice, 1, 0.025, 0.025, [], []);
        }
        check('warm run produced signals', pos && !pos.error && neg && !neg.error, JSON.stringify(pos?.error || neg?.error));
        check('positive: takeProfit above entry', pos.sellPrice > pos.entryPrice, `sell=${pos.sellPrice} entry=${pos.entryPrice}`);
        check('positive: stopLoss below entry', pos.stopLoss < pos.entryPrice, `stop=${pos.stopLoss} entry=${pos.entryPrice}`);
        check('negative: takeProfit below entry', neg.sellPrice < neg.entryPrice, `sell=${neg.sellPrice} entry=${neg.entryPrice}`);
        check('negative: stopLoss above entry', neg.stopLoss > neg.entryPrice, `stop=${neg.stopLoss} entry=${neg.entryPrice}`);
        check('entryPrice equals last close', pos.entryPrice === cache.at(-1).close, `${pos.entryPrice} vs ${cache.at(-1).close}`);

        const bad = finiteKeys(pos, ['entryPrice', 'sellPrice', 'stopLoss', 'score', 'tradeAcc', 'trueAcc', 'prob']);
        check('signal numeric fields finite', bad.length === 0, bad.join(','));

        check('hive connected after training', pos.hiveConnection === true, JSON.stringify({ hive: pos.hiveConnection, steps: pos.lastTrainingStep }));

        // predictions should eventually be produced (not the -1 sentinel)
        const sawPrediction = pos.prob !== -1 || neg.prob !== -1;
        check('predictions produced', sawPrediction, `pos.prob=${pos.prob} neg.prob=${neg.prob}`);
        check('prediction in [0,100]', (pos.prob === -1 || (pos.prob >= 0 && pos.prob <= 100)), `prob=${pos.prob}`);

        check('open simulations tracked', pos.openSimulations >= 0, `open=${pos.openSimulations}`);
        check('training steps > 0', pos.lastTrainingStep > 0, `steps=${pos.lastTrainingStep}`);
    } catch (e) {
        check('warm run completed', false, e.stack);
    }

    // ---- C. direct HiveMind predict/train round trip --------------------------
    try {
        const hm = new HiveMind('state/core-D', 3, 12, 'D', true);
        const inputs = Array.from({ length: 12 }, (_, i) => (i % 3) / 2);
        const p0 = hm.predict(inputs);
        const step = hm.train(inputs, 1);
        const p1 = hm.predict(inputs);
        check('HiveMind.predict returns number in [0,1]', typeof p0 === 'number' && p0 >= 0 && p0 <= 1, `p0=${p0}`);
        check('HiveMind.train returns step count', typeof step === 'number' && step > 0, `step=${step}`);
        check('HiveMind.predict stable/sane after train', typeof p1 === 'number' && p1 >= 0 && p1 <= 1, `p1=${p1}`);

        const bc = hm.broadcastMemory(inputs, 0.025);
        check('broadcastMemory shape', bc && Array.isArray(bc.memories) && bc.compatibility, JSON.stringify(Object.keys(bc || {})));
        const tr = hm.translateMemory(bc.memories, inputs, 0.025);
        check('translateMemory shape', tr && Number.isFinite(tr.injectedRatio), JSON.stringify(Object.keys(tr || {})));
        const dump = hm.dumpState();
        check('dumpState succeeds', dump && dump.status, JSON.stringify(dump));
    } catch (e) {
        check('HiveMind round trip completed', false, e.stack);
    }

    // ---- D. persistence across instances --------------------------------------
    try {
        const a = new HiveMind('state/core-E', 3, 12, 'E', true);
        a.train(Array.from({ length: 12 }, (_, i) => i / 12), 1);
        a.train(Array.from({ length: 12 }, (_, i) => i / 12), 0);
        const b = new HiveMind('state/core-E', 3, 12, 'E', true);
        const meta = b.predict(Array.from({ length: 12 }, (_, i) => i / 12));
        check('state persists across instances', typeof meta === 'number' && Number.isFinite(meta), `pred=${meta}`);
    } catch (e) {
        check('persistence completed', false, e.stack);
    }

    // ---- E. R26-0: the entry-timestamp guard (BUGS.md #33) --------------------
    // A trade may only be closed by a bar strictly AFTER its entry: without this,
    // an over-wide or out-of-order window closes trades on bars that predate them
    // and mislabels the training stream. The guard is a no-op for the production
    // window (one new candle per call).
    try {
        const g = new HiveMindController('G', 'state/core-guard', 120, 4, 'positive', 1, PRICE, true);
        const entry = new Date(Date.parse('2024-01-01T01:00:00Z')).toISOString();
        const before = new Date(Date.parse('2024-01-01T00:00:00Z')).toISOString();
        const after = new Date(Date.parse('2024-01-01T02:00:00Z')).toISOString();
        const openCount = () => g._db.prepare('SELECT COUNT(*) AS n FROM open_trades').get().n;
        g._db.prepare('INSERT INTO open_trades (timestamp, sellPrice, stopLoss, entryPrice, features, confidence) VALUES (?,?,?,?,?,?)')
            .run(entry, 110, 90, 100, JSON.stringify([0, 0, 0, 0, 0, 0]), 60);

        // A bar that crosses BOTH barriers would (wrongly) close the trade if the
        // guard were absent — so this is the meaningful case.
        const bothBar = (ts) => ({ timestamp: ts, open: 100, high: 999, low: 1, close: 100, volume: 1 });
        g._updateOpenTrades([bothBar(before)]);
        check('guard: a bar before the entry cannot close a trade', openCount() === 1, `open=${openCount()}`);
        g._updateOpenTrades([bothBar(entry)]);
        check('guard: the entry bar itself cannot close a trade (strictly-after rule)', openCount() === 1, `open=${openCount()}`);

        // A later bar that crosses only the stop does close it (long: SL below).
        g._updateOpenTrades([{ timestamp: after, open: 100, high: 101, low: 89, close: 100, volume: 1 }]);
        const closedRow = g._db.prepare('SELECT outcome, exitPrice FROM closed_trades WHERE timestamp = ?').get(entry);
        check('guard: a later bar that crosses the stop closes the trade as a loss',
            openCount() === 0 && !!closedRow && closedRow.outcome === 0 && closedRow.exitPrice === 90,
            JSON.stringify({ open: openCount(), closed: closedRow }));
    } catch (e) {
        check('entry-timestamp guard checks completed', false, e.stack);
    }

    // ---- F. R26-0: the production window does not re-insert (no churn) --------
    try {
        const winCache = makeCandles(100, { seed: 21, trend: 0.0004, vol: 0.8 });
        const w = new HiveMindController('W', 'state/core-window', 40, 4, 'positive', 1, PRICE, true);
        let maxRecent = 0;
        const origW = w._getRecentCandles.bind(w);
        w._getRecentCandles = (cs) => { const r = origW(cs); if (Array.isArray(r.recentCandles)) maxRecent = Math.max(maxRecent, r.recentCandles.length); return r; };
        for (let i = 1; i <= winCache.length; i++) w.getSignal(winCache.slice(Math.max(0, i - 40), i), 1);
        check('window contract: a production-shaped window inserts exactly one new candle per call (recentCandles <= 1)',
            maxRecent <= 1, `maxRecent=${maxRecent}`);

        // The prefix shape is what re-inserts — so the check above is not vacuous.
        const p = new HiveMindController('P', 'state/core-window-prefix', 40, 4, 'positive', 1, PRICE, true);
        let maxPrefix = 0;
        const origP = p._getRecentCandles.bind(p);
        p._getRecentCandles = (cs) => { const r = origP(cs); if (Array.isArray(r.recentCandles)) maxPrefix = Math.max(maxPrefix, r.recentCandles.length); return r; };
        for (let i = 1; i <= 70; i++) p.getSignal(winCache.slice(0, i), 1);
        check('window contract: the whole-prefix shape DOES re-insert (the #33 defect is real, so the guard is testable)',
            maxPrefix > 1, `maxPrefix=${maxPrefix}`);
    } catch (e) {
        check('window-contract checks completed', false, e.stack);
    }

    // ---- G. R26-0: a duplicate open-trade timestamp degrades, never throws -----
    try {
        const dupCache = makeCandles(60, { seed: 33, trend: 0.0004, vol: 0.8 });
        const d = new HiveMindController('H', 'state/core-dup', 40, 4, 'positive', 1, PRICE, true);
        for (let i = 1; i <= dupCache.length; i++) d.getSignal(dupCache.slice(Math.max(0, i - 40), i), 1);
        const ts = dupCache.at(-1).timestamp;
        // Force the collision: remove the candle row so the next call re-inserts
        // it, and ensure an open trade already occupies that timestamp.
        d._db.prepare('DELETE FROM candles WHERE timestamp = ?').run(ts);
        d._db.prepare('INSERT OR REPLACE INTO open_trades (timestamp, sellPrice, stopLoss, entryPrice, features, confidence) VALUES (?,?,?,?,?,?)')
            .run(ts, 110, 90, 100, JSON.stringify([0, 0, 0, 0, 0, 0]), 60);
        let threw = null;
        try { d.getSignal(dupCache.slice(Math.max(0, dupCache.length - 40), dupCache.length), 1); } catch (e) { threw = e; }
        check('a duplicate open-trade timestamp degrades to a counted warning instead of throwing out of getSignal',
            !threw && d._globalAccuracy.openTradeWriteErrors >= 1,
            threw ? String(threw.message) : `errors=${d._globalAccuracy.openTradeWriteErrors}`);
    } catch (e) {
        check('duplicate-trade checks completed', false, e.stack);
    }

    // ---- H. R26-12: checkpoint throttling is off the arithmetic path ---------
    // `_saveInterval` (in `getSignal` calls) throttles `HiveMind.dumpState()` — the
    // ~25%-of-per-call cost that rewrites the ENTIRE ensemble state to SQLite. The
    // default (1) dumps every call (bit-identical to the prior behaviour); a finite
    // k>1 dumps every k-th eligible call; `Infinity`/0/negative never dump during
    // the run. The in-memory ensemble is authoritative (nothing reads the state
    // back mid-run) and `_saveState` does not mutate the model, so the emitted
    // signals are IDENTICAL at any interval — only the write count moves.
    //
    // The dump is proven with a deterministic, side-effect-free mind stand-in whose
    // `dumpState` is COUNTED. Because it draws no randomness, three controllers fed
    // the same candles are exactly comparable, so the equivalence is asserted
    // directly rather than inferred.
    try {
        const saveCache = makeCandles(120, { seed: 77, trend: 0.0006, vol: 0.9 });
        const defaultCtl = new HiveMindController('H0', 'state/core-save-default', 60, 4, 'positive', 1, PRICE, true);
        check('R26-12: the default save interval is 1 (dump every call, bit-identical)',
            defaultCtl._saveInterval === 1, String(defaultCtl._saveInterval));

        const makeFakeMind = () => {
            let steps = 0;
            return {
                saves: 0,
                predict: () => 60,
                train: () => (++steps),
                broadcastMemory: () => ({ memories: [], compatibility: 0, totalBroadcast: 0 }),
                translateMemory: () => ({ memoriesInjected: 0, injectedRatio: 0, totalMemories: 0, protosPerMember: 0 }),
                dumpState() { this.saves++; return { status: true }; },
            };
        };
        const drive = (id, dir, interval) => {
            const c = new HiveMindController(id, dir, 60, 4, 'positive', 1, PRICE, true);
            c._saveInterval = interval;
            c._hivemind = makeFakeMind();
            // `trainingSteps > 0` is what makes the dump branch reachable.
            c._globalAccuracy.trainingSteps = 1;
            const rows = [];
            for (let i = 20; i <= saveCache.length; i++) {
                const r = c.getSignal(saveCache.slice(Math.max(0, i - 60), i), 1, 0.025, 0.025, [], []);
                rows.push([r.error || null, r.prob, r.entryPrice, r.sellPrice, r.stopLoss, r.lastTrainingStep, r.openSimulations]);
            }
            return { c, rows };
        };
        const every = drive('H1', 'state/core-save-every', 1);
        const k3 = drive('H2', 'state/core-save-k', 3);
        const never = drive('H3', 'state/core-save-never', Infinity);

        check('R26-12: the emitted signal stream is identical at saveInterval 1, 3 and Infinity (the throttle changes only when state is written)',
            every.rows.length > 0 && every.rows.every((r) => r[0] === null) &&
            JSON.stringify(every.rows) === JSON.stringify(k3.rows) && JSON.stringify(every.rows) === JSON.stringify(never.rows),
            JSON.stringify({
                diffEveryK3: every.rows.findIndex((r, i) => JSON.stringify(r) !== JSON.stringify(k3.rows[i])),
                diffEveryNever: every.rows.findIndex((r, i) => JSON.stringify(r) !== JSON.stringify(never.rows[i])),
            }));
        check('R26-12: saveInterval=1 dumps on every eligible call (non-vacuous: the stream above really did reach the dump branch)',
            every.c._saveTicks > 0 && every.c._hivemind.saves === every.c._saveTicks,
            `saves=${every.c._hivemind.saves} eligible=${every.c._saveTicks}`);
        check('R26-12: saveInterval=3 dumps on exactly every third eligible call',
            k3.c._saveTicks === every.c._saveTicks && k3.c._hivemind.saves === Math.floor(k3.c._saveTicks / 3) && k3.c._hivemind.saves > 0,
            JSON.stringify({ kSaves: k3.c._hivemind.saves, kEligible: k3.c._saveTicks, everyEligible: every.c._saveTicks }));
        check('R26-12: saveInterval=Infinity never dumps during the run',
            never.c._saveTicks === every.c._saveTicks && never.c._hivemind.saves === 0,
            `saves=${never.c._hivemind.saves} eligible=${never.c._saveTicks}`);
        check('R26-12: flushState writes the state on demand, ignoring the interval (and is a no-op before the mind exists)',
            (() => {
                const c = new HiveMindController('H4', 'state/core-save-flush', 60, 4, 'positive', 1, PRICE, true);
                const noMind = c.flushState();
                c._hivemind = makeFakeMind();
                c._saveInterval = Infinity;
                const status = c.flushState();
                return noMind === null && c._hivemind.saves === 1 && !!status && status.status === true;
            })());
    } catch (e) {
        check('R26-12 checkpoint-throttle checks completed', false, e.stack);
    }

    // ---- I. R26-2: the label lifecycle + skill counters ----------------------
    // Every *scored* closed trade contributes its resolved barrier and its Brier
    // component, so a report can reference the model's accuracy to the label base
    // rate (BUGS.md #37). Driven by writing `closed_trades` rows and draining them
    // through `_processClosedTrades`, with a stub mind for the training step.
    try {
        const c = new HiveMindController('I0', 'state/core-labels', 60, 4, 'positive', 1, PRICE, true);
        const insert = c._db.prepare('INSERT INTO closed_trades (timestamp, entryPrice, exitPrice, outcome, features, confidence) VALUES (?, ?, ?, ?, ?, ?)');
        // 3 take-profit (outcome 1, forecast 80) and 7 stop (outcome 0, forecast 20):
        // every forecast is on the correct side, so directional accuracy is 10/10
        // while the label base rate is only 3/10 — exactly the gap #37 is about.
        for (let i = 0; i < 3; i++) insert.run(`TP-${i}`, 100, 110, 1, JSON.stringify([i, i, i, i, i, i]), 80);
        for (let i = 0; i < 7; i++) insert.run(`SL-${i}`, 100, 90, 0, JSON.stringify([100 + i, i, i, i, i, i]), 20);
        c._hivemind = { train: () => 1, dumpState: () => ({ status: true }) };
        c._processClosedTrades(10);

        check('R26-2: the resolved-barrier split and the label base rate are counted (3 TP / 7 SL)',
            c._globalAccuracy.total === 10 && c._globalAccuracy.resolvedTakeProfit === 3 &&
            c._globalAccuracy.resolvedStopLoss === 7,
            JSON.stringify({ total: c._globalAccuracy.total, tp: c._globalAccuracy.resolvedTakeProfit, sl: c._globalAccuracy.resolvedStopLoss }));
        check('R26-2: the Brier components are accumulated per scored trade (10 forecasts at 0.04)',
            c._globalAccuracy.brierCount === 10 && Math.abs(c._globalAccuracy.brierSum - 0.4) < 1e-12,
            JSON.stringify({ sum: c._globalAccuracy.brierSum, n: c._globalAccuracy.brierCount }));

        // Persistence: a fresh controller instance with the same id (the DB file is
        // per controller-id) on the same directory must reload them.
        c._saveGlobalAccuracy();
        const c2 = new HiveMindController('I0', 'state/core-labels', 60, 4, 'positive', 1, PRICE, true);
        check('R26-2: the label/Brier/drop counters round-trip through SQLite',
            c2._globalAccuracy.resolvedTakeProfit === 3 && c2._globalAccuracy.resolvedStopLoss === 7 &&
            c2._globalAccuracy.brierCount === 10 && Math.abs(c2._globalAccuracy.brierSum - 0.4) < 1e-12,
            JSON.stringify({ tp: c2._globalAccuracy.resolvedTakeProfit, n: c2._globalAccuracy.brierCount, sum: c2._globalAccuracy.brierSum }));

        // A malformed bar is counted, never silently skipped (R26-1 suspect 8), and
        // surfaced non-enumerably so the golden signal payload does not move.
        const d = new HiveMindController('I2', 'state/core-drops', 60, 4, 'positive', 1, PRICE, true);
        const good = makeCandles(60, { seed: 9, trend: 0, vol: 0.4 });
        d.getSignal(good, 1);
        const before = d._globalAccuracy.droppedCandles;
        const malformed = { timestamp: good[30].timestamp, open: NaN, high: NaN, low: NaN, close: NaN, volume: 1 };
        const sig = d.getSignal([...good.slice(1), malformed], 1);
        check('R26-1: a malformed candle is counted and surfaced non-enumerably, never silently skipped',
            before === 0 && d._globalAccuracy.droppedCandles === 1 && sig && sig.droppedCandles === 1 &&
            !Object.keys(sig).includes('droppedCandles'),
            JSON.stringify({ before, after: d._globalAccuracy.droppedCandles, onSignal: sig && sig.droppedCandles, keys: sig && Object.keys(sig).length }));
    } catch (e) {
        check('R26-2 label-lifecycle checks completed', false, e.stack);
    }

    // ---- J. R26-11: the trade-label policy (BUGS.md #36) ---------------------
    // The shipped labeller is the `optimistic` two-barrier rule. The policy is
    // configurable, so the A/B can measure the conservative / triple-barrier
    // labels as opt-in variants. The default must be bit-identical (golden), so
    // the field default and every non-default outcome are pinned here.
    try {
        const T0 = '2024-01-01T00:00:00.000Z';
        const mkLabelCtl = (id, dir, policy, horizon = null) => {
            const c = new HiveMindController(id, dir, 60, 4, 'positive', 1, PRICE, true);
            c._labelPolicy = policy;
            c._labelHorizonBars = horizon;
            c._db.prepare('INSERT INTO open_trades (timestamp, sellPrice, stopLoss, entryPrice, features, confidence) VALUES (?, ?, ?, ?, ?, ?)')
                .run(T0, 102, 99, 100, JSON.stringify([0, 0, 0, 0, 0, 0]), 60);
            return c;
        };
        const entryBar = { timestamp: T0, open: 100, high: 100.2, low: 99.8, close: 100, volume: 1 };
        const bothBar = { timestamp: '2024-01-01T00:01:00.000Z', open: 100, high: 103, low: 98.5, close: 101, volume: 1 };
        const gapBar = { timestamp: '2024-01-01T00:01:00.000Z', open: 98, high: 98.5, low: 97, close: 97.5, volume: 1 };
        const quietBar = { timestamp: '2024-01-01T00:01:00.000Z', open: 100, high: 101, low: 99.5, close: 100.5, volume: 1 };
        const closedRows = (c) => c._db.prepare('SELECT exitPrice, outcome FROM closed_trades').all();

        const def = new HiveMindController('J0', 'state/core-label-default', 60, 4, 'positive', 1, PRICE, true);
        check('R26-11: the shipped label policy default is optimistic (the golden-safe labeler)', def._labelPolicy === 'optimistic' && def._labelHorizonBars === null);

        const opt = mkLabelCtl('J1', 'state/core-label-opt', 'optimistic');
        opt._updateOpenTrades([entryBar, bothBar]);
        const optRows = closedRows(opt);
        check('R26-11: optimistic books a bar spanning both barriers as a WIN at the take-profit (the historical behaviour)',
            optRows.length === 1 && optRows[0].outcome === 1 && optRows[0].exitPrice === 102,
            JSON.stringify(optRows));

        const con = mkLabelCtl('J2', 'state/core-label-con', 'conservative');
        con._updateOpenTrades([entryBar, bothBar]);
        const conRows = closedRows(con);
        check('R26-11: conservative resolves a both-barrier bar to the STOP (stop-first tie-break)',
            conRows.length === 1 && conRows[0].outcome === 0 && conRows[0].exitPrice === 99,
            JSON.stringify(conRows));

        const gap = mkLabelCtl('J3', 'state/core-label-gap', 'conservative');
        gap._updateOpenTrades([entryBar, gapBar]);
        const gapRows = closedRows(gap);
        check('R26-11: conservative fills a gapped stop at the bar WORST traded price (the open, not the stop price)',
            gapRows.length === 1 && gapRows[0].outcome === 0 && gapRows[0].exitPrice === 98,
            JSON.stringify(gapRows));

        const tri = mkLabelCtl('J4', 'state/core-label-tri', 'triple', 1);
        tri._updateOpenTrades([entryBar, quietBar]);
        const triRows = closedRows(tri);
        check('R26-11: triple (conservative + time barrier) expires an untriggered trade at the horizon bar and labels it from its close',
            triRows.length === 1 && triRows[0].exitPrice === 100.5 && triRows[0].outcome === 1 &&
            tri._globalAccuracy.resolvedTimeBarrier === 1 && tri._globalAccuracy.heldBarsCount === 1 && tri._globalAccuracy.heldBarsSum === 1,
            JSON.stringify({ rows: triRows, tb: tri._globalAccuracy.resolvedTimeBarrier, held: tri._globalAccuracy.heldBarsCount }));

        // The lifecycle counters persist with the accuracy bag.
        tri._saveGlobalAccuracy();
        const tri2 = new HiveMindController('J4', 'state/core-label-tri', 60, 4, 'positive', 1, PRICE, true);
        check('R26-11: the time-barrier and holding counters round-trip through SQLite',
            tri2._globalAccuracy.resolvedTimeBarrier === 1 && tri2._globalAccuracy.heldBarsCount === 1 &&
            tri2._globalAccuracy.heldBarsSum === 1 && tri2._globalAccuracy.heldBarsMax === 1,
            JSON.stringify({ tb: tri2._globalAccuracy.resolvedTimeBarrier, held: tri2._globalAccuracy.heldBarsCount }));
    } catch (e) {
        check('R26-11 label-policy checks completed', false, e.stack);
    }

    const failed = checks.filter((c) => !c.pass);
    return { total: checks.length, failed: failed.length, failures: failed, checks };
}
