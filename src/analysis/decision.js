// Decision-grade report (round 26, R26-8).
//
// The rest of the analysis layer computes numbers; this module turns them into a
// single artifact that answers the six questions the next cycle asks, with every
// field either a real value or an explicit `{ available: false, reason }` — never a
// silent `null` that a reader could mistake for a healthy zero. It computes NO new
// strategy statistic: every block here is a restatement of data already produced by
// the walk-forward, the dependence layer, the cost ladder, the forecast layer and
// the replication layer (R26-13/R26-14), which is exactly what makes the report
// "decision-grade" rather than another measurement.
//
// The six questions (and the block that answers each):
//   1. Did the models train, and on what?      -> `training`
//   2. Is the edge real?                        -> `edge`
//   3. Is it concentrated?                      -> `concentration`
//   4. Does it pay?                             -> `economics`
//   5. Is it the best family, or just these?    -> `family`
//   6. What would change the verdict?           -> `nextRun`
//
// References: the honest-evaluation battery already cited in `CITATIONS.md` (DSR /
// PBO / SPA / MinTRL); Pardo (2008) for stability as a promotion criterion (the
// concentration readout is its descriptive companion); Bouthillier et al. (2019)
// and Henderson et al. (2018) for why a single-seed point estimate is not a family
// decision (the `family` block's seed fields are `n/a` in a per-seed report — the
// cross-seed distribution is aggregated into `replication.json`, R26-13).
//
// Pure: no I/O, no RNG. Exact reference vectors live in `analysis.test.js`.

import { sharpeRatio } from './performance.js';
import { strategyReturns } from './backtest.js';
import { barsToDetect, UNDERPOWERED_MDE } from './walkforward.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const na = (reason) => ({ available: false, reason });

// ---------------------------------------------------------------------------
// Question 3 — concentration: how much of the edge is a handful of folds?
// ---------------------------------------------------------------------------
// `sig:volume`'s best 20 of 1,136 folds carried 108% of its gross P&L: a candidate
// can win the aggregate and still be a lottery ticket on a few windows. This block
// makes that visible in the artifact (top-K share, signed sums) and measures the
// two inferential consequences directly:
//   - the delete-one-cluster range: the pooled Sharpe when each single fold-window
//     is removed (a wide range means the aggregate is carried by one window);
//   - the per-fold marginal contribution: pooled(Sharpes all) minus pooled(Sharpes
//     without fold i), i.e. what each fold buys the headline number.
// The strategy net returns are rebuilt from the retained `foldInputs` with the same
// `strategyReturns` arithmetic the scored pass used, so this is a restatement, not a
// re-scoring.
export function foldConcentration({ folds, foldInputs = null, costBps = 0, periodsPerYear = 252, topKs = [1, 5, 20] } = {}) {
    if (!Array.isArray(folds) || folds.length === 0) return na('no per-fold metrics');
    const n = folds.length;
    const gross = folds.map((f) => (f && f.metrics && isNum(f.metrics.grossPnl) ? f.metrics.grossPnl : 0));
    const grossTotal = gross.reduce((a, b) => a + b, 0);
    let positiveSum = 0;
    let negativeSum = 0;
    for (const g of gross) {
        if (g > 0) positiveSum += g;
        else if (g < 0) negativeSum += g;
    }
    const sorted = gross.slice().sort((a, b) => b - a);
    const ks = [...new Set((Array.isArray(topKs) ? topKs : []).filter((k) => isNum(k) && k > 0).map((k) => Math.min(Math.floor(k), n)))].sort((a, b) => a - b);
    const topKsOut = ks.map((k) => ({
        k,
        share: grossTotal > 0 ? sorted.slice(0, k).reduce((a, b) => a + b, 0) / grossTotal : null,
    }));
    const block = {
        available: true,
        folds: n,
        grossTotal,
        positiveSum,
        negativeSum,
        topKs: topKsOut,
        deleteOneCluster: na('per-fold inputs were not retained (delete-one-cluster readout unavailable)'),
        marginal: na('per-fold inputs were not retained (per-fold marginal contribution unavailable)'),
        reader: 'top-K share of gross P&L, signed fold sums, the pooled Sharpe range across leave-one-fold-out panels (deleteOneCluster), and each fold\'s marginal contribution to the pooled Sharpe. A candidate whose best few folds carry the gross is a lottery ticket, however strong the aggregate.',
    };
    if (!Array.isArray(foldInputs) || foldInputs.length !== n) return block;
    const usable = foldInputs.every((fi) => fi && Array.isArray(fi.returns) && Array.isArray(fi.signals) && fi.returns.length === fi.signals.length);
    if (!usable) return block;
    const nets = foldInputs.map((fi) => strategyReturns({ returns: fi.returns, signals: fi.signals, costBps }).returns);
    const pooledAll = [].concat(...nets);
    const full = sharpeRatio(pooledAll, { periodsPerYear });
    const leaveOut = [];
    for (let i = 0; i < n; i++) {
        const rest = [].concat(...nets.slice(0, i), ...nets.slice(i + 1));
        leaveOut.push(sharpeRatio(rest, { periodsPerYear }));
    }
    let loIdx = -1;
    let hiIdx = -1;
    for (let i = 0; i < n; i++) {
        if (!isNum(leaveOut[i])) continue;
        if (loIdx === -1 || leaveOut[i] < leaveOut[loIdx]) loIdx = i;
        if (hiIdx === -1 || leaveOut[i] > leaveOut[hiIdx]) hiIdx = i;
    }
    if (loIdx !== -1) {
        block.deleteOneCluster = {
            available: true,
            full,
            min: leaveOut[loIdx],
            max: leaveOut[hiIdx],
            range: leaveOut[hiIdx] - leaveOut[loIdx],
            worstIndex: loIdx,
            bestIndex: hiIdx,
        };
    } else {
        block.deleteOneCluster = na('no finite leave-one-fold-out pooled Sharpe (the pooled returns have no variance to estimate a Sharpe from)');
    }
    const values = nets.map((_, i) => (isNum(full) && isNum(leaveOut[i]) ? full - leaveOut[i] : null));
    const finiteVals = values.filter(isNum);
    if (finiteVals.length) {
        let bi = -1;
        let wi = -1;
        for (let i = 0; i < values.length; i++) {
            if (!isNum(values[i])) continue;
            if (bi === -1 || values[i] > values[bi]) bi = i;
            if (wi === -1 || values[i] < values[wi]) wi = i;
        }
        block.marginal = {
            available: true,
            mean: finiteVals.reduce((a, b) => a + b, 0) / finiteVals.length,
            min: values[wi],
            max: values[bi],
            bestIndex: bi,
            worstIndex: wi,
            values,
        };
    } else {
        block.marginal = na('no finite per-fold marginal contribution (the pooled Sharpe is not finite)');
    }
    return block;
}

