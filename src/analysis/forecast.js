// Forecast comparison — the layer that scores the family as *forecasters*, not
// only as PnL streams (round 26, R26-14).
//
// Every candidate already emits a per-bar signed confidence (round 26, R26-3), so
// the journal makes the family comparable on the quantity the literature actually
// compares: predictive accuracy. The pieces are all classical:
//
//   * proper scores — the Brier score and its Murphy (1973)
//     reliability/resolution/uncertainty partition, plus the log score. These are
//     proper (Gneiting & Raftery 2007): a model cannot earn them by hedging toward
//     the base rate;
//   * the Diebold–Mariano (1995) test on the paired per-bar loss differentials
//     (candidate vs baseline), block-bootstrapped so serial dependence does not
//     inflate the statistic;
//   * the Hansen, Lunde & Nason (2011) Model Confidence Set — the SET of families
//     that cannot be distinguished from the best at a chosen confidence. This is
//     the honest answer to "which family is best" when K models are compared on
//     noisy, dependent losses; crowning the sample-best is the selection bias the
//     whole project exists to avoid.
//
// All pure + seeded (reproducible). Measurement only: no training change, no golden.
//
// R27-5 (grouping): the affine map `(confidence + 1) / 2` recovers a *probability*
// only for a controller-family candidate, whose journaled confidence is
// `confidenceFromProb(prob)`. A signal candidate's confidence is a normalised
// z-score, so the family is scored WITHIN its kind (one MCS per kind; the DM test
// against the baseline only inside the baseline's kind) rather than mixing a
// probability against a z-score. `forecastComparison` states this in its `reader`.

import { mulberry32 } from '../legion/rng.js';
import { mean } from './performance.js';
import { stationaryBlockIndices } from './reality_check.js';

const isArr = Array.isArray;
const finite = (x) => Number.isFinite(x);

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

// A stationary-block bootstrap of the mean of each series in `series` (one array
// per model, all the same length). Returns the per-replicate means as a
// `Float64Array` of shape [nBoot][K] flattened, so callers can derive both the
// Diebold–Mariano SE and the Model Confidence Set from ONE set of resampling
// draws. Deterministic for a given seed.
export function bootstrapMeans(series, { nBoot = 1000, blockLength = null, seed = 12345 } = {}) {
    const K = series.length;
    if (!K) return { available: false, reason: 'no series' };
    const T = series[0].length;
    if (!T) return { available: false, reason: 'empty series' };
    const b = Number.isFinite(blockLength) && blockLength >= 1
        ? Math.max(1, Math.floor(blockLength))
        : Math.max(1, Math.floor(Math.cbrt(T)));
    const rng = mulberry32(seed >>> 0);
    const out = new Float64Array(nBoot * K);
    for (let rep = 0; rep < nBoot; rep++) {
        const idx = stationaryBlockIndices(T, b, rng);
        for (let k = 0; k < K; k++) {
            const s = series[k];
            let sum = 0;
            for (let t = 0; t < T; t++) sum += s[idx[t]];
            out[rep * K + k] = sum / T;
        }
    }
    return { available: true, nBoot, blockLength: b, K, T, means: out };
}

// The Diebold–Mariano (1995) test on the paired per-bar loss differentials
// d_t = lossA_t - lossB_t. The statistic is dbar / SE(dbar), with SE from the
// stationary-block bootstrap (so serial dependence in the losses does not inflate
// it); the p-value is the bootstrap two-sided tail. `favored` names the model with
// the lower average loss (null when the difference is exactly zero / unavailable).
export function dieboldMariano({ lossA = [], lossB = [], nBoot = 1000, blockLength = null, seed = 12345 } = {}) {
    const n = Math.min(lossA.length, lossB.length);
    const d = [];
    for (let i = 0; i < n; i++) {
        if (finite(lossA[i]) && finite(lossB[i])) d.push(lossA[i] - lossB[i]);
    }
    if (d.length < 2) return { available: false, reason: 'fewer than two paired observations' };
    const dbar = mean(d);
    const boot = bootstrapMeans([d], { nBoot, blockLength, seed });
    if (!boot.available) return { available: false, reason: boot.reason };
    let bmean = 0;
    for (let rep = 0; rep < boot.nBoot; rep++) bmean += boot.means[rep];
    bmean /= boot.nBoot;
    let vsum = 0;
    for (let rep = 0; rep < boot.nBoot; rep++) vsum += (boot.means[rep] - bmean) ** 2;
    const se = Math.sqrt(vsum / Math.max(1, boot.nBoot - 1));
    const absDbar = Math.abs(dbar);
    let statistic;
    let pValue;
    // A numerically-zero bootstrap variance (e.g. a constant differential) is
    // treated as zero: the difference is then either exactly zero (no evidence) or
    // infinitely significant (no sampling variability at all).
    if (!(se > 1e-12)) {
        statistic = absDbar > 0 ? Infinity : 0;
        pValue = absDbar > 0 ? 0 : 1;
    } else {
        statistic = dbar / se;
        let exceed = 0;
        for (let rep = 0; rep < boot.nBoot; rep++) {
            if (Math.abs(boot.means[rep] - dbar) >= absDbar) exceed++;
        }
        pValue = (exceed + 1) / (boot.nBoot + 1);
    }
    return {
        available: true,
        n: d.length,
        meanDifferential: dbar,
        se,
        statistic,
        pValue,
        blockLength: boot.blockLength,
        favored: dbar < 0 ? 'A' : (dbar > 0 ? 'B' : null),
    };
}

// The Hansen, Lunde & Nason (2011) Model Confidence Set, range statistic.
// `losses` is one per-bar loss series per model; `ids` names them. The procedure
// starts from the full set and, while the null "all models in the set are equally
// good" is rejected (bootstrap p < alpha), eliminates the model with the largest
// average loss relative to the rest. Returns the surviving set — the families that
// cannot be distinguished from the best at 1 - alpha confidence. Deterministic for
// a given seed. `alpha` is the significance level; confidence = 1 - alpha.
export function modelConfidenceSet({ losses = [], ids = null, alpha = 0.10, nBoot = 1000, blockLength = null, seed = 12345 } = {}) {
    const K = losses.length;
    if (K < 2) {
        return K === 1
            ? { available: true, alpha, members: [0], memberIds: ids ? [ids[0]] : [0], eliminated: [], steps: 0, note: 'a single model is its own MCS' }
            : { available: false, reason: 'need at least one loss series' };
    }
    const T = losses[0].length;
    for (const s of losses) {
        if (!isArr(s) || s.length !== T) return { available: false, reason: 'loss series must be arrays of equal length' };
    }
    const boot = bootstrapMeans(losses, { nBoot, blockLength, seed });
    if (!boot.available) return { available: false, reason: boot.reason };
    const names = ids || losses.map((_, i) => i);
    const observed = losses.map((s) => mean(s));
    const B = boot.nBoot;
    const meanStar = (rep, k) => boot.means[rep * K + k];
    // Bootstrap variance of each model mean (the diagonal of Sigma-hat) and of each
    // pairwise differential mean. Precomputed once: the inner bootstrap loop must
    // not recompute a variance.
    const sd = new Array(K).fill(0);
    const bootMean = new Array(K).fill(0);
    for (let k = 0; k < K; k++) {
        let m = 0;
        for (let rep = 0; rep < B; rep++) m += meanStar(rep, k);
        bootMean[k] = m / B;
    }
    for (let k = 0; k < K; k++) {
        let v = 0;
        for (let rep = 0; rep < B; rep++) v += (meanStar(rep, k) - bootMean[k]) ** 2;
        sd[k] = Math.sqrt(v / Math.max(1, B - 1));
    }
    const sdDiff = [];
    for (let i = 0; i < K; i++) {
        sdDiff.push(new Array(K).fill(0));
        for (let j = 0; j < K; j++) {
            if (i === j) continue;
            let m = 0;
            for (let rep = 0; rep < B; rep++) m += meanStar(rep, i) - meanStar(rep, j);
            m /= B;
            let v = 0;
            for (let rep = 0; rep < B; rep++) v += (meanStar(rep, i) - meanStar(rep, j) - m) ** 2;
            sdDiff[i][j] = Math.sqrt(v / Math.max(1, B - 1));
        }
    }

    const active = losses.map((_, i) => i);
    const eliminated = [];
    let lastP = null;
    let steps = 0;
    while (active.length > 1) {
        // T_R = max_{i,j in M} |dbar_ij| / se(dbar_ij).
        let TR = 0;
        for (let a = 0; a < active.length; a++) {
            for (let b = a + 1; b < active.length; b++) {
                const i = active[a];
                const j = active[b];
                const s = sdDiff[i][j];
                const dbar = observed[i] - observed[j];
                if (s > 0) TR = Math.max(TR, Math.abs(dbar) / s);
                else if (dbar !== 0) TR = Infinity;
            }
        }
        // Centered bootstrap distribution of T_R over the active set.
        let exceed = 0;
        for (let rep = 0; rep < B; rep++) {
            let TRb = 0;
            for (let a = 0; a < active.length; a++) {
                for (let b = a + 1; b < active.length; b++) {
                    const i = active[a];
                    const j = active[b];
                    const s = sdDiff[i][j];
                    if (s <= 0) continue;
                    const d = (meanStar(rep, i) - meanStar(rep, j)) - (observed[i] - observed[j]);
                    TRb = Math.max(TRb, Math.abs(d) / s);
                }
            }
            if (TRb >= TR) exceed++;
        }
        const p = (exceed + 1) / (B + 1);
        lastP = p;
        if (p >= alpha) break;
        // Eliminate the worst: max over the active set of (mean_i - mean of the
        // rest) / se_i.
        let worst = active[0];
        let worstScore = -Infinity;
        for (const i of active) {
            const others = active.filter((x) => x !== i);
            const mOthers = others.length ? mean(others.map((j) => observed[j])) : observed[i];
            const num = observed[i] - mOthers;
            const den = sd[i] > 0 ? sd[i] : (num > 0 ? 0 : Infinity);
            const score = den === 0 ? Infinity : num / den;
            if (score > worstScore) { worstScore = score; worst = i; }
        }
        eliminated.push({ index: worst, id: names[worst], step: steps, pValue: p });
        active.splice(active.indexOf(worst), 1);
        steps++;
    }
    return {
        available: true,
        alpha,
        confidence: 1 - alpha,
        members: active.slice(),
        memberIds: active.map((i) => names[i]),
        eliminated,
        steps,
        lastPValue: lastP,
        nBoot: B,
        blockLength: boot.blockLength,
        note: 'a model is eliminated only when the equal-accuracy null over the surviving set is rejected; the survivors cannot be distinguished from the best at this confidence (Hansen, Lunde & Nason 2011)',
    };
}

