// Tier>1 feature-extraction suite for HiveMindController, executed inside a
// browser Worker via test/browser/harness.js.
//
// `#extractFeatures` has two branches. Tier 1 turns indicator series into the
// feature vector; tier > 1 turns *child* memory prototypes into the feature
// vector via #computeProtoQuality (sort), #robustNormalize (per-vector) and
// #interleave. The tier>1 branch had no direct test, and:
//   * #interleave was rewritten from an O(n^2) `.reduce`+`splice` to a single
//     O(n) pass;
//   * #robustNormalize / #computeProtoQuality previously rejected TypedArrays
//     (`Array.isArray`), silently producing all-zero vectors.
// This suite pins the exact emitted sequence and the plain-array == TypedArray
// equivalence.
//
// The controller writes the feature vector it actually used into
// `open_trades.features`, so the test reads it straight back out of the (sql.js
// shim) database. The shim keys databases by path, so a second connection to
// the same file sees the controller's rows.

import Database, { __ensureSql } from '../shims/better-sqlite3.js';
import HiveMindController from '../../../src/hivemind/hiveMindController.js';
import { truncateToDecimals } from '../../../src/hivemind/utils.js';

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

// Independent re-implementation of HiveMindController's private
// #robustNormalize (same contract: percentile bounds over the full series,
// normalise the trailing `count` values, clamp to [0,1], round to 4 dp).
function refRobustNormalize(data, count) {
    if (!Array.isArray(data) || data.length < 2) return Array(count).fill(0);
    const actualCount = Math.min(count, data.length);
    const vals = data.slice(-actualCount);
    const sorted = [...data].sort((a, b) => a - b);
    const lowerIdx = Math.floor(0.05 * sorted.length);
    const upperIdx = Math.ceil(0.95 * sorted.length) - 1;
    let min = sorted[lowerIdx];
    let max = sorted[upperIdx];
    min = Math.min(min, Math.min(...vals));
    max = Math.max(max, Math.max(...vals));
    if (max === min) {
        const median = sorted[Math.floor(sorted.length / 2)];
        const mad = sorted.reduce((s, v) => s + Math.abs(v - median), 0) / sorted.length;
        const scale = mad > 0 ? mad : Number.EPSILON * 1e6;
        min = median - scale;
        max = median + scale;
    }
    return vals.map((v) => truncateToDecimals(Math.min(1, Math.max(0, (v - min) / (max - min))), 4));
}

function readLatestFeatures(dbPath) {
    const db = new Database(dbPath);
    const row = db.prepare('SELECT features FROM open_trades ORDER BY rowid DESC LIMIT 1').get();
    return row ? JSON.parse(row.features) : null;
}

const PRICE = { atrFactor: 2, stopFactor: 1, minPriceMovement: 0.0025, maxPriceMovement: 0.05 };

// Distinct, non-arithmetic sequences so the interleaved order is observable.
const MEAN = [0, 1, 2, 3, 4, 5, 6, 7];
const VARIANCE = [1, 2, 4, 8, 16, 32, 64, 128];
const MEM_META = { size: 12, accessCount: 7, importance: 1.5 };

function childWith(mean, variance) {
    return { memories: [{ mean, variance, ...MEM_META }] };
}

