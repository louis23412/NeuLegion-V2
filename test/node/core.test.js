// End-to-end controller contract, mirroring test/browser/entries/core.test.js.
// Run with `npm test` (node:test + real better-sqlite3).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import HiveMindController from '../../src/hivemind/hiveMindController.js';
import HiveMind from '../../src/hivemind/hiveMind.js';
import { mulberry32, makeCandles, makeInputs, tempStateDir, PRICE, withSeed } from './helpers.js';

test('short input is rejected without throwing', () => {
    const dir = tempStateDir('core-short');
    const c = new HiveMindController('A', dir, 120, 4, 'positive', 1, PRICE, true);
    const r = c.getSignal(makeCandles(5, { seed: 9 }), 1);
    assert.ok(r && r.error, `expected an error object, got ${JSON.stringify(r)}`);
});

test('directional invariants hold over a warm run', () => {
    const dir = tempStateDir('core-warm');
    const cache = makeCandles(260, { seed: 3, trend: 0.0004, vol: 0.8 });
    let pos = null; let neg = null;

    withSeed(1, () => {
        for (let i = 40; i <= cache.length; i++) {
            const slice = cache.slice(0, i);
            pos = new HiveMindController('B', dir, 120, 4, 'positive', 1, PRICE, true)
                .getSignal(slice, 1, 0.025, 0.025, [], []);
            neg = new HiveMindController('C', dir, 120, 4, 'negative', 1, PRICE, true)
                .getSignal(slice, 1, 0.025, 0.025, [], []);
        }
    });

    assert.ok(pos && !pos.error && neg && !neg.error, JSON.stringify(pos?.error || neg?.error));
    assert.ok(pos.sellPrice > pos.entryPrice, 'positive takeProfit above entry');
    assert.ok(pos.stopLoss < pos.entryPrice, 'positive stopLoss below entry');
    assert.ok(neg.sellPrice < neg.entryPrice, 'negative takeProfit below entry');
    assert.ok(neg.stopLoss > neg.entryPrice, 'negative stopLoss above entry');
    assert.equal(pos.entryPrice, cache.at(-1).close);

    for (const key of ['entryPrice', 'sellPrice', 'stopLoss', 'score', 'tradeAcc', 'trueAcc', 'prob']) {
        assert.ok(Number.isFinite(pos[key]), `${key} finite (got ${pos[key]})`);
    }
    assert.equal(pos.hiveConnection, true);
    assert.ok(pos.prob === -1 || (pos.prob >= 0 && pos.prob <= 100), `prob in range (${pos.prob})`);
    assert.ok(pos.lastTrainingStep > 0);
});

test('predict/train round trip on a bare HiveMind', () => {
    const dir = tempStateDir('core-round');
    const hm = withSeed(2, () => new HiveMind(dir, 3, 12, 'D', true));
    const inputs = Array.from({ length: 12 }, (_, i) => (i % 3) / 2);

    const p0 = hm.predict(inputs);
    const step = hm.train(inputs, 1);
    const p1 = hm.predict(inputs);

    assert.ok(typeof p0 === 'number' && p0 >= 0 && p0 <= 1, `p0=${p0}`);
    assert.ok(typeof step === 'number' && step > 0, `step=${step}`);
    assert.ok(typeof p1 === 'number' && p1 >= 0 && p1 <= 1, `p1=${p1}`);

    const bc = hm.broadcastMemory(inputs, 0.025);
    assert.ok(Array.isArray(bc.memories) && bc.compatibility, JSON.stringify(Object.keys(bc)));
    const tr = hm.translateMemory(bc.memories, inputs, 0.025);
    assert.ok(Number.isFinite(tr.injectedRatio), JSON.stringify(tr));
    assert.ok(hm.dumpState()?.status);
});

test('state persists across instances', () => {
    const dir = tempStateDir('core-persist');
    const rows = makeInputs(12, 6, 5);

    withSeed(4, () => {
        const a = new HiveMind(dir, 3, 12, 'E', true);
        for (let i = 0; i < rows.length; i++) { Math.random = mulberry32(40 + i); a.train(rows[i], i % 2); }
        a.dumpState();
    });

    const b = withSeed(4, () => new HiveMind(dir, 3, 12, 'E', true));
    assert.ok(Number.isFinite(b.predict(rows[0])));
});

test('getSignal produces a well-formed signal after training', () => {
    const dir = tempStateDir('core-signal');
    const cache = makeCandles(120, { seed: 12, trend: 0.0003, vol: 0.7 });
    let sig = null;
    withSeed(6, () => {
        for (let i = 60; i <= cache.length; i++) {
            sig = new HiveMindController('F', dir, 120, 4, 'positive', 1, PRICE, true)
                .getSignal(cache.slice(0, i), 1, 0.025, 0.025, [], []);
        }
    });
    assert.ok(sig && !sig.error, JSON.stringify(sig?.error));
    assert.ok(sig.openSimulations >= 0);
    assert.ok(sig.hiveConnection === true);
});

