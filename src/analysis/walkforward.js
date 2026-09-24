// Walk-forward evaluation harness — the protocol layer that turns a *model*
// (an online predictor that learns over time) into an honest, out-of-sample
// performance report, and turns "should we switch feature X on?" into a
// mechanical, reproducible decision.
//
// Why a dedicated layer on top of `backtest.js`:
//
//   1. `purgedCVBacktest` evaluates a *fixed* signal series; purging protects
//      the metric's independence but does not stop an online model from having
//      seen the future. A walk-forward protocol must (a) train strictly before
//      testing and (b) emit each test bar's position from information available
//      at that bar only.
//   2. "No lookahead" is usually asserted by inspection. Here it is *tested*:
//      `auditNoLookahead` perturbs every return after a test bar and fails if
//      that bar's signal moves. A signal that standardises by a full-series
//      mean, peeks at t+1, or fits on the whole sample is caught automatically.
//   3. Feature promotion ("surprise gate on/off", "uniqueness weights on/off",
//      "homeostasis on/off", "multi-probe on/off") needs a single decision rule
//      that cannot be gamed by one lucky fold: `promoteDecision` requires the
//      candidate to beat the baseline on *pooled* DSR, *mean fold* Sharpe,
//      *positive-fold fraction* and *per-fold win fraction*, with a clean audit.
//
// Pure: no I/O, no RNG. The caller supplies the model through `signalForFold`.
// `signalForFold(trainIdx, testIdx, view)` MUST read the data from `view` rather
// than closing over the raw array — the audit perturbs the view to prove
// causality. A returns-driven model reads `view.returns` (the default view); a
// candle-driven model supplies `viewFor` so the audit perturbs the candle series
// it actually reads (see `analysis/world.js` and docs/BUGS.md #22).
//
// References: Lopez de Prado, AFML ch. 7-8 (purged CV, backtest statistics);
// Pardo, *The Evaluation and Optimization of Trading Strategies* (2008) —
// walk-forward analysis as the deployment-honest alternative to a single split;
// Bailey & Lopez de Prado (2014) — deflated Sharpe; decision-time leakage
// (arXiv 2605.23959) and "What survives honest evaluation?" (arXiv 2608.27734) —
// the latter shows a deliberately leaky oracle posting Sharpe 35 *surviving*
// DSR and PBO, i.e. statistical correction is not a substitute for a structural
// look-ahead guardrail, which is why `auditNoLookahead` exists and the promotion
// gate requires a clean audit.
//
// Round 8 addition: `familywiseSearch` / `walkForwardSearch` put the
// variance-consistent subsampling SPA + Romano-Wolf step-down (Politis & Romano
// 1994; Romano & Wolf 2005) on the honest-evaluation path, and `promoteDecision`
// can require it as an extra hurdle. Grounding for the segment-aware resampling
// (fold lengths passed as `groups`): arXiv 2603.17226 (mean-shift long-run
// variance) and arXiv 2608.23808 (separating search luck from a persistent edge).
//
// Round 9 addition: the same family-wise object can carry the GENERALISED error
// rates of Romano & Wolf (2007, k-FWER, arXiv 0710.2258) and the Romano-Wolf /
// Delattre-Roquain FDP step-down heuristic (arXiv 1311.4030): `kfwer` (opt-in
// integer k) attaches a single-step k-FWER rejection set, and `fdpTarget`
// attaches the FDP-bounded set plus a `promoteDecision` `maxFdp` hurdle. Both are
// default-off, so every default result is byte-identical to Round 8.

import { strategyReturns, backtestMetrics, purgedCVBacktest, purgedCVBacktestAsync, poolFolds } from './backtest.js';
import { normaliseConcurrency } from './parallel.js';
import { walkForwardSplit } from './splits.js';
import { subsamplingSpa, subsamplingStepM, subsamplingFdp, subsamplingKfwer } from './reality_check.js';
import { sharpeRatio } from './performance.js';
import {
    pearsonCorrelation, meanPairwiseCorrelation, equicorrelationDesignEffect, equicorrelationEffectiveSize,
    foldWindowClusters, clusterJackknife, pairedClusterTest, pairedClusterSignTest, clusterStability, signTestFloor,
    studentTCritical,
} from './dependence.js';

// Close-to-close simple returns. `r[0] = 0` (no return is realised at the first
// bar), so the series is the same length as the closes.
export function barReturns(closes) {
    const out = new Array(closes.length).fill(0);
    for (let t = 1; t < closes.length; t++) out[t] = closes[t] / closes[t - 1] - 1;
    return out;
}

// Close-to-close log returns. `r[0] = 0`.
export function logReturns(closes) {
    const out = new Array(closes.length).fill(0);
    for (let t = 1; t < closes.length; t++) out[t] = Math.log(closes[t] / closes[t - 1]);
    return out;
}

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// ---- one confidence -> position pipeline (round 26, R26-3 / BUGS.md #34) ----
//
// Both candidate families are mapped to positions through THIS pair of functions,
// in one documented signed-confidence space `c ∈ [-1, 1]`:
//
//   controller:  c = (prob − 50) / 50                 (`confidenceFromProb`)
//   signal:      c = clamp(z / saturation, −1, 1)     (`analysis/features.js`)
//
// and then the SAME policy maps `c` to a position:
//
//   |c| ≤ deadZone  ->  0                             (abstain: no edge worth trading)
//   else            ->  sign(c) · (|c| − deadZone)/(1 − deadZone) · scale
//
// Before R26-3 the controller carried a dead zone and the signal family did not,
// so a turnover/participation comparison across the two families confounded the
// mapping with the signal. The policy is a run-level parameter (the A/B uses
// `CONTROLLER_POSITION_POLICY`) and the raw `c` is journaled, so a policy sweep is
// pure post-processing (`restateFoldsAtPolicy`).
//
// Properties: sign-preserving, bounded by `scale`, exactly 0 on the dead-zone band
// and for a non-finite confidence.
export function confidenceToPosition(confidence, { deadZone = 0, scale = 1 } = {}) {
    const raw = Number(confidence);
    if (!Number.isFinite(raw)) return 0;
    const c = clamp(raw, -1, 1);
    const dz = clamp(deadZone, 0, 0.999);
    const a = Math.abs(c);
    if (a <= dz) return 0;
    const mag = (a - dz) / (1 - dz);
    return Math.sign(c) * mag * scale;
}

// The controller's raw `prob` in [0, 100] as a signed confidence in [-1, 1].
export function confidenceFromProb(prob) {
    return clamp(Number(prob), 0, 100) / 50 - 1;
}

// A *holding / hysteresis* policy layer (round 26, R26-5) on top of the one
// confidence→position mapping. `confidenceToPosition` is pointwise, so it cannot
// express a no-trade band that depends on the *current* position — which is what a
// proportional trading cost makes optimal (Constantinides 1986; Davis & Norman 1990;
// Gârleanu & Pedersen 2013): enter at `|c| ≥ enter`, and do not leave until
// `|c| ≤ exit` (with `exit < enter`), optionally only after a minimum holding
// period. With no holding parameters this is exactly `confidences.map(confidenceToPosition)`,
// so every default path stays byte-identical.
export function positionSeriesFromConfidence(confidences, policy = {}) {
    const { deadZone = 0, scale = 1 } = policy;
    const enter = policy.enter;
    const exit = policy.exit;
    const rawHold = policy.minHold;
    const hold = Number.isFinite(rawHold) && rawHold > 0 ? Math.floor(rawHold) : 0;
    const holding = Number.isFinite(enter) || Number.isFinite(exit) || hold > 0;
    if (!holding) return confidences.map((c) => confidenceToPosition(c, { deadZone, scale }));
    const enterT = clamp(Number.isFinite(enter) ? enter : (Number.isFinite(deadZone) ? deadZone : 0), 0, 1);
    const exitT = clamp(Number.isFinite(exit) ? exit : 0, 0, enterT);
    const out = new Array(confidences.length).fill(0);
    let pos = 0;
    let held = 0;
    for (let i = 0; i < confidences.length; i++) {
        const c = Number(confidences[i]);
        const mag = Number.isFinite(c) ? Math.min(1, Math.abs(c)) : 0;
        const dir = c > 0 ? 1 : c < 0 ? -1 : 0;
        // The band is indexed by the dead zone too: a signal that would map to 0
        // under `{deadZone, scale}` is a 0-magnitude signal here.
        const effMag = mag <= clamp(deadZone, 0, 0.999) ? 0 : (mag - clamp(deadZone, 0, 0.999)) / (1 - clamp(deadZone, 0, 0.999));
        if (pos === 0) {
            if (dir !== 0 && effMag >= enterT) { pos = dir * scale; held = 0; }
        } else if (held >= hold) {
            if (dir === -pos && effMag >= enterT) { pos = dir * scale; held = 0; }
            else if (effMag <= exitT) { pos = 0; }
        }
        out[i] = pos;
        held += 1;
    }
    return out;
}

// Map a model confidence `prob` in [0, 100] to a position in [-scale, +scale].
//
// The controller path through the one pipeline above — kept as the public name the
// analysis layer and its tests already use. Properties (proved in
// analysis.test.js): odd about prob = 50, monotone non-decreasing for
// direction = 1, bounded by scale, exactly 0 on the dead-zone band, and clamped
// for out-of-range `prob`.
export function probToPosition(prob, { direction = 1, deadZone = 0, scale = 1 } = {}) {
    return Math.sign(direction || 1) * confidenceToPosition(confidenceFromProb(prob), { deadZone, scale });
}

// A fold is *causal* when every training index strictly precedes every test
// index — the condition a walk-forward deployment needs (purged K-fold may train
// on the future side of a test block, which is fine for a fixed signal but not
// for an online model).
export function isCausalFold(fold) {
    if (!fold || !Array.isArray(fold.train) || !Array.isArray(fold.test) || !fold.test.length) return false;
    const firstTest = Math.min(...fold.test);
    return fold.train.every((i) => i < firstTest);
}

// Aggregate a list of per-fold metric objects. `key` selects the metric (default
// net Sharpe). Ignores non-finite values so a degenerate fold cannot poison the
// summary. `positiveFraction` = fraction of folds with a positive metric.
export function aggregateFolds(perFold, key = 'netSharpe') {
    const vals = perFold
        .map((f) => (f && f.metrics ? f.metrics[key] : f && f[key]))
        .filter((v) => Number.isFinite(v));
    const n = vals.length;
    if (n === 0) return { n: 0, mean: NaN, median: NaN, std: NaN, positiveFraction: NaN, min: NaN, max: NaN };
    const mean = vals.reduce((a, b) => a + b, 0) / n;
    const sorted = [...vals].sort((a, b) => a - b);
    const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
    const variance = n > 1 ? vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
    return {
        n,
        mean,
        median,
        std: Math.sqrt(variance),
        positiveFraction: vals.filter((v) => v > 0).length / n,
        min: sorted[0],
        max: sorted[n - 1],
    };
}

// Fraction of folds on which the candidate's metric strictly beats the
// baseline's (paired by fold index). The "did it win almost everywhere, or just
// on average?" guard.
export function foldWinFraction(candidateFolds, baselineFolds, key = 'netSharpe') {
    const m = Math.min(candidateFolds.length, baselineFolds.length);
    let wins = 0;
    let n = 0;
    for (let i = 0; i < m; i++) {
        const c = candidateFolds[i] && candidateFolds[i].metrics ? candidateFolds[i].metrics[key] : NaN;
        const b = baselineFolds[i] && baselineFolds[i].metrics ? baselineFolds[i].metrics[key] : NaN;
        if (!Number.isFinite(c) || !Number.isFinite(b)) continue;
        n++;
        if (c > b) wins++;
    }
    return n ? wins / n : NaN;
}

