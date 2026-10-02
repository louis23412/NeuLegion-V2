// src/analysis/decision/plan.js (round-97 split of src/analysis/decision.js).
// Decision plan section.
import { normalInvCdf } from '../performance.js';
import { barsToDetect, UNDERPOWERED_MDE } from '../walkforward.js';
import { studentTCritical } from '../dependence.js';
import { isNum, na } from './measures.js';



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
    cadence = null,
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
    //
    // R28 (BUGS.md #56): the two scales are DIFFERENT quantities and must be
    // labelled. The paired SE comes from the delete-one-cluster jackknife over the
    // DIFFERENCE; `dependence.seCluster` is the single-series SE of a Sharpe level.
    // Falling back from the former to the latter silently sizes a paired decision
    // with a single-series quantity, so the fallback is explicit and flagged in
    // `pairedUnits.seScale`.
    const pairedDiff = candidate && candidate.promotionTest ? candidate.promotionTest.sharpeDifference : null;
    const hasPairedSe = !!(pairedDiff && isNum(pairedDiff.se));
    const pairedSe = hasPairedSe ? pairedDiff.se
        : (dependence && isNum(dependence.seCluster) ? dependence.seCluster : null);
    const pairedSeScale = hasPairedSe ? 'paired' : (pairedSe == null ? null : 'single-series');
    const pairedClusters = pairedDiff && isNum(pairedDiff.nClusters) ? pairedDiff.nClusters
        : (dependence && isNum(dependence.nClusters) ? dependence.nClusters : null);
    const pairedObserved = pairedDiff == null ? null
        : (isNum(pairedDiff) ? Math.abs(pairedDiff) : (isNum(pairedDiff.value) ? Math.abs(pairedDiff.value) : null));
    const pairedAlpha = (pairedDiff && isNum(pairedDiff.alpha)) ? pairedDiff.alpha
        : (candidate && candidate.promotionTest && isNum(candidate.promotionTest.alpha) ? candidate.promotionTest.alpha : 0.05);
    const pairedUnits = pairedUnitsNeeded({
        se: pairedSe, nClusters: pairedClusters, seScale: pairedSeScale, alpha: pairedAlpha,
        targets: { observed: pairedObserved },
    });
    return {
        available: true,
        // P2: no level statement is citable without its cadence — the A/B's level is
        // a function of `testSize` (RUN-ANALYSIS.md §15.3), so the sizing block names
        // the configuration it was measured at.
        cadence: cadence || null,
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
        // R28 (BUGS.md #56): every sizing field below is on ONE of two scales, and
        // reading one as the other is what produced the old "×4.95 magnitude"
        // artefact. `singleSeries` describes a Sharpe level against zero;
        // `paired` describes the candidate-minus-baseline difference, which is the
        // quantity the decision test actually uses.
        scales: {
            singleSeries: ['effectiveBars', 'observedSharpe', 'mde95', 'mde95Dependent', 'barsToDetect1', 'barsToDetectObserved', 'barsToDetectDependent'],
            paired: ['pairedUnits.se', 'pairedUnits.neededForObserved', 'cheapestFlip.requiredSharpeDifference'],
            note: 'a SINGLE-SERIES sizing describes one Sharpe level against zero; a PAIRED sizing describes the candidate-minus-baseline difference over the same fold windows. The two standard errors differ by the design effect, so they are not interchangeable.',
        },
        reader: 'the sizing knobs for the next run: the honest effective sample and its MDE (i.i.d. and dependence-corrected), the bars a detection of Sharpe 1 / of the observed Sharpe would need at the measured design effect, the PAIRED clusters/seeds a variant-vs-baseline comparison would need for each target difference (referenced to the one-sided cluster-t of the test that runs), the turnover break-even measured against 0/2/5/10 bps, the observed per-fold wall time, and the cheapest single lever that would move the verdict. Read `scales` before comparing any two fields: a single-series MDE and a paired requirement are different quantities (BUGS.md #56).',
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
    // R28 (BUGS.md #56): the magnitude lever is a PAIRED quantity and must be
    // sized with the PAIRED standard error and the ONE-SIDED reference the test
    // actually uses. The old form read `dependence.seCluster` (the SINGLE-SERIES
    // jackknife SE of a Sharpe level) and multiplied it by the two-sided normal
    // constant, then compared the product to the paired difference — mixing three
    // incompatible quantities and overstating the requirement by ~4.7x on the
    // round-27 Step-2 report (factor 4.95 instead of 1.06).
    // `pairedPromotionTest` returns the paired difference as the whole
    // `pairedClusterTest` block (`.value`, `.se`, `.df`, `.alpha`), so read those.
    // Accepting a bare number keeps the helper usable with a plain fixture.
    const pairedDiffBlock = check && check.sharpeDifference && typeof check.sharpeDifference === 'object'
        ? check.sharpeDifference : null;
    const sharpeDifference = check && isNum(check.sharpeDifference) ? check.sharpeDifference
        : (pairedDiffBlock && isNum(pairedDiffBlock.value) ? pairedDiffBlock.value : null);
    const pairedSe = pairedDiffBlock && isNum(pairedDiffBlock.se) ? pairedDiffBlock.se : null;
    const pairedAlpha = pairedDiffBlock && isNum(pairedDiffBlock.alpha) ? pairedDiffBlock.alpha
        : (check && isNum(check.alpha) ? check.alpha : 0.05);
    const pairedDf = pairedDiffBlock && isNum(pairedDiffBlock.df) ? pairedDiffBlock.df
        : (pairedDiffBlock && isNum(pairedDiffBlock.nClusters) ? pairedDiffBlock.nClusters - 1 : null);
    if (gate && gate.requireSharpeDiff === 'applied' && check && check.available && pairedSe != null && sharpeDifference != null) {
        // The test is one-sided (`significant` is `pOneSided <= alpha`), so the
        // reference is the one-sided critical value. With a known df it is the
        // exact t quantile; without one, the one-sided normal quantile (never the
        // two-sided 1.96, which would silently double the tail).
        let reference;
        let referenceKind;
        if (pairedDf != null && pairedDf > 0) {
            reference = studentTCritical(pairedDf, { alpha: pairedAlpha, twoSided: false });
            referenceKind = `student-t(${pairedDf}) one-sided at alpha=${pairedAlpha}`;
        } else {
            reference = normalInvCdf(1 - pairedAlpha);
            referenceKind = `normal one-sided at alpha=${pairedAlpha} (df unknown)`;
        }
        if (Number.isFinite(reference)) {
            const required = reference * pairedSe;
            return {
                available: true,
                kind: 'magnitude',
                binding: reasons[0] || null,
                scale: 'paired',
                se: pairedSe,
                alpha: pairedAlpha,
                df: pairedDf,
                reference: referenceKind,
                requiredSharpeDifference: required,
                currentSharpeDifference: sharpeDifference,
                factor: required > 0 && sharpeDifference !== 0 ? required / sharpeDifference : null,
                reader: `the PAIRED Sharpe difference is ${sharpeDifference} and the one-sided clustered test needs roughly ${required} (${referenceKind} x the paired delete-one-cluster SE ${pairedSe}): the cheapest change is a larger / less noisy edge, or more independent folds. This is a paired requirement, not a single-series MDE.`,
            };
        }
    }
    if (reasons.length) return { available: true, kind: 'gate', binding: reasons[0], reader: `the binding hurdle is: ${reasons[0]}.` };
    return { available: true, kind: 'search', binding: null, reader: 'no candidate cleared the gate; the cheapest change is a better candidate family (see the research leads) rather than more of the same data.' };
}