// ---------------------------------------------------------------------------
// Question 4b — how perishable is the raw confidence?
// ---------------------------------------------------------------------------
// The alpha-decay ranking input (arXiv 2502.04284): the lag-1 autocorrelation of
// the journaled raw pre-policy confidence, computed WITHIN each fold (a fold
// boundary is not a real time step), and the implied exponential half-life in bars.
// Straight-through confidence (half-life ~0) turns over every bar; a persistent
// confidence holds a position longer.
export function confidencePersistence({ foldInputs } = {}) {
    if (!Array.isArray(foldInputs) || foldInputs.length === 0) return na('no journaled confidence');
    let pairs = 0;
    let bars = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (const fi of foldInputs) {
        const c = fi && fi.confidence;
        if (!Array.isArray(c)) continue;
        bars += c.length;
        for (let t = 1; t < c.length; t++) {
            const a = c[t - 1];
            const b = c[t];
            if (!isNum(a) || !isNum(b)) continue;
            pairs += 1;
            sx += a;
            sy += b;
            sxx += a * a;
            syy += b * b;
            sxy += a * b;
        }
    }
    if (pairs < 2) return na('fewer than two adjacent finite confidence pairs');
    const mx = sx / pairs;
    const my = sy / pairs;
    const vx = sxx / pairs - mx * mx;
    const vy = syy / pairs - my * my;
    if (!(vx > 0 && vy > 0)) {
        return { available: true, bars, pairs, lag1: null, halfLife: null, note: 'the journaled confidence is constant (zero variance), so it has no decay rate' };
    }
    const lag1 = (sxy / pairs - mx * my) / Math.sqrt(vx * vy);
    // A lag-1 of exactly 1 is a perfectly persistent (or, with floating error,
    // numerically 1) series — there is no decay rate to report, so guard the
    // 1e-12 neighbourhood rather than emit an astronomically large half-life.
    const halfLife = lag1 > 0 && lag1 < 1 - 1e-12 ? Math.log(0.5) / Math.log(lag1) : null;
    return {
        available: true,
        bars,
        pairs,
        lag1,
        halfLife,
        note: 'lag-1 autocorrelation of the journaled raw pre-policy confidence within folds; halfLife = ln(0.5)/ln(lag1) bars (null when lag1 <= 0 or lag1 within 1e-12 of 1)',
    };
}