// The whole forecast layer over a journal: proper scores per variant, the DM test
// of each candidate against the baseline, and the family Model Confidence Set at
// 90% and 95%. `baseline` and each `candidates[].foldInputs` are the report's
// `foldInputs` arrays; every variant shares the fold grid, so the per-bar losses
// line up. Pure post-processing.
export function forecastComparison({
    baseline = null, candidates = [], baselineKind = 'mechanism', baselineId = 'baseline',
    alpha = 0.10, nBoot = 1000, blockLength = null, seed = 12345, bins = 10,
} = {}) {
    const base = forecastPairs(baseline);
    if (!base.bars) return { available: false, reason: 'the baseline journal carries no finite confidence/outcome pairs' };
    // P1: the benchmark models journal a calibrated probability just as the
    // controller does, so they share the controller's calibration group and are
    // scored against it (MCS + DM), while a signal's normalised z-score keeps its
    // own group. `group` is the grouping key; `kind` stays the variant's own label.
    const groupOf = (kind) => (kind === 'benchmark' ? (baselineKind === 'signal' ? 'signal' : 'controller') : kind);
    const variants = [{ id: baselineId, kind: baselineKind, group: groupOf(baselineKind), pairs: base }];
    for (const c of candidates) {
        if (!c || c.foldInputs == null) continue;
        const pairs = forecastPairs(c.foldInputs);
        if (pairs.bars !== base.bars) {
            // Alignment is the whole point of a paired test; refuse rather than
            // silently compare mismatched windows.
            return { available: false, reason: `variant ${c.id} has ${pairs.bars} pairs, baseline has ${base.bars}` };
        }
        const kind = c.kind || baselineKind;
        variants.push({ id: c.id, kind, group: groupOf(kind), pairs });
    }
    const byId = {};
    for (const v of variants) {
        const decomp = brierDecomposition({ forecasts: v.pairs.forecasts, outcomes: v.pairs.outcomes, bins });
        // P1 (round 29 → 30): referenced proper scores per variant, the quantities
        // the model-class benchmark decides on — a forecaster earns skill only by
        // beating the base-rate forecast on the Brier score (`brierSkill > 0`) or
        // its accuracy (`accuracySkill > 0`). `brierBaseline = p̄(1−p̄)`.
        const baseRate = decomp.baseRate;
        const brierBaseline = Number.isFinite(baseRate) ? baseRate * (1 - baseRate) : null;
        const brier = decomp.brier;
        const brierSkill = (Number.isFinite(brier) && Number.isFinite(brierBaseline) && brierBaseline > 0)
            ? 1 - brier / brierBaseline : null;
        let hits = 0;
        let scored = 0;
        for (let i = 0; i < v.pairs.forecasts.length; i++) {
            const p = v.pairs.forecasts[i];
            const o = v.pairs.outcomes[i];
            if (!Number.isFinite(p) || !Number.isFinite(o)) continue;
            scored++;
            if ((p >= 0.5 ? 1 : 0) === o) hits++;
        }
        const accuracy = scored ? hits / scored : null;
        const chanceAccuracy = Number.isFinite(baseRate) ? Math.max(baseRate, 1 - baseRate) : null;
        const accuracySkill = (Number.isFinite(accuracy) && Number.isFinite(chanceAccuracy)) ? accuracy - chanceAccuracy : null;
        byId[v.id] = {
            kind: v.kind,
            group: v.group,
            bars: v.pairs.bars,
            brier,
            brierBinned: decomp.brierBinned,
            brierBaseline,
            brierSkill,
            accuracy,
            chanceAccuracy,
            accuracySkill,
            logScore: logScore(v.pairs.forecasts, v.pairs.outcomes),
            reliability: decomp.reliability,
            resolution: decomp.resolution,
            uncertainty: decomp.uncertainty,
            baseRate: decomp.baseRate,
        };
    }
    // R27-5: score WITHIN a kind. `(c+1)/2` is a *probability* only for a
    // controller-family candidate: its journaled confidence is
    // `confidenceFromProb(prob) = prob/50 - 1`, which the affine map inverts
    // exactly. A signal candidate's journaled confidence is a normalised z-score
    // (`clamp(z/saturation, -1, 1)`), so mapping it to `(c+1)/2` yields a number
    // that is neither a probability nor comparable across kinds — a cross-kind
    // Brier/DM/MCS would compare a probability against a z-score. So each kind is
    // scored separately: its own Model Confidence Set, and (only inside the
    // baseline's kind, which is the run's reference) the Diebold–Mariano test
    // against the baseline.
    const kinds = [];
    for (const v of variants) if (!kinds.includes(v.group)) kinds.push(v.group);
    const baselineGroup = groupOf(baselineKind);
    const byKind = {};
    for (const kind of kinds) {
        const group = variants.filter((v) => v.group === kind);
        const losses = group.map((v) => brierLosses(v.pairs.forecasts, v.pairs.outcomes));
        const ids = group.map((v) => v.id);
        byKind[kind] = {
            members: ids,
            n: ids.length,
            mcs: {
                at90: modelConfidenceSet({ losses, ids, alpha: 0.10, nBoot, blockLength, seed }),
                at95: modelConfidenceSet({ losses, ids, alpha: 0.05, nBoot, blockLength, seed }),
            },
        };
    }
    const baseLoss = brierLosses(base.forecasts, base.outcomes);
    for (const v of variants.slice(1)) {
        if (v.group === baselineGroup) {
            byId[v.id].dm = dieboldMariano({
                lossA: brierLosses(v.pairs.forecasts, v.pairs.outcomes),
                lossB: baseLoss,
                nBoot, blockLength, seed,
            });
        } else {
            byId[v.id].dm = {
                available: false,
                reason: `cross-kind: ${v.id} is a ${v.kind} candidate, whose journaled confidence is a normalised z-score rather than a calibrated probability, so the paired DM test against the ${baselineKind} baseline is undefined (R27-5)`,
            };
        }
    }
    const primary = byKind[baselineGroup] || { mcs: { at90: null, at95: null } };
    return {
        available: true,
        bars: base.bars,
        baseRate: byId[baselineId].baseRate,
        baselineId,
        kind: baselineKind,
        baselineGroup,
        kinds: kinds.map((k) => ({ kind: k, n: byKind[k].n, members: byKind[k].members })),
        byKind,
        byId,
        mcs: primary.mcs,
        reader: `proper scores (Brier + reliability/resolution/uncertainty, log score) per variant, grouped by \`kind\` (R27-5): the ${baselineKind} family's journaled confidence is \`confidenceFromProb(prob)\`, which \`(c+1)/2\` inverts exactly, so its Brier is a proper score of a probability and \`dm\` is the block-bootstrapped Diebold–Mariano test vs the baseline (favored = lower loss); a non-${baselineKind} family's confidence is a normalised z-score, so those candidates carry \`dm.available=false\` with a reason and are scored only against each other. P1: the benchmark arms (kind 'benchmark') journal a calibrated probability, so they share the baseline's calibration GROUP and are scored against it in the same MCS/DM (each byId row also carries brierBaseline, brierSkill, accuracy, chanceAccuracy and accuracySkill — the referenced proper-skill readout the P1 decision uses). \`mcs\` is the Hansen–Lunde–Nason Model Confidence Set of the baseline's group at 90% and 95% (\`byKind[group].mcs\` holds every kind) — the families that cannot be distinguished from the best. A single sample-best variant is not a winner (selection bias).`,
    };
}

// ---------------------------------------------------------------------------
// W4b (round 49): the winnable job — realized-volatility forecasting.
// ---------------------------------------------------------------------------
// Direction is not predictable at this horizon (G-A, F-06…F-09); volatility is
// the one documented predictability in returns, and F-16/L09 already showed a
// causal EWMA is the forecaster to use. These three pure helpers are the
// measurement the model must beat out of sample at matched exposure before it
// earns a place in the default path. Additive: no scored path reads them.
//
// `realizedVolatility(returns, window)`: causal rolling root-mean-square of
// returns — the realized-vol proxy. Returns an array of length
// max(0, n-window+1) (no null padding, so a caller can align it explicitly).
// `ewmaVolForecast(vols, {lambda})`: causal one-step-ahead EWMA (RiskMetrics
// 1996, lambda=0.94 daily): out[0] = vols[0], out[t] = lambda*out[t-1] +
// (1-lambda)*vols[t-1]. `volForecastSkill(actual, forecast, baseline)`: the
// MSE skill 1 - MSE(f)/MSE(b), NaN when either MSE is not positive-finite.
export function realizedVolatility(returns, window) {
    if (!Array.isArray(returns) || !Number.isInteger(window) || window < 1) return [];
    const n = returns.length;
    if (n < window) return [];
    const out = [];
    let sumSq = 0;
    for (let i = 0; i < window; i++) {
        const x = returns[i];
        sumSq += Number.isFinite(x) ? x * x : 0;
    }
    out.push(Math.sqrt(sumSq / window));
    for (let t = window; t < n; t++) {
        const a = returns[t];
        const d = returns[t - window];
        if (Number.isFinite(a)) sumSq += a * a;
        if (Number.isFinite(d)) sumSq -= d * d;
        out.push(Math.sqrt(Math.max(0, sumSq) / window));
    }
    return out;
}

export function ewmaVolForecast(vols, { lambda = 0.94 } = {}) {
    if (!Array.isArray(vols) || !vols.length) return [];
    if (!Number.isFinite(lambda) || lambda < 0 || lambda > 1) throw new Error(`ewmaVolForecast: lambda must be in [0,1] (got ${lambda}) (W4b)`);
    const out = new Array(vols.length);
    out[0] = vols[0];
    for (let t = 1; t < vols.length; t++) {
        const prev = vols[t - 1];
        out[t] = lambda * out[t - 1] + (1 - lambda) * (Number.isFinite(prev) ? prev : out[t - 1]);
    }
    return out;
}

export function volForecastSkill(actual, forecast, baseline) {
    const mse = (a, f) => {
        let sum = 0;
        let n = 0;
        const len = Math.min(Array.isArray(a) ? a.length : 0, Array.isArray(f) ? f.length : 0);
        for (let i = 0; i < len; i++) {
            if (!Number.isFinite(a[i]) || !Number.isFinite(f[i])) continue;
            const d = a[i] - f[i];
            sum += d * d;
            n++;
        }
        return n ? sum / n : NaN;
    };
    const mf = mse(actual, forecast);
    const mb = mse(actual, baseline);
    if (!Number.isFinite(mf) || !Number.isFinite(mb) || !(mb > 0)) return { available: false, reason: 'insufficient finite pairs or non-positive baseline MSE (W4b)' };
    return { available: true, mseForecast: mf, mseBaseline: mb, skill: 1 - mf / mb };
}

export function fitArVolForecast(trainVols, { order = 1 } = {}) {
    if (!Array.isArray(trainVols) || !Number.isInteger(order) || order < 1) return { available: false, reason: 'order must be a positive integer (W4b-t)' };
    const p = order + 1;
    const rows = [];
    const ys = [];
    for (let t = order; t < trainVols.length; t++) {
        const yt = trainVols[t];
        if (!Number.isFinite(yt)) continue;
        const row = [1];
        let ok = true;
        for (let k = 1; k <= order; k++) {
            const v = trainVols[t - k];
            if (!Number.isFinite(v)) { ok = false; break; }
            row.push(v);
        }
        if (!ok) continue;
        rows.push(row);
        ys.push(yt);
    }
    if (rows.length < p + 1) return { available: false, reason: 'insufficient finite rows to fit AR (W4b-t)' };
    const xtx = Array.from({ length: p }, () => new Array(p).fill(0));
    const xty = new Array(p).fill(0);
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        for (let a = 0; a < p; a++) {
            xty[a] += r[a] * ys[i];
            for (let b = 0; b < p; b++) xtx[a][b] += r[a] * r[b];
        }
    }
    const aug = xtx.map((row, i) => row.concat([xty[i]]));
    for (let c = 0; c < p; c++) {
        let piv = c;
        for (let r = c + 1; r < p; r++) if (Math.abs(aug[r][c]) > Math.abs(aug[piv][c])) piv = r;
        if (!(Math.abs(aug[piv][c]) > 1e-12)) return { available: false, reason: 'singular AR normal equations (W4b-t)' };
        const tmp = aug[c]; aug[c] = aug[piv]; aug[piv] = tmp;
        const d = aug[c][c];
        for (let k = c; k <= p; k++) aug[c][k] /= d;
        for (let r = 0; r < p; r++) {
            if (r === c) continue;
            const f = aug[r][c];
            if (f === 0) continue;
            for (let k = c; k <= p; k++) aug[r][k] -= f * aug[c][k];
        }
    }
    return { available: true, order, coef: aug.map((row) => row[p]), rows: rows.length };
}