// The lookahead audit.
//
// For every test bar t in every fold we perturb every value at index > t, re-run
// `signalForFold` on the perturbed view, and compare the signal emitted *at t*.
// If it moves, the signal at t used information from after t — lookahead. Report
// every offending (fold, index) pair, not just the first, so a partial leak is
// visible.
//
// Contract: `signalForFold` must read the information from `view`, and that
// information must be derived from the array the audit perturbs. Signals may
// legitimately depend on bars with index <= t (including earlier test bars): at
// bar t only the close at t is known, and the position it decides is realised at
// t+1.
//
// `viewFor(returns, perturb)` — optional. `perturb` is `null` for the base pass,
// or `{ after, probe, returns }` for a probe pass (`returns` is the perturbed
// array, provided for callers that consume the return series directly). A model
// whose features come from candles (the shipped `HiveMindController`) is immune
// to a returns-only perturbation, so its audit used to pass VACUOUSLY
// (docs/BUGS.md #22): supplying `viewFor` lets the caller build the view the
// model actually reads and derive it from the perturbed series. The audit then
//
//   * enforces the structural fix: when `viewFor` is supplied, the base and
//     perturbed views MUST differ, otherwise the perturbation cannot reach the
//     model and the result is reported `vacuous` (never `clean`);
//   * optionally enforces the behavioural one: with `requireReachable`, at least
//     one probe must move a *later* position, i.e. the model demonstrably reads
//     the perturbed input.
//
// `auditProbesPerFold` (0 = all) samples the decision points at that budget. The
// full sweep re-runs `signalForFold` once per test bar, which for a
// controller-backed model means a full refit per probe; sampling is a documented
// cost control, not a soundness change for a leak that manifests at every bar.
export function auditNoLookahead({
    signalForFold, folds, returns, probe = 1e3, viewFor = null,
    requireReachable = false, auditProbesPerFold = 0,
    // Optional: REUSE the already-computed per-fold signals as the base pass. The
    // scored pass IS the base pass (same fold, same unperturbed view), so on a
    // deterministic factory the two are byte-identical (measured 240/240 on the
    // real driver) and re-fitting it buys only the independent re-derivation. When
    // `reuseBase` is set and a matching `baseSignals[fi]` is supplied, the base
    // pass is not re-fit; otherwise it is (the default, so the re-derivation stays
    // available as a determinism certificate). No verdict can change either way.
    baseSignals = null, reuseBase = false,
    // Optional progress/reporting hook (round 24). `onProbe(event)` is called
    // after each base pass (`stage:'base'`) and each probe pass (`stage:'probe'`)
    // with that pass's signal, and has no effect on the audit's verdict.
    onProbe = null,
}) {
    const makeView = (r, perturb) => (viewFor ? viewFor(r, perturb) : { returns: r });
    const violations = [];
    let probes = 0;
    let viewDiffers = null;   // structural non-vacuity (only meaningful with viewFor)
    let reachable = false;    // behavioural non-vacuity: a LATER position moved
    let reachableFolds = 0;   // folds in which the shock demonstrably moved a later position
    let reusedBaseFolds = 0;  // folds whose base pass reused the scored signals (no refit)
    for (let fi = 0; fi < folds.length; fi++) {
        const fold = folds[fi];
        const baseView = makeView(returns, null);
        const reusable = reuseBase && Array.isArray(baseSignals) && Array.isArray(baseSignals[fi])
            && baseSignals[fi].length === fold.test.length;
        const base = reusable ? baseSignals[fi] : signalForFold(fold.train, fold.test, baseView);
        if (reusable) reusedBaseFolds++;
        if (!Array.isArray(base) || base.length !== fold.test.length) {
            violations.push({ fold: fi, index: -1, reason: `signal length ${base && base.length} != test length ${fold.test.length}` });
            continue;
        }
        for (let j = 0; j < base.length; j++) {
            if (!Number.isFinite(base[j])) {
                violations.push({ fold: fi, index: fold.test[j], pos: j, reason: `non-finite position ${base[j]} in the signal` });
            }
        }
        if (onProbe) onProbe({ t: 'pass', stage: 'base', foldIndex: fi, foldTotal: folds.length, test: fold.test.slice(), signals: base, reused: reusable });
        const stride = auditProbesPerFold > 0 ? Math.max(1, Math.ceil(fold.test.length / auditProbesPerFold)) : 1;
        let foldReachable = false;
        for (let j = 0; j < fold.test.length; j += stride) {
            const t = fold.test[j];
            const perturbed = returns.slice();
            for (let i = t + 1; i < perturbed.length; i++) perturbed[i] += probe;
            const altView = makeView(perturbed, { after: t, probe, returns: perturbed });
            if (viewFor && viewDiffers === null && t + 1 < returns.length) {
                viewDiffers = viewsDiffer(baseView, altView);
            }
            const alt = signalForFold(fold.train, fold.test, altView);
            probes++;
            if (!Array.isArray(alt)) {
                violations.push({ fold: fi, index: t, pos: j, base: base[j], alt: null, reason: 'signal is not an array on the perturbed view' });
                continue;
            }
            if (onProbe) onProbe({ t: 'pass', stage: 'probe', foldIndex: fi, foldTotal: folds.length, probeAt: t, probeIndex: j, test: fold.test.slice(), signals: alt });
            if (!Number.isFinite(alt[j])) {
                violations.push({ fold: fi, index: t, pos: j, base: base[j], alt: alt[j], reason: `non-finite position ${alt[j]} on the perturbed view` });
            } else if (alt[j] !== base[j]) {
                violations.push({ fold: fi, index: t, pos: j, base: base[j], alt: alt[j], reason: 'position at t moved when only information after t changed' });
            }
            for (let k = j + 1; k < alt.length; k++) {
                if (Number.isFinite(alt[k]) && alt[k] !== base[k]) { reachable = true; foldReachable = true; break; }
            }
        }
        if (foldReachable) reachableFolds++;
    }
    const structuralVacuous = viewFor != null && viewDiffers === false;
    if (structuralVacuous) {
        violations.push({ fold: -1, index: -1, reason: 'vacuous view: the perturbation does not change the object the model reads, so the audit cannot reach its input (docs/BUGS.md #22)' });
    }
    if (requireReachable && !reachable) {
        violations.push({ fold: -1, index: -1, reason: 'vacuous audit: perturbing all future information never moved a later position, so the model does not read the audited input' });
    }
    return {
        clean: violations.length === 0, violations, probes, viewDiffers, reachable, reachableFolds,
        baseReused: reusedBaseFolds,
        vacuous: structuralVacuous || (requireReachable && !reachable),
    };
}

// Do two views carry different information? Structural comparison of the object
// the model reads; a view that cannot be serialised is treated as different (the
// structural check must never manufacture a false vacuity report).
function viewsDiffer(a, b) {
    if (a === b) return false;
    try {
        return JSON.stringify(a) !== JSON.stringify(b);
    } catch {
        return true;
    }
}

// Full walk-forward evaluation of an online model.
//
//   returns        — per-bar returns aligned to the model's index space
//   folds          — from `walkForwardSplit` (causal) or `purgedKFoldSplit`
//   signalForFold  — (trainIdx, testIdx, view) => positions for testIdx
//   costBps        — transaction cost charged on position turnover
//
// When `requireCausal` (default true) every fold must satisfy `isCausalFold`,
// otherwise the evaluation throws: an online model trained on future bars is not
// a walk-forward, no matter how the metrics read. Set it false only for a fixed
// signal evaluated with purged K-fold.
//
// Returns the `purgedCVBacktest` report plus a `{ aggregate, audit }` layer. The
// metric pooling is delegated to `purgedCVBacktest` so the numbers are the ones
// the rest of the analysis layer already reports.
export function walkForwardEvaluate({
    returns, folds, signalForFold, costBps = 0, periodsPerYear = 252, trials = 1,
    audit = true, requireCausal = true,
    viewFor = null, probe = 1e3, requireReachable = false, auditProbesPerFold = 0,
    // The raw pre-policy confidence for the same folds (round 26, R26-3). Journaled
    // beside the emitted positions so a policy sweep is pure post-processing; it has
    // no arithmetic effect on any metric.
    confidenceForFold = null,
    // Reuse the scored pass as the audit's base pass (one less refit per fold; the
    // verdict is provably unchanged — see `auditNoLookahead`).
    auditReuseBase = false,
    // Optional reporting hook (round 24): every scored fold and every audit pass is
    // forwarded here (`{t:'fold'...}` / `{t:'pass', stage:'base'|'probe'...}`) so a
    // long run can stream a fold journal and report live progress. No arithmetic.
    onEvent = null,
}) {
    if (!Array.isArray(folds) || folds.length === 0) {
        throw new Error('walkForwardEvaluate: folds required (use walkForwardSplit / purgedKFoldSplit)');
    }
    if (typeof signalForFold !== 'function') {
        throw new Error('walkForwardEvaluate: signalForFold(trainIdx, testIdx, view) required');
    }
    if (requireCausal) {
        const bad = folds.filter((f) => !isCausalFold(f));
        if (bad.length) {
            throw new Error(`walkForwardEvaluate: ${bad.length}/${folds.length} fold(s) train on/after their test block (not causal walk-forward)`);
        }
    }
    const view = (r, perturb) => (viewFor ? viewFor(r, perturb) : { returns: r });
    const wrapped = (train, test) => signalForFold(train, test, view(returns, null));
    const wrappedConfidence = typeof confidenceForFold === 'function'
        ? (train, test) => confidenceForFold(train, test, view(returns, null))
        : null;
    const cv = purgedCVBacktest({
        returns, signalForFold: wrapped, confidenceForFold: wrappedConfidence, folds, costBps, periodsPerYear, trials,
        onFold: onEvent,
    });
    const aggregate = aggregateFolds(cv.folds);
    const auditResult = audit
        ? auditNoLookahead({
            signalForFold, folds, returns, probe, viewFor, requireReachable, auditProbesPerFold, onProbe: onEvent,
            baseSignals: cv.foldSignals, reuseBase: auditReuseBase,
        })
        : null;
    return {
        folds: cv.folds,
        foldInputs: cv.foldInputs,
        // The number of configurations the search ran: every DSR in this report was
        // deflated by it, so it rides along and a cost restatement cannot silently
        // re-deflate with a different value.
        trials,
        pooledMetrics: cv.pooledMetrics,
        meanFoldSharpe: cv.meanFoldSharpe,
        pooledBars: cv.pooledBars,
        pooledReturns: cv.pooledReturns,
        pooledGross: cv.pooledGross,
        foldLengths: folds.map((f) => f.test.length),
        aggregate,
        audit: auditResult,
        power: powerSummary(cv.pooledMetrics.netSharpe, cv.pooledBars, periodsPerYear),
        probed: viewFor != null,
    };
}

// The concurrent twin of `walkForwardEvaluate` (round 26, R26-4). Identical
// arithmetic and identical emit order; only *when* a fold's positions are decided
// changes. Pass `foldExecutor(ctx)` to dispatch the decision (e.g. to a worker),
// or `signalForFold` to run the same decision in-process (the serial executor).
// The look-ahead audit still runs serially after the scored pass and reads the
// same `foldSignals`, so its passes are byte-identical too. With no executor and
// no `signalForFold`, this throws — there is nothing to schedule.
export async function walkForwardEvaluateAsync({
    returns, folds, signalForFold = null, foldExecutor = null, costBps = 0, periodsPerYear = 252, trials = 1,
    audit = true, requireCausal = true,
    viewFor = null, probe = 1e3, requireReachable = false, auditProbesPerFold = 0,
    confidenceForFold = null, auditReuseBase = false, onEvent = null, concurrency = 1,
}) {
    if (!Array.isArray(folds) || folds.length === 0) {
        throw new Error('walkForwardEvaluateAsync: folds required (use walkForwardSplit / purgedKFoldSplit)');
    }
    if (typeof foldExecutor !== 'function' && typeof signalForFold !== 'function') {
        throw new Error('walkForwardEvaluateAsync: foldExecutor(ctx) or signalForFold(trainIdx, testIdx, view) required');
    }
    // The audit re-fits the signal on perturbed views, so it can only run with an
    // in-process `signalForFold` — a fold executor has no view channel. Fail loudly
    // rather than as a `signalForFold is not a function` TypeError mid-audit.
    if (audit && typeof signalForFold !== 'function') {
        throw new Error('walkForwardEvaluateAsync: `audit` requires an in-process signalForFold (the look-ahead audit re-fits perturbed views; a foldExecutor alone cannot audit)');
    }
    if (requireCausal) {
        const bad = folds.filter((f) => !isCausalFold(f));
        if (bad.length) {
            throw new Error(`walkForwardEvaluateAsync: ${bad.length}/${folds.length} fold(s) train on/after their test block (not causal walk-forward)`);
        }
    }
    const width = normaliseConcurrency(concurrency, { max: folds.length });
    const view = (r, perturb) => (viewFor ? viewFor(r, perturb) : { returns: r });
    const exec = foldExecutor || (async ({ train, test }) => {
        const positions = signalForFold(train, test, view(returns, null));
        const confidence = typeof confidenceForFold === 'function' ? confidenceForFold(train, test, view(returns, null)) : null;
        return { signals: positions, confidence };
    });
    const cv = await purgedCVBacktestAsync({
        returns, folds, foldExecutor: exec, costBps, periodsPerYear, trials,
        onFold: onEvent, concurrency: width,
    });
    const aggregate = aggregateFolds(cv.folds);
    const auditResult = audit
        ? auditNoLookahead({
            signalForFold, folds, returns, probe, viewFor, requireReachable, auditProbesPerFold, onProbe: onEvent,
            baseSignals: cv.foldSignals, reuseBase: auditReuseBase,
        })
        : null;
    return {
        folds: cv.folds,
        foldInputs: cv.foldInputs,
        trials,
        pooledMetrics: cv.pooledMetrics,
        meanFoldSharpe: cv.meanFoldSharpe,
        pooledBars: cv.pooledBars,
        pooledReturns: cv.pooledReturns,
        pooledGross: cv.pooledGross,
        foldLengths: folds.map((f) => f.test.length),
        aggregate,
        audit: auditResult,
        power: powerSummary(cv.pooledMetrics.netSharpe, cv.pooledBars, periodsPerYear),
        probed: viewFor != null,
    };
}

// Statistical power of a pooled Sharpe estimate (round 23, N2). A null A/B
// verdict is only informative if the evaluation could have detected an effect, so
// every report carries the large-sample standard error of the Sharpe estimate and
// the corresponding 95% two-sided minimum detectable Sharpe.
//
// Lo (2002), "The Statistics of Sharpe Ratios": for T observations and per-period
// Sharpe s, SE(s) = sqrt((1 + s^2/2)/T); annualised with P periods per year,
// SR = s*sqrt(P) and SE(SR) = sqrt((P + SR^2/2)/T).
export function sharpeStandardError(sharpe, bars, periodsPerYear = 252) {
    if (!Number.isFinite(sharpe) || !Number.isFinite(bars) || bars <= 0) return NaN;
    return Math.sqrt((periodsPerYear + 0.5 * sharpe * sharpe) / bars);
}

// The 95% two-sided minimum detectable annualised Sharpe (1.96 * SE).
export function minimumDetectableSharpe(sharpe, bars, periodsPerYear = 252, z = 1.959964) {
    const se = sharpeStandardError(sharpe, bars, periodsPerYear);
    return Number.isFinite(se) ? z * se : NaN;
}

// The annualised Sharpe above which a null A/B verdict stops being informative:
// if the run could not have detected an edge of this size, `keep-off` cannot
// distinguish "no edge" from "not enough data", and the honest verdict is
// "underpowered", not "no edge". One Sharpe is a deliberately generous bar.
export const UNDERPOWERED_MDE = 1.0;

// The pooled bars needed to detect an annualised Sharpe at `z` confidence, from
// the same Lo (2002) large-sample standard error: SE(SR)^2 = (P + SR^2/2)/T, so
// T ≈ P*(z/SR)^2 to leading order. NaN for a non-positive Sharpe (no finite
// sample detects a zero or negative edge).
export function barsToDetect(sharpe, periodsPerYear = 252, z = 1.959964) {
    if (!Number.isFinite(sharpe) || sharpe <= 0 || !Number.isFinite(periodsPerYear) || periodsPerYear <= 0) return NaN;
    return Math.ceil(periodsPerYear * (z / sharpe) ** 2);
}

