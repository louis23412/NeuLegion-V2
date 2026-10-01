// src/analysis/features/upgrades.js (round-102 split of src/analysis/features.js).
// Cross-sectional construction tools + the opt-in momentum upgrades (round 30 / round 45).
import { finiteSum, meanOf, varianceOf, momentum } from './base.js';
// ---- cross-sectional demean as a construction tool (round 45, lab R5) ------
//
// F-03: demeaning a signal across the basket collapses the panel's design
// effect (4.92 -> 0.39-0.60, effective streams 1.47 -> 14-19) without
// manufacturing edge (every demeaned momentum arm reads |Sharpe| <= 0.033 —
// F-07 — so this ports the TOOL, never a roster arm; K is untouched).
//
// `demeanedFn` scores ANY returns-computable feature net of the panel: the
// stream's own raw minus the masked cross-sectional mean of the same raw on
// every stream. Sibling streams are read through returns-only views (their
// closes/volumes are null, so a feature needing another stream's closes
// abstains there via the existing guards and is masked out — L10-r: absent
// symbols are excluded, never zero-filled). Fewer than 2 live values, a
// missing panel, or a missing streamIndex abstains (NaN), never throws.
// Point-in-time and causal: every read is at an index <= t, so the lab's
// perturbation audit applies unchanged.
//
// `xsMomentum` is the measured F-03 object (trailing momentum net of the
// panel mean), following the `crossSectionalReversal` precedent above.

// Masked cross-sectional mean: finite values only (L10-r); fewer than 2 live
// values is not a cross-section (NaN).
export function panelMean(valuesByStream) {
    if (!Array.isArray(valuesByStream)) return NaN;
    let sum = 0;
    let n = 0;
    for (const v of valuesByStream) {
        if (Number.isFinite(v)) { sum += v; n += 1; }
    }
    return n >= 2 ? sum / n : NaN;
}

// Any point-in-time feature scored net of its own panel cross-section.
export function demeanedFn(fn) {
    if (typeof fn !== 'function') throw new Error('demeanedFn: a feature function is required');
    return (series, t, params) => {
        const p = series ? series.panel : null;
        if (!p || !Array.isArray(p.returnsByStream)) return NaN;
        const k = p.returnsByStream.length;
        if (!Number.isInteger(p.streamIndex) || p.streamIndex < 0 || p.streamIndex >= k) return NaN;
        const raws = new Array(k);
        for (let i = 0; i < k; i++) {
            if (i === p.streamIndex) {
                raws[i] = fn(series, t, params);
            } else {
                const rs = p.returnsByStream[i];
                if (!rs) { raws[i] = NaN; continue; }
                raws[i] = fn({ returns: rs, closes: null, volumes: null, panel: null }, t, params);
            }
        }
        const mine = raws[p.streamIndex];
        if (!Number.isFinite(mine)) return NaN;
        const m = panelMean(raws);
        if (!Number.isFinite(m)) return NaN;
        return mine - m;
    };
}

// Trailing momentum net of the panel mean (the F-03 object): a bet on this
// stream's RELATIVE trend, approximately dollar-neutral across the basket by
// construction, reduced to a position by the standard z-score + clamp pipeline.
export function xsMomentum(series, t, { window = 16 } = {}) {
    return demeanedFn(momentum)(series, t, { window });
}

// ---- momentum upgrades (round 30, C-SIGUP / C-REGIME, gate G-H) ------------
//
// The research note (`docs/research/round30-winning-mechanisms.md` §1.2) fixes the
// pre-registered upgrade list for gate G-H: **volatility scaling** (the TSMOM
// standard, `1904.04912`), **multi-horizon blending** (`2112.08534`),
// **network/cross-sectional momentum** (a lead-lag panel signal, `2308.11294`) and
// a **causal regime/crash gate** (`2105.13727`, `2604.09060`). Each is a pure,
// point-in-time feature reduced to a position by the SAME z-score + clamp pipeline
// as the shipped family, so it is comparable under the one family-wise gate.
//
// They are OPT-IN (`SIGUP_CANDIDATES`): the default roster and every golden
// fingerprint are untouched, and the four branches are `UNTESTED` in the register
// until G-H measures them (`docs/LINEAGE.md` §3).
//
// Causality: every read is at an index <= t. `networkMomentum` is strictly LAGGED
// (`t - lag`), so it cannot read another stream's contemporaneous bar.

// Volatility-scaled momentum: trailing `window`-bar return divided by its realised
// volatility over the same window. A calm-regime move weighs above the same move in
// a hot regime (the TSMOM sizing standard).
export function volScaledMomentum(series, t, { window = 16 } = {}) {
    const m = finiteSum(series.returns, t - window + 1, t);
    const v = varianceOf(series.returns, t - window + 1, t);
    if (!Number.isFinite(m) || !Number.isFinite(v) || !(v > 0)) return NaN;
    return m / Math.sqrt(v);
}