export function predictArVolForecast(fit, history) {
    const coef = Array.isArray(fit) ? fit : (fit && fit.coef);
    if (!Array.isArray(coef) || !coef.length) return NaN;
    const order = coef.length - 1;
    if (!Array.isArray(history) || history.length < order) return NaN;
    let y = coef[0];
    for (let k = 1; k <= order; k++) {
        const v = history[history.length - k];
        if (!Number.isFinite(v)) return NaN;
        y += coef[k] * v;
    }
    return y;
}

export function tournamentVolForecast(vols, { split = 0.5, lambda = 0.94, order = 1 } = {}) {
    if (!Array.isArray(vols) || vols.length < 8) return { available: false, reason: 'need at least 8 finite vols (W4b-t)' };
    if (!Number.isFinite(split) || split <= 0 || split >= 1) return { available: false, reason: 'split must be in (0,1) (W4b-t)' };
    for (const v of vols) if (!Number.isFinite(v)) return { available: false, reason: 'non-finite vol (W4b-t)' };
    const n = vols.length;
    const trainN = Math.floor(n * split);
    if (!(trainN >= order + 2) || !(n - trainN >= 2)) return { available: false, reason: 'split leaves too little train or test (W4b-t)' };
    const train = vols.slice(0, trainN);
    const test = vols.slice(trainN);
    const fit = fitArVolForecast(train, { order });
    if (!fit.available) return { available: false, reason: fit.reason };
    let ewmaFull;
    try { ewmaFull = ewmaVolForecast(vols, { lambda }); } catch (e) { return { available: false, reason: String((e && e.message) || e) }; }
    let mean = 0;
    for (const v of train) mean += v;
    mean /= train.length;
    const actual = [];
    const ewma = [];
    const ar = [];
    const flat = [];
    for (let j = 0; j < test.length; j++) {
        const g = trainN + j;
        const hist = vols.slice(g - order, g);
        if (hist.length < order) continue;
        const p = predictArVolForecast(fit, hist);
        if (!Number.isFinite(p)) continue;
        actual.push(test[j]);
        ewma.push(ewmaFull[g]);
        ar.push(p);
        flat.push(mean);
    }
    if (actual.length < 2) return { available: false, reason: 'insufficient OOS points (W4b-t)' };
    const se = volForecastSkill(actual, ewma, flat);
    const sa = volForecastSkill(actual, ar, flat);
    if (!se.available || !sa.available) return { available: false, reason: 'degenerate OOS baseline (W4b-t)' };
    const ewmaSkill = se.skill;
    const arSkill = sa.skill;
    return {
        available: true, n, trainN, testN: actual.length, order, lambda,
        coef: fit.coef.slice(),
        mseBaseline: se.mseBaseline, mseEwma: se.mseForecast, mseAr: sa.mseForecast,
        ewmaSkill, arSkill,
        winner: arSkill > ewmaSkill ? 'ar' : 'ewma',
        beatsEwma: arSkill > ewmaSkill,
    };
}

export function tournamentVolForecastAcrossSplits(vols, { splits = [0.3, 0.4, 0.5, 0.6, 0.7], lambda = 0.94, order = 1 } = {}) {
    if (!Array.isArray(vols) || vols.length < 8) return { available: false, reason: 'need at least 8 finite vols (W4b-s)' };
    if (!Array.isArray(splits) || !splits.length) return { available: false, reason: 'splits must be a non-empty array (W4b-s)' };
    for (const s of splits) if (!Number.isFinite(s) || s <= 0 || s >= 1) return { available: false, reason: 'every split must be in (0,1) (W4b-s)' };
    const perSplit = [];
    for (const s of splits) {
        const t = tournamentVolForecast(vols, { split: s, lambda, order });
        if (!t.available) return { available: false, reason: `split ${s}: ${t.reason}` };
        perSplit.push({ split: s, ewmaSkill: t.ewmaSkill, arSkill: t.arSkill, winner: t.winner });
    }
    const arWins = perSplit.filter((p) => p.winner === 'ar').length;
    return {
        available: true, n: vols.length, splits: splits.slice(), lambda, order,
        perSplit, arWins, ewmaWins: perSplit.length - arWins,
        arWinFraction: arWins / perSplit.length,
        ewmaAlwaysPositive: perSplit.every((p) => p.ewmaSkill > 0),
    };
}

export function tournamentVolModel(actual, { ewma = null, ar = null, model = null, baseline = null } = {}) {
    if (!Array.isArray(actual) || !actual.length) return { available: false, reason: 'actual must be a non-empty array (W4b-m)' };
    for (const v of actual) if (!Number.isFinite(v)) return { available: false, reason: 'non-finite actual (W4b-m)' };
    const entries = { ewma, ar, model };
    for (const [k, f] of Object.entries(entries)) {
        if (!Array.isArray(f) || f.length !== actual.length) return { available: false, reason: `${k} must match actual length (W4b-m)` };
        for (const v of f) if (!Number.isFinite(v)) return { available: false, reason: `non-finite ${k} forecast (W4b-m)` };
    }
    const n = actual.length;
    const mean = actual.reduce((a, b) => a + b, 0) / n;
    const base = Array.isArray(baseline) && baseline.length === n ? baseline : new Array(n).fill(mean);
    const skills = {};
    for (const [k, f] of Object.entries(entries)) {
        const s = volForecastSkill(actual, f, base);
        if (!s.available) return { available: false, reason: `${k}: ${s.reason}` };
        skills[k] = s.skill;
    }
    const order = ['model', 'ar', 'ewma'];
    let winner = 'ewma';
    for (const k of order) if (skills[k] > skills[winner]) winner = k;
    return {
        available: true, n,
        skillEwma: skills.ewma, skillAr: skills.ar, skillModel: skills.model,
        winner, modelBeatsReferences: skills.model > skills.ewma && skills.model > skills.ar,
    };
}

export function tournamentVolPanel(volsByStream, { splits = [0.3, 0.4, 0.5, 0.6, 0.7], lambda = 0.94, order = 1 } = {}) {
    if (!volsByStream || typeof volsByStream !== 'object' || Array.isArray(volsByStream)) return { available: false, reason: 'volsByStream must be a {id: vols} object (W4b-p)' };
    const ids = Object.keys(volsByStream);
    if (!ids.length) return { available: false, reason: 'volsByStream must not be empty (W4b-p)' };
    const perStream = {};
    for (const id of ids) {
        const t = tournamentVolForecastAcrossSplits(volsByStream[id], { splits, lambda, order });
        if (!t.available) return { available: false, reason: `${id}: ${t.reason}` };
        perStream[id] = t;
    }
    const arMajority = ids.filter((id) => perStream[id].arWinFraction > 0.5);
    const ewmaClean = ids.filter((id) => perStream[id].ewmaAlwaysPositive);
    return {
        available: true, streams: ids.length, splits: splits.slice(), lambda, order,
        perStream, arMajority: arMajority.length, ewmaClean: ewmaClean.length,
        arMajorityFraction: arMajority.length / ids.length,
        unanimousAr: arMajority.length === ids.length,
        unanimousEwma: ewmaClean.length === ids.length,
    };
}

export function volForecastQlike(actual, forecast, baseline) {
    const qlike = (a, f) => {
        let sum = 0;
        let n = 0;
        const len = Math.min(Array.isArray(a) ? a.length : 0, Array.isArray(f) ? f.length : 0);
        for (let i = 0; i < len; i++) {
            if (!Number.isFinite(a[i]) || !Number.isFinite(f[i]) || !(a[i] > 0) || !(f[i] > 0)) continue;
            const r = f[i] / a[i];
            sum += r - Math.log(r) - 1;
            n++;
        }
        return n ? sum / n : NaN;
    };
    const qf = qlike(actual, forecast);
    const qb = qlike(actual, baseline);
    if (!Number.isFinite(qf) || !Number.isFinite(qb) || !(qb > 0)) return { available: false, reason: 'insufficient positive pairs or non-positive baseline QLIKE (W4b-q)' };
    return { available: true, qlikeForecast: qf, qlikeBaseline: qb, skill: 1 - qf / qb };
}

export function tournamentVolModelAcrossSplits(vols, { splits = [0.3, 0.4, 0.5, 0.6, 0.7], lambda = 0.94, order = 1, modelFn = null } = {}) {
    if (!Array.isArray(vols) || vols.length < 8) return { available: false, reason: 'need at least 8 finite vols (W4b-g)' };
    if (typeof modelFn !== 'function') return { available: false, reason: 'modelFn must be a function (W4b-g)' };
    if (!Array.isArray(splits) || !splits.length) return { available: false, reason: 'splits must be a non-empty array (W4b-g)' };
    for (const s of splits) if (!Number.isFinite(s) || s <= 0 || s >= 1) return { available: false, reason: 'every split must be in (0,1) (W4b-g)' };
    for (const v of vols) if (!Number.isFinite(v)) return { available: false, reason: 'non-finite vol (W4b-g)' };
    let ewmaFull;
    try { ewmaFull = ewmaVolForecast(vols, { lambda }); } catch (e) { return { available: false, reason: String((e && e.message) || e) }; }
    const perSplit = [];
    for (const s of splits) {
        const n = vols.length;
        const trainN = Math.floor(n * s);
        if (!(trainN >= order + 2) || !(n - trainN >= 2)) return { available: false, reason: `split ${s} leaves too little train or test (W4b-g)` };
        const train = vols.slice(0, trainN);
        const test = vols.slice(trainN);
        const fit = fitArVolForecast(train, { order });
        if (!fit.available) return { available: false, reason: `split ${s}: ${fit.reason}` };
        let mean = 0;
        for (const v of train) mean += v;
        mean /= train.length;
        const actual = [];
        const ewma = [];
        const ar = [];
        const model = [];
        const flat = [];
        for (let j = 0; j < test.length; j++) {
            const g = trainN + j;
            const hist = vols.slice(g - order, g);
            if (hist.length < order) continue;
            const pa = predictArVolForecast(fit, hist);
            let pm;
            try { pm = modelFn(train, hist); } catch (e) { return { available: false, reason: `split ${s}: modelFn threw (${String((e && e.message) || e)})` }; }
            if (!Number.isFinite(pa) || !Number.isFinite(pm)) continue;
            actual.push(test[j]);
            ewma.push(ewmaFull[g]);
            ar.push(pa);
            model.push(pm);
            flat.push(mean);
        }
        if (actual.length < 2) return { available: false, reason: `split ${s}: insufficient OOS points (W4b-g)` };
        const t = tournamentVolModel(actual, { ewma, ar, model, baseline: flat });
        if (!t.available) return { available: false, reason: `split ${s}: ${t.reason}` };
        perSplit.push({ split: s, skillEwma: t.skillEwma, skillAr: t.skillAr, skillModel: t.skillModel, winner: t.winner });
    }
    const modelWins = perSplit.filter((p) => p.winner === 'model').length;
    return {
        available: true, n: vols.length, splits: splits.slice(), lambda, order,
        perSplit, modelWins, arWins: perSplit.filter((p) => p.winner === 'ar').length,
        modelWinFraction: modelWins / perSplit.length,
    };
}

