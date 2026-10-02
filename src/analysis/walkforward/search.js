// Walk-forward family-wise search + the report renderer — split from
// `analysis/walkforward.js` in round 74 (byte-exact move).

import { subsamplingSpa, subsamplingStepM, subsamplingFdp, subsamplingKfwer } from '../reality_check.js';
import { sharpeRatio } from '../performance.js';
import {
    pearsonCorrelation, meanPairwiseCorrelation, equicorrelationDesignEffect,
    equicorrelationEffectiveSize,
} from '../dependence.js';
import { blockStability } from './folds.js';


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
    // Round 32 (lab R2): the window-robustness readout — per-window Sharpes
    // over the trailing blocks, so a one-window edge is visible at a glance.
    // Absent only on reports built before the statistic existed.
    if (report.blockStability && Number.isInteger(report.blockStability.blocks)) {
        const bs = report.blockStability;
        lines.push(`  blocks: k=${bs.blocks} positive=${fm(bs.positiveFraction)} min=${fm(bs.min)} max=${fm(bs.max)}` +
            ` [${(bs.blockSharpes || []).map((v) => fm(v)).join(',')}]`);
    }
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
