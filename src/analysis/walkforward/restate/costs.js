// src/analysis/walkforward/restate/costs.js (round-105 split of src/analysis/walkforward/restate.js).
// Cost restatement of a finished report without the model.
import { strategyReturns, backtestMetrics, poolFolds } from '../../backtest.js';
import { aggregateFolds } from '../folds.js';
import { dependenceSummary, powerSummary } from '../power.js';
export const withExtraPanelStreams = (report, priceStreamReturns, priceStreamFoldLengths) => {
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
        priceStreamReturns: hasPanel ? streamReturns : (report.priceStreamReturns || null),
        priceStreamFoldLengths: hasPanel ? priceFoldLengths : (report.priceStreamFoldLengths || null),
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