export function decideVolPromotion(summary, { minModelMajority = 0.6 } = {}) {
    if (!summary || summary.available !== true || !Array.isArray(summary.perSplit) || !summary.perSplit.length) {
        return { decision: 'park', reasons: ['tournament unavailable'] };
    }
    if (!Number.isFinite(minModelMajority) || minModelMajority <= 0 || minModelMajority > 1) {
        return { decision: 'park', reasons: ['minModelMajority must be in (0,1]'] };
    }
    const need = Math.ceil(summary.perSplit.length * minModelMajority);
    if (summary.modelWins >= need) {
        return { decision: 'promote', reasons: [`model wins ${summary.modelWins}/${summary.perSplit.length} splits (needs ${need})`] };
    }
    return { decision: 'park', reasons: [`model wins ${summary.modelWins}/${summary.perSplit.length} splits (needs ${need})`] };
}

export function fitRidgeArVolForecast(trainVols, { order = 1, l2 = 0 } = {}) {
    if (!Array.isArray(trainVols) || !Number.isInteger(order) || order < 1) return { available: false, reason: 'order must be a positive integer (W4b-r)' };
    if (!Number.isFinite(l2) || l2 < 0) return { available: false, reason: 'l2 must be a finite non-negative penalty (W4b-r)' };
    if (!(l2 > 0)) return { ...fitArVolForecast(trainVols, { order }), l2 };
    const p = order + 1;
    const rows = [];
    const ys = [];
    for (let t = order; t < trainVols.length; t++) {
        const yt = trainVols[t];
        if (!Number.isFinite(yt)) continue;
        const row = [1];
        let ok = true;
        for (let k = 1; k <= order; k++) {
            const v = trainVols[t - k];
            if (!Number.isFinite(v)) { ok = false; break; }
            row.push(v);
        }
        if (!ok) continue;
        rows.push(row);
        ys.push(yt);
    }
    if (rows.length < p + 1) return { available: false, reason: 'insufficient finite rows to fit ridge-AR (W4b-r)' };
    const xtx = Array.from({ length: p }, () => new Array(p).fill(0));
    const xty = new Array(p).fill(0);
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        for (let a = 0; a < p; a++) {
            xty[a] += r[a] * ys[i];
            for (let b = 0; b < p; b++) xtx[a][b] += r[a] * r[b];
        }
    }
    for (let k = 1; k < p; k++) xtx[k][k] += l2;
    const aug = xtx.map((row, i) => row.concat([xty[i]]));
    for (let c = 0; c < p; c++) {
        let piv = c;
        for (let r = c + 1; r < p; r++) if (Math.abs(aug[r][c]) > Math.abs(aug[piv][c])) piv = r;
        if (!(Math.abs(aug[piv][c]) > 1e-12)) return { available: false, reason: 'singular ridge-AR normal equations (W4b-r)' };
        const tmp = aug[c]; aug[c] = aug[piv]; aug[piv] = tmp;
        const d = aug[c][c];
        for (let k = c; k <= p; k++) aug[c][k] /= d;
        for (let r = 0; r < p; r++) {
            if (r === c) continue;
            const f = aug[r][c];
            if (f === 0) continue;
            for (let k = c; k <= p; k++) aug[r][k] -= f * aug[c][k];
        }
    }
    return { available: true, order, l2, coef: aug.map((row) => row[p]), rows: rows.length };
}

export function tournamentVolLadder(returns, { windows = [12, 24, 48], splits = [0.3, 0.4, 0.5, 0.6, 0.7], lambda = 0.94, order = 1 } = {}) {
    if (!Array.isArray(returns) || returns.length < 8) return { available: false, reason: 'returns must be an array of at least 8 bars (W4b-w)' };
    for (const r of returns) if (!Number.isFinite(r)) return { available: false, reason: 'non-finite return (W4b-w)' };
    if (!Array.isArray(windows) || !windows.length) return { available: false, reason: 'windows must be a non-empty array (W4b-w)' };
    for (const w of windows) if (!Number.isInteger(w) || w < 1) return { available: false, reason: 'every window must be a positive integer (W4b-w)' };
    const perWindow = {};
    for (const w of windows) {
        const vols = realizedVolatility(returns, w);
        const t = tournamentVolForecastAcrossSplits(vols, { splits, lambda, order });
        if (!t.available) return { available: false, reason: `window ${w}: ${t.reason}` };
        perWindow[w] = t;
    }
    const keys = Object.keys(perWindow);
    const arClean = keys.filter((w) => perWindow[w].arWinFraction > 0.5);
    return {
        available: true, n: returns.length, windows: windows.slice(), splits: splits.slice(), lambda, order,
        perWindow, arClean: arClean.length,
        arCleanFraction: arClean.length / keys.length,
        unanimousAr: arClean.length === keys.length,
    };
}

const W4C_LN2 = Math.log(2);
const W4C_ESTIMATORS = ['cc', 'parkinson', 'garman-klass', 'rogers-satchell'];

function w4cReadBar(bar) {
  let o, h, l, c;
  if (Array.isArray(bar)) [o, h, l, c] = bar;
  else if (bar && typeof bar === 'object') {
    o = bar.o != null ? bar.o : bar.open;
    h = bar.h != null ? bar.h : bar.high;
    l = bar.l != null ? bar.l : bar.low;
    c = bar.c != null ? bar.c : bar.close;
  } else return null;
  o = Number(o); h = Number(h); l = Number(l); c = Number(c);
  if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) return null;
  if (!(o > 0) || !(h > 0) || !(l > 0) || !(c > 0)) return null;
  if (!(h >= l) || h < Math.max(o, c) || l > Math.min(o, c)) return null;
  return { o, h, l, c };
}

export function rangeBarVariance(bar, { estimator = 'parkinson' } = {}) {
  const b = w4cReadBar(bar);
  if (!b) return { available: false, reason: 'bar must be finite positive OHLC with high >= max(open, close) and low <= min(open, close) (W4c)' };
  if (!W4C_ESTIMATORS.includes(estimator)) return { available: false, reason: 'estimator must be cc, parkinson, garman-klass or rogers-satchell (W4c)' };
  const u = Math.log(b.h / b.o);
  const d = Math.log(b.l / b.o);
  const cl = Math.log(b.c / b.o);
  let variance;
  if (estimator === 'cc') variance = cl * cl;
  else if (estimator === 'parkinson') variance = ((u - d) * (u - d)) / (4 * W4C_LN2);
  else if (estimator === 'garman-klass') variance = 0.5 * (u - d) * (u - d) - (2 * W4C_LN2 - 1) * cl * cl;
  else variance = u * (u - cl) + d * (d - cl);
  if (!Number.isFinite(variance)) return { available: false, reason: 'non-finite variance (W4c)' };
  return { available: true, estimator, variance };
}

export function rangeRealizedVolatility(ohlc, window, { estimator = 'parkinson' } = {}) {
  if (!Array.isArray(ohlc) || !Number.isInteger(window) || window < 1) return [];
  if (ohlc.length < window) return [];
  const vars = [];
  for (const bar of ohlc) {
    const r = rangeBarVariance(bar, { estimator });
    if (!r.available) return [];
    vars.push(r.variance);
  }
  const out = [];
  let sum = 0;
  for (let i = 0; i < window; i++) sum += vars[i];
  out.push(Math.sqrt(Math.max(0, sum) / window));
  for (let t = window; t < vars.length; t++) {
    sum += vars[t] - vars[t - window];
    out.push(Math.sqrt(Math.max(0, sum) / window));
  }
  return out;
}

function w4cSampleVariance(xs) {
  const n = xs.length;
  if (n < 2) return NaN;
  let mean = 0;
  for (const x of xs) mean += x;
  mean /= n;
  let s = 0;
  for (const x of xs) s += (x - mean) * (x - mean);
  return s / (n - 1);
}

function w4cRsOf(b) {
  const u = Math.log(b.h / b.o);
  const d = Math.log(b.l / b.o);
  const cl = Math.log(b.c / b.o);
  return u * (u - cl) + d * (d - cl);
}

export function yangZhangVariance(ohlc) {
  if (!Array.isArray(ohlc) || ohlc.length < 3) return { available: false, reason: 'need at least 3 OHLC bars (W4c)' };
  const bars = [];
  for (const bar of ohlc) {
    const b = w4cReadBar(bar);
    if (!b) return { available: false, reason: 'non-finite or inconsistent OHLC bar (W4c)' };
    bars.push(b);
  }
  const n = bars.length;
  const overnight = [];
  for (let i = 1; i < n; i++) overnight.push(Math.log(bars[i].o / bars[i - 1].c));
  const openClose = bars.map((b) => Math.log(b.c / b.o));
  let rs = 0;
  for (const b of bars) rs += w4cRsOf(b);
  rs /= n;
  const vo = w4cSampleVariance(overnight);
  const vc = w4cSampleVariance(openClose);
  const k = 0.34 / (1.34 + (n + 1) / (n - 1));
  const raw = vo + k * vc + (1 - k) * rs;
  if (!Number.isFinite(raw)) return { available: false, reason: 'non-finite Yang-Zhang components (W4c)' };
  return { available: true, n, k, overnight: vo, openClose: vc, rs, variance: Math.max(0, raw), rawVariance: raw };
}

export function yangZhangRealizedVolatility(ohlc, window) {
  if (!Array.isArray(ohlc) || !Number.isInteger(window) || window < 1) return [];
  if (ohlc.length < window || window < 3) return [];
  const bars = [];
  for (const bar of ohlc) {
    const b = w4cReadBar(bar);
    if (!b) return [];
    bars.push(b);
  }
  const n = bars.length;
  const oc = bars.map((b) => Math.log(b.c / b.o));
  const rs = bars.map(w4cRsOf);
  const k = 0.34 / (1.34 + (window + 1) / (window - 1));
  const out = [];
  for (let s = 0; s + window <= n; s++) {
    const on = [];
    for (let i = s; i < s + window; i++) on.push(i === 0 ? 0 : Math.log(bars[i].o / bars[i - 1].c));
    const vo = w4cSampleVariance(on);
    const vc = w4cSampleVariance(oc.slice(s, s + window));
    let vr = 0;
    for (let i = s; i < s + window; i++) vr += rs[i];
    vr /= window;
    const raw = vo + k * vc + (1 - k) * vr;
    if (!Number.isFinite(raw)) return [];
    out.push(Math.sqrt(Math.max(0, raw)));
  }
  return out;
}

function w4cSolveNormal(xtx, xty) {
  const p = xty.length;
  const aug = xtx.map((row, i) => row.concat([xty[i]]));
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(aug[r][c]) > Math.abs(aug[piv][c])) piv = r;
    if (!(Math.abs(aug[piv][c]) > 1e-12)) return null;
    const tmp = aug[c]; aug[c] = aug[piv]; aug[piv] = tmp;
    const d = aug[c][c];
    for (let k = c; k <= p; k++) aug[c][k] /= d;
    for (let r = 0; r < p; r++) {
      if (r === c) continue;
      const f = aug[r][c];
      if (f === 0) continue;
      for (let k = c; k <= p; k++) aug[r][k] -= f * aug[c][k];
    }
  }
  return aug.map((row) => row[p]);
}

function w4cHarFeatures(history, daily, weekly, monthly) {
  const tail = (w) => {
    let sum = 0;
    for (let i = history.length - w; i < history.length; i++) sum += history[i];
    return sum / w;
  };
  return [1, tail(daily), tail(weekly), tail(monthly)];
}

