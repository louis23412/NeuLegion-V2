// Labelling for financial machine learning.
//
// Fixed-horizon returns ignore path: a position can be stopped out long before
// the horizon ends, so the label should be "which barrier was touched first".
// This module provides the three Lopez de Prado primitives:
//   - triple-barrier labels (profit-take / stop-loss / vertical),
//   - the symmetric CUSUM event filter (sample on meaningful moves),
//   - fractional differentiation (stationarity that preserves memory).
//
// Pure: no I/O, no RNG.

// Triple-barrier labels.
//   prices      — array of prices (e.g. closes)
//   events      — indices at which to open a "bet" (default: every index)
//   ptSl        — [profitTakeMult, stopLossMult] in units of `vol`
//   vol         — per-event volatility scale; number, array, or fn(i)->number
//   maxHolding  — vertical barrier length (in observations)
// Returns [{ event, t1, label, ret }] where label in {1, -1, 0}:
//   1 = profit-take touched first, -1 = stop-loss first, 0 = vertical barrier.
export function tripleBarrierLabels({ prices, events = null, ptSl = [1, 1], vol = 1, maxHolding = 10 } = {}) {
    const n = prices.length;
    if (!(n > 0)) return [];
    const evs = events || Array.from({ length: n }, (_, i) => i);
    const volAt = typeof vol === 'function' ? vol
        : Array.isArray(vol) ? (i) => vol[i]
            : () => vol;
    const [ptMult, slMult] = ptSl;

    const out = [];
    for (const e of evs) {
        if (e < 0 || e >= n) continue;
        const entry = prices[e];
        const v = volAt(e);
        const ptLevel = entry + ptMult * v;
        const slLevel = entry - slMult * v;
        const t1 = Math.min(n - 1, e + maxHolding);
        let label = 0;
        let touched = t1;
        for (let t = e + 1; t <= t1; t++) {
            const p = prices[t];
            if (p >= ptLevel) { label = 1; touched = t; break; }
            if (p <= slLevel) { label = -1; touched = t; break; }
        }
        out.push({ event: e, t1: touched, label, ret: prices[touched] - entry });
    }
    return out;
}

// Symmetric CUSUM event filter. Emits non-overlapping event indices where the
// cumulative signed move exceeds +/- threshold. Higher threshold => fewer events.
export function cusumFilter({ prices, threshold, events = null } = {}) {
    const n = prices.length;
    if (!(n > 1)) return [];
    const out = [];
    let sPos = 0;
    let sNeg = 0;
    let lastEmit = -Infinity;
    for (let t = 1; t < n; t++) {
        const r = prices[t] - prices[t - 1];
        sPos = Math.max(0, sPos + r);
        sNeg = Math.min(0, sNeg + r);
        if (sPos > threshold || sNeg < -threshold) {
            if (t !== lastEmit) { out.push(t); lastEmit = t; }
            sPos = 0;
            sNeg = 0;
        }
    }
    return out;
}

// Fractional-differentiation weights (Lopez de Prado ch. 5).
//   w_0 = 1, w_k = w_{k-1} * (k - 1 - d) / k
// (the binomial expansion of (1 - x)^d, so d = 1 gives [1, -1, 0, ...]).
// `size > 0` truncates the window to that many weights; `size <= 0` uses
// DEFAULT_FD_WINDOW (the series must be truncated in practice — the exact
// binomial series converges far too slowly to be used untruncated).
export const DEFAULT_FD_WINDOW = 100;

export function fractionalDiffWeights(d, size = 0) {
    const w = [1];
    // Explicit size: exactly that many weights (trailing zeros kept, so the
    // d = 1 window is [1, -1, 0, ...]).
    if (size > 0) {
        for (let k = 1; k < size; k++) {
            const next = w[k - 1] * (k - 1 - d) / k;
            if (!Number.isFinite(next)) break;
            w.push(next);
        }
        return w;
    }
    // Auto: expand until the tail is negligible, capped at DEFAULT_FD_WINDOW.
    for (let k = 1; k < DEFAULT_FD_WINDOW; k++) {
        const next = w[k - 1] * (k - 1 - d) / k;
        if (!Number.isFinite(next) || Math.abs(next) < 1e-12) break;
        w.push(next);
    }
    return w;
}

// Apply fractional differentiation to a series. Returns an array the same length
// as `series`; positions before the window is full are NaN. The effective window
// is min(weights, series) so short series are still usable.
export function fractionalDiff(series, d, size = 0) {
    const w = fractionalDiffWeights(d, size);
    const width = Math.min(w.length, series.length);
    const out = new Array(series.length).fill(NaN);
    for (let t = width - 1; t < series.length; t++) {
        let acc = 0;
        for (let k = 0; k < width; k++) acc += w[k] * series[t - k];
        out[t] = acc;
    }
    return out;
}

// Convenience: fractionally-differenced log prices (memory-preserving stationarity).
export function fracDiffLogPrices(prices, d, size = 0) {
    return fractionalDiff(prices.map((p) => Math.log(p)), d, size);
}
