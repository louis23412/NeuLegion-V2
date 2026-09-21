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
