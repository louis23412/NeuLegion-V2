// Walk-forward power/sizing/dependence readers — split from
// `analysis/walkforward.js` in round 74 (byte-exact move). `powerSummary` is
// exported for the evaluation/report/restatement parts; the `walkforward.js`
// shim does not re-export it (same convention as round 71's `w4cSolveNormal`).

import { backtestMetrics, poolFolds } from '../backtest.js';
import { sharpeRatio } from '../performance.js';
import {
    meanPairwiseCorrelation, equicorrelationDesignEffect, equicorrelationEffectiveSize,
    foldWindowClusters, clusterJackknife,
} from '../dependence.js';


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

export function powerSummary(sharpe, bars, periodsPerYear, dependence = null) {
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
    const panel = report && Array.isArray(report.priceStreamReturns) && report.priceStreamReturns.length >= 2
        ? report.priceStreamReturns
        : (report ? report.streamReturns : null);
    if (!report || !Array.isArray(panel) || panel.length < 2) return null;
    const q = report.dependence && report.dependence.available ? report.dependence.foldLength : null;
    if (!Number.isInteger(q) || q < 1) return null;
    try {
        return foldWindowClusters(panel, q);
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