// node:test mirror of test/browser/entries/indicators.test.js.
//
// IndicatorProcessor is the hand-rolled candle -> feature extractor and had no
// direct tests before this file. It does not touch the database, so this suite
// runs with plain node:test and the shared helpers only.
//
//   npm test            # runs test/node/*.test.js
//
// NOTE: the development sandbox has no Node, so this file is not executed there.
// It is derived from the browser suite, which IS executed headlessly and is the
// authoritative check; keep the two in sync.

import test from 'node:test';
import assert from 'node:assert/strict';
import IndicatorProcessor from '../../src/hivemind/indicatorProcessor.js';
import { makeCandles, mulberry32 } from './helpers.js';

const BASE_TS = Date.parse('2024-01-01T00:00:00Z');
const ts = (i) => new Date(BASE_TS + i * 60000).toISOString();

function flatCandles(n, price = 100) {
    return Array.from({ length: n }, (_, i) => ({
        timestamp: ts(i), open: price, high: price, low: price, close: price, volume: 1000,
    }));
}

function monotonicCandles(n, from, step, { closeIsHigh = false, closeIsLow = false } = {}) {
    return Array.from({ length: n }, (_, i) => {
        const c = from + i * step;
        return { timestamp: ts(i), open: c, high: closeIsHigh ? c : c + 1, low: closeIsLow ? c : c - 1, close: c, volume: 1000 };
    });
}

function refRSILast(values, period = 14) {
    const n = values.length;
    if (n < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) { const d = values[i] - values[i - 1]; gains += d > 0 ? d : 0; losses += d < 0 ? -d : 0; }
    let ag = gains / period, al = losses / period, last = 50;
    for (let i = period; i < n; i++) {
        const d = values[i] - values[i - 1];
        ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
        al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
        last = al <= 0 ? (ag <= 0 ? 50 : 100) : 100 - 100 / (1 + ag / al);
    }
    return last;
}

function refATRLast(high, low, close, period = 14) {
    const tr = [];
    for (let i = 1; i < close.length; i++) tr.push(Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1])));
    let v = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < tr.length; i++) v = (v * (period - 1) + tr[i]) / period;
    return v;
}

function refWilliamsLast(high, low, close, period = 14) {
    const n = high.length;
    const hi = Math.max(...high.slice(n - period));
    const lo = Math.min(...low.slice(n - period));
    const denom = hi - lo;
    const r = denom > 0 ? ((hi - close[n - 1]) / denom) * -100 : -50;
    return Math.min(Math.max(r, -100), 0);
}

function refBollingerPBLast(close, period = 20, mult = 2) {
    const w = close.slice(-period);
    const sma = w.reduce((a, b) => a + b, 0) / period;
    const variance = w.reduce((a, v) => a + Math.pow(v - sma, 2), 0) / period;
    const sd = Math.sqrt(variance);
    const upper = sma + mult * sd, lower = sma - mult * sd;
    const denom = upper - lower;
    return denom > 0 ? (close[close.length - 1] - lower) / denom : 0.5;
}

const LEN_KEYS = { rsi: (n) => n - 14, macdDiff: (n) => n - 17, atr: (n) => n - 14, ema100: (n) => n, stochasticDiff: (n) => n - 15, bollingerPercentB: (n) => n - 19, obv: (n) => n, adx: (n) => n - 14, cci: (n) => n - 19, williamsR: (n) => n - 13 };
const RANGES = {
    rsi: [0, 100], macdDiff: [-1e9, 1e9], atr: [0, 1000], ema100: [-1e9, 1e9],
    stochasticDiff: [-100, 100], obv: [-1e9, 1e9], adx: [0, 100], cci: [-1000, 1000], williamsR: [-100, 0],
};

test('guards: rejects non-array / too-short / all-invalid feeds', () => {
    const ip = new IndicatorProcessor();
    assert.equal(ip.compute('nope').error, true);
    assert.equal(ip.compute(null).error, true);
    assert.equal(ip.compute([]).error, true);
    assert.equal(ip.compute(flatCandles(10)).error, true);
    assert.notEqual(ip.compute(flatCandles(11)).error, true);
    const junk = Array.from({ length: 30 }, () => ({ timestamp: '', close: NaN, high: 1, low: 1, volume: 1 }));
    assert.equal(ip.compute(junk).error, true);
    const r = ip.compute(flatCandles(125));
    assert.equal(r.error, undefined);
    assert.ok(!('success' in r));
});

test('junk rows are filtered and do not change the features', () => {
    const ip = new IndicatorProcessor();
    const clean = makeCandles(125, { seed: 5, trend: 0.002, vol: 1 });
    const dirty = [];
    for (let i = 0; i < clean.length; i++) {
        if (i % 7 === 3) dirty.push({ timestamp: '', close: NaN, high: undefined, low: 'x', volume: -1 });
        dirty.push(clean[i]);
    }
    const a = ip.compute(clean), b = ip.compute(dirty);
    for (const k of Object.keys(LEN_KEYS)) {
        assert.equal(a[k].length, b[k].length, `${k} length`);
        for (let i = 0; i < a[k].length; i++) assert.ok(Object.is(a[k][i], b[k][i]), `${k}[${i}]`);
    }
});

test('output lengths match window formulas (MACD needs n>=26)', () => {
    const ip = new IndicatorProcessor();
    for (const n of [26, 60, 125, 260]) {
        const r = ip.compute(makeCandles(n, { seed: n, trend: 0.001 }));
        for (const [k, f] of Object.entries(LEN_KEYS)) assert.equal(r[k].length, f(n), `${k} @ n=${n}`);
    }
    // Guard inconsistency: MACD requires 26 candles though its recurrences only
    // need 22, so 22..25 produce max(0, n-25) entries (0 for the whole range).
    assert.equal(ip.compute(makeCandles(25, { seed: 7 })).macdDiff.length, 0);
    assert.equal(ip.compute(makeCandles(26, { seed: 7 })).macdDiff.length, 9);
});