// Round 26 (R26-2, BUGS.md #37): the label-lifecycle counters and the Brier
// components are persisted, and a malformed candle is counted rather than
// silently skipped. This is the native-driver proof of the browser entry's
// section I — the global_stats table takes a REAL (`brier_sum`) in an INTEGER-
// affinity column, which only real better-sqlite3 can certify.
test('R26-2: label lifecycle, Brier components and dropped candles persist on native SQLite', () => {
    const dir = tempStateDir('core-labels');
    const c = new HiveMindController('L', dir, 120, 4, 'positive', 1, PRICE, true);
    const insert = c._db.prepare('INSERT INTO closed_trades (timestamp, entryPrice, exitPrice, outcome, features, confidence) VALUES (?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < 3; i++) insert.run(`TP-${i}`, 100, 110, 1, JSON.stringify([i, i, i, i, i, i]), 80);
    for (let i = 0; i < 7; i++) insert.run(`SL-${i}`, 100, 90, 0, JSON.stringify([100 + i, i, i, i, i, i]), 20);
    c._hivemind = { train: () => 1, dumpState: () => ({ status: true }) };
    c._processClosedTrades(10);

    assert.equal(c._globalAccuracy.resolvedTakeProfit, 3);
    assert.equal(c._globalAccuracy.resolvedStopLoss, 7);
    assert.equal(c._globalAccuracy.brierCount, 10);
    assert.ok(Math.abs(c._globalAccuracy.brierSum - 0.4) < 1e-12, `brierSum=${c._globalAccuracy.brierSum}`);

    c._saveGlobalAccuracy();
    const c2 = new HiveMindController('L', dir, 120, 4, 'positive', 1, PRICE, true);
    assert.equal(c2._globalAccuracy.resolvedTakeProfit, 3);
    assert.equal(c2._globalAccuracy.resolvedStopLoss, 7);
    assert.equal(c2._globalAccuracy.brierCount, 10);
    assert.ok(Math.abs(c2._globalAccuracy.brierSum - 0.4) < 1e-12, `reloaded brierSum=${c2._globalAccuracy.brierSum}`);

    const d = new HiveMindController('M', tempStateDir('core-drops'), 120, 4, 'positive', 1, PRICE, true);
    const good = makeCandles(120, { seed: 9, trend: 0, vol: 0.4 });
    d.getSignal(good, 1);
    const before = d._globalAccuracy.droppedCandles;
    const malformed = { timestamp: good[30].timestamp, open: NaN, high: NaN, low: NaN, close: NaN, volume: 1 };
    const sig = d.getSignal([...good.slice(1), malformed], 1);
    assert.equal(before, 0);
    assert.equal(d._globalAccuracy.droppedCandles, 1);
    assert.equal(sig.droppedCandles, 1);
    assert.ok(!Object.keys(sig).includes('droppedCandles'), 'the diagnostic must stay non-enumerable');
});

// Round 26 (R26-11, BUGS.md #36): the trade-label policy. `optimistic` is the
// shipped labeller; `conservative` (stop-first tie-break + worst-price gapped
// stop) and `triple` (conservative + a time barrier) are opt-in. This is the
// native-driver proof of the browser entry's section J: the label resolution and
// the new lifecycle counters round-trip through REAL better-sqlite3 (the
// `resolved_time_barrier` / `held_bars_*` columns have INTEGER affinity, which
// only the native driver can certify).
test('R26-11: the label policies label correctly and round-trip their counters on native SQLite', () => {
    const T0 = '2024-01-01T00:00:00.000Z';
    const mk = (id, dir, policy, horizon = null) => {
        const c = new HiveMindController(id, dir, 120, 4, 'positive', 1, PRICE, true);
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

    const def = new HiveMindController('J0', tempStateDir('core-label-default'), 120, 4, 'positive', 1, PRICE, true);
    assert.equal(def._labelPolicy, 'optimistic');
    assert.equal(def._labelHorizonBars, null);

    const opt = mk('J1', tempStateDir('core-label-opt'), 'optimistic');
    opt._updateOpenTrades([entryBar, bothBar]);
    assert.deepEqual(closedRows(opt), [{ exitPrice: 102, outcome: 1 }]);

    const con = mk('J2', tempStateDir('core-label-con'), 'conservative');
    con._updateOpenTrades([entryBar, bothBar]);
    assert.deepEqual(closedRows(con), [{ exitPrice: 99, outcome: 0 }]);

    const gap = mk('J3', tempStateDir('core-label-gap'), 'conservative');
    gap._updateOpenTrades([entryBar, gapBar]);
    assert.deepEqual(closedRows(gap), [{ exitPrice: 98, outcome: 0 }]);

    const triDir = tempStateDir('core-label-tri');
    const tri = mk('J4', triDir, 'triple', 1);
    tri._updateOpenTrades([entryBar, quietBar]);
    assert.deepEqual(closedRows(tri), [{ exitPrice: 100.5, outcome: 1 }]);
    assert.equal(tri._globalAccuracy.resolvedTimeBarrier, 1);
    assert.equal(tri._globalAccuracy.heldBarsCount, 1);
    assert.equal(tri._globalAccuracy.heldBarsSum, 1);
    assert.equal(tri._globalAccuracy.heldBarsMax, 1);

    tri._saveGlobalAccuracy();
    const tri2 = new HiveMindController('J4', triDir, 120, 4, 'positive', 1, PRICE, true);
    assert.equal(tri2._globalAccuracy.resolvedTimeBarrier, 1);
    assert.equal(tri2._globalAccuracy.heldBarsCount, 1);
    assert.equal(tri2._globalAccuracy.heldBarsSum, 1);
    assert.equal(tri2._globalAccuracy.heldBarsMax, 1);
});