// Multi-horizon blended momentum: the mean risk-adjusted (momentum / realised vol)
// over several horizons, so fast and slow trend agree instead of one horizon
// dominating. Distinct from `momentumAgreement`, which reads only the SIGNS.
export function blendedMomentum(series, t, { lenses = [8, 16, 32] } = {}) {
    const r = series.returns;
    let acc = 0;
    let n = 0;
    for (const L of lenses) {
        const m = finiteSum(r, t - L + 1, t);
        const v = varianceOf(r, t - L + 1, t);
        if (!Number.isFinite(m) || !Number.isFinite(v) || !(v > 0)) continue;
        acc += m / Math.sqrt(v);
        n += 1;
    }
    return n >= 2 ? acc / n : NaN;
}

// Network (lead-lag) momentum: the OTHER streams' risk-adjusted momentum ending
// `lag` bars ago (`2308.11294` — momentum spills over economically linked assets).
// Reads `series.panel.returnsByStream` and skips this stream by `panel.streamIndex`;
// abstains without a panel (a single-stream run) or before the window is populated.
export function networkMomentum(series, t, { window = 16, lag = 1 } = {}) {
    const p = series.panel;
    if (!p || !Array.isArray(p.returnsByStream)) return NaN;
    if (!Number.isInteger(p.streamIndex) || p.streamIndex < 0 || p.streamIndex >= p.returnsByStream.length) return NaN;
    const end = t - lag;
    if (end < 0) return NaN;
    let acc = 0;
    let n = 0;
    for (let i = 0; i < p.returnsByStream.length; i++) {
        if (i === p.streamIndex) continue;
        const rs = p.returnsByStream[i];
        if (!rs) continue;
        const m = finiteSum(rs, end - window + 1, end);
        if (!Number.isFinite(m)) continue;
        const v = varianceOf(rs, end - window + 1, end);
        acc += (Number.isFinite(v) && v > 0) ? m / Math.sqrt(v) : m;
        n += 1;
    }
    return n >= 1 ? acc / n : NaN;
}

// Regime-gated momentum (`2105.13727`, `2604.09060`): momentum, but ABSTAIN while
// the trailing `gateWindow`-bar return sits below `-gateZ` standard deviations of
// its own causal vol estimate — the momentum-crash regime where trend arms give the
// gains back. Causal and pre-registered (not a fitted vol bucket).
export function regimeGatedMomentum(series, t, { window = 16, gateWindow = 32, gateZ = 2 } = {}) {
    const r = series.returns;
    const m = finiteSum(r, t - window + 1, t);
    if (!Number.isFinite(m)) return NaN;
    const v = varianceOf(r, t - gateWindow + 1, t);
    const gate = finiteSum(r, t - gateWindow + 1, t);
    if (Number.isFinite(v) && v > 0 && Number.isFinite(gate)) {
        const threshold = -gateZ * Math.sqrt(v) * Math.sqrt(gateWindow);
        if (gate <= threshold) return NaN;
    }
    return m;
}


// The round-30 momentum-upgrade family (C-SIGUP / C-REGIME, gate G-H). OPT-IN,
// deliberately NOT part of `SIGNAL_CANDIDATES`: pre-registered hypotheses
// (`docs/research/round30-winning-mechanisms.md` §1.2), so a default run's roster,
// `K` and every golden fingerprint are untouched. `sig-network-momentum` reads the
// cross-section through `view.panel` and is marked `crossSectional` so a
// panel-less run reports it `not-applicable` rather than a live degenerate arm
// (`BUGS.md` #70).
export const SIGUP_CANDIDATES = Object.freeze([
    {
        id: 'sig-vol-momentum', label: 'sig:vol-momentum', kind: 'signal', fn: volScaledMomentum, window: 16,
        crossSectional: false,
        note: 'volatility-scaled momentum: trailing 16-bar return over its realised vol (the TSMOM sizing standard, 1904.04912)',
    },
    {
        id: 'sig-blend-momentum', label: 'sig:blend-momentum', kind: 'signal', fn: blendedMomentum, window: 32,
        params: { lenses: [8, 16, 32] },
        crossSectional: false,
        note: 'multi-horizon blended momentum: the mean risk-adjusted (momentum/vol) over the 8/16/32-bar horizons, so fast and slow trend agree (2112.08534)',
    },
    {
        id: 'sig-network-momentum', label: 'sig:network-momentum', kind: 'signal', fn: networkMomentum, window: 16,
        params: { lag: 1 },
        crossSectional: true,
        note: 'network (lead-lag) momentum: the other streams\' risk-adjusted momentum one bar back (a panel signal, 2308.11294) — abstains without a panel',
    },
    {
        id: 'sig-regime-momentum', label: 'sig:regime-momentum', kind: 'signal', fn: regimeGatedMomentum, window: 16,
        params: { gateWindow: 32, gateZ: 2 },
        crossSectional: false,
        note: 'regime-gated momentum: momentum, abstaining while the trailing 32-bar return is below -2 sigma (a causal momentum-crash gate, 2105.13727 / 2604.09060)',
    },
]);
