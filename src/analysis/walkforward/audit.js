// Walk-forward evaluation + the no-lookahead audit — split from
// `analysis/walkforward.js` in round 74 (byte-exact move).

import { purgedCVBacktest, purgedCVBacktestAsync } from '../backtest.js';
import { normaliseConcurrency } from '../parallel.js';
import { walkForwardSplit } from '../splits.js';
import { isCausalFold } from './returns.js';
import { aggregateFolds, blockStability } from './folds.js';
import { powerSummary } from './power.js';


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
    // Round 32 (lab R2): how many trailing windows the window-robustness
    // statistic splits the scored series into. Reporting only.
    blockWindows = 6,
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
        // Round 32 (lab R2): the window-robustness readout over this stream's
        // own scored bars. A single stream has no cross-stream panel, but its
        // edge can still be one window's luck — so the statistic is computed
        // here too, over the one series.
        blockStability: blockStability([cv.pooledReturns], blockWindows, { periodsPerYear }),
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
    // Round 32 (lab R2): trailing-window count for the window-robustness readout.
    blockWindows = 6,
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
        // Round 32 (lab R2): the window-robustness readout over this run's own
        // scored bars (the async twin scores the identical arithmetic).
        blockStability: blockStability([cv.pooledReturns], blockWindows, { periodsPerYear }),
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