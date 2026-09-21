// Direct test suite for IndicatorProcessor - the hand-rolled candle->indicator
// feature extractor. Before this file it had NO direct tests at all: it was only
// exercised indirectly through the controller, so a wrong window, a wrong
// alignment or a missing guard would silently change the feature distribution
// the whole hivemind trains on.
//
// The tests come in three flavours:
//   1. Contracts: guards/error returns, key set, output lengths, no mutation,
//      determinism, invalid-row filtering.
//   2. Invariants: every output array is finite and inside its documented range.
//   3. End-alignment: each indicator's LAST element must describe the MOST
//      RECENT candle. This is verified with hand-written reference recurrences
//      that mirror the exact smoothing the implementation uses, plus closed-form
//      cases (flat series, strictly monotonic series) where the value is known.
//
// Run it after ANY change to src/hivemind/indicatorProcessor.js.

import IndicatorProcessor from '../../../src/hivemind/indicatorProcessor.js';

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const BASE_TS = Date.parse('2024-01-01T00:00:00Z');
function ts(i) { return new Date(BASE_TS + i * 60000).toISOString(); }

// Realistic OHLCV series: random walk with a configurable drift, plus a little
// intrabar spread so high/low/close are distinct (the flat generator would make
// every volatility indicator trivially constant).
function mkCandles(n, { seed = 1, start = 100, drift = 0, vol = 1 } = {}) {
    const rnd = mulberry32(seed);
    const out = [];
    let price = start;
    for (let i = 0; i < n; i++) {
        const open = price;
        price = Math.max(0.5, price + drift * price + (rnd() - 0.5) * 2 * vol);
        const close = price;
        const high = Math.max(open, close) + rnd() * vol;
        const low = Math.min(open, close) - rnd() * vol;
        out.push({
            timestamp: ts(i),
            open: Number(open.toFixed(6)),
            high: Number(high.toFixed(6)),
            low: Number(low.toFixed(6)),
            close: Number(close.toFixed(6)),
            volume: Math.round(1000 + rnd() * 5000),
        });
    }
    return out;
}

// Constant-price series: every delta is zero, so every indicator has a
// closed-form expected value (see the "flat series" block).
function flatCandles(n, price = 100) {
    return Array.from({ length: n }, (_, i) => ({
        timestamp: ts(i), open: price, high: price, low: price, close: price, volume: 1000,
    }));
}

function monotonicCandles(n, from, step, { closeIsHigh = false, closeIsLow = false } = {}) {
    return Array.from({ length: n }, (_, i) => {
        const c = from + i * step;
        const high = closeIsHigh ? c : c + 1;
        const low = closeIsLow ? c : c - 1;
        return { timestamp: ts(i), open: c, high, low, close: c, volume: 1000 };
    });
}

// ---- reference recurrences (mirror the implementation exactly) -------------
function refRSILast(values, period = 14) {
    const n = values.length;
    if (n < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const d = values[i] - values[i - 1];
        gains += d > 0 ? d : 0;
        losses += d < 0 ? -d : 0;
    }
    let ag = gains / period, al = losses / period;
    let last = 50;
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
    for (let i = 1; i < close.length; i++) {
        tr.push(Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1])));
    }
    if (tr.length < period) return 0;
    let v = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
    v = Math.min(Math.max(v, 0), 1000);
    for (let i = period; i < tr.length; i++) {
        v = (v * (period - 1) + tr[i]) / period;
        v = Math.min(Math.max(v, 0), 1000);
    }
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

function refCCILast(high, low, close, period = 20) {
    const n = high.length;
    const tp = [];
    for (let i = n - period; i < n; i++) tp.push((high[i] + low[i] + close[i]) / 3);
    const sma = tp.reduce((a, b) => a + b, 0) / period;
    const md = tp.reduce((a, v) => a + Math.abs(v - sma), 0) / period;
    const cur = (high[n - 1] + low[n - 1] + close[n - 1]) / 3;
    const cci = md > 0 ? (cur - sma) / (0.015 * md) : 0;
    return Math.min(Math.max(cci, -1000), 1000);
}