export async function run() {
    await __ensureSql();
    const checks = [];
    const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });

    const candles = makeCandles(200, { seed: 13, trend: 0.0003, vol: 0.9 });

    const nm = refRobustNormalize(MEAN, MEAN.length);
    const nv = refRobustNormalize(VARIANCE, VARIANCE.length);
    // #interleave(normMean, normVariance) must emit
    // [mean0, var0, mean1, var1, ...], sliced and padded to inputSize (=10 for
    // tier 2, cacheSize 40).
    const expected = [];
    for (let i = 0; i < 10; i++) expected.push(i % 2 === 0 ? nm[i / 2] : nv[(i - 1) / 2]);

    // ---- A. plain-array child memory (production shape) ----------------------
    const DB_A = 'state/feat/hivemind_controller-positive-FA.db';
    let sigA = null;
    let featsA = null;
    try {
        const c = new HiveMindController('FA', 'state/feat', 40, 4, 'positive', 2, PRICE, true);
        sigA = c.getSignal(candles, 1, 0.025, 0.025, [], [childWith(MEAN, VARIANCE)]);
        featsA = readLatestFeatures(DB_A);
    } catch (e) {
        check('tier>1 getSignal runs', false, e.stack);
    }

    check('tier>1 getSignal returns a signal', sigA && !sigA.error, JSON.stringify(sigA && sigA.error));
    check('tier>1 features were persisted', Array.isArray(featsA), String(featsA));

    if (Array.isArray(featsA)) {
        check('tier>1 feature vector length equals inputSize (10)', featsA.length === 10, `len=${featsA.length}`);
        check('tier>1 features are finite numbers', featsA.every((v) => typeof v === 'number' && Number.isFinite(v)), JSON.stringify(featsA));

        let mismatch = -1;
        for (let i = 0; i < expected.length; i++) {
            if (!Object.is(featsA[i], expected[i])) { mismatch = i; break; }
        }
        check('tier>1 features match interleave(normMean, normVariance)', mismatch === -1,
            mismatch === -1 ? '' : `idx ${mismatch}: got ${featsA[mismatch]} want ${expected[mismatch]}`);
        check('tier>1 interleave is not a plain concatenation',
            !(Object.is(featsA[0], nm[0]) && Object.is(featsA[1], nm[1]) && Object.is(featsA[2], nm[2])),
            JSON.stringify(featsA.slice(0, 3)));
        check('tier>1 features stay inside [0,1]', featsA.every((v) => v >= 0 && v <= 1), JSON.stringify(featsA));
        check('tier>1 feature vector is not all-zero (TypedArray guard regressed?)',
            featsA.some((v) => v !== 0), JSON.stringify(featsA));
    }

    // ---- B. TypedArray child memory is equivalent to plain arrays -----------
    const DB_B = 'state/feat/hivemind_controller-positive-FB.db';
    let featsB = null;
    try {
        const c = new HiveMindController('FB', 'state/feat', 40, 4, 'positive', 2, PRICE, true);
        const r = c.getSignal(candles, 1, 0.025, 0.025, [],
            [childWith(Float32Array.from(MEAN), Float32Array.from(VARIANCE))]);
        if (r && !r.error) featsB = readLatestFeatures(DB_B);
    } catch (e) {
        check('tier>1 TypedArray getSignal runs', false, e.stack);
    }
    check('tier>1 Float32Array memory yields the same features as plain arrays',
        Array.isArray(featsB) && Array.isArray(featsA) && featsB.length === featsA.length
            && featsB.every((v, i) => Object.is(v, featsA[i])),
        featsB ? JSON.stringify(featsB) : 'null');

    // ---- C. no child memories -> the vector is padded with 0.5 ---------------
    const DB_C = 'state/feat/hivemind_controller-positive-FC.db';
    let featsC = null;
    try {
        const c = new HiveMindController('FC', 'state/feat', 40, 4, 'positive', 2, PRICE, true);
        const r = c.getSignal(candles, 1, 0.025, 0.025, [], []);
        if (r && !r.error) featsC = readLatestFeatures(DB_C);
    } catch (e) {
        check('tier>1 empty-child getSignal runs', false, e.stack);
    }
    check('tier>1 with no child memories pads 0.5 to inputSize',
        Array.isArray(featsC) && featsC.length === 10 && featsC.every((v) => Object.is(v, 0.5)),
        JSON.stringify(featsC));

    // ---- D. tier 1 still takes the indicator path (regression) ---------------
    // cacheSize 120 -> desiredSize 30 -> most balanced factorisation is
    // 6 indicators x 5 candles, so inputSize (and the feature length) is 30.
    const DB_D = 'state/feat/hivemind_controller-positive-FD.db';
    let featsD = null;
    try {
        const c = new HiveMindController('FD', 'state/feat', 120, 4, 'positive', 1, PRICE, true);
        const r = c.getSignal(candles, 1, 0.025, 0.025, [], [childWith(MEAN, VARIANCE)]);
        if (r && !r.error) featsD = readLatestFeatures(DB_D);
    } catch (e) {
        check('tier1 getSignal runs', false, e.stack);
    }
    check('tier1 ignores child memories and yields inputSize features',
        Array.isArray(featsD) && featsD.length === 30 && featsD.every((v) => v >= 0 && v <= 1),
        featsD ? `len=${featsD.length}` : 'null');

    return { total: checks.length, failed: checks.filter((c) => !c.pass).length, failures: checks.filter((c) => !c.pass), checks };
}