// ---------------------------------------------------------------------------
// Question 6 — what would change the verdict?
// ---------------------------------------------------------------------------
// `nextRunPlan` converts the finished run into the sizing knobs for the next one:
// how many bars a detection needs at the measured design effect, whether the edge
// clears a realistic taker cost, and the single cheapest lever that would move the
// decision. It is deliberately conservative: every hint is guarded and returns
// `null` (with the surrounding block still `available`) rather than inventing a
// number the data cannot support.
export function nextRunPlan({
    power = null, dependence = null, candidate = null, baseline = null,
    levels = [0, 2, 5, 10], periodsPerYear = 252, durationMs = null, folds = null, streams = null,
} = {}) {
    const designEffect = dependence && isNum(dependence.designEffect) ? dependence.designEffect : null;
    const effectiveBars = dependence && isNum(dependence.effectiveBars) ? dependence.effectiveBars
        : (power && isNum(power.effectiveBars) ? power.effectiveBars : null);
    const observedSharpe = power && isNum(power.observedSharpe) ? power.observedSharpe : null;
    const mde95 = power && isNum(power.mdeSharpe) ? power.mdeSharpe : null;
    const mde95Dependent = power && isNum(power.mdeSharpeDependent) ? power.mdeSharpeDependent : null;
    const barsToDetect1 = power && isNum(power.barsToDetect1) ? power.barsToDetect1 : null;
    const barsToDetectObserved = isNum(observedSharpe) && observedSharpe > 0 ? barsToDetect(observedSharpe, periodsPerYear) : null;
    const barsToDetectDependent = barsToDetect1 != null && designEffect != null ? Math.ceil(barsToDetect1 * designEffect) : null;
    const pooledMetrics = candidate && candidate.pooledMetrics ? candidate.pooledMetrics : null;
    const breakEvenBps = pooledMetrics && isNum(pooledMetrics.breakEvenCostBps) ? pooledMetrics.breakEvenCostBps : null;
    const clears = {};
    for (const lvl of Array.isArray(levels) ? levels : []) clears[lvl] = breakEvenBps == null ? null : breakEvenBps >= lvl;
    const perFoldMs = isNum(durationMs) && isNum(folds) && folds > 0 ? durationMs / folds : null;
    // The measured cost law (RUNBOOK §4 / OPTIMIZATION.md): a fit replays all
    // history up to its fold, so the run is O(n^2) per stream. The observed
    // mean per-fold wall time is the honest constant for a same-shaped rerun.
    const projected = perFoldMs == null ? null : {
        folds: folds * 2,
        streams: streams == null ? null : streams,
        ms: perFoldMs * folds * 2,
        note: 'linear in folds at the measured per-fold cost; a larger fold count also lengthens each replay (O(n^2)), so treat this as a lower bound',
    };
    const flip = cheapestFlip({ candidate, dependence, pooledMetrics, breakEvenBps, levels });
    // R26-8 clause 6 / R26-13: a PAIRED comparison's power is set by the paired
    // difference's SE, not by either series' own SE, so size it separately from
    // `barsToDetect` (which sizes a single series). `promotionTest.sharpeDifference`
    // is the whole `pairedClusterTest` block, so read `.se`/`.nClusters`/`.value`.
    const pairedDiff = candidate && candidate.promotionTest ? candidate.promotionTest.sharpeDifference : null;
    const pairedSe = pairedDiff && isNum(pairedDiff.se) ? pairedDiff.se
        : (dependence && isNum(dependence.seCluster) ? dependence.seCluster : null);
    const pairedClusters = pairedDiff && isNum(pairedDiff.nClusters) ? pairedDiff.nClusters
        : (dependence && isNum(dependence.nClusters) ? dependence.nClusters : null);
    const pairedObserved = pairedDiff == null ? null
        : (isNum(pairedDiff) ? Math.abs(pairedDiff) : (isNum(pairedDiff.value) ? Math.abs(pairedDiff.value) : null));
    const pairedUnits = pairedUnitsNeeded({ se: pairedSe, nClusters: pairedClusters, targets: { observed: pairedObserved, mde95Dependent } });
    return {
        available: true,
        effectiveBars,
        designEffect,
        observedSharpe,
        mde95,
        mde95Dependent,
        underpowered: power && typeof power.underpowered === 'boolean' ? power.underpowered : null,
        underpoweredDependent: power && typeof power.underpoweredDependent === 'boolean' ? power.underpoweredDependent : null,
        underpoweredThreshold: UNDERPOWERED_MDE,
        barsToDetect1,
        barsToDetectObserved,
        barsToDetectDependent,
        breakEvenBps,
        clearsBps: clears,
        measuredPerFoldMs: perFoldMs,
        projected,
        pairedUnits,
        cheapestFlip: flip,
        reader: 'the sizing knobs for the next run: the honest effective sample and its MDE (i.i.d. and dependence-corrected), the bars a detection of Sharpe 1 / of the observed Sharpe would need at the measured design effect, the PAIRED clusters/seeds a variant-vs-baseline comparison would need for each target difference, the turnover break-even measured against 0/2/5/10 bps, the observed per-fold wall time, and the cheapest single lever that would move the verdict.',
    };
}

