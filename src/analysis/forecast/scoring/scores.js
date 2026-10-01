// src/analysis/forecast/scoring/scores.js (round-104 split of src/analysis/forecast/scoring.js).
// Forecast-pair extraction + proper scores (Brier/Murphy/log).
import { mean } from '../../performance.js';
export const isArr = Array.isArray;
export const finite = (x) => Number.isFinite(x);
// A forecast observation: the signed confidence at bar j predicts the sign of the
// NEXT bar's return. `forecastPairs` turns a report's `foldInputs`
// ([{ returns, signals, confidence }]) into aligned (probability, outcome) arrays.
// The last bar of each fold is dropped: its outcome lies outside the journaled
// window. A fold without a finite confidence/return at a bar contributes nothing
// there.
export function forecastPairs(foldInputs) {
    const forecasts = [];
    const outcomes = [];
    const inputs = isArr(foldInputs) ? foldInputs : [];
    for (const fi of inputs) {
        if (!fi || !isArr(fi.returns) || !isArr(fi.confidence)) continue;
        const len = Math.min(fi.returns.length, fi.confidence.length);
        for (let j = 0; j + 1 < len; j++) {
            const c = fi.confidence[j];
            const next = fi.returns[j + 1];
            if (!finite(c) || !finite(next)) continue;
            // The raw signed confidence is in [-1, 1] for both families; the
            // probability is the affine map, clipped so the log score cannot blow up.
            forecasts.push(Math.min(1, Math.max(0, (c + 1) / 2)));
            outcomes.push(next > 0 ? 1 : 0);
        }
    }
    return { forecasts, outcomes, bars: forecasts.length };
}

// A single bin index for equal-width bins over [0, 1]; the top edge is closed.
export function brierBinIndex(p, bins) {
    const k = Math.floor(p * bins);
    return Math.min(bins - 1, Math.max(0, k));
}

// The Brier score of a probabilistic forecast of a binary outcome: mean (p - o)^2.
export function brierScore(forecasts, outcomes) {
    const n = Math.min(forecasts.length, outcomes.length);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
        if (!finite(forecasts[i]) || !finite(outcomes[i])) continue;
        sum += (forecasts[i] - outcomes[i]) ** 2;
        count++;
    }
    return count ? sum / count : NaN;
}

// The log score (negative log-likelihood per bar): mean -(o ln p + (1-o) ln(1-p)).
// `eps` clips the probability away from 0/1 so a confidently-wrong forecast is
// penalised heavily but finitely (the score is unbounded otherwise).
export function logScore(forecasts, outcomes, { eps = 1e-15 } = {}) {
    const n = Math.min(forecasts.length, outcomes.length);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
        const p0 = forecasts[i];
        const o = outcomes[i];
        if (!finite(p0) || !finite(o)) continue;
        const p = Math.min(1 - eps, Math.max(eps, p0));
        sum -= o * Math.log(p) + (1 - o) * Math.log(1 - p);
        count++;
    }
    return count ? sum / count : NaN;
}

// Murphy's (1973) exact partition of the Brier score for a BINNED forecast:
//   BS_binned = REL - RES + UNC
// where, over equal-width forecast bins,
//   REL = sum_k (n_k/N) (mean_p_k - mean_o_k)^2   (calibration error),
//   RES = sum_k (n_k/N) (mean_o_k - baseRate)^2   (how sharply bins separate),
//   UNC = baseRate (1 - baseRate)                 (the outcome's own variance).
// REL - RES + UNC equals the Brier score of the piecewise-constant (binned)
// forecast exactly (the within-bin outcome variance is UNC - RES by the ANOVA
// decomposition of a binary variable); the raw Brier is also returned, and the gap
// is the within-bin *forecast* variance that merging into a bin discards.
// Gneiting & Raftery (2007) for why a proper score is required at all.
export function brierDecomposition({ forecasts = [], outcomes = [], bins = 10 }) {
    const n = Math.min(forecasts.length, outcomes.length);
    const fb = [];
    const ob = [];
    for (let i = 0; i < n; i++) {
        if (!finite(forecasts[i]) || !finite(outcomes[i])) continue;
        fb.push(forecasts[i]);
        ob.push(outcomes[i]);
    }
    if (!fb.length) return { available: false, reason: 'no finite forecast/outcome pairs' };
    const B = Math.max(1, Math.floor(bins));
    const N = fb.length;
    const baseRate = mean(ob);
    const uncertainty = baseRate * (1 - baseRate);
    const raw = mean(fb.map((p, i) => (p - ob[i]) ** 2));
    const groups = new Array(B).fill(null).map(() => ({ n: 0, sumP: 0, sumO: 0, sumO2: 0 }));
    for (let i = 0; i < N; i++) {
        const g = groups[brierBinIndex(fb[i], B)];
        g.n++; g.sumP += fb[i]; g.sumO += ob[i]; g.sumO2 += ob[i] * ob[i];
    }
    let reliability = 0;
    let resolution = 0;
    let binned = 0;
    const detail = [];
    for (let k = 0; k < B; k++) {
        const g = groups[k];
        const lo = k / B;
        const hi = (k + 1) / B;
        if (!g.n) {
            detail.push({ lo, hi, n: 0, meanForecast: null, meanOutcome: null });
            continue;
        }
        const mp = g.sumP / g.n;
        const mo = g.sumO / g.n;
        const w = g.n / N;
        reliability += w * (mp - mo) ** 2;
        resolution += w * (mo - baseRate) ** 2;
        const withinVar = g.sumO2 / g.n - mo * mo;   // o in {0,1} => = mo(1-mo)
        binned += w * ((mp - mo) ** 2 + withinVar);
        detail.push({ lo, hi, n: g.n, meanForecast: mp, meanOutcome: mo });
    }
    return {
        available: true,
        bars: N,
        bins: B,
        baseRate,
        brier: raw,
        brierBinned: binned,
        reliability,
        resolution,
        uncertainty,
        identityResidual: binned - (reliability - resolution + uncertainty),
        detail,
    };
}

// The per-bar Brier loss of one variant (for the paired DM test and the MCS): the
// squared error of the probability against the realised outcome.
export function brierLosses(forecasts, outcomes) {
    const n = Math.min(forecasts.length, outcomes.length);
    const loss = new Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
        if (!finite(forecasts[i]) || !finite(outcomes[i])) continue;
        loss[i] = (forecasts[i] - outcomes[i]) ** 2;
    }
    return loss;
}