export function fitHarVolForecast(trainVols, { daily = 1, weekly = 5, monthly = 22 } = {}) {
  for (const [name, v] of [['daily', daily], ['weekly', weekly], ['monthly', monthly]]) {
    if (!Number.isInteger(v) || v < 1) return { available: false, reason: `${name} must be a positive integer (W4c)` };
  }
  if (!(daily <= weekly && weekly <= monthly)) return { available: false, reason: 'need daily <= weekly <= monthly (W4c)' };
  if (!Array.isArray(trainVols)) return { available: false, reason: 'trainVols must be an array (W4c)' };
  for (const v of trainVols) if (!Number.isFinite(v)) return { available: false, reason: 'non-finite vol (W4c)' };
  const p = 4;
  const rows = [];
  const ys = [];
  for (let t = monthly; t < trainVols.length; t++) {
    rows.push(w4cHarFeatures(trainVols.slice(0, t), daily, weekly, monthly));
    ys.push(trainVols[t]);
  }
  if (rows.length < p + 1) return { available: false, reason: 'insufficient rows to fit HAR (W4c)' };
  const xtx = Array.from({ length: p }, () => new Array(p).fill(0));
  const xty = new Array(p).fill(0);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    for (let a = 0; a < p; a++) {
      xty[a] += r[a] * ys[i];
      for (let b = 0; b < p; b++) xtx[a][b] += r[a] * r[b];
    }
  }
  const coef = w4cSolveNormal(xtx, xty);
  if (!coef) return { available: false, reason: 'singular HAR normal equations (W4c)' };
  return { available: true, daily, weekly, monthly, coef, rows: rows.length };
}

export function predictHarVolForecast(fit, history) {
  const coef = Array.isArray(fit) ? fit : (fit && fit.coef);
  const daily = Array.isArray(fit) ? 1 : Number((fit && fit.daily) || 1);
  const weekly = Array.isArray(fit) ? 5 : Number((fit && fit.weekly) || 5);
  const monthly = Array.isArray(fit) ? 22 : Number((fit && fit.monthly) || 22);
  if (!Array.isArray(coef) || coef.length !== 4) return NaN;
  if (!Array.isArray(history) || history.length < monthly) return NaN;
  for (const v of history.slice(history.length - monthly)) if (!Number.isFinite(v)) return NaN;
  const f = w4cHarFeatures(history, daily, weekly, monthly);
  return coef[0] * f[0] + coef[1] * f[1] + coef[2] * f[2] + coef[3] * f[3];
}

export function tournamentHarVolForecast(vols, { split = 0.5, lambda = 0.94, order = 1, har = {} } = {}) {
  if (!Array.isArray(vols) || vols.length < 8) return { available: false, reason: 'need at least 8 finite vols (W4c)' };
  if (!Number.isFinite(split) || split <= 0 || split >= 1) return { available: false, reason: 'split must be in (0,1) (W4c)' };
  for (const v of vols) if (!Number.isFinite(v)) return { available: false, reason: 'non-finite vol (W4c)' };
  const hh = { daily: 1, weekly: 5, monthly: 22, ...(har || {}) };
  if (!Number.isInteger(order) || order < 1) return { available: false, reason: 'order must be a positive integer (W4c)' };
  const n = vols.length;
  const trainN = Math.floor(n * split);
  const need = Math.max(order + 2, hh.monthly + 1);
  if (!(trainN >= need) || !(n - trainN >= 2)) return { available: false, reason: 'split leaves too little train or test (W4c)' };
  const train = vols.slice(0, trainN);
  const test = vols.slice(trainN);
  const arFit = fitArVolForecast(train, { order });
  if (!arFit.available) return { available: false, reason: arFit.reason };
  const harFit = fitHarVolForecast(train, hh);
  if (!harFit.available) return { available: false, reason: harFit.reason };
  let ewmaFull;
  try { ewmaFull = ewmaVolForecast(vols, { lambda }); } catch (e) { return { available: false, reason: String((e && e.message) || e) }; }
  let mean = 0;
  for (const v of train) mean += v;
  mean /= train.length;
  const histNeed = Math.max(order, harFit.monthly);
  const actual = [];
  const ewma = [];
  const ar = [];
  const harF = [];
  const flat = [];
  for (let j = 0; j < test.length; j++) {
    const g = trainN + j;
    const hist = vols.slice(g - histNeed, g);
    if (hist.length < histNeed) continue;
    const pa = predictArVolForecast(arFit, hist.slice(hist.length - order));
    const ph = predictHarVolForecast(harFit, hist);
    if (!Number.isFinite(pa) || !Number.isFinite(ph)) continue;
    actual.push(test[j]);
    ewma.push(ewmaFull[g]);
    ar.push(pa);
    harF.push(ph);
    flat.push(mean);
  }
  if (actual.length < 2) return { available: false, reason: 'insufficient OOS points (W4c)' };
  const se = volForecastSkill(actual, ewma, flat);
  const sa = volForecastSkill(actual, ar, flat);
  const sh = volForecastSkill(actual, harF, flat);
  if (!se.available || !sa.available || !sh.available) return { available: false, reason: 'degenerate OOS baseline (W4c)' };
  const skills = { ewma: se.skill, ar: sa.skill, har: sh.skill };
  let winner = 'ewma';
  if (skills.ar > skills[winner]) winner = 'ar';
  if (skills.har > skills[winner]) winner = 'har';
  return {
    available: true, n, trainN, testN: actual.length, order, lambda,
    daily: harFit.daily, weekly: harFit.weekly, monthly: harFit.monthly,
    coef: arFit.coef.slice(), harCoef: harFit.coef.slice(),
    mseBaseline: se.mseBaseline, mseEwma: se.mseForecast, mseAr: sa.mseForecast, mseHar: sh.mseForecast,
    ewmaSkill: se.skill, arSkill: sa.skill, harSkill: sh.skill,
    winner, beatsAr: sh.skill > sa.skill,
  };
}

export function tournamentHarVolForecastAcrossSplits(vols, { splits = [0.3, 0.4, 0.5, 0.6, 0.7], lambda = 0.94, order = 1, har = {} } = {}) {
  if (!Array.isArray(vols) || vols.length < 8) return { available: false, reason: 'need at least 8 finite vols (W4c)' };
  if (!Array.isArray(splits) || !splits.length) return { available: false, reason: 'splits must be a non-empty array (W4c)' };
  for (const s of splits) if (!Number.isFinite(s) || s <= 0 || s >= 1) return { available: false, reason: 'every split must be in (0,1) (W4c)' };
  const perSplit = [];
  for (const s of splits) {
    const t = tournamentHarVolForecast(vols, { split: s, lambda, order, har });
    if (!t.available) return { available: false, reason: `split ${s}: ${t.reason}` };
    perSplit.push({ split: s, ewmaSkill: t.ewmaSkill, arSkill: t.arSkill, harSkill: t.harSkill, winner: t.winner });
  }
  const harWins = perSplit.filter((p) => p.winner === 'har').length;
  const arWins = perSplit.filter((p) => p.winner === 'ar').length;
  return {
    available: true, n: vols.length, splits: splits.slice(), lambda, order,
    perSplit, harWins, arWins, ewmaWins: perSplit.length - harWins - arWins,
    harWinFraction: harWins / perSplit.length,
    arWinFraction: arWins / perSplit.length,
  };
}

export function expandingVolForecasts(vols, { minTrain = 100, step = 1, lambda = 0.94, order = 1, har = {} } = {}) {
  if (!Array.isArray(vols) || vols.length < 8) return { available: false, reason: 'need at least 8 finite vols (W4c-x)' };
  for (const v of vols) if (!Number.isFinite(v)) return { available: false, reason: 'non-finite vol (W4c-x)' };
  if (!Number.isInteger(minTrain) || minTrain < 8) return { available: false, reason: 'minTrain must be an integer of at least 8 (W4c-x)' };
  if (!Number.isInteger(step) || step < 1) return { available: false, reason: 'step must be a positive integer (W4c-x)' };
  if (!Number.isInteger(order) || order < 1) return { available: false, reason: 'order must be a positive integer (W4c-x)' };
  const hh = { daily: 1, weekly: 5, monthly: 22, ...(har || {}) };
  const histNeed = Math.max(order, hh.monthly);
  if (!(minTrain > histNeed)) return { available: false, reason: 'minTrain must exceed the longest lag (W4c-x)' };
  if (!(vols.length > minTrain)) return { available: false, reason: 'no out-of-sample points beyond minTrain (W4c-x)' };
  let ewmaFull;
  try { ewmaFull = ewmaVolForecast(vols, { lambda }); } catch (e) { return { available: false, reason: String((e && e.message) || e) }; }
  const actual = [];
  const ewma = [];
  const ar = [];
  const harF = [];
  const flat = [];
  for (let g = minTrain; g < vols.length; g += step) {
    const train = vols.slice(0, g);
    const arFit = fitArVolForecast(train, { order });
    const harFit = fitHarVolForecast(train, hh);
    if (!arFit.available || !harFit.available) continue;
    const hist = vols.slice(g - histNeed, g);
    const pa = predictArVolForecast(arFit, hist.slice(hist.length - order));
    const ph = predictHarVolForecast(harFit, hist);
    if (!Number.isFinite(pa) || !Number.isFinite(ph)) continue;
    let mean = 0;
    for (const v of train) mean += v;
    mean /= train.length;
    actual.push(vols[g]);
    ewma.push(ewmaFull[g]);
    ar.push(pa);
    harF.push(ph);
    flat.push(mean);
  }
  if (actual.length < 2) return { available: false, reason: 'insufficient out-of-sample points (W4c-x)' };
  const se = volForecastSkill(actual, ewma, flat);
  const sa = volForecastSkill(actual, ar, flat);
  const sh = volForecastSkill(actual, harF, flat);
  if (!se.available || !sa.available || !sh.available) return { available: false, reason: 'degenerate out-of-sample baseline (W4c-x)' };
  const skills = { ewma: se.skill, ar: sa.skill, har: sh.skill };
  let winner = 'ewma';
  if (skills.ar > skills[winner]) winner = 'ar';
  if (skills.har > skills[winner]) winner = 'har';
  return {
    available: true, n: vols.length, minTrain, step, order, lambda,
    daily: hh.daily, weekly: hh.weekly, monthly: hh.monthly,
    points: actual.length, actual, ewma, ar, har: harF, baseline: flat,
    mseBaseline: se.mseBaseline, mseEwma: se.mseForecast, mseAr: sa.mseForecast, mseHar: sh.mseForecast,
    ewmaSkill: se.skill, arSkill: sa.skill, harSkill: sh.skill,
    winner, beatsAr: sh.skill > sa.skill,
  };
}

export function tournamentHarVolPanel(volsByStream, { splits = [0.3, 0.4, 0.5, 0.6, 0.7], lambda = 0.94, order = 1, har = {} } = {}) {  if (!volsByStream || typeof volsByStream !== 'object' || Array.isArray(volsByStream)) return { available: false, reason: 'volsByStream must be a {id: vols} object (W4c)' };
  const ids = Object.keys(volsByStream);
  if (!ids.length) return { available: false, reason: 'volsByStream must not be empty (W4c)' };
  const perStream = {};
  for (const id of ids) {
    const t = tournamentHarVolForecastAcrossSplits(volsByStream[id], { splits, lambda, order, har });
    if (!t.available) return { available: false, reason: `${id}: ${t.reason}` };
    perStream[id] = t;
  }
  const harMajority = ids.filter((id) => perStream[id].harWinFraction > 0.5);
  const arMajority = ids.filter((id) => perStream[id].arWinFraction > 0.5);
  return {
    available: true, streams: ids.length, splits: splits.slice(), lambda, order,
    perStream, harMajority: harMajority.length, arMajority: arMajority.length,
    harMajorityFraction: harMajority.length / ids.length,
    arMajorityFraction: arMajority.length / ids.length,
    unanimousHar: harMajority.length === ids.length,
    unanimousAr: arMajority.length === ids.length,
  };
}

