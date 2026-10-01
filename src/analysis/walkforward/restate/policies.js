// src/analysis/walkforward/restate/policies.js (round-105 split of src/analysis/walkforward/restate.js).
// Policy restatement + round-trip verification, without the model.
import { strategyReturns, backtestMetrics, poolFolds } from '../../backtest.js';
import { positionSeriesFromConfidence } from '../returns.js';
import { aggregateFolds } from '../folds.js';
import { dependenceSummary, powerSummary } from '../power.js';
import { withExtraPanelStreams } from './costs.js';
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
    const restatedFoldInputs = [];
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
        restatedFoldInputs.push({ ...input, signals: sig });
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
        priceStreamReturns: report.streamFoldLengths ? streamReturns : (report.priceStreamReturns || null),
        priceStreamFoldLengths: report.streamFoldLengths ? priceFoldLengths : (report.priceStreamFoldLengths || null),
        // P2: carry the journal forward so a restated report can itself be restated
        // (chained cadence/policy/exposure sweeps) without re-reading the run.
        // L10-cn: the carried inputs carry the RESTATED signals, so a
        // policy-restated report handed to foldConcentration mixes no bases.
        foldInputs: restatedFoldInputs,
        aggregate: aggregateFolds(perFold),
        dependence,
        extraPanelStreams: report.extraPanelStreams || null,
        panelStreams: extras.length,
        panelMismatch: report.panelMismatch === true,
        panelMismatchReason: report.panelMismatchReason || null,
        dependenceWithoutExtras,
        power: powerSummary(pooledMetrics.netSharpe, pooled.length, periodsPerYear, dependence),
        audit: report.audit || null,
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

