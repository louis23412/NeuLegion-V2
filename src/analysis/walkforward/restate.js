// Walk-forward restatements — split from `analysis/walkforward.js` in round 74
// (byte-exact move): cost/policy/cadence/exposure re-scoring of a finished
// report without the model.

import { strategyReturns, backtestMetrics, poolFolds } from '../backtest.js';
import { walkForwardSplit } from '../splits.js';
import { confidenceToPosition, positionSeriesFromConfidence } from './returns.js';
import { aggregateFolds } from './folds.js';
import { dependenceSummary, powerSummary } from './power.js';
import { poolReports, promoteDecision } from './report.js';


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