function powerSummary(sharpe, bars, periodsPerYear, dependence = null) {
    const se = sharpeStandardError(sharpe, bars, periodsPerYear);
    const mdeSharpe = Number.isFinite(se) ? 1.959964 * se : NaN;
    const base = {
        bars,
        se,
        mdeSharpe,
        observedSharpe: sharpe,
        // The report-level honesty flag (round 24b): a null verdict from a run
        // that could not detect a Sharpe of 1 is uninformative, so the summary
        // says so instead of implying "no edge".
        underpowered: Number.isFinite(mdeSharpe) && mdeSharpe > UNDERPOWERED_MDE,
        // The sample size that WOULD detect an annualised Sharpe of 1 at 95% —
        // the sizing knob for the next (power) run.
        barsToDetect1: barsToDetect(1, periodsPerYear),
    };
    // Round 25. `se`/`mdeSharpe`/`underpowered` above assume the `bars` are
    // independent draws — which a pooled cross-stream report is not (see
    // `dependence.js`). When the pooled panel supplied a cluster view, the honest
    // numbers ride alongside rather than replacing them, so a reader can always
    // see how much of the "power" was the i.i.d. assumption.
    if (dependence && Number.isFinite(dependence.seCluster)) {
        const seDependent = dependence.seCluster;
        const mdeSharpeDependent = 1.959964 * seDependent;
        return {
            ...base,
            seDependent,
            mdeSharpeDependent,
            underpoweredDependent: Number.isFinite(mdeSharpeDependent) && mdeSharpeDependent > UNDERPOWERED_MDE,
            varianceInflation: dependence.designEffect,
            effectiveBars: dependence.effectiveBars,
        };
    }
    return base;
}

// ---------------------------------------------------------------------------
// Dependence-aware inference for a pooled multi-stream report (round 25)
// ---------------------------------------------------------------------------
// The pooled sample of a K-stream walk-forward is a rectangular fold grid: every
// stream contributes the same folds of the same length, and the same fold is the
// same calendar window. Two consequences the i.i.d. readout cannot express, both
// measured on the attempt-3 power run (`RUN-ANALYSIS.md` §5.6):
//
//   - the K streams are strongly correlated per fold (0.41-0.52 there), so K
//     streams are worth `equicorrelationEffectiveSize(K, rbar)` ∝ 1-2 independent
//     ones (Kish 1965);
//   - the pooled Sharpe's true standard error is ~2x the i.i.d. Lo (2002) SE.
//
// `dependenceSummary` measures both from the panel itself with the delete-one-
// cluster jackknife over fold-window clusters (`dependence.js`; Cameron & Miller
// 2015). It is O(folds) Sharpe evaluations — seconds at power scale — and
// deterministic.
export function dependenceSummary({ streamReturns, streamFoldLengths = null, foldLength = null, periodsPerYear = 252 } = {}) {
    if (!Array.isArray(streamReturns) || streamReturns.length < 2) {
        return { available: false, reason: 'a single stream has no cross-stream dependence to measure' };
    }
    const first = streamReturns[0];
    if (!Array.isArray(first) || first.length === 0) {
        return { available: false, reason: 'stream returns are missing' };
    }
    if (!streamReturns.every((s) => Array.isArray(s) && s.length === first.length)) {
        return { available: false, reason: 'streams are not equal length (not a rectangular fold grid)' };
    }
    // The fold length has to be derivable: prefer the explicit argument, then the
    // per-stream fold-length list (all folds equal), then infer the divisor.
    let q = Number.isInteger(foldLength) && foldLength > 0 ? foldLength : null;
    if (q == null && Array.isArray(streamFoldLengths) && Array.isArray(streamFoldLengths[0]) && streamFoldLengths[0].length) {
        const lens = streamFoldLengths[0];
        if (lens.every((l) => l === lens[0])) q = lens[0];
    }
    if (q == null || first.length % q !== 0) {
        return { available: false, reason: 'the fold grid is not rectangular (fold lengths differ or do not tile the stream)' };
    }
    const clusters = foldWindowClusters(streamReturns, q);
    const statistic = (a) => sharpeRatio(a, { periodsPerYear });
    const jk = clusterJackknife({ clusters, statistic });
    const pooled = streamReturns.flat();
    const n = pooled.length;
    const seIid = sharpeStandardError(statistic(pooled), n, periodsPerYear);
    // Per-stream per-fold statistic series, for the "how correlated are the
    // streams really?" readout. A 15-bar fold Sharpe is noisy but *paired* across
    // streams in the same window, which is exactly the quantity the question is
    // about.
    const perFoldSeries = streamReturns.map((s) => {
        const out = [];
        for (let from = 0; from < s.length; from += q) out.push(sharpeRatio(s.slice(from, from + q), { periodsPerYear }));
        return out;
    });
    const meanPairwiseStreamCorr = meanPairwiseCorrelation(perFoldSeries);
    const designEffect = Number.isFinite(seIid) && seIid > 0 && Number.isFinite(jk.se) ? (jk.se / seIid) ** 2 : NaN;
    return {
        available: true,
        nClusters: jk.nClusters,
        clustersPerStream: jk.nClusters,
        foldLength: q,
        streams: streamReturns.length,
        // The cluster jackknife's SE of the pooled Sharpe (the honest one).
        seCluster: jk.se,
        // The i.i.d. Lo (2002) SE it is measured against.
        seIid,
        // (seCluster / seIid)^2: the factor by which the i.i.d. variance of the
        // pooled Sharpe understates the truth. It absorbs serial dependence,
        // cross-stream dependence and non-normality together — it is a variance
        // inflation, not a pure correlation coefficient.
        designEffect,
        // The sample size that would have the same information if the bars were
        // independent: what the DSR/PSR floors should use. Note this can EXCEED the
        // bar count when the streams are diversifying (designEffect < 1) — the
        // variance really is smaller than i.i.d. — but `backtestMetrics` deliberately
        // declines to *inflate* confidence beyond the raw sample, so the adjusted
        // metrics are null in that case and `adjustmentNeeded` says why.
        effectiveBars: Number.isFinite(designEffect) && designEffect > 0 ? n / designEffect : null,
        // True when the i.i.d. readout is genuinely over-confident and the adjusted
        // floors apply; false when the panel is diversifying (nothing to deflate).
        adjustmentNeeded: Number.isFinite(designEffect) && designEffect > 1,
        // The equicorrelation reading (Kish 1965): with an average pairwise
        // correlation `rbar`, K streams are worth this many independent ones.
        meanPairwiseStreamCorr,
        equicorrelationDesignEffect: equicorrelationDesignEffect(streamReturns.length, meanPairwiseStreamCorr),
        effectiveStreams: equicorrelationEffectiveSize(streamReturns.length, meanPairwiseStreamCorr),
        reader: 'seCluster = delete-one-cluster jackknife SE of the pooled Sharpe over fold-window clusters (Cameron & Miller 2015); designEffect = (seCluster/seIid)^2; effectiveBars = bars/designEffect (feeds psrAdjusted/dsrAdjusted when adjustmentNeeded); adjustmentNeeded = designEffect > 1 (the i.i.d. readout is over-confident only then); effectiveStreams = K/(1+(K-1)*rbar) (Kish 1965).',
    };
}

// The fold-window clusters of a report, or null when the report has no
// cross-stream panel (a single stream) or no retained per-stream returns.
export function clustersOf(report, { periodsPerYear = 252 } = {}) {
    if (!report || !Array.isArray(report.streamReturns) || report.streamReturns.length < 2) return null;
    const q = report.dependence && report.dependence.available ? report.dependence.foldLength : null;
    if (!Number.isInteger(q) || q < 1) return null;
    try {
        return foldWindowClusters(report.streamReturns, q);
    } catch {
        return null;
    }
}

// Merge per-stream walk-forward reports into one (ROADMAP round 23, N2). Each
// stream (e.g. one symbol) contributes its folds as segments of a single pooled
// out-of-sample stream, so the pooled metrics, the fold aggregate, the
// family-wise search `groups` and the audit all describe the whole cross-symbol
// evaluation rather than one symbol.
//
// The pooling arithmetic is `backtest#poolFolds` — the same function a single
// stream uses — so a merged report and a single-stream report are directly
// comparable. A single report is returned untouched (no re-pooling), so the
// one-stream path stays byte-identical.
export function poolReports(reports, { periodsPerYear = 252, trials = 1, extraPanelStreams = null } = {}) {
    if (!Array.isArray(reports) || reports.length === 0) {
        throw new Error('poolReports: at least one report is required');
    }
    if (reports.length === 1) return reports[0];
    const perFold = reports.flatMap((r) => r.folds || []);
    const pooled = reports.flatMap((r) => r.pooledReturns || []);
    const pooledGross = reports.flatMap((r) => r.pooledGross || []);
    // The per-stream panel, retained by reference: `streamReturns` is what the
    // dependence machinery groups into fold-window clusters, and `foldInputs` is
    // what lets the report be restated at another cost level (round 25).
    const priceStreamReturns = reports.map((r) => r.pooledReturns || []);
    const priceFoldLengths = reports.map((r) => r.foldLengths || []);
    // Round 29 -> 30 (P4): a funding/carry sleeve is a genuinely independent RETURN
    // source, so the DSR's design-effect adjustment should count it. Extra streams
    // are appended to the panel (never to the scored price returns), and each extra
    // stream is declared as one fold of its own length. A stream in this panel is a
    // PER-STREAM series (the test bars of one world, folds concatenated) — so an
    // extra stream must match `priceStreamReturns[0].length`, NOT the concatenated
    // `pooled.length` (which is every stream's bars). A mismatch is reported as
    // unavailable rather than silently dropped (a silent drop would leave the
    // design effect looking better than it is).
    const extra = (Array.isArray(extraPanelStreams) ? extraPanelStreams : [])
        .filter((s) => Array.isArray(s) && s.length);
    const panelLength = priceStreamReturns.length ? (priceStreamReturns[0] || []).length : 0;
    const hasVariance = (s) => {
        const first = s[0];
        for (let i = 1; i < s.length; i++) if (s[i] !== first) return true;
        return false;
    };
    const lengthMismatch = extra.some((s) => s.length !== panelLength);
    // A CONSTANT stream carries no information and makes every pairwise correlation
    // undefined, so it must not enter the panel either — that is the same class of
    // silent degradation the length check guards (and is exactly what a mis-wired
    // sleeve, e.g. an all-zero carry series, looks like).
    const degenerate = extra.some((s) => !hasVariance(s));
    const panelMismatch = lengthMismatch || degenerate;
    const panelMismatchReason = lengthMismatch ? 'length' : (degenerate ? 'degenerate' : null);
    const streamReturns = panelMismatch ? priceStreamReturns : [...priceStreamReturns, ...extra];
    const streamFoldLengths = panelMismatch ? priceFoldLengths : [...priceFoldLengths, ...extra.map((s) => [s.length])];
    const foldInputs = reports.flatMap((r) => r.foldInputs || []);
    const priceDependence = dependenceSummary({ streamReturns: priceStreamReturns, streamFoldLengths: priceFoldLengths, periodsPerYear });
    const dependence = panelMismatch
        ? priceDependence
        : dependenceSummary({ streamReturns, streamFoldLengths, periodsPerYear });
    const effectiveBars = dependence && dependence.available ? dependence.effectiveBars : null;
    const { pooledMetrics, meanFoldSharpe } = poolFolds(perFold, pooled, pooledGross, { periodsPerYear, trials, effectiveBars });
    const audits = reports.map((r) => r.audit).filter(Boolean);
    const audit = audits.length
        ? {
            clean: audits.every((a) => a.clean),
            vacuous: audits.some((a) => a.vacuous),
            reachable: audits.every((a) => a.reachable === true),
            viewDiffers: audits.every((a) => a.viewDiffers !== false),
            probes: audits.reduce((n, a) => n + (a.probes || 0), 0),
            reachableFolds: audits.reduce((n, a) => n + (a.reachableFolds || 0), 0),
            baseReused: audits.reduce((n, a) => n + (a.baseReused || 0), 0),
            violations: audits.flatMap((a) => a.violations || []),
            streams: audits.length,
        }
        : null;
    return {
        folds: perFold,
        pooledMetrics,
        meanFoldSharpe,
        trials,
        pooledBars: pooled.length,
        pooledReturns: pooled,
        pooledGross,
        streamReturns,
        streamFoldLengths,
        foldInputs,
        foldLengths: reports.flatMap((r) => r.foldLengths || []),
        aggregate: aggregateFolds(perFold),
        dependence,
        // Round 29 -> 30 (P4): the extra (carry/funding) panel streams that were
        // folded into `dependence`, plus the PRICE-ONLY dependence so a reader can
        // see exactly what adding the sleeve did. `panelMismatch` is true when a
        // supplied stream did not tile the pooled price grid, in which case the
        // extra streams were excluded from `dependence` (never silently averaged).
        panelStreams: extra.length,
        panelMismatch,
        panelMismatchReason,
        dependenceWithoutExtras: extra.length ? priceDependence : null,
        extraPanelStreams: extra.length && !panelMismatch ? extra : null,
        audit,
        power: powerSummary(pooledMetrics.netSharpe, pooled.length, periodsPerYear, dependence),
        probed: reports.some((r) => r.probed === true),
    };
}