// ---- W4c-y: forecast combination (round 64) ---------------------------------
// Bates & Granger (1969): a combination of rival forecasts usually beats every
// rival on its own. Timmermann (2006): estimated "optimal" weights add
// estimation error, so the simple equal-weight average is the reference to
// beat (the forecast combination puzzle). Audrino & Knaus (2016, arXiv
// 1610.02653): lasso-regularised combinations win on realized-variance panels.
// Every weight below is fit on a weight-train span and scored on a LATER
// weight-test span — never the same bars.
function w4cCollectCombinePairs(actual, cols) {
  const rows = [];
  const ys = [];
  const m = actual.length;
  for (let i = 0; i < m; i++) {
    const y = actual[i];
    if (!Number.isFinite(y)) continue;
    const row = [];
    let ok = true;
    for (const c of cols) {
      const v = c[i];
      if (!Number.isFinite(v)) { ok = false; break; }
      row.push(v);
    }
    if (!ok) continue;
    rows.push(row);
    ys.push(y);
  }
  return { rows, ys };
}

export function fitCombineWeights(trainActual, trainCols, { intercept = false } = {}) {
  if (!Array.isArray(trainActual)) return { available: false, reason: 'trainActual must be an array (W4c-y)' };
  if (!Array.isArray(trainCols) || !trainCols.length) return { available: false, reason: 'need at least one forecast column (W4c-y)' };
  for (const c of trainCols) {
    if (!Array.isArray(c) || c.length !== trainActual.length) return { available: false, reason: 'forecast columns must align with actual (W4c-y)' };
  }
  const K = trainCols.length;
  const p = K + (intercept ? 1 : 0);
  const { rows, ys } = w4cCollectCombinePairs(trainActual, trainCols);
  if (rows.length < p + 1) return { available: false, reason: 'insufficient finite rows to fit combination (W4c-y)' };
  const full = rows.map((r) => (intercept ? [1, ...r] : r.slice()));
  const xtx = Array.from({ length: p }, () => new Array(p).fill(0));
  const xty = new Array(p).fill(0);
  for (let i = 0; i < full.length; i++) {
    const r = full[i];
    for (let a = 0; a < p; a++) {
      xty[a] += r[a] * ys[i];
      for (let b = 0; b < p; b++) xtx[a][b] += r[a] * r[b];
    }
  }
  const coef = w4cSolveNormal(xtx, xty);
  if (!coef) return { available: false, reason: 'singular combination normal equations (W4c-y)' };
  return {
    available: true, rows: rows.length, hasIntercept: !!intercept,
    intercept: intercept ? coef[0] : 0, weights: intercept ? coef.slice(1) : coef.slice(),
  };
}

export function inverseMseWeights(trainActual, trainCols) {
  if (!Array.isArray(trainActual)) return { available: false, reason: 'trainActual must be an array (W4c-y)' };
  if (!Array.isArray(trainCols) || !trainCols.length) return { available: false, reason: 'need at least one forecast column (W4c-y)' };
  for (const c of trainCols) {
    if (!Array.isArray(c) || c.length !== trainActual.length) return { available: false, reason: 'forecast columns must align with actual (W4c-y)' };
  }
  const mses = [];
  for (const c of trainCols) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < trainActual.length; i++) {
      const y = trainActual[i];
      const f = c[i];
      if (!Number.isFinite(y) || !Number.isFinite(f)) continue;
      const d = y - f;
      sum += d * d;
      n++;
    }
    if (!n) return { available: false, reason: 'no finite pairs for a column (W4c-y)' };
    const mse = sum / n;
    if (!(mse > 0)) return { available: false, reason: 'a column is exact on train, no inverse weight (W4c-y)' };
    mses.push(mse);
  }
  let total = 0;
  for (const m of mses) total += 1 / m;
  return { available: true, mses, weights: mses.map((m) => (1 / m) / total) };
}

export function fitLassoCombineWeights(trainActual, trainCols, { l1 = 0.01, iters = 200 } = {}) {
  // Scale-free penalty: columns and target are RMS-normalised before the
  // coordinate descent and the weights mapped back, so one l1 means the same
  // shrinkage on vols of any magnitude (round 66 — a raw l1 is dominated by
  // the series scale and zeroes out small-magnitude panels).
  if (!Array.isArray(trainActual)) return { available: false, reason: 'trainActual must be an array (W4c-y)' };
  if (!Array.isArray(trainCols) || !trainCols.length) return { available: false, reason: 'need at least one forecast column (W4c-y)' };
  for (const c of trainCols) {
    if (!Array.isArray(c) || c.length !== trainActual.length) return { available: false, reason: 'forecast columns must align with actual (W4c-y)' };
  }
  if (!Number.isFinite(l1) || l1 < 0) return { available: false, reason: 'l1 must be a finite non-negative penalty (W4c-y)' };
  if (!Number.isInteger(iters) || iters < 1) return { available: false, reason: 'iters must be a positive integer (W4c-y)' };
  const { rows, ys } = w4cCollectCombinePairs(trainActual, trainCols);
  if (rows.length < 2) return { available: false, reason: 'insufficient finite rows to fit lasso combination (W4c-y)' };
  const n = rows.length;
  const K = trainCols.length;
  const z = new Array(K).fill(0);
  for (let j = 0; j < K; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += rows[i][j] * rows[i][j];
    z[j] = s / n;
  }
  const sc = z.map((v) => (v > 0 ? Math.sqrt(v) : 0));
  let sy = 0;
  for (const y of ys) sy += y * y;
  sy = Math.sqrt(sy / n);
  if (!(sy > 0)) return { available: true, rows: n, l1, iters, weights: new Array(K).fill(0) };
  const yn = ys.map((y) => y / sy);
  const xs = rows.map((r) => r.map((v, j) => (sc[j] > 0 ? v / sc[j] : 0)));
  const w = new Array(K).fill(0);
  const resid = yn.slice();
  for (let it = 0; it < iters; it++) {
    for (let j = 0; j < K; j++) {
      if (!(sc[j] > 0)) { w[j] = 0; continue; }
      let rho = 0;
      for (let i = 0; i < n; i++) rho += xs[i][j] * (resid[i] + w[j] * xs[i][j]);
      rho /= n;
      const nw = Math.sign(rho) * Math.max(0, Math.abs(rho) - l1);
      const dw = nw - w[j];
      if (dw !== 0) {
        w[j] = nw;
        for (let i = 0; i < n; i++) resid[i] -= dw * xs[i][j];
      }
    }
  }
  const weights = w.map((v, j) => (sc[j] > 0 ? (v * sy) / sc[j] : 0));
  return { available: true, rows: n, l1, iters, weights };
}

export function predictCombine(forecasts, weights) {
  if (!Array.isArray(forecasts) || !Array.isArray(weights)) return NaN;
  if (!forecasts.length || forecasts.length !== weights.length) return NaN;
  let s = 0;
  for (let k = 0; k < forecasts.length; k++) {
    const f = forecasts[k];
    const w = weights[k];
    if (!Number.isFinite(f) || !Number.isFinite(w)) return NaN;
    s += f * w;
  }
  return s;
}

const W4CY_ORDER = ['ewma', 'ar', 'har', 'eq', 'inv', 'ols', 'lasso'];

export function tournamentCombineVolForecast(vols, { split = 0.5, lambda = 0.94, order = 1, har = {}, lasso = {} } = {}) {
  if (!Array.isArray(vols) || vols.length < 8) return { available: false, reason: 'need at least 8 finite vols (W4c-y)' };
  if (!Number.isFinite(split) || split <= 0 || split >= 1) return { available: false, reason: 'split must be in (0,1) (W4c-y)' };
  for (const v of vols) if (!Number.isFinite(v)) return { available: false, reason: 'non-finite vol (W4c-y)' };
  if (!Number.isInteger(order) || order < 1) return { available: false, reason: 'order must be a positive integer (W4c-y)' };
  const hh = { daily: 1, weekly: 5, monthly: 22, ...(har || {}) };
  const n = vols.length;
  const trainN = Math.floor(n * split);
  const need = Math.max(order + 2, hh.monthly + 1);
  if (!(trainN >= need) || !(n - trainN >= 2)) return { available: false, reason: 'split leaves too little train or test (W4c-y)' };
  const train = vols.slice(0, trainN);
  const test = vols.slice(trainN);
  const arFit = fitArVolForecast(train, { order });
  if (!arFit.available) return { available: false, reason: arFit.reason };
  const harFit = fitHarVolForecast(train, hh);
  if (!harFit.available) return { available: false, reason: harFit.reason };
  let ewmaFull;
  try { ewmaFull = ewmaVolForecast(vols, { lambda }); } catch (e) { return { available: false, reason: String((e && e.message) || e) }; }
  let mean = 0;
  for (const v of train) mean += v;
  mean /= train.length;
  const histNeed = Math.max(order, harFit.monthly);
  const actual = [];
  const ewma = [];
  const ar = [];
  const harF = [];
  for (let j = 0; j < test.length; j++) {
    const g = trainN + j;
    const hist = vols.slice(g - histNeed, g);
    if (hist.length < histNeed) continue;
    const pa = predictArVolForecast(arFit, hist.slice(hist.length - order));
    const ph = predictHarVolForecast(harFit, hist);
    if (!Number.isFinite(pa) || !Number.isFinite(ph)) continue;
    actual.push(test[j]);
    ewma.push(ewmaFull[g]);
    ar.push(pa);
    harF.push(ph);
  }
  if (actual.length < 8) return { available: false, reason: 'insufficient OOS points for a weight split (W4c-y)' };
  const cut = Math.floor(actual.length / 2);
  const wTrain = (arr) => arr.slice(0, cut);
  const wTest = (arr) => arr.slice(cut);
  const wTrainCols = [wTrain(ewma), wTrain(ar), wTrain(harF)];
  const inv = inverseMseWeights(wTrain(actual), wTrainCols);
  if (!inv.available) return { available: false, reason: `inverse-MSE weights: ${inv.reason}` };
  const ols = fitCombineWeights(wTrain(actual), wTrainCols);
  if (!ols.available) return { available: false, reason: `OLS weights: ${ols.reason}` };
  const las = fitLassoCombineWeights(wTrain(actual), wTrainCols, lasso);
  if (!las.available) return { available: false, reason: `lasso weights: ${las.reason}` };
  const eqW = [1 / 3, 1 / 3, 1 / 3];
  const testCols = [wTest(ewma), wTest(ar), wTest(harF)];
  const flat = wTest(actual).map(() => mean);
  const series = {
    ewma: wTest(ewma), ar: wTest(ar), har: wTest(harF),
    eq: [], inv: [], ols: [], lasso: [],
  };
  for (let i = 0; i < wTest(actual).length; i++) {
    const f = [testCols[0][i], testCols[1][i], testCols[2][i]];
    series.eq.push((f[0] + f[1] + f[2]) / 3);
    series.inv.push(predictCombine(f, inv.weights));
    series.ols.push(predictCombine(f, ols.weights));
    series.lasso.push(predictCombine(f, las.weights));
  }
  const skills = {};
  const mses = {};
  for (const k of W4CY_ORDER) {
    const s = volForecastSkill(wTest(actual), series[k], flat);
    if (!s.available) return { available: false, reason: `degenerate weight-test baseline for ${k} (W4c-y)` };
    skills[k] = s.skill;
    mses[k] = s.mseForecast;
  }
  let winner = W4CY_ORDER[0];
  for (const k of W4CY_ORDER) if (skills[k] > skills[winner]) winner = k;
  const bestCombineSkill = Math.max(skills.eq, skills.inv, skills.ols, skills.lasso);
  const bestCombine = W4CY_ORDER.filter((k) => k === 'eq' || k === 'inv' || k === 'ols' || k === 'lasso')
    .find((k) => skills[k] === bestCombineSkill);
  const wta = wTest(actual);
  const qi = [];
  for (let i = 0; i < wta.length; i++) {
    if (!(wta[i] > 0)) continue;
    let ok = true;
    for (const k of W4CY_ORDER) if (!(series[k][i] > 0)) { ok = false; break; }
    if (ok) qi.push(i);
  }
  let qlike = null;
  if (qi.length >= 2) {
    const qSkills = {};
    let qOk = true;
    for (const k of W4CY_ORDER) {
      const s = volForecastQlike(qi.map((i) => wta[i]), qi.map((i) => series[k][i]), qi.map(() => mean));
      if (!s.available) { qOk = false; break; }
      qSkills[k] = s.skill;
    }
    if (qOk) {
      let qw = W4CY_ORDER[0];
      for (const k of W4CY_ORDER) if (qSkills[k] > qSkills[qw]) qw = k;
      const qBest = Math.max(qSkills.eq, qSkills.inv, qSkills.ols, qSkills.lasso);
      qlike = { available: true, n: qi.length, skills: qSkills, winner: qw, bestCombineSkill: qBest, beatsHar: qBest > qSkills.har };
    }
  }
  return {
    available: true, n, trainN, testN: actual.length,
    weightTrainN: cut, weightTestN: actual.length - cut,
    order, lambda, daily: harFit.daily, weekly: harFit.weekly, monthly: harFit.monthly,
    skills, mses, mseBaseline: volForecastSkill(wTest(actual), series[winner], flat).mseBaseline,
    weights: { eq: eqW, inv: inv.weights.slice(), ols: ols.weights.slice(), lasso: las.weights.slice() },
    olsIntercept: ols.intercept, lassoL1: las.l1,
    winner, bestCombine, bestCombineSkill,
    beatsHar: bestCombineSkill > skills.har,
    qlike: qlike || { available: false, reason: 'insufficient all-positive weight-test bars (W4c-yq)' },
  };
}

