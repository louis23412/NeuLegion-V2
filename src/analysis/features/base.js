// src/analysis/features/base.js (round-102 split of src/analysis/features.js).
// The eight shipped point-in-time features + the default candidate table.
import { fractionalDiffWeights } from '../labels.js';

export const finiteSum = (s, a, b) => {
    if (!s || a < 0 || b < a) return NaN;
    let acc = 0;
    for (let i = a; i <= b; i++) {
        if (!Number.isFinite(s[i])) return NaN;
        acc += s[i];
    }
    return acc;
};

export const meanOf = (s, a, b) => {
    if (!s || a < 0 || b < a) return NaN;
    let acc = 0;
    for (let i = a; i <= b; i++) {
        if (!Number.isFinite(s[i])) return NaN;
        acc += s[i];
    }
    return acc / (b - a + 1);
};

// Sample variance of `s[a..b]`.
export const varianceOf = (s, a, b) => {
    if (!s || a < 0 || b <= a) return NaN;
    const n = b - a + 1;
    const m = meanOf(s, a, b);
    if (!Number.isFinite(m)) return NaN;
    let acc = 0;
    for (let i = a; i <= b; i++) acc += (s[i] - m) * (s[i] - m);
    return acc / (n - 1);
};


// ---- features (point-in-time; `series = { closes, returns, volumes }`) ------

// Trailing return momentum.
export function momentum(series, t, { window = 16 } = {}) {
    return finiteSum(series.returns, t - window + 1, t);
}

// The fractional difference of log price at bar t (causal by construction: the
// weights are a binomial series and every term reads `closes[t - k]`, k >= 0).
export function fracDiffAt(closes, t, { d = 0.4, window = 16 } = {}) {
    if (!closes || t < 0 || t >= closes.length) return NaN;
    const w = fractionalDiffWeights(d, window);
    let acc = 0;
    for (let k = 0; k < w.length; k++) {
        const i = t - k;
        if (i < 0) return NaN;
        acc += w[k] * Math.log(closes[i]);
    }
    return acc;
}

// Fractionally-differenced log-price momentum: the one-bar change of the
// memory-preserving FD series (AFML ch. 5).
export function fracMomentum(series, t, { window = 16, d = 0.4 } = {}) {
    const a = fracDiffAt(series.closes, t, { d, window });
    const b = fracDiffAt(series.closes, t - 1, { d, window });
    if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
    return a - b;
}

// Realised-volatility regime: short-window vol over long-window vol, minus 1.
// Positive means the short horizon is currently hotter than the long one.
export function volRegime(series, t, { window = 8, long = 32 } = {}) {
    const vShort = varianceOf(series.returns, t - window + 1, t);
    const vLong = varianceOf(series.returns, t - long + 1, t);
    if (!Number.isFinite(vShort) || !Number.isFinite(vLong) || !(vLong > 0)) return NaN;
    return Math.sqrt(vShort / vLong) - 1;
}

// Multi-horizon momentum sign agreement in [-1, 1].
export function momentumAgreement(series, t, { lenses = [4, 8, 16, 32] } = {}) {
    let acc = 0;
    let n = 0;
    for (const L of lenses) {
        const m = finiteSum(series.returns, t - L + 1, t);
        if (!Number.isFinite(m)) continue;
        acc += Math.sign(m);
        n++;
    }
    return n >= 2 ? acc / n : NaN;
}

// Where the close sits inside its trailing range, centred on 0.
export function rangeLocation(series, t, { window = 32 } = {}) {
    const c = series.closes;
    if (!c || t - window + 1 < 0) return NaN;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = t - window + 1; i <= t; i++) {
        if (!Number.isFinite(c[i])) return NaN;
        if (c[i] < lo) lo = c[i];
        if (c[i] > hi) hi = c[i];
    }
    if (!(hi > lo)) return NaN;
    return (c[t] - lo) / (hi - lo) - 0.5;
}

// Volume (turnover) imbalance: short- over long-window mean volume, minus 1.
export function volumeImbalance(series, t, { window = 8, long = 32 } = {}) {
    const v = series.volumes;
    if (!v || t - long + 1 < 0) return NaN;
    const sShort = meanOf(v, t - window + 1, t);
    const sLong = meanOf(v, t - long + 1, t);
    if (!Number.isFinite(sShort) || !Number.isFinite(sLong) || !(sLong > 0)) return NaN;
    return sShort / sLong - 1;
}

// Lag-1 autocorrelation of returns over the trailing window.
export function autocorr1(series, t, { window = 32 } = {}) {
    const r = series.returns;
    if (!r || t - window < 1) return NaN;
    const m = meanOf(r, t - window + 1, t);
    if (!Number.isFinite(m)) return NaN;
    let num = 0;
    let den = 0;
    for (let i = t - window + 1; i <= t; i++) {
        num += (r[i] - m) * (r[i - 1] - m);
        den += (r[i] - m) * (r[i] - m);
    }
    if (!(den > 0)) return NaN;
    return num / den;
}

// Momentum acceleration: the change in trailing momentum over one window.
export function acceleration(series, t, { window = 16 } = {}) {
    const now = finiteSum(series.returns, t - window + 1, t);
    const prev = finiteSum(series.returns, t - 2 * window + 1, t - window);
    if (!Number.isFinite(now) || !Number.isFinite(prev)) return NaN;
    return now - prev;
}


// ---- the family ------------------------------------------------------------

// The causal signal family. Each candidate is a pure feature plus its (fixed,
// documented) window. `kind: 'signal'` distinguishes these from the mechanism
// flags in `analyze.js#VARIANTS` in the A/B report.
export const SIGNAL_CANDIDATES = Object.freeze([
    {
        id: 'sig-momentum', label: 'sig:momentum', kind: 'signal', fn: momentum, window: 16,
        note: 'trailing 16-bar return momentum (the classic trend primitive)',
    },
    {
        id: 'sig-frac-momentum', label: 'sig:frac-momentum', kind: 'signal', fn: fracMomentum, window: 16, params: { d: 0.4 },
        note: 'one-bar change of the fractionally-differenced log price, d=0.4 (AFML ch. 5: stationary but memory-preserving)',
    },
    {
        id: 'sig-vol-regime', label: 'sig:vol-regime', kind: 'signal', fn: volRegime, window: 8, params: { long: 32 },
        note: 'realised-volatility regime: 8-bar vol / 32-bar vol - 1',
    },
    {
        id: 'sig-agreement', label: 'sig:agreement', kind: 'signal', fn: momentumAgreement, window: 32,
        note: 'momentum sign agreement across the 4/8/16/32-bar horizons',
    },
    {
        id: 'sig-range', label: 'sig:range', kind: 'signal', fn: rangeLocation, window: 32,
        note: 'close location within its 32-bar range, centred on 0',
    },
    {
        id: 'sig-volume', label: 'sig:volume', kind: 'signal', fn: volumeImbalance, window: 8, params: { long: 32 },
        note: 'volume imbalance: 8-bar over 32-bar mean volume - 1 (turnover regime)',
    },
    {
        id: 'sig-autocorr', label: 'sig:autocorr', kind: 'signal', fn: autocorr1, window: 32,
        note: 'lag-1 autocorrelation of returns over 32 bars (mean-reversion vs trend)',
    },
    {
        id: 'sig-accel', label: 'sig:acceleration', kind: 'signal', fn: acceleration, window: 16,
        note: 'momentum acceleration: 16-bar momentum change over one window',
    },
]);

