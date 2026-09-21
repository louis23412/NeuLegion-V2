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

    const failed = checks.filter((c) => !c.pass);
    return { total: checks.length, failed: failed.length, failures: failed, checks };
}