export function tournamentCombineVolForecastAcrossSplits(vols, { splits = [0.3, 0.4, 0.5, 0.6, 0.7], lambda = 0.94, order = 1, har = {}, lasso = {} } = {}) {
  if (!Array.isArray(vols) || vols.length < 8) return { available: false, reason: 'need at least 8 finite vols (W4c-y)' };
  if (!Array.isArray(splits) || !splits.length) return { available: false, reason: 'splits must be a non-empty array (W4c-y)' };
  for (const s of splits) if (!Number.isFinite(s) || s <= 0 || s >= 1) return { available: false, reason: 'every split must be in (0,1) (W4c-y)' };
  const perSplit = [];
  for (const s of splits) {
    const t = tournamentCombineVolForecast(vols, { split: s, lambda, order, har, lasso });
    if (!t.available) return { available: false, reason: `split ${s}: ${t.reason}` };
    perSplit.push({ split: s, winner: t.winner, skills: { ...t.skills }, beatsHar: t.beatsHar, qlikeWinner: t.qlike.available ? t.qlike.winner : null, qlikeSkills: t.qlike.available ? { ...t.qlike.skills } : null });
  }
  const wins = {};
  for (const k of W4CY_ORDER) wins[k] = perSplit.filter((p) => p.winner === k).length;
  const combineWins = wins.eq + wins.inv + wins.ols + wins.lasso;
  const qDecided = perSplit.filter((p) => p.qlikeWinner !== null);
  const qWins = {};
  for (const k of W4CY_ORDER) qWins[k] = qDecided.filter((p) => p.qlikeWinner === k).length;
  const qCombineWins = qWins.eq + qWins.inv + qWins.ols + qWins.lasso;
  return {
    available: true, n: vols.length, splits: splits.slice(), lambda, order,
    perSplit, wins, combineWins,
    combineWinFraction: combineWins / perSplit.length,
    harWins: wins.har,
    harWinFraction: wins.har / perSplit.length,
    qlikeDecided: qDecided.length, qlikeAbstained: perSplit.length - qDecided.length,
    qlikeWins: qWins, qlikeCombineWins: qCombineWins,
    qlikeCombineWinFraction: qCombineWins / perSplit.length,
    qlikeHarWins: qWins.har,
  };
}

export function tournamentCombineVolPanel(volsByStream, { splits = [0.3, 0.4, 0.5, 0.6, 0.7], lambda = 0.94, order = 1, har = {}, lasso = {} } = {}) {
  if (!volsByStream || typeof volsByStream !== 'object' || Array.isArray(volsByStream)) return { available: false, reason: 'volsByStream must be a {id: vols} object (W4c-y)' };
  const ids = Object.keys(volsByStream);
  if (!ids.length) return { available: false, reason: 'volsByStream must not be empty (W4c-y)' };
  const perStream = {};
  for (const id of ids) {
    const t = tournamentCombineVolForecastAcrossSplits(volsByStream[id], { splits, lambda, order, har, lasso });
    if (!t.available) return { available: false, reason: `${id}: ${t.reason}` };
    perStream[id] = t;
  }
  const majority = (k) => ids.filter((id) => perStream[id].wins[k] / perStream[id].perSplit.length > 0.5);
  const harMaj = majority('har');
  const combineMaj = ids.filter((id) => {
    const w = perStream[id].wins;
    return (w.eq + w.inv + w.ols + w.lasso) / perStream[id].perSplit.length > 0.5;
  });
  const qMaj = (get) => ids.filter((id) => {
    const t = perStream[id];
    if (!t.qlikeDecided) return false;
    return get(t) / t.perSplit.length > 0.5;
  });
  const qCombineMaj = qMaj((t) => t.qlikeCombineWins);
  const qHarMaj = qMaj((t) => t.qlikeHarWins);
  return {
    available: true, streams: ids.length, splits: splits.slice(), lambda, order,
    perStream,
    harMajority: harMaj.length, harMajorityFraction: harMaj.length / ids.length,
    unanimousHar: harMaj.length === ids.length,
    combineMajority: combineMaj.length, combineMajorityFraction: combineMaj.length / ids.length,
    unanimousCombine: combineMaj.length === ids.length,
    qlikeCombineMajority: qCombineMaj.length,
    qlikeCombineMajorityFraction: qCombineMaj.length / ids.length,
    unanimousQlikeCombine: qCombineMaj.length === ids.length,
    qlikeHarMajority: qHarMaj.length,
    qlikeHarMajorityFraction: qHarMaj.length / ids.length,
  };
}

// ---- W4c-z: forecast-sized books (round 65) ---------------------------------
// F-16/F-106: sizing is a risk result, not a forecast result — the repo owns
// the causal scaling arithmetic, the caller owns the target (re-estimated
// causally, never banked). `target` is a scalar vol or a per-bar array aligned
// with `vols` (e.g. a trailing mean); every bar with a non-finite return, a
// non-positive forecast vol, or a non-positive target is skipped, never
// assigned an infinite scale.
export function applyVolTargetScaling(returns, vols, { target, cap = 4 } = {}) {
  if (!Array.isArray(returns) || !Array.isArray(vols) || returns.length !== vols.length) return { available: false, reason: 'returns and vols must be aligned arrays (W4c-z)' };
  if (!Array.isArray(target) && !(target > 0)) return { available: false, reason: 'target must be a positive vol (W4c-z)' };
  if (Array.isArray(target) && target.length !== vols.length) return { available: false, reason: 'array target must align with vols (W4c-z)' };
  if (!(cap > 0)) return { available: false, reason: 'cap must be a positive multiple (W4c-z)' };
  const index = [];
  const scaled = [];
  const scales = [];
  let skipped = 0;
  for (let t = 0; t < returns.length; t++) {
    const r = returns[t];
    const v = vols[t];
    const tg = Array.isArray(target) ? target[t] : target;
    if (!Number.isFinite(r) || !Number.isFinite(v) || !(v > 0) || !(tg > 0)) { skipped++; continue; }
    const s = Math.min(cap, tg / v);
    index.push(t);
    scales.push(s);
    scaled.push(s * r);
  }
  if (!scaled.length) return { available: false, reason: 'no scorable bars (W4c-z)' };
  return { available: true, n: returns.length, scored: scaled.length, skipped, index, scales, scaled };
}

// ---- W4c-w: online (rolling) combination (round 67) --------------------------
// Frozen weights assume the best blend is stationary. Online combination
// re-fits the blend on a trailing window of realised (actual, forecast)
// tuples - the rolling analogue of Bates & Granger (1969); the Gibbs
// (exponential-loss) arm is the plain member of the Generalized Gibbs
// Ensemble Weighting family (arXiv 2608.28116); the frozen-vs-rolling frame
// is the "frozen + online" simplex of the downside-controlled online
// combination literature (arXiv 2609.29096). Every weight at bar i reads only
// tuples strictly before i.
export function gibbsCombineWeights(trainActual, trainCols, { eta = 2 } = {}) {
  if (!Array.isArray(trainActual)) return { available: false, reason: 'trainActual must be an array (W4c-w)' };
  if (!Array.isArray(trainCols) || !trainCols.length) return { available: false, reason: 'need at least one forecast column (W4c-w)' };
  for (const c of trainCols) {
    if (!Array.isArray(c) || c.length !== trainActual.length) return { available: false, reason: 'forecast columns must align with actual (W4c-w)' };
  }
  if (!Number.isFinite(eta) || eta < 0) return { available: false, reason: 'eta must be a finite non-negative temperature (W4c-w)' };
  const mses = [];
  for (const c of trainCols) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < trainActual.length; i++) {
      const y = trainActual[i];
      const f = c[i];
      if (!Number.isFinite(y) || !Number.isFinite(f)) continue;
      const d = y - f;
      sum += d * d;
      n++;
    }
    if (!n) return { available: false, reason: 'no finite pairs for a column (W4c-w)' };
    const mse = sum / n;
    if (!(mse > 0)) return { available: false, reason: 'a column is exact on train, no Gibbs weight (W4c-w)' };
    mses.push(mse);
  }
  const minMse = Math.min(...mses);
  const raw = mses.map((m) => Math.exp(-eta * (m / minMse - 1)));
  let total = 0;
  for (const r of raw) total += r;
  return { available: true, mses, eta, weights: raw.map((r) => r / total) };
}

const W4CW_METHODS = ['ols', 'eq', 'inv', 'gibbs', 'lasso'];