// The promotion decision. A candidate feature/config is promoted over a baseline
// only when it clears every hurdle:
//
//   - mean fold Sharpe improves by at least `minSharpeDelta`,
//   - pooled deflated Sharpe is at least `minDsrDelta` better than the baseline,
//   - pooled DSR is at least `minDsr` in absolute terms — the candidate must
//     demonstrate an *edge*, not merely beat another non-edge. This floor is what
//     fixes the gate's size: comparing two zero-skill signals, "better than the
//     other" is a coin flip (~40% false promotions measured), whereas demanding
//     DSR >= 0.95 as well gives ~3.5% size at full power on a genuine edge
//     (measured over 300 driftless-walk seeds, 5 walk-forward folds each). See
//     `walkforward.test.js` / `analysis.test.js` section S.
//   - the lookahead audits pass (when `requireCleanAudit`).
//
// R28 (BUGS.md #57): the two RAW fold hurdles (`foldWinFraction >= 0.5` and
// `positiveFraction >= baseline`) are no longer part of the SHIPPED
// (dependence-aware) gate. `DESIGN.md` §6.1 recorded that decision in round 25
// ("the raw fraction is still reported, as a statistic") but the code kept them
// always-on, so the best round-27 arm reported a 0.20 fold-win fraction over 288
// correlated folds while the error-controlled window-level sign test put it at
// exactly 0.50. They remain supported (`rawFoldHurdles`, default true, preserves
// the round-23/24 classic path and its published size/power calibration) and
// `foldWinFraction`/`positiveFoldFraction` are always returned as statistics.
//
// Round 25 adds the dependence-aware hurdles, all default-off so the round-23/24
// decision path is byte-identical unless a caller opts in (the real driver does):
//
//   - `requireSharpeDiff`: the candidate's pooled Sharpe must beat the baseline's
//     by more than the sampling error of the *difference*, with the standard
//     error taken from a delete-one-cluster jackknife over fold-window clusters
//     (Cameron & Miller 2015) and the p-value referenced to t(C-1). This is the
//     honest replacement for "the mean fold Sharpe went up": with 8 correlated
//     streams the i.i.d. comparison overstates significance by ~2x.
//   - `requireBreadth` (round 25; now REPORTED, not shipped): the candidate must
//     win the majority of fold *windows* significantly, by an exact sign test over
//     the same clusters (Demsar 2006). Kept as an option, but round 26 (R26-7)
//     removed it from the shipped gate: it passed 8/8 candidates and hit its 2^-n
//     floor on three, so it separated nothing about magnitude. `minFoldWinFraction`
//     compares a raw fraction of 288 correlated folds against 0.5 with no reference
//     distribution, so a margin of 0.4896-vs-0.5000 is unreadable; the sign test is
//     still computed and reported as `promotionTest.breadth`.
//   - `requireClusterStability` (round 26, R26-7): the MAGNITUDE companion to the
//     sign test. The paired Sharpe difference must stay positive when ANY single
//     fold-window cluster is deleted (`clusterStability`). A candidate whose edge is
//     carried by a handful of windows — the measured `sig:volume` case, where the
//     best 20 of 1,136 folds carry 108% of the gross — fails this even when it wins
//     most windows and the full-sample magnitude test.
//   - `minDsrAdjusted`: the DSR floor applied to the design-effect-adjusted DSR
//     (`pooledMetrics.dsrAdjusted`, computed on `effectiveBars`). Skipped — not
//     failed — when no cross-stream panel exists to estimate the design effect
//     from (a single stream has no cross-stream dependence to correct).
//
// All three are SKIPPED rather than failed when the input does not exist (no
// cross-stream panel to estimate them from), which is the honest reading of a
// single-stream report: inventing a design effect of 1 and calling it "applied"
// would be a false claim, and failing every candidate would make a one-symbol run
// un-promotable. `minDsrAdjusted` additionally distinguishes `not-needed` (a panel
// exists but its design effect is <= 1, so the unadjusted floor was already
// honest) from `skipped-no-panel`. The returned `gate` object records
// `applied` / `skipped-no-panel` / `not-needed` / `off` per hurdle, so a report can
// never claim a hurdle it did not actually evaluate.
//
// Returns `{ promote, reasons, foldWinFraction, promotionTest, gate }`; `reasons`
// is empty iff promoted, so the caller can log exactly which hurdle failed, and
// `promotionTest` carries the numbers behind the round-25 hurdles (or
// `{available:false}` when there is no panel) so the report can show them even
// when the classic gate was used.
export function promoteDecision(baseline, candidate, {
    minSharpeDelta = 0,
    minDsrDelta = 0,
    minDsr = 0.95,
    minFoldWinFraction = 0.5,
    minPositiveFoldDelta = 0,
    // R28 (BUGS.md #57): the two RAW fold hurdles are statistics, not gate
    // hurdles. `true` preserves the round-23/24 classic gate (and its published
    // size/power calibration); the shipped dependence-aware gate passes `false`
    // and relies on the error-controlled cluster tests. `foldWinFraction` and
    // `positiveFoldFraction` are returned either way.
    rawFoldHurdles = true,
    requireCleanAudit = true,
    maxSearchP = null,
    requireSearchReject = false,
    maxFdp = null,
    // Round 25 (all default-off).
    requireSharpeDiff = false,
    requireBreadth = false,
    // Round 26 (R26-7): the stability half of the dependence gate — the pooled edge
    // must survive deleting any single fold-window cluster (the statistical form of
    // "the edge is not carried by a handful of folds"). `requireBreadth` (the exact
    // sign test) is retained as an option but is no longer part of the shipped gate:
    // it is a REPORTED statistic.
    requireClusterStability = false,
    minStableFraction = 1,
    minDsrAdjusted = null,
    alpha = 0.05,
    periodsPerYear = 252,
} = {}) {
    const reasons = [];
    // R28 (BUGS.md #55/#56): every evaluated hurdle is also recorded with its
    // value, threshold and MARGIN, so a knife-edge miss is legible in the report
    // (the round-27 `sig:momentum` adjusted DSR is 0.00124 below the 0.95 floor).
    // `reasons` keeps its string form for every existing reader; `hurdles` is the
    // structured companion and `tightestHurdle` is the closest one to its line.
    const hurdles = [];
    const record = (hurdle, value, threshold, direction, failed, gated = true) => {
        const vNum = typeof value === 'number' && Number.isFinite(value);
        const tNum = typeof threshold === 'number' && Number.isFinite(threshold);
        hurdles.push({
            hurdle,
            value: vNum ? value : (value === undefined ? null : value),
            threshold: tNum ? threshold : (threshold === undefined ? null : threshold),
            direction,
            margin: vNum && tNum ? value - threshold : null,
            failed: !!failed,
            // `gated:false` = a REPORTED STATISTIC that did not participate in the
            // verdict (R28, BUGS.md #57: the raw fold fractions). Its `failed` and
            // `margin` are still the honest evaluation of its stated rule, so a
            // reader can see it was below the line; `gated:false` records that the
            // failure could not affect the verdict (and `tightestHurdle` skips it).
            gated,
        });
    };
    const fail = (hurdle, value, threshold, direction, reason) => {
        record(hurdle, value, threshold, direction, true);
        reasons.push(reason);
    };
    const pass = (hurdle, value, threshold, direction, gated = true) => record(hurdle, value, threshold, direction, false, gated);
    const promotionTest = pairedPromotionTest(baseline, candidate, { alpha, periodsPerYear, minStableFraction });
    const bMean = baseline.aggregate ? baseline.aggregate.mean : baseline.meanFoldSharpe;
    const cMean = candidate.aggregate ? candidate.aggregate.mean : candidate.meanFoldSharpe;
    const bDsr = baseline.pooledMetrics ? baseline.pooledMetrics.dsr : NaN;
    const cDsr = candidate.pooledMetrics ? candidate.pooledMetrics.dsr : NaN;

    if (!(cMean >= bMean + minSharpeDelta)) {
        fail('meanSharpeDelta', cMean, bMean + minSharpeDelta, 'candidate >= baseline + minSharpeDelta',
            `mean fold Sharpe ${cMean} < baseline ${bMean} + ${minSharpeDelta}`);
    } else pass('meanSharpeDelta', cMean, bMean + minSharpeDelta, 'candidate >= baseline + minSharpeDelta');
    if (!(cDsr >= bDsr + minDsrDelta)) {
        fail('dsrDelta', cDsr, bDsr + minDsrDelta, 'candidate >= baseline + minDsrDelta',
            `pooled DSR ${cDsr} < baseline ${bDsr} + ${minDsrDelta}`);
    } else pass('dsrDelta', cDsr, bDsr + minDsrDelta, 'candidate >= baseline + minDsrDelta');
    if (!(cDsr >= minDsr)) {
        fail('minDsr', cDsr, minDsr, 'candidate >= minDsr',
            `pooled DSR ${cDsr} < ${minDsr} (no demonstrated edge)`);
    } else pass('minDsr', cDsr, minDsr, 'candidate >= minDsr');
    const win = foldWinFraction(candidate.folds, baseline.folds);
    const bPos = baseline.aggregate ? baseline.aggregate.positiveFraction : NaN;
    const cPos = candidate.aggregate ? candidate.aggregate.positiveFraction : NaN;
    // R28 (BUGS.md #57): computed and returned as statistics in every case; the
    // REASON is only pushed when the classic raw hurdles are enabled. `failed` is
    // the honest evaluation of the stated decision rule at this run's numbers (so a
    // reported statistic can be seen to be below its line); `gated:false` says that
    // failure could not affect the verdict.
    if (Number.isFinite(win)) {
        const winFails = win < minFoldWinFraction;
        if (rawFoldHurdles && winFails) {
            fail('foldWinFraction', win, minFoldWinFraction, 'candidate >= minFoldWinFraction',
                `fold win fraction ${win} < ${minFoldWinFraction}`);
        } else {
            record('foldWinFraction', win, minFoldWinFraction, 'candidate >= minFoldWinFraction', winFails, rawFoldHurdles);
        }
    }
    if (Number.isFinite(bPos) && Number.isFinite(cPos)) {
        const posFails = !(cPos >= bPos + minPositiveFoldDelta);
        if (rawFoldHurdles && posFails) {
            fail('positiveFoldFraction', cPos, bPos + minPositiveFoldDelta, 'candidate >= baseline + minPositiveFoldDelta',
                `positive-fold fraction ${cPos} < baseline ${bPos} + ${minPositiveFoldDelta}`);
        } else {
            record('positiveFoldFraction', cPos, bPos + minPositiveFoldDelta, 'candidate >= baseline + minPositiveFoldDelta', posFails, rawFoldHurdles);
        }
    }
    if (requireCleanAudit) {
        if (baseline.audit && !baseline.audit.clean) fail('baselineAudit', false, true, 'audit clean', `baseline failed the lookahead audit (${baseline.audit.violations.length} violations)`);
        if (candidate.audit && !candidate.audit.clean) fail('candidateAudit', false, true, 'audit clean', `candidate failed the lookahead audit (${candidate.audit.violations.length} violations)`);
    }
    // --- round 25: dependence-aware hurdles (default-off) --------------------
    // A hurdle whose input does not exist is SKIPPED, not failed: a single-stream
    // report has no cross-stream panel, so there is nothing to estimate a design
    // effect or a paired test from. `gate` records which happened per hurdle, so
    // a report can never claim a gate it did not actually apply.
    const gate = { minDsrAdjusted: 'off', requireSharpeDiff: 'off', requireBreadth: 'off', requireClusterStability: 'off' };
    const hasPanel = (r) => !!(r && Array.isArray(r.streamReturns) && r.streamReturns.length >= 2
        && r.dependence && r.dependence.available);
    const panel = hasPanel(baseline) && hasPanel(candidate);
    if (minDsrAdjusted != null) {
        const cAdj = candidate.pooledMetrics ? candidate.pooledMetrics.dsrAdjusted : null;
        if (cAdj != null) {
            gate.minDsrAdjusted = 'applied';
            if (!(cAdj >= minDsrAdjusted)) {
                fail('minDsrAdjusted', cAdj, minDsrAdjusted, 'candidate >= minDsrAdjusted',
                    `pooled DSR (dependence-adjusted, ${candidate.pooledMetrics.effectiveBars} effective bars) ${cAdj} < ${minDsrAdjusted}`);
            } else pass('minDsrAdjusted', cAdj, minDsrAdjusted, 'candidate >= minDsrAdjusted');
        } else if (!hasPanel(candidate)) {
            // No cross-stream panel at all: a single stream has no cross-stream
            // dependence, so the unadjusted floor above is already the honest one.
            gate.minDsrAdjusted = 'skipped-no-panel';
        } else {
            // The panel EXISTS but the measured design effect is <= 1 (the streams
            // are diversifying rather than redundant), so there is no
            // over-confidence to deflate and the unadjusted floor is again the
            // honest one. This is "NOT NEEDED" — a different statement from "could
            // not be computed", and the report must not conflate the two.
            gate.minDsrAdjusted = 'not-needed';
        }
    }
    if (requireSharpeDiff) {
        if (!panel) {
            gate.requireSharpeDiff = 'skipped-no-panel';
        } else {
            gate.requireSharpeDiff = 'applied';
            if (!promotionTest.available) {
                reasons.push(`paired Sharpe-difference test unavailable (${promotionTest.reason})`);
            } else {
                const d = promotionTest.sharpeDifference;
                // R28 (BUGS.md #55/#56): the margin is against the ONE-SIDED
                // cluster-t threshold the test itself uses, so "how close was it"
                // is a real quantity (the round-27 `label:conservative` value
                // 0.2164 is 0.0126 below the 0.2290 it needed).
                const crit = Number.isFinite(d.df) ? studentTCritical(d.df, { alpha, twoSided: false }) : NaN;
                const threshold = Number.isFinite(crit) ? crit * d.se : null;
                if (!d.significant) {
                    fail('pairedSharpeDifference', d.value, threshold,
                        'candidate - baseline > tCritical(df, alpha) * pairedSE',
                        `paired cluster Sharpe difference not significant at ${alpha}: dSharpe=${d.value} se=${d.se} t=${d.t} df=${d.df} p=${d.pOneSided}`);
                } else if (threshold != null) {
                    pass('pairedSharpeDifference', d.value, threshold, 'candidate - baseline > tCritical(df, alpha) * pairedSE');
                }
            }
        }
    }
    if (requireBreadth) {
        if (!panel) {
            gate.requireBreadth = 'skipped-no-panel';
        } else {
            gate.requireBreadth = 'applied';
            if (!promotionTest.available) {
                reasons.push(`breadth test unavailable (${promotionTest.reason})`);
            } else if (!promotionTest.breadth.significant) {
                const b = promotionTest.breadth;
                fail('breadth', b.pValue, alpha, 'p <= alpha',
                    `breadth ${b.wins}/${b.n} fold windows not significant at ${alpha}: p=${b.pValue} (best possible ${b.floor})`);
            } else {
                pass('breadth', promotionTest.breadth.pValue, alpha, 'p <= alpha');
            }
        }
    }
    // Round 26 (R26-7): cluster stability — the pooled edge must survive deleting any
    // single fold-window cluster. Unlike the sign test this is a MAGNITUDE check: a
    // candidate can win most windows yet be carried entirely by a few (the measured
    // `sig:volume` case: its best 20 of 1,136 folds carry 108% of its gross), and it
    // can also win the magnitude test on the full sample while one window alone
    // accounts for the edge.
    if (requireClusterStability) {
        if (!panel) {
            gate.requireClusterStability = 'skipped-no-panel';
        } else {
            gate.requireClusterStability = 'applied';
            if (!promotionTest.available) {
                reasons.push(`cluster-stability test unavailable (${promotionTest.reason})`);
            } else if (!promotionTest.stability || !promotionTest.stability.available) {
                reasons.push(`cluster-stability test unavailable (${(promotionTest.stability && promotionTest.stability.reason) || 'no stability estimate'})`);
            } else if (!promotionTest.stability.stable) {
                const s = promotionTest.stability;
                fail('clusterStability', s.fractionPositive, s.minFraction, 'fractionPositive >= minFraction',
                    `cluster stability ${s.fractionPositive} of ${s.nClusters} leave-one-window differences positive (required >= ${s.minFraction}); removing window ${s.worstCluster} alone drops the paired Sharpe difference to ${s.worstDelta}`);
            } else {
                pass('clusterStability', promotionTest.stability.fractionPositive, promotionTest.stability.minFraction, 'fractionPositive >= minFraction');
            }
        }
    }
    if (maxSearchP != null || requireSearchReject) {
        const s = candidate.search;
        const p = s && Number.isFinite(s.pValue) ? s.pValue : NaN;
        if (requireSearchReject && !(s && s.rejected)) {
            fail('searchReject', null, null, 'rejected by the family-wise search', 'candidate not rejected by the family-wise (subsampling step-down) search test');
        }
        if (maxSearchP != null) {
            if (!Number.isFinite(p)) reasons.push('family-wise search p-value missing on the candidate');
            else if (!(p <= maxSearchP)) fail('maxSearchP', p, maxSearchP, 'p <= maxSearchP', `family-wise search p ${p} > ${maxSearchP}`);
            else pass('maxSearchP', p, maxSearchP, 'p <= maxSearchP');
        }
    }
    if (maxFdp != null) {
        const f = candidate.search && candidate.search.fdp;
        if (!f) reasons.push('family-wise FDP estimate missing on the candidate');
        else if (f.nRejected < 1) reasons.push('family-wise FDP search rejected nothing');
        else if (!(Number.isFinite(f.estimatedFdp) && f.estimatedFdp <= maxFdp)) {
            fail('maxFdp', f.estimatedFdp, maxFdp, 'estimatedFdp <= maxFdp', `family-wise estimated FDP ${f.estimatedFdp} > ${maxFdp}`);
        } else pass('maxFdp', f.estimatedFdp, maxFdp, 'estimatedFdp <= maxFdp');
    }
    // The hurdle closest to its line on the side that decided the verdict: for a
    // keep-off, the FAILED hurdle with the smallest |margin| (how nearly it
    // passed); for a promotion, the PASSED hurdle with the smallest |margin| (how
    // nearly it failed). `hurdles` above carries every evaluated one.
    const decided = hurdles.filter((h) => h.margin != null && h.gated !== false && (reasons.length ? h.failed : !h.failed));
    let tightestHurdle = null;
    for (const h of decided) {
        if (!tightestHurdle || Math.abs(h.margin) < Math.abs(tightestHurdle.margin)) tightestHurdle = h;
    }
    return { promote: reasons.length === 0, reasons, hurdles, tightestHurdle, foldWinFraction: win, positiveFoldFraction: cPos, rawFoldHurdles, promotionTest, gate };
}

