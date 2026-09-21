// node:test mirror of test/browser/entries/features.test.js.
//
// Exercises HiveMindController's tier>1 feature-extraction path
// (#computeProtoQuality + #robustNormalize + #interleave) and the tier-1
// indicator path. Reads the feature vector the controller persisted into
// `open_trades.features` and compares it to an independent reference.
//
//   npm test            # runs test/node/*.test.js
//
// NOTE: the development sandbox has no Node, so this file is not executed there.
// It is derived from the browser suite, which IS executed headlessly and is the
// authoritative check; keep the two in sync.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Database from 'better-sqlite3';

import HiveMindController from '../../src/hivemind/hiveMindController.js';
import { truncateToDecimals } from '../../src/hivemind/utils.js';
import { makeCandles, tempStateDir, PRICE } from './helpers.js';

// Independent re-implementation of #robustNormalize.
function refRobustNormalize(data, count) {
    if (!Array.isArray(data) || data.length < 2) return Array(count).fill(0);
    const actualCount = Math.min(count, data.length);
    const vals = data.slice(-actualCount);
    const sorted = [...data].sort((a, b) => a - b);
    const lowerIdx = Math.floor(0.05 * sorted.length);
    const upperIdx = Math.ceil(0.95 * sorted.length) - 1;
    let min = Math.min(sorted[lowerIdx], Math.min(...vals));
    let max = Math.max(sorted[upperIdx], Math.max(...vals));
    if (max === min) {
        const median = sorted[Math.floor(sorted.length / 2)];
        const mad = sorted.reduce((s, v) => s + Math.abs(v - median), 0) / sorted.length;
        const scale = mad > 0 ? mad : Number.EPSILON * 1e6;
        min = median - scale;
        max = median + scale;
    }
    return vals.map((v) => truncateToDecimals(Math.min(1, Math.max(0, (v - min) / (max - min))), 4));
}

function readLatestFeatures(dir, id, type = 'positive') {
    const db = new Database(path.join(dir, `hivemind_controller-${type}-${id}.db`), { fileMustExist: false });
    const row = db.prepare('SELECT features FROM open_trades ORDER BY rowid DESC LIMIT 1').get();
    db.close();
    return row ? JSON.parse(row.features) : null;
}

const MEAN = [0, 1, 2, 3, 4, 5, 6, 7];
const VARIANCE = [1, 2, 4, 8, 16, 32, 64, 128];
const MEM_META = { size: 12, accessCount: 7, importance: 1.5 };
const childWith = (mean, variance) => ({ memories: [{ mean, variance, ...MEM_META }] });

test('tier>1 features match interleave(normMean, normVariance)', () => {
    const dir = tempStateDir('feat-a');
    const candles = makeCandles(200, { seed: 13, trend: 0.0003, vol: 0.9 });
    const c = new HiveMindController('FA', dir, 40, 4, 'positive', 2, PRICE, true);
    const sig = c.getSignal(candles, 1, 0.025, 0.025, [], [childWith(MEAN, VARIANCE)]);
    assert.ok(sig && !sig.error, JSON.stringify(sig && sig.error));

    const feats = readLatestFeatures(dir, 'FA');
    assert.ok(Array.isArray(feats), `features not persisted: ${feats}`);

    const nm = refRobustNormalize(MEAN, MEAN.length);
    const nv = refRobustNormalize(VARIANCE, VARIANCE.length);
    const expected = [];
    for (let i = 0; i < 10; i++) expected.push(i % 2 === 0 ? nm[i / 2] : nv[(i - 1) / 2]);

    assert.equal(feats.length, 10, `feature length ${feats.length}`);
    for (let i = 0; i < expected.length; i++) {
        assert.ok(Object.is(feats[i], expected[i]), `feature[${i}] got ${feats[i]} want ${expected[i]}`);
    }
    assert.ok(feats.some((v) => v !== 0), 'feature vector must not be all-zero');
    assert.ok(feats.every((v) => v >= 0 && v <= 1), `features outside [0,1]: ${JSON.stringify(feats)}`);
});

test('tier>1 Float32Array memory equals plain-array memory', () => {
    const dir = tempStateDir('feat-b');
    const candles = makeCandles(200, { seed: 13, trend: 0.0003, vol: 0.9 });
    const plain = new HiveMindController('FB', dir, 40, 4, 'positive', 2, PRICE, true)
        .getSignal(candles, 1, 0.025, 0.025, [], [childWith(MEAN, VARIANCE)]);
    assert.ok(plain && !plain.error);
    const typed = new HiveMindController('FC', dir, 40, 4, 'positive', 2, PRICE, true)
        .getSignal(candles, 1, 0.025, 0.025, [], [childWith(Float32Array.from(MEAN), Float32Array.from(VARIANCE))]);
    assert.ok(typed && !typed.error);

    const a = readLatestFeatures(dir, 'FB');
    const b = readLatestFeatures(dir, 'FC');
    assert.ok(Array.isArray(a) && Array.isArray(b));
    assert.equal(b.length, a.length);
    for (let i = 0; i < a.length; i++) assert.ok(Object.is(a[i], b[i]), `idx ${i}: ${a[i]} vs ${b[i]}`);
});

test('tier>1 with no child memories pads 0.5 to inputSize', () => {
    const dir = tempStateDir('feat-c');
    const candles = makeCandles(200, { seed: 13, trend: 0.0003, vol: 0.9 });
    const r = new HiveMindController('FD', dir, 40, 4, 'positive', 2, PRICE, true)
        .getSignal(candles, 1, 0.025, 0.025, [], []);
    assert.ok(r && !r.error);
    const feats = readLatestFeatures(dir, 'FD');
    assert.ok(Array.isArray(feats));
    assert.equal(feats.length, 10, `feature length ${feats.length}`);
    assert.ok(feats.every((v) => Object.is(v, 0.5)), JSON.stringify(feats));
});

test('tier1 ignores child memories and yields inputSize features', () => {
    const dir = tempStateDir('feat-d');
    const candles = makeCandles(200, { seed: 13, trend: 0.0003, vol: 0.9 });
    const r = new HiveMindController('FE', dir, 120, 4, 'positive', 1, PRICE, true)
        .getSignal(candles, 1, 0.025, 0.025, [], [childWith(MEAN, VARIANCE)]);
    assert.ok(r && !r.error);
    const feats = readLatestFeatures(dir, 'FE');
    assert.ok(Array.isArray(feats));
    // cacheSize 120 -> inputSize 30 (6 indicators x 5 candles).
    assert.equal(feats.length, 30, `feature length ${feats.length}`);
    assert.ok(feats.every((v) => v >= 0 && v <= 1), JSON.stringify(feats));
});