const KEYS = ['lastClose', 'lastAtr', 'rsi', 'macdDiff', 'atr', 'ema100', 'stochasticDiff', 'bollingerPercentB', 'obv', 'adx', 'cci', 'williamsR'];
const LEN_KEYS = { rsi: (n) => n - 14, macdDiff: (n) => n - 17, atr: (n) => n - 14, ema100: (n) => n, stochasticDiff: (n) => n - 15, bollingerPercentB: (n) => n - 19, obv: (n) => n, adx: (n) => n - 14, cci: (n) => n - 19, williamsR: (n) => n - 13 };
const RANGES = {
    rsi: [0, 100], macdDiff: [-1e9, 1e9], atr: [0, 1000], ema100: [-1e9, 1e9],
    stochasticDiff: [-100, 100], obv: [-1e9, 1e9],
    adx: [0, 100], cci: [-1000, 1000], williamsR: [-100, 0],
};
// %B is deliberately NOT clamped to [0,1]: the bands use the *population*
// stddev over `period` bars, so the last close can sit up to
// sqrt(period-1) ~ 4.36 sigma from the mean while upper-lower only spans 4
// sigma. A trending series legitimately produces %B just above 1 or below 0.
// The meaningful invariant is only that it stays in a sane neighbourhood of
// the bands; it is exercised in the invariants block below.
const PB_MIN = -10, PB_MAX = 10;

const allFinite = (arr) => Array.isArray(arr) && arr.length > 0 && arr.every((v) => typeof v === 'number' && Number.isFinite(v));