// ---------------------------------------------------------------------------
// The paired promotion test (round 25)
// ---------------------------------------------------------------------------
// `promoteDecision`'s classic hurdles compare two *summary numbers* — a mean
// fold Sharpe, a win fraction, a DSR — with no reference distribution and, for
// the fold hurdles, over 288 folds that are not independent observations (the
// same calendar window repeats across the streams). This builds the missing
// reference distributions from the panel itself:
//
//   sharpeDifference — paired delete-one-cluster jackknife over fold-window
//                      clusters; t referenced to t(C-1). Answers "is the pooled
//                      Sharpe improvement larger than its own sampling error?"
//   breadth          — exact sign test over the same clusters. Answers "did it
//                      win more than half the windows, significantly?" (the
//                      error-controlled version of the 0.5 win-fraction hurdle).
//
// Both are deterministic and O(C) statistic evaluations. `available:false` (with
// a reason) when the reports carry no comparable panel — a single-stream run, or
// two runs with different fold grids — so callers can fall back gracefully
// instead of inventing a test.
export function pairedPromotionTest(baseline, candidate, { alpha = 0.05, periodsPerYear = 252, minStableFraction = 1 } = {}) {
    const clustersB = clustersOf(baseline, { periodsPerYear });
    const clustersA = clustersOf(candidate, { periodsPerYear });
    if (!clustersA || !clustersB) {
        return { available: false, alpha, reason: 'no cross-stream panel on one or both reports (single stream, or per-stream returns were not retained)' };
    }
    if (clustersA.length !== clustersB.length) {
        return { available: false, alpha, reason: `the two reports have different fold-window counts (${clustersA.length} vs ${clustersB.length})` };
    }
    const statistic = (a) => sharpeRatio(a, { periodsPerYear });
    const sharpeDifference = pairedClusterTest({ clustersA, clustersB, statistic, alpha });
    const breadthRaw = pairedClusterSignTest({ clustersA, clustersB, statistic });
    const breadth = breadthRaw.available
        ? { ...breadthRaw, alpha, significant: Number.isFinite(breadthRaw.pValue) && breadthRaw.pValue <= alpha, floor: signTestFloor(breadthRaw.n) }
        : breadthRaw;
    // Round 26 (R26-7): the stability half of the gate — the pooled edge must
    // survive deleting any single fold-window cluster. Computed here (not in the
    // driver) so the number rides on `promotionTest` and is reported even under the
    // classic gate.
    const stability = clusterStability({ clustersA, clustersB, statistic, minFraction: minStableFraction });
    return {
        available: true,
        alpha,
        nClusters: clustersA.length,
        sharpeDifference,
        breadth,
        stability,
        reader: 'paired cluster test over fold-window clusters: sharpeDifference = candidate-baseline pooled Sharpe with a delete-one-cluster jackknife SE (t referenced to t(C-1)); breadth = exact sign test of per-window wins (REPORTED, no longer a gate since round 26); stability = the leave-one-cluster-out pooled Sharpe difference must stay positive for (at least) every window — the edge must not be carried by a handful of folds. sharpeDifference and stability are the round-26 gate inputs, estimated from the same clusters, the sample unit the fold structure actually repeats.',
    };
}

// ---------------------------------------------------------------------------
// Restating a report at another cost level (round 25)
// ---------------------------------------------------------------------------
// `foldInputs` retains each fold's (returns, signals) by reference, so a report
// can be re-scored at ANY transaction-cost level with exactly the arithmetic the
// scored pass used (`backtestMetrics` over the same folds, pooled with
// `poolFolds`) — without a model and without a re-run. This is what makes the
// cost ladder possible: the attempt-3 power run's verdict flipped between
// `costBps: 0` (keep-off) and `costBps: 2` (sig:acceleration promotes with zero
// reasons), and a single scored cost level cannot show that.
//
// The restated report carries everything a decision needs: per-fold metrics,
// the pooled metrics, the aggregate, the per-stream panel (rebuilt on the
// restated net returns, so the dependence block and the paired test are also
// cost-aware) and the fold lengths.
// Round 29 -> 30 (P4): extra panel streams (the funding/carry sleeve) ride along
// on a pooled report. A restatement MUST re-append them, otherwise the restated
// dependence block would silently lose an independent stream the scored block
// counted — a cost-ladder row would then disagree with the scored row for a
// reason that has nothing to do with cost.
//
// `priceStreamReturns` / `priceStreamFoldLengths` are the PRICE-ONLY panel (the
// caller rebuilds it from the journal); the extras are appended HERE, once. If the
// lengths handed in do not line up with the returns (a caller that passed the
// already-extended list, which would double-count the sleeve), they are derived
// from the returns so the panel stays rectangular.
const withExtraPanelStreams = (report, priceStreamReturns, priceStreamFoldLengths) => {
    const extras = report && Array.isArray(report.extraPanelStreams) ? report.extraPanelStreams : [];
    if (!extras.length) return { streamReturns: priceStreamReturns, streamFoldLengths: priceStreamFoldLengths };
    const lens = Array.isArray(priceStreamFoldLengths) && priceStreamFoldLengths.length === priceStreamReturns.length
        ? priceStreamFoldLengths
        : priceStreamReturns.map((s) => [s.length]);
    return {
        streamReturns: [...priceStreamReturns, ...extras],
        streamFoldLengths: [...lens, ...extras.map((s) => [s.length])],
    };
};

export function restateReportAtCost(report, costBps, { periodsPerYear = 252, trials = null } = {}) {
    if (!report || !Array.isArray(report.foldInputs) || !report.foldInputs.length) return null;
    // The deflated Sharpe depends on the number of trials the search ran, so a
    // restatement MUST use the same `trials` the scored pass did or it silently
    // reports a different DSR. Default to the report's own recorded `trials`
    // rather than to 1.
    const effectiveTrials = Number.isFinite(trials) ? trials : (Number.isFinite(report.trials) ? report.trials : 1);
    // A single-stream report is returned untouched by `poolReports` (no re-pool),
    // so it carries NO `streamFoldLengths` / `dependence` / `streamReturns`. Only a
    // pooled multi-stream report has a cross-stream panel to rebuild; restating a
    // single-stream report must not fabricate one (it would turn a `null`
    // dependence into a bogus `available:false` block and move `power`).
    const hasPanel = Array.isArray(report.streamFoldLengths) && report.streamFoldLengths.length > 0;
    const perFold = [];
    const pooled = [];
    const pooledGross = [];
    const streamReturns = [];
    const priceFoldLengths = [];
    let streamIndex = -1;
    let streamRemaining = 0;
    for (let fi = 0; fi < report.foldInputs.length; fi++) {
        const input = report.foldInputs[fi];
        const bt = strategyReturns({ returns: input.returns, signals: input.signals, costBps });
        // Carry the fold's identity from the scored report, so a restated report
        // is structurally identical to the one it restates (only the cost differs).
        const scored = report.folds && report.folds[fi] ? report.folds[fi] : {};
        perFold.push({
            testStart: scored.testStart,
            testEnd: scored.testEnd,
            metrics: backtestMetrics({ returns: input.returns, signals: input.signals, costBps, periodsPerYear, trials: effectiveTrials }),
        });
        for (const r of bt.returns) pooled.push(r);
        for (const r of bt.gross) pooledGross.push(r);
        if (hasPanel) {
            if (streamRemaining <= 0) {
                // Rebuild the per-stream panel greedily from the flat fold list: the
                // report's `streamFoldLengths` says how many folds each stream owns.
                streamReturns.push([]);
                priceFoldLengths.push([]);
                streamIndex++;
                const lens = report.streamFoldLengths[streamIndex];
                streamRemaining = Array.isArray(lens) ? lens.length : 0;
            }
            streamReturns[streamIndex].push(...bt.returns);
            priceFoldLengths[streamIndex].push(bt.returns.length);
            streamRemaining--;
        }
    }
    const rebuilt = withExtraPanelStreams(report, streamReturns, hasPanel ? priceFoldLengths : null);
    const extras = Array.isArray(report.extraPanelStreams) ? report.extraPanelStreams : [];
    const dependence = hasPanel
        ? dependenceSummary({ streamReturns: rebuilt.streamReturns, streamFoldLengths: rebuilt.streamFoldLengths, periodsPerYear })
        : (report.dependence || null);
    // The PRICE-ONLY dependence at THIS cost, so `dependence` (with the sleeve) and
    // `dependenceWithoutExtras` are a like-for-like pair at one cost level rather
    // than a restated block beside a scored one.
    const dependenceWithoutExtras = hasPanel && extras.length
        ? dependenceSummary({ streamReturns, streamFoldLengths: priceFoldLengths, periodsPerYear })
        : null;
    const effectiveBars = dependence && dependence.available ? dependence.effectiveBars : null;
    const { pooledMetrics } = poolFolds(perFold, pooled, pooledGross, { periodsPerYear, trials: effectiveTrials, effectiveBars });
    return {
        costBps,
        trials: effectiveTrials,
        folds: perFold,
        pooledMetrics,
        pooledBars: pooled.length,
        pooledReturns: pooled,
        pooledGross,
        streamReturns: hasPanel ? rebuilt.streamReturns : report.streamReturns,
        streamFoldLengths: hasPanel ? rebuilt.streamFoldLengths : report.streamFoldLengths,
        // Carry the sleeve forward so a restatement can itself be restated (the
        // cost ladder re-scores the SAME report at each level, but a chained
        // restatement must not silently lose the independent stream), plus the
        // panel bookkeeping `poolReports` attached.
        extraPanelStreams: report.extraPanelStreams || null,
        panelStreams: extras.length,
        panelMismatch: report.panelMismatch === true,
        panelMismatchReason: report.panelMismatchReason || null,
        dependenceWithoutExtras,
        foldInputs: report.foldInputs,
        foldLengths: report.foldLengths,
        aggregate: aggregateFolds(perFold),
        dependence,
        // The look-ahead audit is cost-independent, so it carries over unchanged.
        audit: report.audit || null,
        power: powerSummary(pooledMetrics.netSharpe, pooled.length, periodsPerYear, dependence),
    };
}