function cheapestFlip({ candidate, dependence, pooledMetrics, breakEvenBps, levels }) {
    if (!candidate) return na('no candidate to reason about');
    const promoted = !!candidate.promote;
    const reasons = Array.isArray(candidate.reasons) ? candidate.reasons : [];
    const gate = candidate.gate || null;
    const check = candidate.promotionTest || null;
    if (promoted) return { available: true, kind: 'none', binding: null, reader: 'the candidate already promotes; no change is needed.' };
    const minLevel = Array.isArray(levels) && levels.length ? Math.min(...levels) : 0;
    if (breakEvenBps != null && breakEvenBps < minLevel) {
        return {
            available: true,
            kind: 'cost',
            binding: reasons[0] || null,
            reader: `the gross edge is consumed at ${breakEvenBps} bps of turnover, below even the cheapest tested cost (${minLevel} bps): the cheapest change is more edge per unit turnover (a holding rule / lower-turnover signal), not more data.`,
        };
    }
    const stability = check && check.stability ? check.stability : null;
    if (stability && stability.available && stability.stable === false) {
        return {
            available: true,
            kind: 'stability',
            binding: reasons[0] || null,
            reader: `the pooled edge is carried by window ${stability.worstCluster} (delete it and the paired Sharpe difference falls to ${stability.worstDelta}): the cheapest change is a signal whose edge is spread across windows.`,
        };
    }
    const seCluster = dependence && isNum(dependence.seCluster) ? dependence.seCluster : null;
    // `pairedPromotionTest` returns the paired difference as the whole
    // `pairedClusterTest` block (`.value`, `.se`, ...), so read the scalar from
    // `.value`. Accepting a bare number keeps the helper usable with a plain
    // fixture; requiring a number alone would silently never fire on a real report
    // (the round-26 fixture originally passed a number and hid exactly that).
    const sharpeDifference = check && isNum(check.sharpeDifference) ? check.sharpeDifference
        : (check && check.sharpeDifference && isNum(check.sharpeDifference.value) ? check.sharpeDifference.value : null);
    if (gate && gate.requireSharpeDiff === 'applied' && check && check.available && seCluster != null && sharpeDifference != null) {
        const required = 1.959964 * seCluster;
        return {
            available: true,
            kind: 'magnitude',
            binding: reasons[0] || null,
            requiredSharpeDifference: required,
            currentSharpeDifference: sharpeDifference,
            factor: required > 0 && sharpeDifference !== 0 ? required / sharpeDifference : null,
            reader: `the paired Sharpe difference is ${sharpeDifference} and the clustered test needs roughly ${required} (1.96 x the delete-one-cluster SE ${seCluster}): the cheapest change is a larger / less noisy edge, or more independent folds.`,
        };
    }
    if (reasons.length) return { available: true, kind: 'gate', binding: reasons[0], reader: `the binding hurdle is: ${reasons[0]}.` };
    return { available: true, kind: 'search', binding: null, reader: 'no candidate cleared the gate; the cheapest change is a better candidate family (see the research leads) rather than more of the same data.' };
}

