// src/analysis/walkforward/report/gate.js (round-106 split of src/analysis/walkforward/report.js).
// The promotion gate: paired cluster tests plus the hurdle decision.
import { sharpeRatio } from '../../performance.js';
import {
    pairedClusterTest, pairedClusterSignTest, clusterStability, signTestFloor,
    studentTCritical,
} from '../../dependence.js';
import { foldWinFraction } from '../folds.js';
import { clustersOf } from '../power.js';
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
    // Round 32 (lab R2): the window-robustness hurdle — the candidate's edge
    // must be positive in at least this fraction of the trailing windows.
    // Default-off (`null`), so every default verdict is byte-identical to
    // round 31; set it (e.g. 5/6) to make J1-window luck fail the gate.
    minBlockPositiveFraction = null,
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
    const gate = { minDsrAdjusted: 'off', requireSharpeDiff: 'off', requireBreadth: 'off', requireClusterStability: 'off', blockStability: 'off' };
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
    // Round 32 (lab R2): window robustness — the edge must be positive in at
    // least `minBlockPositiveFraction` of the trailing windows. Unlike the
    // cluster hurdles this needs no cross-stream panel (a single stream is
    // scored over its own windows), so the only skip is a report that predates
    // the statistic. Default-off: `minBlockPositiveFraction == null` leaves
    // every default verdict byte-identical.
    if (minBlockPositiveFraction != null) {
        const bs = candidate.blockStability;
        if (bs && Number.isFinite(bs.positiveFraction)) {
            gate.blockStability = 'applied';
            if (!(bs.positiveFraction >= minBlockPositiveFraction)) {
                fail('blockStability', bs.positiveFraction, minBlockPositiveFraction, 'positiveFraction >= minBlockPositiveFraction',
                    `block stability ${bs.positiveFraction} < ${minBlockPositiveFraction} (edge positive in too few of ${bs.blocks} trailing windows)`);
            } else pass('blockStability', bs.positiveFraction, minBlockPositiveFraction, 'positiveFraction >= minBlockPositiveFraction');
        } else {
            gate.blockStability = 'skipped-no-panel';
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