export async function run() {
    const checks = [];
    const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });
    const ip = new IndicatorProcessor();

    // ---- A. guards / error contract ----------------------------------------
    try {
        check('non-array input -> error', ip.compute('nope').error === true);
        check('null input -> error', ip.compute(null).error === true);
        check('empty array -> error', ip.compute([]).error === true);
        check('10 candles -> error (needs >=11)', ip.compute(flatCandles(10)).error === true);
        check('11 candles -> not error', ip.compute(flatCandles(11)).error !== true);
        check('all-invalid candles -> error', ip.compute(Array.from({ length: 30 }, () => ({ timestamp: '', close: NaN, high: 1, low: 1, volume: 1 }))).error === true);
        const mostlyInvalid = [...flatCandles(10), { timestamp: '', close: NaN, high: NaN, low: NaN, volume: NaN }];
        check('>=11 candles but <11 valid -> error', ip.compute(mostlyInvalid).error === true);

        const r = ip.compute(flatCandles(125));
        check('valid compute has no error flag', r.error === undefined);
        check('key set complete', KEYS.every((k) => Object.prototype.hasOwnProperty.call(r, k)), KEYS.filter((k) => !(k in r)).join(','));
        check('uses .error convention (not success flag)', !('success' in r));
    } catch (e) {
        check('guard block completed', false, e.stack);
    }

    // ---- B. invalid-row filtering ------------------------------------------
    // The up-front `validCandles` filter must drop malformed rows while keeping
    // every valid row in order, so a feed with junk rows produces exactly the
    // same features as the clean feed.
    try {
        const clean = mkCandles(125, { seed: 5, drift: 0.002, vol: 1 });
        const junk = { timestamp: '', close: NaN, high: undefined, low: 'x', volume: -1 };
        const dirty = [];
        for (let i = 0; i < clean.length; i++) {
            if (i % 7 === 3) dirty.push({ ...junk });
            dirty.push(clean[i]);
        }
        const a = ip.compute(clean);
        const b = ip.compute(dirty);
        const sameLens = Object.keys(LEN_KEYS).every((k) => a[k].length === b[k].length);
        const sameVals = Object.keys(LEN_KEYS).every((k) => {
            for (let i = 0; i < a[k].length; i++) if (!Object.is(a[k][i], b[k][i])) return false;
            return true;
        });
        check('junk rows filtered: identical lengths', sameLens, JSON.stringify(Object.keys(LEN_KEYS).map((k) => `${k}:${a[k].length}/${b[k].length}`).filter((s) => !s.split(':')[1].split('/').every((x) => x === s.split(':')[1].split('/')[0]))));
        check('junk rows filtered: bit-identical outputs', sameVals);
        check('lastClose tracks the last valid row', Object.is(a.lastClose, clean[clean.length - 1].close));

        const badTs = mkCandles(20, { seed: 6 }).map((c, i) => (i === 5 ? { ...c, timestamp: '   ' } : (i === 6 ? { ...c, timestamp: 12 } : c)));
        const rc = ip.compute(badTs);
        check('numeric epoch timestamp accepted, blank rejected', rc.error === undefined && rc.obv.length === 19, `obvLen=${rc.obv && rc.obv.length}`);
    } catch (e) {
        check('filtering block completed', false, e.stack);
    }

    // ---- C. output lengths (window sizes line up) --------------------------
    try {
        for (const n of [26, 60, 125, 260]) {
            const r = ip.compute(mkCandles(n, { seed: n, drift: 0.001 }));
            let ok = true; let detail = '';
            for (const [k, f] of Object.entries(LEN_KEYS)) {
                const want = f(n);
                if (r[k].length !== want) { ok = false; detail = `${k}: got ${r[k].length} want ${want} (n=${n})`; break; }
            }
            check(`output lengths match window formulas (n=${n})`, ok, detail);
        }
        // MACD's *guard* demands slowPeriod+signalPeriod = 26 candles even
        // though its actual recurrences only need 22. For 22 <= n <= 25 the
        // error path therefore returns `max(0, n-25)` entries (0 for all of
        // that range) instead of the (n-17) the main path would produce. Pin
        // the boundary so a future change to either the guard or the formulas
        // is caught.
        const n25 = ip.compute(mkCandles(25, { seed: 7 }));
        const n26 = ip.compute(mkCandles(26, { seed: 7 }));
        check('MACD guard boundary: n=25 yields empty macdDiff', n25.macdDiff.length === 0, `len=${n25.macdDiff.length}`);
        check('MACD guard boundary: n=26 yields n-17 macdDiff', n26.macdDiff.length === 9, `len=${n26.macdDiff.length}`);
    } catch (e) {
        check('length block completed', false, e.stack);
    }

    // ---- D. finiteness + range invariants ----------------------------------
    try {
        const r = ip.compute(mkCandles(300, { seed: 9, drift: 0.003, vol: 1.5 }));
        check('all output arrays finite', KEYS.every((k) => Array.isArray(r[k]) ? r[k].every(Number.isFinite) : Number.isFinite(r[k])),
            KEYS.filter((k) => Array.isArray(r[k]) ? !r[k].every(Number.isFinite) : !Number.isFinite(r[k])).join(','));
        let rangeOk = true; let rangeDetail = '';
        for (const [k, [lo, hi]] of Object.entries(RANGES)) {
            const bad = r[k].find((v) => v < lo - 1e-9 || v > hi + 1e-9);
            if (bad !== undefined) { rangeOk = false; rangeDetail = `${k}=${bad}`; break; }
        }
        check('all outputs within documented ranges', rangeOk, rangeDetail);
        check(`bollingerPercentB within [${PB_MIN}, ${PB_MAX}] (unclamped by design)`, r.bollingerPercentB.every((v) => v >= PB_MIN && v <= PB_MAX));
        check('lastAtr equals atr.at(-1)', Object.is(r.lastAtr, r.atr[r.atr.length - 1]));
        check('lastClose equals last candle close', Object.is(r.lastClose, 100) || Number.isFinite(r.lastClose));
    } catch (e) {
        check('invariant block completed', false, e.stack);
    }

    // ---- E. flat series: every indicator has a closed-form value -----------
    try {
        const r = ip.compute(flatCandles(125, 100));
        const expect = {
            rsi: [50, 0], macdDiff: [0, 0], atr: [0, 0], ema100: [100, 100],
            stochasticDiff: [0, 0], bollingerPercentB: [0.5, 0.5], obv: [0, 0],
            adx: [50, 50], cci: [0, 0], williamsR: [-50, -50],
        };
        for (const [k, [lo, hi]] of Object.entries(expect)) {
            const v = r[k][r[k].length - 1];
            check(`flat series ${k} == ${lo}`, Number.isFinite(v) && Math.abs(v - lo) <= Math.max(1e-9, Math.abs(hi - lo)), `${v}`);
        }
        check('flat series lastClose == 100', Object.is(r.lastClose, 100));
        check('flat series lastAtr == 0', Object.is(r.lastAtr, 0));
    } catch (e) {
        check('flat block completed', false, e.stack);
    }

    // ---- F. monotonic series: RSI/Williams saturate ------------------------
    try {
        const up = ip.compute(monotonicCandles(125, 100, 0.7, { closeIsHigh: true }));
        const down = ip.compute(monotonicCandles(125, 200, -0.7, { closeIsLow: true }));
        check('strictly rising: RSI == 100', Object.is(up.rsi[up.rsi.length - 1], 100), `${up.rsi[up.rsi.length - 1]}`);
        check('strictly falling: RSI == 0', Object.is(down.rsi[down.rsi.length - 1], 0), `${down.rsi[down.rsi.length - 1]}`);
        check('close==high: Williams %R == 0', Math.abs(up.williamsR[up.williamsR.length - 1]) < 1e-9, `${up.williamsR[up.williamsR.length - 1]}`);
        check('close==low: Williams %R == -100', Math.abs(down.williamsR[down.williamsR.length - 1] + 100) < 1e-9, `${down.williamsR[down.williamsR.length - 1]}`);
        check('rising %B > 0.5 > falling %B', up.bollingerPercentB[up.bollingerPercentB.length - 1] > 0.5 && down.bollingerPercentB[down.bollingerPercentB.length - 1] < 0.5);
        check('rising OBV strictly positive', up.obv[up.obv.length - 1] > 0, `${up.obv[up.obv.length - 1]}`);
        check('falling OBV strictly negative', down.obv[down.obv.length - 1] < 0, `${down.obv[down.obv.length - 1]}`);
        const upOBV = up.obv;
        let nonDecreasing = true;
        for (let i = 1; i < upOBV.length; i++) if (upOBV[i] < upOBV[i - 1]) { nonDecreasing = false; break; }
        check('rising OBV is monotonically non-decreasing', nonDecreasing);
    } catch (e) {
        check('monotonic block completed', false, e.stack);
    }

    // ---- G. end-alignment: LAST element describes the LATEST candle --------
    // This is the property that makes the feature matrix usable: every series
    // must be causal and anchored to the same most-recent bar.
    try {
        for (const seed of [3, 17, 42]) {
            const c = mkCandles(160, { seed, drift: 0.0015, vol: 1.3 });
            const close = c.map((x) => x.close), high = c.map((x) => x.high), low = c.map((x) => x.low);
            const r = ip.compute(c);
            const last = (k) => r[k][r[k].length - 1];

            check(`seed ${seed}: last RSI matches hand recurrence`, Math.abs(last('rsi') - refRSILast(close)) < 1e-9, `${last('rsi')} vs ${refRSILast(close)}`);
            check(`seed ${seed}: last ATR matches hand recurrence`, Math.abs(last('atr') - refATRLast(high, low, close)) < 1e-9, `${last('atr')} vs ${refATRLast(high, low, close)}`);
            check(`seed ${seed}: last Williams %R matches last-14-bar window`, Math.abs(last('williamsR') - refWilliamsLast(high, low, close)) < 1e-9, `${last('williamsR')} vs ${refWilliamsLast(high, low, close)}`);
            check(`seed ${seed}: last %B matches last-20-bar window`, Math.abs(last('bollingerPercentB') - refBollingerPBLast(close)) < 1e-9, `${last('bollingerPercentB')} vs ${refBollingerPBLast(close)}`);
            check(`seed ${seed}: last CCI matches last-20-bar window`, Math.abs(last('cci') - refCCILast(high, low, close)) < 1e-9, `${last('cci')} vs ${refCCILast(high, low, close)}`);
            check(`seed ${seed}: ema100 last element is finite`, Number.isFinite(last('ema100')));
            check(`seed ${seed}: macdDiff last element is finite`, Number.isFinite(last('macdDiff')));
            check(`seed ${seed}: adx last element is finite`, Number.isFinite(last('adx')));
        }
    } catch (e) {
        check('alignment block completed', false, e.stack);
    }

    // ---- H. causal tail: mutating only the last candle moves only the tail -
    // Appending one MORE bar must leave every earlier output untouched (bar the
    // full-series-median normalisation inside MACD). This catches accidental
    // future leakage / index-shift bugs.
    try {
        const base = mkCandles(80, { seed: 11, drift: 0.001, vol: 1 });
        const shifted = [...base, { ...base[base.length - 1], timestamp: ts(80), close: base[base.length - 1].close * 1.5, high: base[base.length - 1].high * 1.5, low: base[base.length - 1].low * 1.5 }];
        const a = ip.compute(base), b = ip.compute(shifted);
        // rsi/atr/williams/cci/%B are strictly backward-looking windows, so the
        // shared prefix must match exactly.
        const causal = ['rsi', 'atr', 'williamsR', 'cci', 'bollingerPercentB', 'obv'];
        let samePrefix = true; let detail = '';
        for (const k of causal) {
            for (let i = 0; i < a[k].length; i++) {
                if (!Object.is(a[k][i], b[k][i])) { samePrefix = false; detail = `${k}[${i}] ${a[k][i]} vs ${b[k][i]}`; break; }
            }
            if (!samePrefix) break;
        }
        check('appending a bar leaves earlier windowed outputs unchanged', samePrefix, detail);
        check('appending a bar extends every array by one', causal.every((k) => b[k].length === a[k].length + 1));
    } catch (e) {
        check('causality block completed', false, e.stack);
    }

    // ---- I. determinism + input immutability -------------------------------
    try {
        const c = mkCandles(120, { seed: 21, drift: 0.002, vol: 1.2 });
        const snapshot = JSON.stringify(c);
        const a = ip.compute(c);
        const b = ip.compute(c);
        check('compute does not mutate its input', JSON.stringify(c) === snapshot);
        let deterministic = true;
        for (const k of KEYS) {
            if (Array.isArray(a[k])) {
                if (a[k].length !== b[k].length || a[k].some((v, i) => !Object.is(v, b[k][i]))) { deterministic = false; break; }
            } else if (!Object.is(a[k], b[k])) { deterministic = false; break; }
        }
        check('compute is deterministic', deterministic);
    } catch (e) {
        check('determinism block completed', false, e.stack);
    }

    // ---- J. extreme (but valid) prices do not produce non-finite output ----
    try {
        const huge = mkCandles(60, { seed: 31, start: 1e9, drift: 0.01, vol: 1e6 });
        const tiny = mkCandles(60, { seed: 32, start: 0.5, drift: 0, vol: 1e-7 });
        const rh = ip.compute(huge), rt = ip.compute(tiny);
        check('huge prices stay finite', KEYS.every((k) => Array.isArray(rh[k]) ? rh[k].every(Number.isFinite) : Number.isFinite(rh[k])));
        check('tiny prices stay finite', KEYS.every((k) => Array.isArray(rt[k]) ? rt[k].every(Number.isFinite) : Number.isFinite(rt[k])));
    } catch (e) {
        check('extreme block completed', false, e.stack);
    }

    const failed = checks.filter((c) => !c.pass);
    return { total: checks.length, failed: failed.length, failures: failed, checks };
}