export function rollingCombineWeights(actual, cols, { window = 60, method = 'ols', lasso = {}, eta = 2 } = {}) {
  if (!Array.isArray(actual)) return { available: false, reason: 'actual must be an array (W4c-w)' };
  if (!Array.isArray(cols) || !cols.length) return { available: false, reason: 'need at least one forecast column (W4c-w)' };
  for (const c of cols) {
    if (!Array.isArray(c) || c.length !== actual.length) return { available: false, reason: 'forecast columns must align with actual (W4c-w)' };
  }
  if (!W4CW_METHODS.includes(method)) return { available: false, reason: `method must be one of ${W4CW_METHODS.join(',')} (W4c-w)` };
  const K = cols.length;
  const minBars = K + 1;
  if (!Number.isInteger(window) || window < minBars) return { available: false, reason: `window must be an integer of at least ${minBars} (W4c-w)` };
  if (actual.length <= minBars) return { available: false, reason: 'no bars beyond the fitting minimum (W4c-w)' };
  const fitAt = (lo, hi) => {
    const a = actual.slice(lo, hi);
    const cc = cols.map((c) => c.slice(lo, hi));
    if (method === 'eq') return { available: true, weights: new Array(K).fill(1 / K) };
    if (method === 'inv') return inverseMseWeights(a, cc);
    if (method === 'gibbs') return gibbsCombineWeights(a, cc, { eta });
    if (method === 'lasso') return fitLassoCombineWeights(a, cc, lasso);
    return fitCombineWeights(a, cc);
  };
  const weights = [];
  const combined = [];
  for (let i = 0; i < actual.length; i++) {
    if (i < minBars) { weights.push(null); combined.push(NaN); continue; }
    const lo = Math.max(0, i - window);
    const f = fitAt(lo, i);
    if (!f.available) { weights.push(null); combined.push(NaN); continue; }
    const fc = cols.map((c) => c[i]);
    weights.push(f.weights.slice());
    combined.push(predictCombine(fc, f.weights));
  }
  const scored = combined.filter((v) => Number.isFinite(v)).length;
  if (!scored) return { available: false, reason: 'no scorable bars (W4c-w)' };
  return { available: true, n: actual.length, window, method, minBars, weights, combined, scored };
}

const W4CR_ORDER = ['ewma', 'ar', 'har', 'eq', 'frozen', 'rols', 'rinv', 'rgibbs'];

export function tournamentRollingCombineVolForecast(vols, { split = 0.5, window = 60, lambda = 0.94, order = 1, har = {}, lasso = {}, eta = 2 } = {}) {
  if (!Array.isArray(vols) || vols.length < 8) return { available: false, reason: 'need at least 8 finite vols (W4c-w)' };
  if (!Number.isFinite(split) || split <= 0 || split >= 1) return { available: false, reason: 'split must be in (0,1) (W4c-w)' };
  for (const v of vols) if (!Number.isFinite(v)) return { available: false, reason: 'non-finite vol (W4c-w)' };
  if (!Number.isInteger(order) || order < 1) return { available: false, reason: 'order must be a positive integer (W4c-w)' };
  const hh = { daily: 1, weekly: 5, monthly: 22, ...(har || {}) };
  const n = vols.length;
  const trainN = Math.floor(n * split);
  const need = Math.max(order + 2, hh.monthly + 1);
  if (!(trainN >= need) || !(n - trainN >= 2)) return { available: false, reason: 'split leaves too little train or test (W4c-w)' };
  const train = vols.slice(0, trainN);
  const test = vols.slice(trainN);
  const arFit = fitArVolForecast(train, { order });
  if (!arFit.available) return { available: false, reason: arFit.reason };
  const harFit = fitHarVolForecast(train, hh);
  if (!harFit.available) return { available: false, reason: harFit.reason };
  let ewmaFull;
  try { ewmaFull = ewmaVolForecast(vols, { lambda }); } catch (e) { return { available: false, reason: String((e && e.message) || e) }; }
  let mean = 0;
  for (const v of train) mean += v;
  mean /= train.length;
  const histNeed = Math.max(order, harFit.monthly);
  const actual = [];
  const ewma = [];
  const ar = [];
  const harF = [];
  for (let j = 0; j < test.length; j++) {
    const g = trainN + j;
    const hist = vols.slice(g - histNeed, g);
    if (hist.length < histNeed) continue;
    const pa = predictArVolForecast(arFit, hist.slice(hist.length - order));
    const ph = predictHarVolForecast(harFit, hist);
    if (!Number.isFinite(pa) || !Number.isFinite(ph)) continue;
    actual.push(test[j]);
    ewma.push(ewmaFull[g]);
    ar.push(pa);
    harF.push(ph);
  }
  if (actual.length < 8) return { available: false, reason: 'insufficient OOS points for a weight split (W4c-w)' };
  const cut = Math.floor(actual.length / 2);
  const frozen = fitCombineWeights(actual.slice(0, cut), [ewma.slice(0, cut), ar.slice(0, cut), harF.slice(0, cut)]);
  if (!frozen.available) return { available: false, reason: `frozen weights: ${frozen.reason}` };
  const roll = {};
  for (const m of ['ols', 'inv', 'gibbs']) {
    const r = rollingCombineWeights(actual, [ewma, ar, harF], { window, method: m, lasso, eta });
    if (!r.available) return { available: false, reason: `rolling ${m}: ${r.reason}` };
    roll[m] = r;
  }
  const K = 3;
  const minBars = K + 1;
  const scoreIdx = [];
  for (let i = Math.max(cut, minBars); i < actual.length; i++) {
    if (Number.isFinite(roll.ols.combined[i]) && Number.isFinite(roll.inv.combined[i]) && Number.isFinite(roll.gibbs.combined[i])) scoreIdx.push(i);
  }
  if (scoreIdx.length < 2) return { available: false, reason: 'insufficient jointly-scored bars (W4c-w)' };
  const at = (arr) => scoreIdx.map((i) => arr[i]);
  const flat = scoreIdx.map(() => mean);
  const series = {
    ewma: at(ewma), ar: at(ar), har: at(harF),
    eq: scoreIdx.map((i) => (ewma[i] + ar[i] + harF[i]) / 3),
    frozen: scoreIdx.map((i) => predictCombine([ewma[i], ar[i], harF[i]], frozen.weights)),
    rols: at(roll.ols.combined), rinv: at(roll.inv.combined), rgibbs: at(roll.gibbs.combined),
  };
  const skills = {};
  const mses = {};
  for (const k of W4CR_ORDER) {
    const s = volForecastSkill(at(actual), series[k], flat);
    if (!s.available) return { available: false, reason: `degenerate scoring span for ${k} (W4c-w)` };
    skills[k] = s.skill;
    mses[k] = s.mseForecast;
  }
  let winner = W4CR_ORDER[0];
  for (const k of W4CR_ORDER) if (skills[k] > skills[winner]) winner = k;
  const bestRollingSkill = Math.max(skills.rols, skills.rinv, skills.rgibbs);
  return {
    available: true, n, trainN, testN: actual.length, scoredN: scoreIdx.length,
    order, lambda, window,
    daily: harFit.daily, weekly: harFit.weekly, monthly: harFit.monthly,
    skills, mses, mseBaseline: volForecastSkill(at(actual), series[winner], flat).mseBaseline,
    frozenWeights: frozen.weights.slice(),
    winner,
    beatsFrozen: { rols: skills.rols > skills.frozen, rinv: skills.rinv > skills.frozen, rgibbs: skills.rgibbs > skills.frozen },
    bestRollingSkill,
    anyRollingBeatsFrozen: bestRollingSkill > skills.frozen,
  };
}

export function tournamentRollingCombineVolForecastAcrossSplits(vols, { splits = [0.3, 0.4, 0.5, 0.6, 0.7], window = 60, lambda = 0.94, order = 1, har = {}, lasso = {}, eta = 2 } = {}) {
  if (!Array.isArray(vols) || vols.length < 8) return { available: false, reason: 'need at least 8 finite vols (W4c-w)' };
  if (!Array.isArray(splits) || !splits.length) return { available: false, reason: 'splits must be a non-empty array (W4c-w)' };
  for (const s of splits) if (!Number.isFinite(s) || s <= 0 || s >= 1) return { available: false, reason: 'every split must be in (0,1) (W4c-w)' };
  const perSplit = [];
  for (const s of splits) {
    const t = tournamentRollingCombineVolForecast(vols, { split: s, window, lambda, order, har, lasso, eta });
    if (!t.available) return { available: false, reason: `split ${s}: ${t.reason}` };
    perSplit.push({ split: s, winner: t.winner, skills: { ...t.skills }, beatsFrozen: { ...t.beatsFrozen }, anyRollingBeatsFrozen: t.anyRollingBeatsFrozen });
  }
  const wins = {};
  for (const k of W4CR_ORDER) wins[k] = perSplit.filter((p) => p.winner === k).length;
  const rollingWins = wins.rols + wins.rinv + wins.rgibbs;
  return {
    available: true, n: vols.length, splits: splits.slice(), lambda, order, window,
    perSplit, wins, rollingWins, frozenWins: wins.frozen,
    rollingWinFraction: rollingWins / perSplit.length,
    frozenWinFraction: wins.frozen / perSplit.length,
  };
}

export function tournamentRollingCombineVolPanel(volsByStream, { splits = [0.3, 0.4, 0.5, 0.6, 0.7], window = 60, lambda = 0.94, order = 1, har = {}, lasso = {}, eta = 2 } = {}) {
  if (!volsByStream || typeof volsByStream !== 'object' || Array.isArray(volsByStream)) return { available: false, reason: 'volsByStream must be a {id: vols} object (W4c-w)' };
  const ids = Object.keys(volsByStream);
  if (!ids.length) return { available: false, reason: 'volsByStream must not be empty (W4c-w)' };
  const perStream = {};
  for (const id of ids) {
    const t = tournamentRollingCombineVolForecastAcrossSplits(volsByStream[id], { splits, window, lambda, order, har, lasso, eta });
    if (!t.available) return { available: false, reason: `${id}: ${t.reason}` };
    perStream[id] = t;
  }
  const rollingMaj = ids.filter((id) => perStream[id].rollingWins / perStream[id].perSplit.length > 0.5);
  const frozenMaj = ids.filter((id) => perStream[id].frozenWins / perStream[id].perSplit.length > 0.5);
  return {
    available: true, streams: ids.length, splits: splits.slice(), lambda, order, window,
    perStream,
    rollingMajority: rollingMaj.length, rollingMajorityFraction: rollingMaj.length / ids.length,
    unanimousRolling: rollingMaj.length === ids.length,
    frozenMajority: frozenMaj.length, frozenMajorityFraction: frozenMaj.length / ids.length,
  };
}

// Render the forecast block for the human summary.
export function formatForecast(block) {
    if (!block || !block.available) return `forecast: unavailable (${block ? block.reason : 'none'})`;
    const f = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
    const m90 = block.mcs && block.mcs.at90 && block.mcs.at90.available ? block.mcs.at90.memberIds.join(',') : 'n/a';
    const m95 = block.mcs && block.mcs.at95 && block.mcs.at95.available ? block.mcs.at95.memberIds.join(',') : 'n/a';
    const base = block.byId && block.byId[block.baselineId || 'baseline'];
    // R27-5: the block is scored per kind, so the summary names each group (a
    // signal family is not comparable to the probability-calibrated controller).
    const groups = Array.isArray(block.kinds) ? block.kinds.map((g) => `${g.kind}(${g.n})`).join(' ') : null;
    return `forecast: bars=${block.bars} baseRate=${f(block.baseRate)} ` +
        `baseline(brier=${f(base && base.brier)} log=${f(base && base.logScore)}) | mcs90=[${m90}] mcs95=[${m95}]` +
        (groups ? ` | groups: ${groups}` : '');
}
