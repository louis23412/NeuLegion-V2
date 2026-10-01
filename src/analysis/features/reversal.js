// src/analysis/features/reversal.js (round-102 split of src/analysis/features.js).
// The opt-in short-horizon reversal family (round 29 -> 30, P3).
import { meanOf, varianceOf } from './base.js';
// ---- short-horizon reversal (round 29 -> 30, P3) ---------------------------
//
// `2608.21888` documents significant 15-minute DIRECTIONAL reversal in ~90 % of
// 183 Binance pairs (vs 2.7 % of US equities), in every coin-year since 2021, and
// the edge lives in SIGNS rather than magnitudes. The project's own 1h data has
// lag-1 autocorrelation -0.013 and a `sig:autocorr` arm that fails the gate, so
// the hypothesis must be tested at a SHORTER bar interval — these are the
// point-in-time reversal primitives for that test.
//
// The sign reversal is `-r[t]` (minus the last bar's return). The shared z-score
// pipeline already normalises by the feature's own trailing dispersion, so
// `reversal` is a magnitude-normalised primitive; `reversalVol` additionally
// divides by the trailing realised volatility, so a large move in a calm regime
// is weighted above the same move in a volatile one.

// Sign reversal: minus the last bar's return.
export function reversal(series, t) {
    const r = series.returns;
    if (!r || t < 1) return NaN;
    return Number.isFinite(r[t]) ? -r[t] : NaN;
}

// Multi-bar reversal: minus the mean return over the trailing `window` bars.
export function reversalWindow(series, t, { window = 4 } = {}) {
    const m = meanOf(series.returns, t - window + 1, t);
    return Number.isFinite(m) ? -m : NaN;
}

// Volatility-scaled reversal: minus the last bar's return divided by the trailing
// realised volatility (std of returns over `window` bars, EXCLUDING t so the
// scale is causal and is not driven by the move it is scaling).
export function reversalVol(series, t, { window = 16 } = {}) {
    const r = series.returns;
    if (!r || t < 2) return NaN;
    const v = r[t];
    if (!Number.isFinite(v)) return NaN;
    const varw = varianceOf(r, t - window, t - 1);
    if (!Number.isFinite(varw) || !(varw > 0)) return NaN;
    return -v / Math.sqrt(varw);
}

// Cross-sectional reversal: minus the last bar's return NET of the cross-section
// mean, so the position is a bet against THIS stream's relative move rather than
// against the whole market. Reads `series.panel` (the other streams' aligned
// returns), which the driver attaches to the view; abstains (NaN -> position 0)
// when there is no panel (a single-stream run) or fewer than two live streams.
export function crossSectionalReversal(series, t) {
    const p = series.panel;
    const r = series.returns;
    if (!p || !Array.isArray(p.returnsByStream) || !r) return NaN;
    const mine = r[t];
    if (!Number.isFinite(mine)) return NaN;
    let sum = 0;
    let n = 0;
    for (const rs of p.returnsByStream) {
        const v = rs ? rs[t] : NaN;
        if (Number.isFinite(v)) { sum += v; n += 1; }
    }
    if (n < 2) return NaN;
    return -(mine - sum / n);
}


// The short-horizon reversal family (round 29 -> 30, P3). OPT-IN, deliberately
// NOT part of `SIGNAL_CANDIDATES`: this is a new *hypothesis* (a documented
// short-horizon effect at a new bar interval) rather than another member of the
// shipped 1h feature family, and putting it in the default roster would enlarge
// `K` for every existing run and move every deflated Sharpe. The driver exposes
// it as `REVERSAL_VARIANTS` (`--variants=sig-reversal,...`), so the default
// trajectory and every golden fingerprint are untouched.
export const REVERSAL_CANDIDATES = Object.freeze([
    {
        id: 'sig-reversal', label: 'sig:reversal', kind: 'signal', fn: reversal, window: 1,
        crossSectional: false,
        note: 'sign reversal: minus the last bar\'s return (the documented 15m directional-reversal primitive, 2608.21888)',
    },
    {
        id: 'sig-reversal-4', label: 'sig:reversal-4', kind: 'signal', fn: reversalWindow, window: 4,
        crossSectional: false,
        note: 'minus the trailing 4-bar mean return (a slower short-horizon reversal)',
    },
    {
        id: 'sig-reversal-vol', label: 'sig:reversal-vol', kind: 'signal', fn: reversalVol, window: 16,
        crossSectional: false,
        note: 'minus the last bar\'s return divided by the trailing 16-bar realised volatility (volatility-scaled reversal)',
    },
    {
        id: 'sig-reversal-xs', label: 'sig:reversal-xs', kind: 'signal', fn: crossSectionalReversal, window: 1,
        crossSectional: true,
        note: 'cross-sectional reversal: minus the last bar\'s return net of the cross-section mean (a bet against this stream\'s relative move)',
    },
]);

