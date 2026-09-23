// Determinism + open-book invariant locks for the shipped controller (R27-6).
//
// This is the "sanity layer" the round-27 review asked for: after several rounds
// of touching the trade bookkeeping (the entry-timestamp guard, the true holding
// period, the triple-barrier horizon, the causal-window weights), a small set of
// invariants is asserted that are true of ANY healthy controller run, so a
// refactor that silently breaks one is caught here rather than in a multi-minute
// analysis run.
//
//   A. DETERMINISM — two runs of the same synthetic stream under the same seed
//      produce identical emitted positions AND identical `Math.random()` draw
//      counts (so a change that perturbs the RNG consumption is a visible test
//      failure, not a silent fingerprint drift);
//   B. OPEN-BOOK INVARIANTS — over a real walk-forward stream: the resolved-barrier
//      split is exhaustive, the holding duration is finite and bounded by the
//      cache, `brierSum` is finite, `trainingSteps` is monotone, and a clean
//      stream writes no bad open-trade rows;
//   C. TIMESTAMP INVARIANT — the shipped candle files are 24-char ISO-8601 UTC
//      strings, strictly increasing and unique (the `ORDER BY timestamp` and the
//      string-keyed candle cache both depend on it);
//   D. OFF-STATE / LIVENESS — every round-27 config is off by default and a
//      bit-exact no-op when off; the causal-window weight is exactly 1 on
//      non-overlapping (horizon-1) labels, which is the `inert` case the A/B
//      reports;
//   E. AUDIT NON-VACUITY — a view the perturbation cannot change is reported
//      `vacuous`, never `clean` (BUGS.md #22, re-asserted after R27-1).
//
// Like the other entries this takes `{ ensureSql, stateDir, readFile }` so the
// node mirror can run against real better-sqlite3, a temp state dir, and the real
// filesystem; in the browser harness it lazily loads the sql.js shim and reads
// the shipped files through `globalThis.__fs`.
// The shim is imported **lazily** inside `run()`, never statically: keeping every
// browser-only module out of the *static* import graph is what lets Node link this
// entry at all (docs/BUGS.md #15.3 and #52 — a static shim import drags the CDN
// `https:` module into the node mirror, which the default ESM loader refuses).