// Restate a report at another confidence->position policy (round 26, R26-3).
//
// The journal records, per fold, the model's raw signed confidence and the
// positions the scored policy emitted. A policy change (dead zone, scale — and,
// from R26-6, a holding rule) is then PURE POST-PROCESSING: no model is re-run.
// `restateReportAtPolicy(report, policy)` returns the restated per-fold positions
// and metrics plus the pooled/aggregate/dependence blocks, recomputed with the
// same `backtestMetrics`/`poolFolds` arithmetic the scored pass used — so a policy
// sweep is exactly the `--cost-ladder` idea applied to the mapping instead of the
// cost.
//
// Acceptance (pinned): at the scored policy this reproduces the emitted positions
// byte-for-byte (`verifyPolicyRoundTrip`), which is what makes the sweep sound.
export function restateReportAtPolicy(report, policy = {}, { costBps = 0, periodsPerYear = 252, trials = null } = {}) {
    if (!report || !Array.isArray(report.foldInputs) || !report.foldInputs.length) return null;
    const effectiveTrials = Number.isFinite(trials) ? trials : (Number.isFinite(report.trials) ? report.trials : 1);
    const perFold = [];
    const positions = [];
    const pooled = [];
    const pooledGross = [];
    const streamReturns = [];
    const priceFoldLengths = [];
    let streamIndex = -1;
    let streamRemaining = 0;
    for (let fi = 0; fi < report.foldInputs.length; fi++) {
        const input = report.foldInputs[fi];
        // A fold with no journaled confidence (an older journal) falls back to the
        // scored positions — the restatement is then the identity for that fold.
        const sig = Array.isArray(input.confidence)
            ? positionSeriesFromConfidence(input.confidence, policy)
            : input.signals;
        const bt = strategyReturns({ returns: input.returns, signals: sig, costBps });
        const scored = report.folds && report.folds[fi] ? report.folds[fi] : {};
        perFold.push({
            testStart: scored.testStart,
            testEnd: scored.testEnd,
            metrics: backtestMetrics({ returns: input.returns, signals: sig, costBps, periodsPerYear, trials: effectiveTrials }),
        });
        positions.push(sig);
        for (const r of bt.returns) pooled.push(r);
        for (const r of bt.gross) pooledGross.push(r);
        if (streamRemaining <= 0) {
            streamReturns.push([]);
            priceFoldLengths.push([]);
            streamIndex++;
            const lens = report.streamFoldLengths && report.streamFoldLengths[streamIndex];
            streamRemaining = Array.isArray(lens) ? lens.length : 0;
        }
        streamReturns[streamIndex].push(...bt.returns);
        priceFoldLengths[streamIndex].push(bt.returns.length);
        streamRemaining--;
    }
    const rebuilt = withExtraPanelStreams(report, streamReturns, report.streamFoldLengths ? priceFoldLengths : null);
    const extras = Array.isArray(report.extraPanelStreams) ? report.extraPanelStreams : [];
    const dependence = dependenceSummary({ streamReturns: rebuilt.streamReturns, streamFoldLengths: rebuilt.streamFoldLengths, periodsPerYear });
    // The PRICE-ONLY dependence at this same policy/cost (see `restateReportAtCost`).
    const dependenceWithoutExtras = extras.length
        ? dependenceSummary({ streamReturns, streamFoldLengths: priceFoldLengths, periodsPerYear })
        : null;
    const effectiveBars = dependence && dependence.available ? dependence.effectiveBars : null;
    const { pooledMetrics } = poolFolds(perFold, pooled, pooledGross, { periodsPerYear, trials: effectiveTrials, effectiveBars });
    return {
        policy: {
            deadZone: Number.isFinite(policy.deadZone) ? policy.deadZone : 0,
            scale: Number.isFinite(policy.scale) ? policy.scale : 1,
            ...(Number.isFinite(policy.enter) ? { enter: policy.enter } : {}),
            ...(Number.isFinite(policy.exit) ? { exit: policy.exit } : {}),
            ...(Number.isFinite(policy.minHold) && policy.minHold > 0 ? { minHold: Math.floor(policy.minHold) } : {}),
        },
        costBps,
        trials: effectiveTrials,
        folds: perFold,
        positions,
        pooledMetrics,
        pooledBars: pooled.length,
        pooledReturns: pooled,
        pooledGross,
        streamReturns: rebuilt.streamReturns,
        streamFoldLengths: rebuilt.streamFoldLengths,
        // P2: carry the journal forward so a restated report can itself be restated
        // (chained cadence/policy/exposure sweeps) without re-reading the run.
        foldInputs: report.foldInputs,
        aggregate: aggregateFolds(perFold),
        dependence,
        extraPanelStreams: report.extraPanelStreams || null,
        panelStreams: extras.length,
        panelMismatch: report.panelMismatch === true,
        panelMismatchReason: report.panelMismatchReason || null,
        dependenceWithoutExtras,
        power: powerSummary(pooledMetrics.netSharpe, pooled.length, periodsPerYear, dependence),
    };
}

// The acceptance check for R26-3: the journaled confidence + the scored policy
// must reproduce the emitted positions exactly. Returns `{ ok, mismatch, folds }`.
export function verifyPolicyRoundTrip(report, policy = {}) {
    if (!report || !Array.isArray(report.foldInputs) || !report.foldInputs.length) {
        return { ok: false, mismatch: 0, folds: 0, reason: 'no foldInputs' };
    }
    let mismatch = 0;
    let checked = 0;
    for (const f of report.foldInputs) {
        if (!f || !Array.isArray(f.confidence) || !Array.isArray(f.signals) || f.confidence.length !== f.signals.length) {
            return { ok: false, mismatch, folds: checked, reason: 'a fold is missing confidence/signals (or they differ in length)' };
        }
        checked++;
        const restated = positionSeriesFromConfidence(f.confidence, policy);
        for (let i = 0; i < f.signals.length; i++) {
            if (restated[i] !== f.signals[i]) mismatch++;
        }
    }
    return { ok: mismatch === 0, mismatch, folds: checked };
}

// ---------------------------------------------------------------------------
// P2 (round 29 → 30): configuration-robust evaluation + exposure matching
// ---------------------------------------------------------------------------
// The A/B's LEVEL is a function of the retrain cadence (`RUN-ANALYSIS.md` §15.3):
// the same model, seed, data and CRN moved the baseline's pooled Sharpe by Δ1.01
// when `testSize` went 15 → 10, and the best candidate's paired Δ collapsed
// +0.2164 → +0.0289. So a single-cadence verdict is a verdict about the
// configuration as much as about the strategy. Two tools make that explicit:
//
//   1. `restateReportAtCadence` re-scores a journal on a DIFFERENT fold grid — the
//      fixed-position version of the cadence change (the "fixed position series
//      re-scored under a different fold grid" of §1.4, which moves Sharpe only
//      ~0.08-0.24). Pure post-processing (no model), used for the cadence-robustness
//      retrospective and as a cheap sensitivity check.
//   2. `exposureMatchedPair` quotes a cross-family comparison at MATCHED exposure:
//      the two families' confidences live on different scales (controller |conf| max
//      0.2555 vs signals saturating at 1.0 — `BUGS.md` #61), so an absolute dead
//      zone is a different filter for each. The dead zone is set per family from the
//      empirical quantile of |confidence| that matches a common in-market share.

// The dead zone that leaves ~`targetFraction` of bars in the market, from the
// empirical distribution of |confidence|. `confidenceToPosition` treats `|c| <= dz`
// as flat, so the in-market subset is `|c| > dz`; the threshold is placed just below
// the `m`-th largest |confidence| with `m = round(targetFraction * n)`.
export function exposureDeadZone(confidences, targetFraction) {
    const a = (Array.isArray(confidences) ? confidences : [])
        .map((c) => Math.abs(Number(c)))
        .filter((c) => Number.isFinite(c));
    const n = a.length;
    const target = Number.isFinite(targetFraction) ? Math.min(1, Math.max(0, targetFraction)) : 0;
    if (!n) return { deadZone: 0, achievedFraction: null, n: 0 };
    const s = a.slice().sort((x, y) => x - y);
    const m = Math.round(target * n);
    let dz;
    if (m <= 0) dz = 0.999;             // nothing in the market
    else if (m >= n) dz = 0;            // everything in the market
    else {
        // Place the threshold midway between the m-th and (m+1)-th largest |c| so
        // EXACTLY m values satisfy `|c| > dz` when the distribution is continuous,
        // and degrade gracefully to `s[n-m]` when those two are tied.
        const hi = s[n - m];
        const lo = s[n - m - 1];
        dz = lo === hi ? hi : (lo + hi) / 2;
        dz = Math.min(0.999, Math.max(0, dz));
    }
    // `achievedFraction` uses the exact rule `|c| > dz` (not `>=`), so a reader sees
    // how close the match really is when the |confidence| distribution has ties.
    let inMarket = 0;
    for (const c of a) if (c > dz) inMarket++;
    return { deadZone: dz, achievedFraction: inMarket / n, n };
}

// Re-score a journal on a different walk-forward cadence. The per-stream bar series
// (returns + raw confidence) are rebuilt from the report's `foldInputs` (placed at
// each fold's `testStart`), then re-partitioned with `walkForwardSplit({n, trainSize,
// testSize, step})` and re-scored through the same `restateReportAtPolicy` arithmetic.
// A fixed-position restatement: it holds the model's trajectory constant and varies
// only the grid, so it is a LOWER bound on the cadence sensitivity (the real swing is
// the model retraining more often — §1.4).
export function restateReportAtCadence(report, {
    testSize, trainSize = null, step = null, policy = {}, costBps = 0, periodsPerYear = 252, trials = null,
} = {}) {
    if (!report || !Array.isArray(report.foldInputs) || !report.foldInputs.length || !Number.isFinite(testSize) || testSize <= 0) return null;
    const keepPolicy = policy && Object.keys(policy).length ? policy : (report.policy || {});
    // P4: a report's panel may carry EXTRA streams (the funding/carry sleeve). Those
    // are not price streams: they have no `foldInputs` and must not be rebuilt from
    // the journal. Only the price streams participate in the fold rebuild; the sleeve
    // is re-projected onto the NEW grid separately (below), so a cadence restatement
    // keeps the same panel rather than silently dropping an independent stream (which
    // would make the design effect look better than it is).
    const extras = Array.isArray(report.extraPanelStreams) ? report.extraPanelStreams : [];
    const nStreams = Array.isArray(report.streamFoldLengths) && report.streamFoldLengths.length
        ? Math.max(1, report.streamFoldLengths.length - extras.length) : 1;
    const foldsPer = (s) => (Array.isArray(report.streamFoldLengths) && report.streamFoldLengths[s]
        ? report.streamFoldLengths[s].length : report.folds.length / nStreams);
    let N = 0;
    for (const f of report.folds) if (Number.isFinite(f.testEnd)) N = Math.max(N, f.testEnd + 1);
    if (!(N > 0)) return null;
    // Default the training length from the first fold's grid position. `walkForwardSplit`
    // builds non-expanding folds whose first training window is `[0, testStart)`, so
    // fold 0's `testStart` IS the training-window LENGTH (an expanding split's first
    // fold also starts at 0, so the same reading holds). The earlier
    // `testStart - foldLen` expression subtracted the test window and under-sized the
    // train set by one `testSize` whenever the caller omitted `trainSize`.
    const firstStart = report.folds[0] && Number.isFinite(report.folds[0].testStart) ? report.folds[0].testStart : NaN;
    const tr = trainSize == null ? (firstStart > 0 ? firstStart : testSize) : trainSize;
    const streams = [];
    let fi = 0;
    for (let s = 0; s < nStreams; s++) {
        const returns = new Array(N).fill(0);
        const confidence = new Array(N).fill(0);
        const count = foldsPer(s);
        for (let k = 0; k < count; k++, fi++) {
            const f = report.folds[fi];
            const input = report.foldInputs[fi];
            if (!f || !input) continue;
            const src = Array.isArray(input.returns) ? input.returns : [];
            const conf = Array.isArray(input.confidence) ? input.confidence : [];
            const len = Math.min(src.length, f.testEnd - f.testStart + 1);
            for (let i = 0; i < len; i++) {
                returns[f.testStart + i] = src[i];
                confidence[f.testStart + i] = conf[i];
            }
        }
        streams.push({ returns, confidence });
    }
    const newFoldInputs = [];
    const newFolds = [];
    const newStreamFoldLengths = [];
    const newGrid = walkForwardSplit({ n: N, trainSize: tr, testSize, step });
    for (let s = 0; s < nStreams; s++) {
        const lens = [];
        for (const fold of newGrid) {
            const ret = fold.test.map((t) => streams[s].returns[t]);
            const conf = fold.test.map((t) => streams[s].confidence[t]);
            newFoldInputs.push({ returns: ret, confidence: conf });
            newFolds.push({ testStart: fold.testStart, testEnd: fold.testEnd, test: fold.test.slice(), metrics: {} });
            lens.push(fold.test.length);
        }
        newStreamFoldLengths.push(lens);
    }
    // P4: re-project the extra (carry) streams onto the new grid. The sleeve is a flat
    // per-BAR return series over the original fold test bars, so — exactly like the
    // price streams — it is placed on the length-N bar axis at each original fold's
    // `testStart` and the new grid is read back off it.
    let extrasForGrid = null;
    if (extras.length) {
        const priceFolds = report.folds.slice(0, foldsPer(0));
        extrasForGrid = extras.map((sleeve) => {
            const placed = new Array(N).fill(0);
            let cursor = 0;
            for (const f of priceFolds) {
                const len = f.testEnd - f.testStart + 1;
                for (let i = 0; i < len && cursor + i < sleeve.length; i++) placed[f.testStart + i] = sleeve[cursor + i];
                cursor += len;
            }
            const out = [];
            for (const fold of newGrid) for (const t of fold.test) out.push(placed[t]);
            return out;
        });
    }
    const synthetic = {
        foldInputs: newFoldInputs,
        folds: newFolds,
        streamFoldLengths: newStreamFoldLengths,
        extraPanelStreams: extrasForGrid,
        trials: report.trials,
        policy: keepPolicy,
    };
    const out = restateReportAtPolicy(synthetic, keepPolicy, { costBps, periodsPerYear, trials });
    if (out) out.cadence = { testSize, trainSize: tr, step: step == null ? testSize : step, folds: newFolds.length, panelStreams: extrasForGrid ? extrasForGrid.length : 0 };
    return out;
}