// (Question 6b, R26-8 clause 6 / R26-13) `barsToDetect` sizes a SINGLE series from
// its own Sharpe SE. A variant-vs-baseline decision is a PAIRED comparison, so its
// power depends on the paired difference's SE — a different, usually much smaller,
// number. For a paired SE `se` measured over `nClusters` fold-window clusters, the
// SE over `n` clusters is `se * sqrt(nClusters / n)`, and the test is the ONE-SIDED
// cluster-t at `alpha` with `n - 1` degrees of freedom (`pairedClusterTest`'s
// `significant` is `pOneSided <= alpha`). So the cluster count whose resolvable
// difference falls to a target is the smallest `n` with
//
//     tCritical(n - 1, alpha) * se * sqrt(nClusters / n) <= target
//
// (no closed form: the critical value moves with `n`), found by bisection. An
// 80%-powered test adds the standard normal shift, i.e. replaces the critical
// value with `tCritical(n - 1, alpha) + z_0.80`.
//
// R28 (BUGS.md #56): the previous form used the two-sided normal constant
// 1.959964 in a one-sided t test, which at C = 36 overstated the requirement by
// `1.959964 / 1.68957 = 16%` (55 clusters instead of 41 on the round-27 Step-2
// report). It also sized a cross-scale `mde95Dependent` target with a paired SE;
// that target is dropped — the paired MDE at the CURRENT cluster count is
// `tCritical(C - 1, alpha) * se`, reported as `reference.critical * se`.
function pairedUnitsNeeded({ se, nClusters, targets = {}, alpha = 0.05, seScale = 'paired' } = {}) {
    if (!isNum(se) || !(se > 0)) return na('no finite paired standard error to size a paired comparison from');
    if (!isNum(nClusters) || nClusters < 2) return na('no paired cluster/seed count to size a paired comparison from');
    const z80 = normalInvCdf(0.80);
    const resolvable = (n, extra = 0) => {
        const t = studentTCritical(Math.max(1, n - 1), { alpha, twoSided: false });
        if (!Number.isFinite(t)) return null;
        return (t + extra) * se * Math.sqrt(nClusters / n);
    };
    // Smallest n >= 2 whose resolvable difference is <= target.
    const clustersFor = (target, extra = 0) => {
        if (!isNum(target) || !(target > 0)) return null;
        const atTwo = resolvable(2, extra);
        if (atTwo == null) return null;
        if (atTwo <= target) return 2;
        let lo = 2;
        let hi = 4;
        while (hi < 1e7 && (resolvable(hi, extra) == null || resolvable(hi, extra) > target)) { lo = hi; hi *= 2; }
        if (resolvable(hi, extra) == null || resolvable(hi, extra) > target) return null;
        for (let i = 0; i < 100; i++) {
            const mid = Math.floor((lo + hi) / 2);
            if (mid <= lo) break;
            const r = resolvable(mid, extra);
            if (r != null && r > target) lo = mid; else hi = mid;
        }
        return hi;
    };
    const needed = {};
    for (const [name, target] of Object.entries(targets || {})) {
        needed[name] = clustersFor(target);
    }
    const observed = targets && isNum(targets.observed) ? targets.observed : null;
    const df = Math.max(1, Math.floor(nClusters) - 1);
    const critical = studentTCritical(df, { alpha, twoSided: false });
    return {
        available: true,
        se,
        // R28: the SCALE of `se`. 'paired' = the delete-one-cluster SE of the
        // candidate-minus-baseline difference (the right quantity). 'single-series'
        // = the fallback `dependence.seCluster`, which sizes a Sharpe level and is
        // flagged so a reader cannot mistake one for the other (BUGS.md #56).
        seScale,
        nClusters,
        alpha,
        side: 'one-sided',
        reference: {
            kind: 'student-t', df, alpha, side: 'one-sided',
            critical: Number.isFinite(critical) ? critical : null,
            pairedMde95: Number.isFinite(critical) ? critical * se : null,
        },
        z80,
        needed,
        // R27-5: flat, self-describing aliases. The old `required.observed` read as
        // an OBSERVATION ("we observed 37 clusters") when it is a REQUIREMENT ("you
        // need 37 clusters to detect what you observed; you have 36").
        neededForObserved: needed.observed == null ? null : needed.observed,
        // R28: the same requirement at 80% power (the plan's "81 clusters"), and
        // NOT the old cross-scale `neededForMde95Dependent`.
        neededForObservedPower80: observed == null ? null : clustersFor(observed, z80),
        reader: 'the fold-window clusters (or independent seeds) a PAIRED variant-vs-baseline comparison would NEED for the one-sided cluster-t at alpha to resolve each target Sharpe difference: the smallest n with tCritical(n - 1, alpha) * se * sqrt(nClusters / n) <= target, from the measured PAIRED SE (se) over nClusters clusters. `neededForObserved` is the requirement at the measured difference; `neededForObservedPower80` is the same at 80% power (`+ z_0.80`). `reference.pairedMde95` is the difference the current cluster count can resolve. `seScale` names the scale of `se` (paired / single-series); `barsToDetect` sizes a single series, this sizes the paired difference the decision uses — do not compare them (BUGS.md #56).',
    };
}
