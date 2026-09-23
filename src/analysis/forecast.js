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
    const variants = [{ id: baselineId, kind: baselineKind, pairs: base }];
    for (const c of candidates) {
        if (!c || c.foldInputs == null) continue;
        const pairs = forecastPairs(c.foldInputs);
        if (pairs.bars !== base.bars) {
            // Alignment is the whole point of a paired test; refuse rather than
            // silently compare mismatched windows.
            return { available: false, reason: `variant ${c.id} has ${pairs.bars} pairs, baseline has ${base.bars}` };
        }
        variants.push({ id: c.id, kind: c.kind || baselineKind, pairs });
    }
    const byId = {};
    for (const v of variants) {
        const decomp = brierDecomposition({ forecasts: v.pairs.forecasts, outcomes: v.pairs.outcomes, bins });
        byId[v.id] = {
            kind: v.kind,
            bars: v.pairs.bars,
            brier: decomp.brier,
            brierBinned: decomp.brierBinned,
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
    for (const v of variants) if (!kinds.includes(v.kind)) kinds.push(v.kind);
    const byKind = {};
    for (const kind of kinds) {
        const group = variants.filter((v) => v.kind === kind);
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
        if (v.kind === baselineKind) {
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
    const primary = byKind[baselineKind] || { mcs: { at90: null, at95: null } };
    return {
        available: true,
        bars: base.bars,
        baseRate: byId[baselineId].baseRate,
        baselineId,
        kind: baselineKind,
        kinds: kinds.map((k) => ({ kind: k, n: byKind[k].n, members: byKind[k].members })),
        byKind,
        byId,
        mcs: primary.mcs,
        reader: `proper scores (Brier + reliability/resolution/uncertainty, log score) per variant, grouped by \`kind\` (R27-5): the ${baselineKind} family's journaled confidence is \`confidenceFromProb(prob)\`, which \`(c+1)/2\` inverts exactly, so its Brier is a proper score of a probability and \`dm\` is the block-bootstrapped Diebold–Mariano test vs the baseline (favored = lower loss); a non-${baselineKind} family's confidence is a normalised z-score, so those candidates carry \`dm.available=false\` with a reason and are scored only against each other. \`mcs\` is the Hansen–Lunde–Nason Model Confidence Set of the baseline's kind at 90% and 95% (\`byKind[kind].mcs\` holds every kind) — the families that cannot be distinguished from the best. A single sample-best variant is not a winner (selection bias).`,
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