// (Question 6b, R26-8 clause 6 / R26-13) `barsToDetect` sizes a SINGLE series from
// its own Sharpe SE. A variant-vs-baseline decision is a PAIRED comparison, so its
// power depends on the paired difference's SE — a different, usually much smaller,
// number. For a paired SE `se` measured over `nClusters` fold-window clusters, the
// SE over `n` clusters is `se * sqrt(nClusters / n)`, so the cluster (or independent
// seed) count whose 95% half-width equals a target difference is
// `nClusters * (1.959964 * se / target)^2`. Same leading-order z form as
// `barsToDetect`; an 80%-powered test would need roughly
// (1.96 + 0.84)^2 / 1.96^2 ~= 2.1x more, so this is a lower bound.
function pairedUnitsNeeded({ se, nClusters, targets = {}, z = 1.959964 } = {}) {
    if (!isNum(se) || !(se > 0)) return na('no finite paired standard error to size a paired comparison from');
    if (!isNum(nClusters) || nClusters < 2) return na('no paired cluster/seed count to size a paired comparison from');
    const needed = {};
    for (const [name, target] of Object.entries(targets || {})) {
        needed[name] = isNum(target) && target > 0 ? Math.ceil(nClusters * (z * se / target) ** 2) : null;
    }
    return {
        available: true,
        se,
        nClusters,
        z,
        needed,
        // R27-5: flat, self-describing aliases. The old `required.observed` read as
        // an OBSERVATION ("we observed 37 clusters") when it is a REQUIREMENT ("you
        // need 37 clusters to detect what you observed; you have 36"). It aliases
        // `needed.observed`, and `needed.mde95Dependent` gets the same treatment.
        neededForObserved: needed.observed == null ? null : needed.observed,
        neededForMde95Dependent: needed.mde95Dependent == null ? null : needed.mde95Dependent,
        reader: 'the fold-window clusters (or independent seeds) a PAIRED variant-vs-baseline comparison would NEED for the 95% paired SE to fall to each target Sharpe difference: nClusters * (1.959964 * se / target)^2, from the measured paired SE (se) over nClusters clusters. `neededForObserved` is the requirement at the measured difference; `needed.mde95Dependent` is the requirement at the dependence-corrected MDE. A lower bound (an 80%-powered test needs ~2.1x more); barsToDetect sizes a single series, this sizes the paired difference the decision uses.',
    };
}