// Quote a cross-family (or cross-configuration) comparison at MATCHED exposure. The
// common target is the LESS-invested family's `nonZeroFraction` by default, so
// neither arm wins by being invested more; the dead zone of each arm is set to the
// empirical quantile of its own |confidence| that achieves that share. Returns both
// restated reports, their dead zones and the full promotion decision — the honest
// replacement for the §15.5(c) promoting row that compared an ~80 %-invested book
// with one holding 16 of 4320 bars.
export function exposureMatchedPair({
    baseline, candidate, targetNonZeroFraction = null, policy = null,
    costBps = 0, periodsPerYear = 252, trials = null, decisionOptions = {},
    keepBandInMatch = false,
} = {}) {
    if (!baseline || !candidate || !Array.isArray(baseline.foldInputs) || !Array.isArray(candidate.foldInputs)) {
        return { available: false, reason: 'both reports must carry foldInputs (a journaled confidence) for exposure matching' };
    }
    // Resolve the policy we are matching AT: the caller may pass one, otherwise fall
    // back to whatever the baseline report was scored at. The raw in-market share is
    // measured by RESTATING both reports at that policy — never read off
    // `report.pooledMetrics`, because a report built from a journal (the retired-run
    // retrospective) does not carry it, which would silently yield a zero target and
    // a degenerate "match" where both arms sit flat.
    const basePolicy = policy && Object.keys(policy).length ? policy
        : (baseline.policy && Object.keys(baseline.policy).length ? baseline.policy : {});
    const flatConf = (r) => r.foldInputs.flatMap((f) => (Array.isArray(f.confidence) ? f.confidence : []));
    const bRaw = restateReportAtPolicy(baseline, basePolicy, { costBps, periodsPerYear, trials });
    const cRaw = restateReportAtPolicy(candidate, basePolicy, { costBps, periodsPerYear, trials });
    if (!bRaw || !cRaw) return { available: false, reason: 'a report could not be restated at the base policy (no foldInputs)' };
    const baseFrac = bRaw.pooledMetrics.nonZeroFraction;
    const candFrac = cRaw.pooledMetrics.nonZeroFraction;
    let target = targetNonZeroFraction;
    if (!Number.isFinite(target)) {
        const vals = [baseFrac, candFrac].filter((x) => Number.isFinite(x));
        target = vals.length ? Math.min(...vals) : 0;
    }
    const bDead = exposureDeadZone(flatConf(baseline), target);
    const cDead = exposureDeadZone(flatConf(candidate), target);
    // The matched row deliberately drops any HOLDING BAND and compares with a
    // pointwise dead zone. Two reasons. (1) The band's `enter`/`exit` are a second
    // absolute threshold in confidence space, so it suffers the same scale
    // mismatch as the dead zone (§15.5(c): `enter 0.2` is ~80 %-invested for a
    // saturated signal but ~flat for a controller whose |confidence| maxes at
    // 0.2555). (2) A band's hysteresis cannot even be pushed to an arbitrarily
    // small exposure — with `exit = enter/4` the position dwells until |c| decays,
    // which floors the in-market share — so a "matching" that keeps the band often
    // cannot reach the target at all. Equalising exposure exactly therefore needs a
    // scale-free rule: both families trade the top-X % of bars by |confidence|.
    // The banded comparison stays available as the RAW row.
    const matchedPolicyFor = (quantileDead) => {
        const p = { ...basePolicy, deadZone: quantileDead };
        if (keepBandInMatch !== true) { delete p.enter; delete p.exit; }
        return p;
    };
    const bPolicy = matchedPolicyFor(bDead.deadZone);
    const cPolicy = matchedPolicyFor(cDead.deadZone);
    const b = restateReportAtPolicy(baseline, bPolicy, { costBps, periodsPerYear, trials });
    const c = restateReportAtPolicy(candidate, cPolicy, { costBps, periodsPerYear, trials });
    if (!b || !c) return { available: false, reason: 'a report could not be restated at the matched policy (no foldInputs)' };
    const decision = promoteDecision(b, c, decisionOptions);
    // A dead zone can only select bars by a |confidence| threshold, so when a
    // family's confidence is discrete (saturated ±integer signal scores) the
    // achieved share can overshoot the target — the candidate may simply be unable
    // to trade as FEW bars as the baseline. Flag it rather than hiding it.
    const totalBars = b.foldInputs.reduce((s, f) => s + (Array.isArray(f.confidence) ? f.confidence.length : 0), 0) || 1;
    const tolerance = Math.max(0.02, 2 / totalBars);
    const matchedWithinTolerance = Math.abs(b.pooledMetrics.nonZeroFraction - target) <= tolerance
        && Math.abs(c.pooledMetrics.nonZeroFraction - target) <= tolerance;
    return {
        available: true,
        targetNonZeroFraction: target,
        matchedWithinTolerance,
        tolerance,
        policy: basePolicy,
        matchedPolicy: { baseline: bPolicy, candidate: cPolicy },
        baseline: {
            deadZone: bPolicy.deadZone, enter: Number.isFinite(bPolicy.enter) ? bPolicy.enter : null,
            achievedFraction: b.pooledMetrics.nonZeroFraction,
            nonZeroFraction: b.pooledMetrics.nonZeroFraction,
            netSharpe: b.pooledMetrics.netSharpe, dsrAdjusted: b.pooledMetrics.dsrAdjusted,
        },
        candidate: {
            deadZone: cPolicy.deadZone, enter: Number.isFinite(cPolicy.enter) ? cPolicy.enter : null,
            achievedFraction: c.pooledMetrics.nonZeroFraction,
            nonZeroFraction: c.pooledMetrics.nonZeroFraction,
            netSharpe: c.pooledMetrics.netSharpe, dsrAdjusted: c.pooledMetrics.dsrAdjusted,
        },
        raw: {
            baselineNonZeroFraction: baseFrac, candidateNonZeroFraction: candFrac,
            baselineNetSharpe: bRaw.pooledMetrics.netSharpe,
            candidateNetSharpe: cRaw.pooledMetrics.netSharpe,
            baselineDsrAdjusted: bRaw.pooledMetrics.dsrAdjusted,
            candidateDsrAdjusted: cRaw.pooledMetrics.dsrAdjusted,
        },
        decision,
        reader: 'matched exposure: both families trade the top-X % of bars by |confidence| (the minimum of the two families\' scored in-market shares, by default), so the exposure confound is removed. The matched row uses a pointwise dead zone only — a holding band\'s `enter`/`exit` are another absolute confidence-space threshold, so a banded "match" is neither scale-free nor always reachable. A promotion at UNMATCHED exposure can be an artefact of one arm abstaining (BUGS.md #61); the matched row tests the same claim at equal exposure.',
    };
}

// The cost ladder: the whole decision recomputed at a handful of cost levels.
//
// `levels` are in basis points of turnover (the unit `--cost-bps` uses). Level 0
// is the gross comparison the scientific verdict is usually read at; 5-10 bps is
// a realistic crypto taker fee (Binance spot taker 10 bps, USDⓈ-M futures taker
// 5 bps — `binancefees`; `frazzini2018costs` for the general cost scale). The
// ladder is cheap (O(bars) per level) because it re-scores retained fold inputs
// rather than re-running a model, so a verdict can always carry its sensitivity
// instead of being an artefact of one unstated cost assumption.
export function costLadder({
    baseline, candidates, levels = [0, 2, 5, 10], periodsPerYear = 252, trials = null,
    decisionOptions = {},
}) {
    // Default the trial count to what the reports were actually deflated by, so a
    // caller that passes nothing cannot silently change every restated DSR.
    const effectiveTrials = Number.isFinite(trials) ? trials
        : (baseline && Number.isFinite(baseline.trials) ? baseline.trials : 1);
    const rows = [];
    for (const costBps of levels) {
        const base = restateReportAtCost(baseline, costBps, { periodsPerYear, trials: effectiveTrials });
        if (!base) return { available: false, reason: 'reports do not carry fold inputs (restate unavailable)' };
        const row = {
            costBps,
            baseline: {
                netSharpe: base.pooledMetrics.netSharpe,
                dsr: base.pooledMetrics.dsr,
                dsrAdjusted: base.pooledMetrics.dsrAdjusted,
                breakEvenCostBps: base.pooledMetrics.breakEvenCostBps,
                grossPnl: base.pooledMetrics.grossPnl,
                turnover: base.pooledMetrics.turnover,
                maxDrawdown: base.pooledMetrics.maxDrawdown,
                nonZeroFraction: base.pooledMetrics.nonZeroFraction,
            },
            candidates: [],
        };
        for (const candidate of candidates) {
            const c = restateReportAtCost(candidate, costBps, { periodsPerYear, trials: effectiveTrials });
            if (!c) return { available: false, reason: 'reports do not carry fold inputs (restate unavailable)' };
            const decision = promoteDecision(base, c, decisionOptions);
            row.candidates.push({
                id: candidate.id,
                netSharpe: c.pooledMetrics.netSharpe,
                dsr: c.pooledMetrics.dsr,
                dsrAdjusted: c.pooledMetrics.dsrAdjusted,
                breakEvenCostBps: c.pooledMetrics.breakEvenCostBps,
                grossPnl: c.pooledMetrics.grossPnl,
                turnover: c.pooledMetrics.turnover,
                maxDrawdown: c.pooledMetrics.maxDrawdown,
                nonZeroFraction: c.pooledMetrics.nonZeroFraction,
                foldWinFraction: decision.foldWinFraction,
                promote: decision.promote,
                reasons: decision.reasons,
                breadth: decision.promotionTest && decision.promotionTest.available ? decision.promotionTest.breadth : null,
            });
        }
        rows.push(row);
    }
    return {
        available: true,
        levels: levels.slice(),
        periodsPerYear,
        trials: effectiveTrials,
        rows,
        reader: 'for each cost level (bps of turnover): the restated pooled metrics and the full promotion decision. A verdict that changes across the ladder is a verdict about the cost assumption, not about the strategy.',
    };
}

export const DEPENDENCE_GATE_READER = 'Round-26 gate: the candidate must (a) beat the baseline on the paired cluster Sharpe difference at alpha (the magnitude floor) and (b) be STABLE — the paired Sharpe difference must stay positive when ANY single fold-window cluster is deleted (the edge must not be carried by a handful of folds), and (c) clear the DSR floor on the design-effect-adjusted sample size (dsrAdjusted). The exact sign test over fold windows is still computed and reported (`promotionTest.breadth`) but is no longer a gate: it passed every candidate and its 2^-n floor made it uninformative about magnitude. (a) and (b) are estimated from fold-window clusters, the unit the walk-forward repeats; (c) uses n/designEffect because the pooled bars are correlated across streams. The returned `gate` records, per hurdle, whether it was applied | skipped-no-panel (a single stream has no panel to estimate from) | not-needed (a panel exists but the design effect is <= 1, so nothing was over-confident to deflate) | off — a report can never claim a hurdle it did not evaluate.';

// ---------------------------------------------------------------------------
// Family correlation: how many independent bets did the search really make?
// ---------------------------------------------------------------------------
// The deflated Sharpe and the family-wise search both correct for the number of
// configurations that were *searched* (K). When several candidates are near-copies
// of one another the effective number of independent trials is smaller than K —
// on the attempt-3 power run the per-fold Sharpe of the momentum and acceleration
// candidates correlates 0.863, so those two are close to one bet — and a reader
// deserves to know how concentrated the search was.
//
// This measures it from the panel itself. Each candidate's per-fold EXCESS return
// over the baseline (its own contribution, net of the market and fold effects that
// the baseline already carries) is one series; the average pairwise correlation
// between those series gives the Kish (1965) design effect and an effective trial
// count `K/(1+(K-1)*rbar)`.
//
// It is reported as a DIAGNOSTIC ONLY, and the deflated Sharpe keeps `trials = K`
// on purpose: methods that substitute an effective number of independent tests for
// the number of tests actually run do NOT control the family-wise error rate
// (arXiv 1612.04535, which tests exactly the genomics methods that grew out of
// Cheverud/Nyholt), and correlated tests are still tests that were run (Harvey,
// Liu & Zhu 2016). A small effective-trial reading is therefore evidence about the
// shape of the search, never a licence to relax a correction.
export function familyCorrelation({ baseline, candidates, periodsPerYear = 252, labels = null } = {}) {
    if (!baseline || !Array.isArray(baseline.pooledReturns) || !baseline.pooledReturns.length) {
        return { available: false, reason: 'baseline report does not expose pooledReturns' };
    }
    if (!Array.isArray(candidates) || candidates.length < 2) {
        return { available: false, reason: 'fewer than two candidates — there is no family to correlate' };
    }
    const lengths = Array.isArray(baseline.foldLengths) ? baseline.foldLengths : null;
    if (!lengths || !lengths.length) {
        return { available: false, reason: 'baseline report does not expose foldLengths (no fold grid to segment)' };
    }
    const T = baseline.pooledReturns.length;
    if (!candidates.every((c) => c && Array.isArray(c.pooledReturns) && c.pooledReturns.length === T)) {
        return { available: false, reason: 'candidate return series do not share the baseline fold grid' };
    }
    // One per-fold Sharpe series per candidate, of the candidate's EXCESS return
    // over the baseline. Sharpe (not the raw fold mean) so a high-volatility
    // candidate is not automatically "different" from a quiet one.
    const segment = (series) => {
        const out = [];
        let from = 0;
        for (const len of lengths) {
            const ex = new Array(len);
            for (let t = 0; t < len; t++) ex[t] = series[from + t] - baseline.pooledReturns[from + t];
            out.push(sharpeRatio(ex, { periodsPerYear }));
            from += len;
        }
        return out;
    };
    const perCandidate = candidates.map((c) => segment(c.pooledReturns));
    const rbar = meanPairwiseCorrelation(perCandidate);
    const K = candidates.length;
    // The full pairwise matrix (and the strongest pair) so the report can name
    // what the search duplicated, not just how much.
    const matrix = perCandidate.map((a, i) => perCandidate.map((b, j) => (i === j ? 1 : pearsonCorrelation(a, b))));
    let maxPair = null;
    for (let i = 0; i < K; i++) {
        for (let j = i + 1; j < K; j++) {
            const r = matrix[i][j];
            if (Number.isFinite(r) && (!maxPair || r > maxPair.rho)) maxPair = { a: i, b: j, rho: r };
        }
    }
    return {
        available: true,
        K,
        // R28 (BUGS.md #55): the candidate LABELS `maxPair`'s indices refer to, so a
        // reader resolves them against the same list the matrix was built from.
        labels: Array.isArray(labels) ? labels.slice(0, K) : null,
        folds: lengths.length,
        foldLengths: lengths.slice(),
        periodsPerYear,
        meanPairwiseExcessCorr: rbar,
        maxPair,
        designEffect: equicorrelationDesignEffect(K, rbar),
        effectiveTrials: equicorrelationEffectiveSize(K, rbar),
        excessCorrelations: matrix,
        reader: 'per-candidate per-fold Sharpe of the candidate\'s EXCESS return over the baseline; meanPairwiseExcessCorr = average pairwise Pearson r; effectiveTrials = K/(1+(K-1)*rbar) (Kish 1965). DIAGNOSTIC ONLY — the deflated Sharpe keeps trials=K, because an effective number of independent tests does not control the family-wise error rate (arXiv 1612.04535) and correlated tests are still tests that were run (Harvey, Liu & Zhu 2016).',
    };
}

