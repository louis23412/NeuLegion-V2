// The causal signal family for the walk-forward A/B (ROADMAP round 23, N1).
//
// Every feature here is a PURE, POINT-IN-TIME function of the series it is
// handed: `fn(series, t, params)` reads only indices <= t, and nothing in this
// module ever precomputes a whole-series array. A feature therefore cannot
// accidentally see the future, and `auditNoLookahead` run over the audited candle
// view (`analysis/world.js`) *proves* it: perturbing every bar after t must leave
// the position at t unchanged.
//
// A candidate turns a feature into a tradable position through one deterministic,
// parameter-free pipeline:
//
//   raw = fn(series, t, params)                       (point in time)
//   z   = (raw - mean(raw, last zWindow bars)) / std  (causal, sample stddev)
//   pos = clamp(z / saturation, -1, +1)               (0 while the window is not
//                                                      full, or std is 0)
//
// No fitted parameters, no state, no look-ahead: the same bar always yields the
// same position. That is what makes the family comparable under one family-wise
// gate (subsampling SPA / Romano-Wolf step-down) and one DSR floor, and it is why
// the A/B can treat "which feature family carries an edge" as a multiple-testing
// problem rather than a search over tunables.
//
// Round-23 context: `analyze.js` used to run its candidate family over the six
// *mechanism flags* only, so `K` was 7 and P3-1's stated "genuinely larger real
// feature family (fractionally-differenced momentum, volatility regime,
// volume/turnover)" was never actually built. This module is that family.
//
// Grounding: Lopez de Prado, AFML ch. 5 (fractional differentiation preserves
// memory while restoring stationarity), ch. 17 (feature families) and
// `docs/research/financial-validation.md`. The fractional-differencing weights are
// the proven `fractionalDiffWeights` from `labels.js`, not a re-derivation.

import { fractionalDiffWeights } from './labels.js';

export const DEFAULT_POSITION = Object.freeze({ saturation: 2, zWindow: 32, minObs: 8 });

// Bounded position from a z-score: saturates at +/-1 at `saturation` standard
// deviations, is exactly 0 for a non-finite input, and never leaves [-1, 1].
export function clampPosition(z, { saturation = DEFAULT_POSITION.saturation } = {}) {
    if (!Number.isFinite(z) || !(saturation > 0)) return 0;
    const p = z / saturation;
    return p < -1 ? -1 : p > 1 ? 1 : p;
}

const finiteSum = (s, a, b) => {
    if (!s || a < 0) return NaN;
    let acc = 0;
    for (let i = a; i <= b; i++) {
        if (!Number.isFinite(s[i])) return NaN;
        acc += s[i];
    }
    return acc;
};

const meanOf = (s, a, b) => {
    if (!s || a < 0 || b < a) return NaN;
    let acc = 0;
    for (let i = a; i <= b; i++) {
        if (!Number.isFinite(s[i])) return NaN;
        acc += s[i];
    }
    return acc / (b - a + 1);
};

// Sample variance of `s[a..b]`.
const varianceOf = (s, a, b) => {
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

// ---- the causal z-score pipeline ------------------------------------------

// Causal z-score of a point-in-time feature. `fn(series, i, params)` must read
// only indices <= i. Returns 0 (abstain) when the window is not yet populated,
// when fewer than `minObs` finite observations exist, or when the std is 0.
export function causalZScore(fn, series, t, {
    window = 32, zWindow = DEFAULT_POSITION.zWindow, minObs = DEFAULT_POSITION.minObs, params = null,
} = {}) {
    const args = { window, ...(params || {}) };
    const raw = fn(series, t, args);
    if (!Number.isFinite(raw)) return 0;
    const vals = [];
    for (let i = Math.max(0, t - zWindow + 1); i <= t; i++) {
        const v = fn(series, i, args);
        if (Number.isFinite(v)) vals.push(v);
    }
    if (vals.length < minObs) return 0;
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    let acc = 0;
    for (const v of vals) acc += (v - m) * (v - m);
    const std = Math.sqrt(acc / (vals.length - 1));
    if (!(std > 0)) return 0;
    return (raw - m) / std;
}

// The position one candidate takes at bar `t`.
export function positionAt(candidate, series, t) {
    const z = causalZScore(candidate.fn, series, t, {
        window: candidate.window,
        zWindow: candidate.zWindow == null ? DEFAULT_POSITION.zWindow : candidate.zWindow,
        minObs: candidate.minObs == null ? DEFAULT_POSITION.minObs : candidate.minObs,
        params: candidate.params || null,
    });
    return clampPosition(z, { saturation: candidate.saturation == null ? DEFAULT_POSITION.saturation : candidate.saturation });
}

// The `signal(view, test)` a candidate contributes to the A/B. Missing series
// (e.g. a returns-only view has no closes) make the feature abstain, never throw.
export const signalForCandidate = (candidate) => (view, test) => {
    const series = {
        closes: view && view.closes ? view.closes : null,
        returns: view && view.returns ? view.returns : null,
        volumes: view && view.volumes ? view.volumes : null,
    };
    return test.map((t) => positionAt(candidate, series, t));
};

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