test('all outputs finite and within documented ranges (%B is unclamped)', () => {
    const ip = new IndicatorProcessor();
    const r = ip.compute(makeCandles(300, { seed: 9, trend: 0.003, vol: 1.5 }));
    for (const k of Object.keys(LEN_KEYS)) {
        assert.ok(r[k].every(Number.isFinite), `${k} finite`);
        if (RANGES[k]) {
            const [lo, hi] = RANGES[k];
            for (const v of r[k]) assert.ok(v >= lo - 1e-9 && v <= hi + 1e-9, `${k}=${v} outside [${lo},${hi}]`);
        }
    }
    // %B can leave [0,1] by design (population stddev bands).
    for (const v of r.bollingerPercentB) assert.ok(v >= -10 && v <= 10, `pb=${v}`);
});

test('flat series has closed-form indicator values', () => {
    const ip = new IndicatorProcessor();
    const r = ip.compute(flatCandles(125, 100));
    const last = (k) => r[k][r[k].length - 1];
    assert.equal(last('rsi'), 50);
    assert.ok(Math.abs(last('macdDiff')) < 1e-12);
    assert.equal(last('atr'), 0);
    assert.equal(last('ema100'), 100);
    assert.equal(last('stochasticDiff'), 0);
    assert.equal(last('bollingerPercentB'), 0.5);
    assert.equal(last('obv'), 0);
    assert.equal(last('adx'), 50);
    assert.equal(last('cci'), 0);
    assert.equal(last('williamsR'), -50);
    assert.equal(r.lastClose, 100);
    assert.equal(r.lastAtr, 0);
});

test('monotonic series saturates RSI/Williams and orients OBV', () => {
    const ip = new IndicatorProcessor();
    const up = ip.compute(monotonicCandles(125, 100, 0.7, { closeIsHigh: true }));
    const down = ip.compute(monotonicCandles(125, 200, -0.7, { closeIsLow: true }));
    assert.equal(up.rsi[up.rsi.length - 1], 100);
    assert.equal(down.rsi[down.rsi.length - 1], 0);
    assert.ok(Math.abs(up.williamsR[up.williamsR.length - 1]) < 1e-9);
    assert.ok(Math.abs(down.williamsR[down.williamsR.length - 1] + 100) < 1e-9);
    assert.ok(up.obv[up.obv.length - 1] > 0);
    assert.ok(down.obv[down.obv.length - 1] < 0);
});

test('every series is end-aligned to the most recent candle', () => {
    const ip = new IndicatorProcessor();
    for (const seed of [3, 17, 42]) {
        const c = makeCandles(160, { seed, trend: 0.0015, vol: 1.3 });
        const close = c.map((x) => x.close), high = c.map((x) => x.high), low = c.map((x) => x.low);
        const r = ip.compute(c);
        const last = (k) => r[k][r[k].length - 1];
        assert.ok(Math.abs(last('rsi') - refRSILast(close)) < 1e-9, `rsi seed ${seed}`);
        assert.ok(Math.abs(last('atr') - refATRLast(high, low, close)) < 1e-9, `atr seed ${seed}`);
        assert.ok(Math.abs(last('williamsR') - refWilliamsLast(high, low, close)) < 1e-9, `williamsR seed ${seed}`);
        assert.ok(Math.abs(last('bollingerPercentB') - refBollingerPBLast(close)) < 1e-9, `%B seed ${seed}`);
    }
});

test('appending a bar leaves earlier windowed outputs untouched', () => {
    const ip = new IndicatorProcessor();
    const base = makeCandles(80, { seed: 11, trend: 0.001, vol: 1 });
    const lastC = base[base.length - 1];
    const shifted = [...base, { ...lastC, timestamp: ts(80), close: lastC.close * 1.5, high: lastC.high * 1.5, low: lastC.low * 1.5 }];
    const a = ip.compute(base), b = ip.compute(shifted);
    for (const k of ['rsi', 'atr', 'williamsR', 'cci', 'bollingerPercentB', 'obv']) {
        assert.equal(b[k].length, a[k].length + 1, `${k} extended`);
        for (let i = 0; i < a[k].length; i++) assert.ok(Object.is(a[k][i], b[k][i]), `${k}[${i}]`);
    }
});

test('compute is deterministic and does not mutate its input', () => {
    const ip = new IndicatorProcessor();
    const c = makeCandles(120, { seed: 21, trend: 0.002, vol: 1.2 });
    const snapshot = JSON.stringify(c);
    const a = ip.compute(c);
    const b = ip.compute(c);
    assert.equal(JSON.stringify(c), snapshot);
    for (const k of Object.keys(LEN_KEYS)) {
        assert.equal(a[k].length, b[k].length);
        for (let i = 0; i < a[k].length; i++) assert.ok(Object.is(a[k][i], b[k][i]), `${k}[${i}]`);
    }
});

test('extreme but valid prices stay finite', () => {
    const ip = new IndicatorProcessor();
    for (const opts of [{ start: 1e9, trend: 0.01, vol: 1e6 }, { start: 0.5, trend: 0, vol: 1e-7 }]) {
        const r = ip.compute(makeCandles(60, { seed: 31, ...opts }));
        for (const k of Object.keys(LEN_KEYS)) assert.ok(r[k].every(Number.isFinite), `${k} finite`);
    }
});