// ---------------------------------------------------------------------------
// Composition — the six-question decision block
// ---------------------------------------------------------------------------
export function decisionReport({
    model = null,
    // R27-5: when the featured row has no model block of its own (a pure signal
    // candidate that won), the caller passes the BASELINE's model here, so the
    // training question is answered by the baseline controller and labelled as such
    // instead of degrading to n/a. `{ kind: 'baseline' }` is the only kind today.
    modelReferent = null,
    runMeta = {},
    baseline = null,
    candidate = null,
    concentration = null,
    confidence = null,
    nextRun = null,
    familyCorrelation = null,
    familywise = null,
    costLadder = null,
    forecast = null,
    replication = null,
    positionPolicy = null,
} = {}) {
    const meta = runMeta || {};
    const referentBaseline = !!(modelReferent && modelReferent.kind === 'baseline');
    const modelBlock = model || null;
    const candModel = candidate && candidate.model ? candidate.model : null;
    // Which model block the training question is answered by. Without a referent
    // this is the featured candidate's own model (or the `model` argument); with a
    // baseline referent it is the baseline's, explicitly labelled.
    const effectiveModel = referentBaseline ? modelBlock : (candModel || modelBlock);
    const modelAvailable = !!(effectiveModel && effectiveModel.available !== false);
    const training = {
        // Question 1: did the models train, and on what? Null model diagnostics is
        // stated as such, never rendered as a healthy model.
        model: effectiveModel || na('no model diagnostics were collected for this run (a pure-signal or bare run)'),
        modelReferent: modelReferent || null,
        labelPolicy: meta.labelPolicy == null ? null : meta.labelPolicy,
        labelHorizonBars: meta.labelHorizonBars == null ? null : meta.labelHorizonBars,
        seed: meta.seed == null ? null : meta.seed,
        trials: meta.trials == null ? null : meta.trials,
        saveInterval: meta.saveInterval == null ? null : meta.saveInterval,
        // Derived from the model block's own label diagnostics: `summarizeModelStats`
        // exposes `baseRate`/`resolved`/`heldBars`/`status` — NOT a
        // `labelDistribution` field — so reading `candidate.model.labelDistribution`
        // here was always a silent null (the same shape-mismatch class as `BUGS.md`
        // #38). A model-backed candidate now carries its label distribution; a pure
        // signal candidate (no model) is still an explicit null. R27-5: when a
        // referent is supplied, the distribution follows the referent (the effective
        // model block above), so the two always agree on whose model they describe.
        labelDistribution: modelAvailable ? {
            status: effectiveModel.status == null ? null : effectiveModel.status,
            baseRate: effectiveModel.baseRate == null ? null : effectiveModel.baseRate,
            resolved: effectiveModel.resolved || null,
            heldBars: effectiveModel.heldBars || null,
        } : null,
        reader: referentBaseline
            ? 'the per-variant model diagnostics (training steps, label base rate, skill, resolved-barrier split, entry-to-close holding-period distribution) plus the label policy, seed and searched-roster size, WITH AN EXPLICIT REFERENT: the featured row is a pure signal with no model of its own, so `model` and `labelDistribution` are the BASELINE controller\'s, stated as such via `modelReferent`. A null model block means a pure-signal variant, not a trained one. The entry-to-training age (the FIFO/`processCount=1` drain lag) is NOT yet measured — see TODO #62.'
            : 'the per-variant model diagnostics (training steps, label base rate, skill, resolved-barrier split, entry-to-close holding-period distribution) plus the label policy, seed and searched-roster size. A null model block means a pure-signal variant, not a trained one. The entry-to-training age (the FIFO/`processCount=1` drain lag) is NOT yet measured — see TODO #62.',
    };
    const edge = {
        available: true,
        promote: candidate ? !!candidate.promote : null,
        reasons: candidate ? (candidate.reasons || []) : null,
        bindingHurdle: candidate && candidate.reasons && candidate.reasons.length ? candidate.reasons[0] : null,
        gate: meta.gate == null ? null : meta.gate,
        gateOptions: meta.gateOptions || null,
        dependence: candidate && candidate.dependence ? candidate.dependence : (baseline && baseline.dependence ? baseline.dependence : null),
        promotionTest: candidate && candidate.promotionTest ? candidate.promotionTest : null,
        familyCorrelation: familyCorrelation || na('no family to correlate (fewer than two candidates)'),
        familywise: familywise || na('the family-wise search did not run'),
        reader: 'the promoted/keep-off verdict, the named binding hurdle, the dependence-aware panel and paired cluster test behind it, and the family-wise search cross-check. A keep-off verdict is only citable when the binding hurdle is named and the run was powered.',
    };
    const economics = {
        available: true,
        costLadder: costLadder || na('the cost ladder did not run'),
        confidence: confidence || na('the raw confidence was not journaled'),
        positionPolicy: positionPolicy == null ? null : positionPolicy,
        breakEvenBps: candidate && candidate.pooledMetrics && isNum(candidate.pooledMetrics.breakEvenCostBps) ? candidate.pooledMetrics.breakEvenCostBps : null,
        participation: candidate && candidate.pooledMetrics ? {
            nonZeroFraction: candidate.pooledMetrics.nonZeroFraction == null ? null : candidate.pooledMetrics.nonZeroFraction,
            meanAbsPosition: candidate.pooledMetrics.meanAbsPosition == null ? null : candidate.pooledMetrics.meanAbsPosition,
        } : null,
        reader: 'whether it pays: the whole verdict restated at 0/2/5/10 bps of turnover, the measured break-even cost, participation under the unified confidence->position policy, and the raw-confidence decay (the alpha-decay ranking input).',
    };
    const family = {
        available: true,
        forecast: forecast || na('the forecast comparison did not run'),
        // R26-13's cross-seed distribution is aggregated ACROSS runs and written to
        // `replication.json` beside the first run dir, so a per-seed report has no
        // summary of its siblings. These fields accept a supplied aggregate, but the
        // shipped path never supplies one — and `replicateAnalysis`'s aggregate is
        // keyed `byVariant` (with `varianceComponents` NESTED as `.components`), not
        // `seedDistribution`/`varianceComponents`/`pairedVarianceRatio`, so reading
        // those names here was the same shape-mismatch class as `BUGS.md` #38/#40
        // (structurally unreachable, no information lost because `replication.json`
        // carries the aggregate). The readers below say exactly that.
        seedDistribution: replication && replication.seedDistribution ? replication.seedDistribution : na('the cross-seed distribution is aggregated into replication.json by a multi-seed run (--seeds=a,b,c); a per-seed report does not summarize its siblings'),
        varianceComponents: replication && replication.varianceComponents ? replication.varianceComponents : na('the seed/fold variance decomposition is aggregated into replication.json by a multi-seed run'),
        pairedVarianceRatio: replication && replication.pairedVarianceRatio ? replication.pairedVarianceRatio : na('the paired/unpaired variance ratio (the CRN criterion) is aggregated into replication.json by a multi-seed run'),
        reader: 'is it the best family, or just the best of these? proper forecast scores + the Model Confidence Set; the cross-seed distribution and variance decomposition come from a multi-seed run and live in replication.json (a single-seed point estimate is not a family decision).',
    };
    return {
        schema: 'nl.decision.v1',
        verdict: {
            promote: candidate ? !!candidate.promote : null,
            candidateId: candidate && candidate.id != null ? candidate.id : null,
            reasons: candidate ? (candidate.reasons || []) : null,
        },
        training,
        edge,
        concentration: concentration || na('the concentration readout did not run'),
        economics,
        family,
        nextRun: nextRun || na('the next-run sizing block did not run'),
        reader: 'The decision-grade report (R26-8). Six blocks, one per question the next cycle asks (training / edge / concentration / economics / family / nextRun). Every block states its own availability; a missing input is an explicit { available: false, reason } rather than a null that could read as a healthy zero. It adds no new strategy statistic — it makes the existing ones legible, printing the design-effect-adjusted numbers and the seed distribution beside the point estimates.',
    };
}

