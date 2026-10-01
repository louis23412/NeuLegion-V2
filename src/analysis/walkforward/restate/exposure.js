// src/analysis/walkforward/restate/exposure.js (round-105 split of src/analysis/walkforward/restate.js).
// Exposure/cadence restatements, the matched-pair comparison, and the cost ladder.
import { walkForwardSplit } from '../../splits.js';
import { promoteDecision } from '../report.js';
import { restateReportAtCost } from './costs.js';
import { restateReportAtPolicy } from './policies.js';
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