// ---------------------------------------------------------------------------
// Family-wise search correction on the honest-evaluation path
// ---------------------------------------------------------------------------
//
// DSR answers "is this statistic surprising given I ran `trials` of them?"
// (parametric, single-statistic). The subsampling SPA / Romano-Wolf step-down
// answers the complementary, non-parametric question "given the K strategies I
// actually searched over, WHICH of them beat the benchmark?" (Politis & Romano
// 1994; Romano & Wolf 2005). `familywiseSearch` makes that decision a first-class
// object; `walkForwardSearch` wires a walk-forward report set into it; and
// `promoteDecision` can optionally require it as an extra hurdle.
//
// `groups` here are the fold LENGTHS of the pooled OOS series: a walk-forward OOS
// return stream is a concatenation of fold test windows whose first bar carries
// no exposure (a deterministic zero) and, more importantly, whose bars came from
// different refit models. Every resampling window and the long-run variance are
// therefore computed WITHIN one fold (see reality_check#resolveGroups and the
// mean-shift LRV result, arXiv 2603.17226).
//
// Two opt-in generalisations of the family-wise guarantee (both default-off, so
// the default object below is byte-identical to Round 8):
//   - `kfwer: k` attaches `subsamplingKfwer` — the SINGLE-STEP k-FWER, which
//     controls P(k or more false rejections) <= alpha (Romano & Wolf 2007,
//     arXiv 0710.2258). Unlike the step-down it has a finite-sample bound from
//     the empirical window law, so it is the procedure to prefer when a handful
//     of false names is tolerable but a flood is not.
//   - `fdpTarget: f` attaches `subsamplingFdp` — the Romano-Wolf FDP step-down
//     heuristic, which bounds the false discovery PROPORTION at (k_l-1)/R with
//     probability 1-alpha for a small target f (Delattre & Roquain 2014,
//     arXiv 1311.4030). EXPERIMENTAL: the heuristic is not rigorously
//     FDP-controlling in finite samples, so treat the attached bound as a
//     diagnostic and gate on it explicitly via `promoteDecision({maxFdp})`.
export function familywiseSearch({
    strategies, groups = null, benchmark = 0, windowLength = null, bandwidth = null,
    alpha = 0.05, labels = null, fdpTarget = null, kfwer = null,
} = {}) {
    if (!Array.isArray(strategies) || strategies.length < 1) {
        throw new Error('familywiseSearch: strategies must be a non-empty array of return series');
    }
    const K = strategies.length;
    const spa = subsamplingSpa({ returnsMatrix: strategies, benchmark, windowLength, bandwidth, groups });
    const stepM = subsamplingStepM({ returnsMatrix: strategies, benchmark, windowLength, bandwidth, groups, alpha });
    const fdp = fdpTarget == null ? null : subsamplingFdp({ returnsMatrix: strategies, benchmark, windowLength, bandwidth, groups, alpha, fdpTarget });
    const kf = kfwer == null ? null : subsamplingKfwer({ returnsMatrix: strategies, benchmark, windowLength, bandwidth, groups, alpha, k: kfwer });
    const labelOf = (k2) => (labels && labels[k2] != null ? String(labels[k2]) : `#${k2}`);
    const candidates = [];
    for (let k2 = 0; k2 < K; k2++) {
        candidates.push({
            index: k2,
            label: labelOf(k2),
            mean: spa.means[k2],
            standardError: spa.standardErrors[k2],
            statistic: stepM.tStats[k2],
            pValue: stepM.stepPValues[k2],
            rejected: stepM.rejected[k2],
            kfwerPValue: kf ? kf.pValues[k2] : null,
            kfwerRejected: kf ? kf.rejected[k2] : false,
            isBest: k2 === spa.bestIndex,
            spaPValue: k2 === spa.bestIndex ? spa.pValue : null,
        });
    }
    const rejectedIndices = candidates.filter((c) => c.rejected).map((c) => c.index);
    return {
        alpha,
        K,
        T: spa.T,
        windowLength: spa.windowLength,
        bandwidth: spa.bandwidth,
        nWindows: spa.nWindows,
        groups: spa.groups,
        spaPValue: spa.pValue,
        bestIndex: spa.bestIndex,
        bestLabel: labelOf(spa.bestIndex),
        rejectedIndices,
        rejectedLabels: rejectedIndices.map(labelOf),
        fdp: fdp ? { ...fdp, rejectedLabels: fdp.rejectedIndices.map(labelOf) } : null,
        kfwer: kf ? { ...kf, rejectedLabels: kf.rejectedIndices.map(labelOf) } : null,
        candidates,
        spa,
        stepM,
    };
}

// Map a walk-forward report set onto the family-wise test. The family is
// [baseline, ...candidates], so index 0 is the benchmark strategy, and it is
// scored on the pooled OOS return streams `walkForwardEvaluate` exposes.
// `trimFoldStarts` (default true) drops each fold's first test bar: the lagged
// position makes it an exact zero, so it carries no return information and only
// dilutes the variance. If that leaves too few bars to subsample, the untrimmed
// series is used instead.
export function walkForwardSearch({
    baseline, candidates, labels = null, benchmark = 0, alpha = 0.05,
    windowLength = null, bandwidth = null, groups = null, trimFoldStarts = true,
    fdpTarget = null, kfwer = null,
} = {}) {
    if (!baseline || !Array.isArray(baseline.pooledReturns) && !ArrayBuffer.isView(baseline.pooledReturns)) {
        throw new Error('walkForwardSearch: baseline report must expose pooledReturns');
    }
    if (!Array.isArray(candidates) || !candidates.length) {
        throw new Error('walkForwardSearch: candidates must be a non-empty array of reports');
    }
    const reports = [baseline, ...candidates];
    for (const r of reports) {
        if (!r || !(Array.isArray(r.pooledReturns) || ArrayBuffer.isView(r.pooledReturns))) {
            throw new Error('walkForwardSearch: every report must expose pooledReturns');
        }
    }
    let strategies = reports.map((r) => r.pooledReturns);
    const T = strategies[0].length;
    if (!strategies.every((s) => s.length === T)) {
        throw new Error('walkForwardSearch: pooled return series must be equal length (same folds)');
    }
    const foldLengths = groups || baseline.foldLengths || null;
    let allLabels = ['baseline', ...(labels || candidates.map((r, i) => `candidate-${i + 1}`))];
    let groupLengths = Array.isArray(foldLengths) ? foldLengths.slice() : null;
    let trimmed = false;
    if (trimFoldStarts && Array.isArray(foldLengths)) {
        const keep = [];
        const newGroups = [];
        let cursor = 0;
        for (const len of foldLengths) {
            for (let i = 1; i < len; i++) keep.push(cursor + i);
            if (len - 1 >= 2) newGroups.push(len - 1);
            cursor += len;
        }
        if (keep.length >= 6 && newGroups.length) {
            strategies = strategies.map((s) => keep.map((i) => s[i]));
            groupLengths = newGroups;
            trimmed = true;
        }
    }
    const search = familywiseSearch({ strategies, groups: groupLengths, benchmark, windowLength, bandwidth, alpha, labels: allLabels, fdpTarget, kfwer });
    return { ...search, baselineIndex: 0, candidateIndices: candidates.map((_, i) => i + 1), trimmedFoldStarts: trimmed };
}

const fmtFixed4 = (x) => (Number.isFinite(x) ? x.toFixed(4) : String(x));

// One line summarising a `familywiseSearch` result (whole family) or a single
// candidate's `search` attachment.
function formatSearchLine(s) {
    if (!s) return '';
    if (Array.isArray(s.candidates)) {
        const rej = s.rejectedLabels && s.rejectedLabels.length ? s.rejectedLabels.join(',') : 'none';
        const g = s.groups ? s.groups.join('x') : '1';
        let line = `  search: SPA p=${fmtFixed4(s.spaPValue)} best=${s.bestLabel} StepM rejects=[${rej}] @${s.alpha}`
            + ` (sub b=${s.windowLength} m=${s.bandwidth} wins=${s.nWindows} K=${s.K} T=${s.T} groups=${g})`;
        if (s.kfwer) {
            const krej = s.kfwer.rejectedLabels && s.kfwer.rejectedLabels.length ? s.kfwer.rejectedLabels.join(',') : 'none';
            line += `\n  kfwer: k=${s.kfwer.k} rejects=[${krej}] @${s.alpha}`;
        }
        if (s.fdp) {
            const frej = s.fdp.rejectedLabels && s.fdp.rejectedLabels.length ? s.fdp.rejectedLabels.join(',') : 'none';
            const ef = s.fdp.estimatedFdp == null ? 'n/a' : fmtFixed4(s.fdp.estimatedFdp);
            line += `\n  fdp:   target=${s.fdp.fdpTarget} k=${s.fdp.kHat} R=${s.fdp.nRejected} estFDP=${ef} rejects=[${frej}]`;
        }
        return line;
    }
    return `  search: StepM p=${fmtFixed4(s.pValue)} rejected=${!!s.rejected}${s.alpha != null ? ` @${s.alpha}` : ''}`;
}

// Human-readable one-block summary (used by the real-candle runner). The optional
// `search` (or `report.search`) appends the family-wise search-corrected line.
// `promotionTest` is the paired cluster test produced by `promoteDecision` when
// this report was judged against a baseline. It is NOT a property of the report
// itself (a report does not know its baseline), so it is passed in explicitly —
// defaulting to a `promotionTest` field if a caller stored one on the report.
export function formatReport(report, { label = 'candidate', search = null, promotionTest = report.promotionTest } = {}) {
    const m = report.pooledMetrics || {};
    const a = report.aggregate || {};
    const audit = report.audit
        ? (report.audit.vacuous ? 'VACUOUS' : (report.audit.clean ? 'clean' : `LEAK (${report.audit.violations.length})`)) +
          // Round 24b: name the audit's behavioural half inline, so a long
          // multi-candidate report shows at a glance which candidates the shock
          // actually reached (a volume-blind audit used to hide here).
          (report.audit.reachableFolds == null
              ? ''
              : ` reachable=${report.audit.reachableFolds}/${report.folds ? report.folds.length : 0} probes=${report.audit.probes || 0}`)
        : 'skipped';
    const f = (x) => (Number.isFinite(x) ? x.toFixed(4) : String(x));
    // Undefined metrics (e.g. hit rate on a flat/abstaining baseline) read as
    // `n/a`, never `NaN` — `NaN` in a headline report is noise, not information.
    const fm = (x) => (Number.isFinite(x) ? x.toFixed(4) : 'n/a');
    const lines = [
        `[${label}] folds=${report.folds ? report.folds.length : 0} bars=${report.pooledBars}`,
        `  pooled: Sharpe=${fm(m.netSharpe)} PSR=${fm(m.psr)} DSR=${fm(m.dsr)} MDD=${fm(m.maxDrawdown)} hit=${fm(m.hitRate)}`,
        // Turnover and the assumption-free break-even cost make a high-turnover
        // signal comparable to a low-turnover mechanism (a zero-cost comparison
        // flatters the signal). `breakEven` is the per-unit-turnover cost in bps at
        // which the gross P&L is exactly consumed (`n/a` if the strategy never trades).
        `  cost:   turnover=${fm(m.turnover)} grossPnl=${fm(m.grossPnl)} breakEven=${m.breakEvenCostBps == null ? 'n/a' : `${fm(m.breakEvenCostBps)}bps`}`,
        // Round 25: participation. A strategy that abstains on most bars has the
        // same turnover as one that trades small all the time, but a very
        // different risk profile — `nonZero` makes that visible.
        `  part:   nonZero=${fm(m.nonZeroFraction)} meanAbsPos=${fm(m.meanAbsPosition)} trades=${m.tradeCount == null ? 'n/a' : m.tradeCount}`,
        `  folds:  mean=${fm(a.mean)} median=${fm(a.median)} std=${fm(a.std)} positive=${fm(a.positiveFraction)}`,
        `  audit:  ${audit}`,
    ];
    // Round 25: the design-effect-adjusted PSR/DSR (only present on a pooled
    // multi-stream report, where the design effect can be estimated).
    if (Number.isFinite(m.dsrAdjusted)) {
        lines.push(`  adjusted: DSR=${fm(m.dsrAdjusted)} PSR=${fm(m.psrAdjusted)} @ ${m.effectiveBars} effective bars (of ${m.bars})`);
    }
    if (report.power && Number.isFinite(report.power.se) && report.power.bars > 0) {
        lines.push(`  power:  SE=${f(report.power.se)} MDE95 Sharpe=±${f(report.power.mdeSharpe)} (bars=${report.power.bars})${report.power.underpowered ? ' | UNDERPOWERED' : ''}`);
    }
    // Round 25: the honest power line, when a cluster view exists. `iid` is what
    // the line above assumed; `dependent` is the delete-one-cluster jackknife.
    if (report.power && Number.isFinite(report.power.seDependent)) {
        lines.push(`  power*: SE=${f(report.power.seDependent)} MDE95 Sharpe=±${f(report.power.mdeSharpeDependent)}` +
            ` (inflation=${f(report.power.varianceInflation)}x, effective bars=${f(report.power.effectiveBars)})` +
            `${report.power.underpoweredDependent ? ' | UNDERPOWERED' : ''}`);
    }
    if (report.dependence && report.dependence.available) {
        lines.push(`  depend: streamCorr=${f(report.dependence.meanPairwiseStreamCorr)} effectiveStreams=${f(report.dependence.effectiveStreams)}` +
            ` foldClusters=${report.dependence.nClusters} seIid=${f(report.dependence.seIid)} seCluster=${f(report.dependence.seCluster)}`);
    }
    if (promotionTest) {
        const pt = promotionTest;
        if (pt.available) {
            const d = pt.sharpeDifference;
            const b = pt.breadth;
            lines.push(`  paired: dSharpe=${f(d.value)} se=${f(d.se)} t=${f(d.t)} p=${f(d.pOneSided)} (alpha=${pt.alpha})` +
                ` | breadth ${b.available ? `${b.wins}/${b.n} windows p=${f(b.pValue)}` : 'n/a'}`);
        } else {
            lines.push(`  paired: n/a (${pt.reason})`);
        }
    }
    const s = search || report.search;
    if (s) lines.push(formatSearchLine(s));
    return lines.join('\n');
}