// Compact, deterministic summary lines for the run summary.
export function formatDecision(decision) {
    if (!decision) return 'decision: unavailable';
    const lines = [];
    const v = decision.verdict || {};
    lines.push(`decision: ${v.promote ? 'PROMOTE' : 'keep-off'}${v.candidateId ? ` (${v.candidateId})` : ''}` + (v.reasons && v.reasons.length ? ` | binding: ${v.reasons[0]}` : ''));
    const c = decision.concentration;
    if (c && c.available) {
        const top = (c.topKs || []).map((t) => `top${t.k}=${t.share == null ? 'n/a' : `${(t.share * 100).toFixed(1)}%`}`).join(' ');
        const range = c.deleteOneCluster && c.deleteOneCluster.available
            ? ` | LOO Sharpe [${fmt(c.deleteOneCluster.min)}, ${fmt(c.deleteOneCluster.max)}] worst=#${c.deleteOneCluster.worstIndex}`
            : '';
        lines.push(`  concentration: grossPos=${fmt(c.positiveSum)} grossNeg=${fmt(c.negativeSum)} ${top}${range}`);
    } else {
        lines.push(`  concentration: n/a (${c ? c.reason : 'none'})`);
    }
    const n = decision.nextRun;
    if (n && n.available) {
        lines.push(`  nextRun: effBars=${fmt(n.effectiveBars)} MDE95=${fmt(n.mde95)}` +
            (n.mde95Dependent == null ? '' : ` (dep ${fmt(n.mde95Dependent)})`) +
            ` breakEven=${n.breakEvenBps == null ? 'n/a' : `${fmt(n.breakEvenBps)}bps`}` +
            (n.pairedUnits && n.pairedUnits.available && n.pairedUnits.neededForObserved != null
                ? ` | pairedClusters(need,obs)=${n.pairedUnits.neededForObserved}` : '') +
            (n.cheapestFlip && n.cheapestFlip.available ? ` | cheapest flip: ${n.cheapestFlip.kind}` : ''));
    } else {
        lines.push(`  nextRun: n/a (${n ? n.reason : 'none'})`);
    }
    return lines.join('\n');
}

const fmt = (x) => (isNum(x) ? x.toFixed(3) : 'n/a');