import HiveMindController from '../../../src/hivemind/hiveMindController.js';
import HiveMind from '../../../src/hivemind/hiveMind.js';
import { walkForwardSplit } from '../../../src/analysis/splits.js';
import { auditNoLookahead } from '../../../src/analysis/walkforward.js';
import { CANDLE_MANIFEST } from '../../../src/candles_audit.js';

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function makeCandles(n, { start = 100, seed = 1, trend = 0, vol = 1 } = {}) {
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
            timestamp: new Date(baseTs + i * 60000).toISOString(),
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

// A seeded `Math.random` that also counts its draws, restored afterwards.
function withSeededRandom(seed, fn) {
    const real = Math.random;
    const rnd = mulberry32(seed);
    const state = { calls: 0 };
    Math.random = () => { state.calls += 1; return rnd(); };
    try { return { value: fn(), calls: state.calls }; } finally { Math.random = real; }
}

export async function run(options = {}) {
    if (options.ensureSql) await options.ensureSql();
    else {
        const shim = await import('../shims/better-sqlite3.js');
        await shim.__ensureSql();
    }
    const stateDir = options.stateDir || ((label) => `state/ctl-invariants-${label}`);
    const readFile = (options && typeof options.readFile === 'function')
        ? options.readFile
        : ((globalThis.__fs && typeof globalThis.__fs.readTextFile === 'function')
            ? (p) => globalThis.__fs.readTextFile(p)
            : null);

    const checks = [];
    const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });

    // ---- A. determinism ------------------------------------------------------
    try {
        // The online model is the only source of randomness on the scored path, so
        // its determinism is the controller's determinism. Two INDEPENDENT model
        // instances (fresh dirs) trained on the same sequence under the same seed
        // must emit identical probabilities AND consume an identical number of
        // `Math.random()` draws — a change that perturbs RNG consumption shows up
        // here rather than as a silent fingerprint drift. (This mirrors the proven
        // pattern in sanity.test.js; it avoids the controller's intentionally
        // stateful DB, which makes two sequential full streams non-comparable.)
        const H_ES = 2;
        const H_IS = 8;
        const inputs8 = (s) => Array.from({ length: H_IS }, (_, i) => Math.sin(s * 1.7 + i * 0.9) * 0.6);
        const probes = [inputs8(1), inputs8(2), inputs8(3)];
        const runModel = (dir) => {
            const hm = new HiveMind(dir, H_ES, H_IS, 'DET', true);
            for (let s = 0; s < 6; s++) {
                const r = mulberry32(52 * 31 + s);
                Math.random = () => r();
                hm.train(inputs8(s), s % 2);
            }
            return probes.map((p) => {
                const r = mulberry32(7);
                Math.random = () => r();
                return hm.predict(p);
            });
        };
        const a = withSeededRandom(52, () => runModel(stateDir('det-a')));
        const b = withSeededRandom(52, () => runModel(stateDir('det-b')));
        check('determinism: the same seed emits an identical probability series',
            JSON.stringify(a.value) === JSON.stringify(b.value),
            `${JSON.stringify(a.value)} vs ${JSON.stringify(b.value)}`);
        check('determinism: the same seed consumes an identical number of Math.random() draws',
            a.calls === b.calls && a.calls > 0, `a=${a.calls} b=${b.calls}`);

        // The production controller shape (a fresh controller per getSignal call,
        // all sharing one state dir, worker.js does exactly this) is exercised once
        // for the open-book invariants below.
        const cache = makeCandles(160, { seed: 77, trend: 0.0004, vol: 0.9 });
        const stream = (dir) => {
            const probs = [];
            let monotone = true;
            let lastStep = -1;
            let ga = null;
            for (let i = 60; i <= cache.length; i++) {
                const c = new HiveMindController('DET', dir, 120, 4, 'positive', 1, PRICE, true);
                const sig = c.getSignal(cache.slice(Math.max(0, i - 120), i), 1, 0.025, 0.025, [], []);
                probs.push(sig && Number.isFinite(sig.prob) ? sig.prob : null);
                const step = c._globalAccuracy.trainingSteps;
                if (step < lastStep) monotone = false;
                lastStep = step;
                ga = c._globalAccuracy;
            }
            return { probs, monotone, ga };
        };
        const run = withSeededRandom(1234, () => stream(stateDir('stream')));
        check('determinism: training steps never decrease over a stream', run.value.monotone);
        check('determinism: the stream emits a real (non-abstaining) signal series',
            run.value.probs.some((p) => Number.isFinite(p) && p >= 0 && p <= 100),
            JSON.stringify(run.value.probs.slice(0, 6)));

        // ---- B. open-book invariants over that stream ------------------------
        const ga = run.value.ga;
        check('invariants: the resolved-barrier split is exhaustive (total == TP + SL)',
            ga.total === ga.resolvedTakeProfit + ga.resolvedStopLoss,
            JSON.stringify({ total: ga.total, tp: ga.resolvedTakeProfit, sl: ga.resolvedStopLoss }));
        check('invariants: every closed trade has a finite holding duration >= 1 and <= cacheSize-1',
            ga.heldBarsCount > 0 && ga.heldBarsSum >= ga.heldBarsCount && ga.heldBarsMax >= 1 && ga.heldBarsMax <= 119,
            JSON.stringify({ count: ga.heldBarsCount, sum: ga.heldBarsSum, max: ga.heldBarsMax }));
        check('invariants: every closed trade is eventually resolved (heldBars >= resolved rows)',
            ga.heldBarsCount >= ga.resolvedTakeProfit + ga.resolvedStopLoss,
            JSON.stringify({ held: ga.heldBarsCount, resolved: ga.resolvedTakeProfit + ga.resolvedStopLoss }));
        check('invariants: the Brier accumulator stays finite', Number.isFinite(ga.brierSum) && ga.brierCount >= 0,
            JSON.stringify({ brierSum: ga.brierSum, brierCount: ga.brierCount }));
        check('invariants: a clean stream writes no bad open-trade rows',
            (ga.openTradeWriteErrors || 0) === 0 && (ga.quarantinedRows || 0) === 0,
            JSON.stringify({ openTradeWriteErrors: ga.openTradeWriteErrors || 0, quarantinedRows: ga.quarantinedRows || 0 }));
    } catch (e) {
        check('A/B determinism + invariants completed', false, e.stack);
    }

    // ---- C. timestamp invariant on the shipped files -------------------------
    try {
        if (!readFile) {
            check('C: shipped-file reader available', false, 'no readFile option and no globalThis.__fs');
        } else {
            // One file is enough to lock the invariant (the full audit lives in
            // candles.test.js): every timestamp is canonical 24-char ISO-8601 UTC,
            // strictly increasing, with no duplicates.
            const entry = CANDLE_MANIFEST[0];
            const text = await readFile(entry.file);
            const lines = text.split('\n');
            let rows = 0, badFormat = 0, nonIncreasing = 0, duplicates = 0, prev = null;
            const seen = new Set();
            for (const line of lines) {
                if (!line) continue;
                let row;
                try { row = JSON.parse(line); } catch { badFormat++; continue; }
                rows++;
                const ts = row.timestamp;
                if (typeof ts !== 'string' || ts.length !== 24 || new Date(ts).toISOString() !== ts) badFormat++;
                const ms = Date.parse(ts);
                if (seen.has(ms)) duplicates++;
                else seen.add(ms);
                if (prev != null && ms <= prev) nonIncreasing++;
                prev = ms;
            }
            check('C: shipped candle timestamps are canonical 24-char ISO-8601 UTC',
                rows > 0 && badFormat === 0, `${entry.file}: rows=${rows} badFormat=${badFormat}`);
            check('C: shipped candle timestamps strictly increase with no duplicates',
                nonIncreasing === 0 && duplicates === 0,
                `${entry.file}: nonIncreasing=${nonIncreasing} duplicates=${duplicates}`);
        }
    } catch (e) {
        check('C: timestamp invariant completed', false, (e && e.stack) || String(e));
    }

    // ---- D. off-state / liveness --------------------------------------------
    try {
        const c = new HiveMindController('OFF', stateDir('off-state'), 120, 4, 'positive', 1, PRICE, true);
        const trades = [
            { timestamp: new Date(Date.parse('2024-01-01T00:00:00Z')).toISOString(), confidence: 60 },
            { timestamp: new Date(Date.parse('2024-01-01T01:00:00Z')).toISOString(), confidence: 60 },
        ];
        check('D: the sample-weight feature is off by default (no config -> null weights, no summary)',
            c._sampleWeightConfig === null && c._sampleWeightsForBatch(trades) === null && c.sampleWeightSummary() === null);

        // On the shipped labeler (horizon 1) consecutive entries never overlap, so
        // every causal-window weight is exactly 1 — the mechanism is a bit-exact
        // no-op, which is the `inert` case the A/B reports via the liveness block.
        c._sampleWeightConfig = { mode: 'causal-window', windowBars: 64, horizonBars: 1, normalization: 'mean1' };
        const w = c._sampleWeightsForBatch(trades);
        check('D: the causal-window weight is exactly 1 on non-overlapping (horizon-1) labels',
            Array.isArray(w) && w.length === 2 && w.every((x) => x === 1),
            JSON.stringify(w));
        const summary = c.sampleWeightSummary();
        check('D: the sample-weight summary reports the (all-ones) stream so inertness is visible',
            summary && summary.count === 2 && summary.min === 1 && summary.max === 1 && Math.abs(summary.mean - 1) < 1e-12,
            JSON.stringify(summary));

        // With overlapping labels the weights really do vary, so the feature is
        // live only where it can express an effect (this is R27-3's whole point).
        const c2 = new HiveMindController('LIVE', stateDir('live-state'), 120, 4, 'positive', 1, PRICE, true);
        c2._sampleWeightConfig = { mode: 'causal-window', windowBars: 64, horizonBars: 4, normalization: 'mean1' };
        const spaced = [0, 1, 2, 3].map((h) => ({ timestamp: new Date(Date.parse('2024-01-01T00:00:00Z') + h * 3600000).toISOString(), confidence: 60 }));
        const overlapped = c2._sampleWeightsForBatch(spaced);
        check('D: with overlapping (horizon>1) labels the weights are non-uniform and finite',
            Array.isArray(overlapped) && overlapped.length === 4 &&
            new Set(overlapped).size > 1 && overlapped.every((w) => Number.isFinite(w) && w > 0) &&
            overlapped.some((w) => w > 1),
            JSON.stringify(overlapped));

        // R28 (BUGS.md #54/#58): the MEASURED span and the mean-1 EMITTED stream.
        // With `horizonBars: null` the ring's span is the causal EMA of the realized
        // holding periods of the trades already drained — never the span of the label
        // being weighted (that would be lookahead). The reported `min`/`max`/`mean`
        // are the EMITTED (normalised) stream and `meanUnnormalised` the raw one.
        const mkTs = (h) => new Date(Date.parse('2024-01-01T00:00:00Z') + h * 3600000).toISOString();
        const tenTrades = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((h) => ({ timestamp: mkTs(h), confidence: 60 }));
        const c3 = new HiveMindController('MEAS', stateDir('meas-state'), 120, 4, 'positive', 1, PRICE, true);
        c3._sampleWeightConfig = { mode: 'causal-window', windowBars: 8, horizonBars: null, normalization: 'mean1', emittedNormalization: 'mean1' };
        c3._sampleWeightHeldBars = new Map([[mkTs(0), 8], [mkTs(1), 8]]);
        const measured = c3._sampleWeightsForBatch(tenTrades);
        const ms = c3.sampleWeightSummary();
        check('D (R28, BUGS.md #58): a null config horizon is measured from the drained holding periods (causally)',
            c3._sampleWeightHeldBarsEma === 8 && ms.horizonBars === 8 && ms.measureHorizon === true &&
            c3._sampleWeightHeldBars.size === 0 && !c3._sampleWeightHeldBars.has(mkTs(9)),
            JSON.stringify({ ema: c3._sampleWeightHeldBarsEma, summary: ms }));
        check('D (R28, BUGS.md #54): the summary reports the EMITTED stream (min < 1 < max, ess < n) and the RAW scale separately',
            ms.count === 10 && ms.min < 1 && ms.max > 1 &&
            Math.abs(ms.mean - 1.0136322827009256) < 1e-9 &&
            Math.abs(ms.meanUnnormalised - 0.9763185865818833) < 1e-9 &&
            ms.mean !== ms.meanUnnormalised && ms.ess < ms.n && ms.effectiveFraction < 1 &&
            Math.abs(ms.ess - 4.0917868969148845) < 1e-9 && Math.abs(ms.n - 5.4) < 1e-9,
            JSON.stringify(ms));
        check('D (R28): the emitted weights are exactly the returned batch (the summary is not a second computation)',
            measured.every((w, i) => w >= ms.min && w <= ms.max) &&
            Math.abs(measured.reduce((a, b) => a + b, 0) / measured.length - ms.mean) < 1e-9 &&
            measured[2] === 0.7941176470588236 && measured[9] === 1.6029223460632247,
            JSON.stringify(measured));
        // Causality: perturbing a LATER trade's realized holding period (or a later
        // trade's span) must not move an EARLIER label's emitted weight.
        const c4 = new HiveMindController('CAUS', stateDir('caus-state'), 120, 4, 'positive', 1, PRICE, true);
        c4._sampleWeightConfig = { ...c3._sampleWeightConfig };
        c4._sampleWeightHeldBars = new Map([[mkTs(0), 8], [mkTs(5), 40], [mkTs(9), 50]]);
        const perturbed = c4._sampleWeightsForBatch(tenTrades);
        check('D (R28, P1c): the span estimator is causal — a later trade\'s heldBars cannot change an earlier label\'s weight',
            JSON.stringify(perturbed.slice(0, 5)) === JSON.stringify(measured.slice(0, 5)) &&
            JSON.stringify(perturbed.slice(5)) !== JSON.stringify(measured.slice(5)) &&
            c4._sampleWeightHeldBarsEma > 8,
            JSON.stringify({ same: JSON.stringify(perturbed.slice(0, 5)) === JSON.stringify(measured.slice(0, 5)), ema: c4._sampleWeightHeldBarsEma }));
        // The explicit `--sample-weight-horizon` (a FIXED span) and the raw arm.
        const c5 = new HiveMindController('FIXED', stateDir('fixed-state'), 120, 4, 'positive', 1, PRICE, true);
        c5._sampleWeightConfig = { mode: 'causal-window', windowBars: 8, horizonBars: 12, normalization: 'mean1', emittedNormalization: 'mean1' };
        const fixedW = c5._sampleWeightsForBatch(tenTrades);
        const fs = c5.sampleWeightSummary();
        check('D (R28, P1c): an explicit span horizon is FIXED (never measured) and produces its own weights',
            fs.horizonBars === 12 && fs.measureHorizon === false && c5._sampleWeightHeldBarsEma == null &&
            JSON.stringify(fixedW) !== JSON.stringify(measured),
            JSON.stringify({ summary: fs, w: fixedW }));
        const c6 = new HiveMindController('RAW', stateDir('raw-state'), 120, 4, 'positive', 1, PRICE, true);
        c6._sampleWeightConfig = { mode: 'causal-window', windowBars: 8, horizonBars: null, normalization: 'mean1', emittedNormalization: 'none' };
        c6._sampleWeightHeldBars = new Map([[mkTs(0), 8], [mkTs(1), 8]]);
        const rawW = c6._sampleWeightsForBatch(tenTrades);
        const rs = c6.sampleWeightSummary();
        check('D (R28, P3 arm B): emittedNormalization:none reproduces the un-normalised stream (mean == meanUnnormalised, the raw scale)',
            rs.mean === rs.meanUnnormalised &&
            Math.abs(rs.mean - 0.9763185865818833) < 1e-9 &&
            Math.abs(rs.max - 1.5287946428571426) < 1e-9 &&
            Math.abs(rs.min - 0.7777777777777777) < 1e-9,
            JSON.stringify({ summary: rs, w: rawW }));
        check('D (R28, P3 arm B): the raw arm differs from the mean-1 arm (the normaliser is live, not a no-op)',
            JSON.stringify(rawW) !== JSON.stringify(measured) &&
            Math.abs(rs.meanUnnormalised - ms.meanUnnormalised) < 1e-12 &&
            measured[9] !== rawW[9],
            JSON.stringify({ raw: rawW.slice(0, 4), norm: measured.slice(0, 4) }));
    } catch (e) {
        check('D: off-state/liveness checks completed', false, e.stack);
    }

    // ---- E. audit non-vacuity -------------------------------------------------
    try {
        const returns = Array.from({ length: 120 }, (_, i) => Math.sin(i / 3) * 0.01);
        const folds = walkForwardSplit({ n: 120, trainSize: 60, testSize: 10 });
        const r = auditNoLookahead({
            signalForFold: (tr, te) => te.map(() => 1),
            folds, returns, probe: 1000,
            viewFor: (ret) => ({ returns: ret }),
            requireReachable: true, auditProbesPerFold: 1,
        });
        check('E: a signal that ignores the (genuinely perturbed) view is reported vacuous, never clean',
            r.vacuous === true && r.clean === false && r.viewDiffers === true && r.reachable === false,
            JSON.stringify({ vacuous: r.vacuous, clean: r.clean, viewDiffers: r.viewDiffers, reachable: r.reachable }));
    } catch (e) {
        check('E: audit non-vacuity completed', false, e.stack);
    }

    const failed = checks.filter((c) => !c.pass);
    return { total: checks.length, failed: failed.length, failures: failed, checks };
}
