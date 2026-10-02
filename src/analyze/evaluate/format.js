// src/analyze/evaluate/format.js (round-96 split of src/analyze/evaluate.js).
// Report formatters (auditVerdict, formatFullHistory, formatAnalysis).
import { formatReport, costLadder, familyCorrelation } from '../../analysis/walkforward.js';
import { formatTurnoverSweep } from '../../analysis/holding.js';
import { formatStreamSelection } from '../../analysis/streams.js';
import { formatForecast } from '../../analysis/forecast.js';
import { formatDecision } from '../../analysis/decision.js';
import { CONTROLLER_POSITION_POLICY } from '../roster.js';
import { summarizeModelStats } from '../models.js';


const f4 = (x) => (Number.isFinite(x) ? x.toFixed(4) : String(x));

// The one-line audit verdict for the human summary. `reachable`/`reachableFolds`
// are what distinguish a *structural* certificate (the perturbation changed the
// object the model reads) from a *behavioural* one (it demonstrably moved a later
// position); the machine-readable report always carries the full audit object.
export const auditVerdict = (report) => {
    const a = report && report.audit;
    if (!a) return 'skipped';
    const parts = [
        a.clean ? 'clean' : 'LEAK',
        `probes=${a.probes || 0}`,
        `reachable=${a.reachable === true}`,
    ];
    if (a.reachableFolds != null) parts.push(`reachableFolds=${a.reachableFolds}`);
    if (a.vacuous) parts.push('VACUOUS');
    return parts.join(' ');
};

// Render the A/B verdict as a human-readable block. `extra` carries the round-25
// run-level blocks (`costLadder`, `familyCorrelation`, `gate`) that are computed
// after the evaluation: they are optional so `formatAnalysis(result)` still
// renders on its own (the tests, and any caller that only wants the raw A/B).
// Round 33 (lab R1): render the long-sample readout. One line per arm naming the
// pooled full-history Sharpe, the break-even, the 5/10 bps restatements and the
// block readout, so a verdict read off the --bars window can be compared at a
// glance. Unavailable arms state their reason; a null block renders nothing (the
// default run is byte-identical).
export function formatFullHistory(block) {
    if (!block || block.available === false) return '';
    const arms = block.arms || {};
    const lines = [];
    for (const id of Object.keys(arms)) {
        const a = arms[id];
        if (!a || a.available === false) {
            lines.push(`full-history ${id}: n/a (${(a && a.reason) || 'not scored'})`);
            continue;
        }
        const m = a.pooledMetrics || {};
        const bs = a.blockStability || {};
        const per = Array.isArray(a.perStream)
            ? a.perStream.map((s) => `${s.label} ${Number.isFinite(s.metrics && s.metrics.netSharpe) ? s.metrics.netSharpe.toFixed(4) : 'n/a'}`).join(', ')
            : '';
        lines.push(`full-history ${id}: pooled Sharpe=${Number.isFinite(m.netSharpe) ? m.netSharpe.toFixed(4) : 'n/a'}` +
            ` @${a.bars}bars/${a.streams}streams breakEven=${m.breakEvenCostBps == null ? 'n/a' : `${m.breakEvenCostBps.toFixed(4)}bps`}` +
            ` @5bps=${Number.isFinite(a.netSharpeAt5bps) ? a.netSharpeAt5bps.toFixed(4) : 'n/a'}` +
            ` @10bps=${Number.isFinite(a.netSharpeAt10bps) ? a.netSharpeAt10bps.toFixed(4) : 'n/a'}` +
            ` blocks k=${bs.blocks == null ? 'n/a' : bs.blocks} positive=${Number.isFinite(bs.positiveFraction) ? bs.positiveFraction.toFixed(4) : 'n/a'}` +
            (per ? ` | streams: ${per}` : ''));
    }
    return lines.join('\n');
}

export function formatAnalysis(result, extra = {}) {
    const lines = [];
    const s = result.search;
    lines.push(`walk-forward A/B: ${result.candidates.length + 1} variants, ` +
        `${result.baseline.folds ? result.baseline.folds.length : 0} folds, ${result.baseline.pooledBars} pooled bars`);
    const ib = extra.intervalBars != null ? extra.intervalBars : (result.intervalBars || 1);
    lines.push(`model: ${result.model || 'bare'} | streams=${result.streams || 1} | ` +
        `positionPolicy=${JSON.stringify(result.positionPolicy || CONTROLLER_POSITION_POLICY)} | ` +
        `probe=${f4(result.probe)} | auditProbesPerFold=${result.auditProbesPerFold || 0} | costBps=${result.costBps || 0} | reuseBase=${result.reuseBase === true}` +
        ` | intervalBars=${ib} | crn=${extra.commonRandomNumbers !== false}`);
    // Round 26 (R26-2): whether each model-backed variant actually trained, and
    // whether it beats its label base rate. Without this, a keep-off verdict is
    // ambiguous between "no edge" and "no model" (BUGS.md #35/#37).
    const ms = extra.model || null;
    if (ms && typeof ms.get === 'function' && typeof ms.size === 'number' && ms.size > 0) {
        const parts = [];
        for (const [id, acc] of ms) {
            const d = summarizeModelStats(acc);
            if (!d) continue;
            parts.push(`${id} ${d.status} steps=${d.trainingSteps}` +
                ` base=${d.baseRate == null ? 'n/a' : f4(d.baseRate)}` +
                ` skill=${d.brierSkill == null ? 'n/a' : f4(d.brierSkill)}` +
                ` warmErrors=${d.warmErrors}`);
        }
        if (parts.length) lines.push(`models: ${parts.join(' | ')}`);
    }
    // Round 25: state the gate. A `keep-off` verdict means something different
    // under a dependence-aware gate than under the classic one, so the reader
    // must be told which one produced it.
    const g = extra.gate || null;
    if (g && g.mode) {
        lines.push(`gate:   ${g.mode}${g.alpha != null ? ` (alpha=${f4(g.alpha)})` : ''}` +
            (g.mode === 'dependence'
                ? ' — paired cluster Sharpe difference + exact sign test over fold windows + DSR floor on design-effect-adjusted bars'
                : ' — the round-23/24 hurdles only (no dependence correction)'));
    }
    lines.push(formatReport(result.baseline, { label: `baseline(${result.baselineVariant.label})` }));
    for (const c of result.candidates) {
        const decision = c.decision || { promote: false, reasons: [], gate: null, promotionTest: null };
        const verdict = decision.promote ? 'PROMOTE' : 'keep-off';
        const kind = c.variant.kind === 'signal' ? ' |signal' : '';
        const fw = c.search ? ` | StepM p=${f4(c.search.pValue)} rejected=${!!c.search.rejected}` : '';
        // Name any round-25 hurdle that was SKIPPED for lack of a panel, so a
        // green gate can never be read as "all hurdles passed".
        const skippedHurdles = decision.gate
            ? Object.entries(decision.gate).filter(([, v]) => v === 'skipped-no-panel').map(([k2]) => k2)
            : [];
        const gt = skippedHurdles.length ? ` | gate-skipped=${skippedHurdles.join(',')}` : '';
        // R27-1: an inactive candidate (inert / duplicate / not-applicable / skipped)
        // names its status inline, and a candidate with no report (never evaluated)
        // is stated as such rather than crashing the formatter on a null report.
        const liveTag = c.active ? '' : ` [${(c.liveness && c.liveness.status) || (c.skipped ? 'skipped' : 'inactive')}]`;
        const label = `${c.variant.label} [${verdict}]${kind}${liveTag}${c.skipped ? ' (skipped: controller-scoped)' : ''}${fw}${gt}`;
        if (!c.report) {
            lines.push(`[${label}] not evaluated`);
            lines.push(`  reasons: ${(decision.reasons || []).join('; ')}`);
            continue;
        }
        // The paired cluster test belongs to the candidate-vs-baseline DECISION,
        // not to the report, so it is handed to the formatter here (round 25). A
        // single-stream run still renders it — as `paired: n/a (reason)` — so the
        // absence of a panel is stated rather than silently omitted.
        lines.push(formatReport(c.report, {
            label,
            promotionTest: decision.promotionTest,
        }));
        if (!decision.promote) lines.push(`  reasons: ${(decision.reasons || []).join('; ')}`);
    }
    if (s && s.skipped) {
        lines.push(`family-wise: skipped (${s.reason || 'no active candidates'})`);
    } else if (s && Array.isArray(s.candidates)) {
        lines.push(`family-wise: SPA p=${f4(s.spaPValue)} best=${s.bestLabel} Rejects=[${s.rejectedLabels.length ? s.rejectedLabels.join(',') : 'none'}] K=${s.K} T=${s.T}`);
    } else if (s && s.error) {
        lines.push(`family-wise: unavailable (${s.error})`);
    }
    // Round 25: how concentrated the search was. DIAGNOSTIC ONLY — the deflated
    // Sharpe keeps trials=K on purpose (an effective number of independent tests
    // does not control the FWER: arXiv 1612.04535).
    const fc = extra.familyCorrelation;
    if (fc && fc.available) {
        const mp = fc.maxPair ? ` | maxPair=${familyPairLabel(fc.maxPair, result, fc.labels)} r=${f4(fc.maxPair.rho)}` : '';
        lines.push(`family: excessCorr=${f4(fc.meanPairwiseExcessCorr)} effectiveTrials=${f4(fc.effectiveTrials)} of ${fc.K}${mp}` +
            ' (diagnostic only; DSR keeps trials=K)');
    }
    // Round 25: the cost ladder. One line per level, naming the promoting
    // candidates, so a verdict that only holds at one cost assumption is obvious.
    const cl = extra.costLadder;
    if (cl && cl.available && Array.isArray(cl.rows)) {
        for (const row of cl.rows) {
            const promo = row.candidates.filter((c) => c.promote).map((c) => c.id);
            // Round 32 (lab R3): name every candidate's restated net Sharpe on the
            // line itself, so the 5/10 bps verdict is readable without opening the
            // machine-readable rows (a promotes-only line hides a cost death).
            const nets = row.candidates.map((c) => `${c.id} ${f4(c.netSharpe)}`).join(', ');
            lines.push(`cost-ladder +${row.costBps}bps: baseline Sharpe=${f4(row.baseline.netSharpe)} DSR=${f4(row.baseline.dsr)}` +
                ` | promotes=[${promo.length ? promo.join(',') : 'none'}] | netSharpe=[${nets}]`);
        }
    }
    // Round 26 (R26-5): the turnover attack. One line per candidate naming the
    // best break-even policy, so the reader sees whether any no-trade band (or
    // hysteresis / minimum holding) clears the target cost — and which.
    const ts = extra.turnoverSweep;
    if (ts) {
        const rendered = formatTurnoverSweep(ts);
        if (rendered) for (const line of rendered.split('\n')) lines.push(line);
    }
    // Round 26 (R26-6): the effective independence of the stream basket (Kish
    // design effect over the streams' own returns) and, when asked, the greedy
    // selection order. Design/diagnostic only.
    const ss = extra.streamSelection;
    if (ss) {
        const rendered = formatStreamSelection(ss);
        if (rendered) for (const line of rendered.split('\n')) lines.push(line);
        if (ss.keep != null && ss.keptDesignEffect && ss.keptDesignEffect.available) {
            lines.push(`streams kept=${ss.keep} -> ${ss.kept.join(',')} DE=${f4(ss.keptDesignEffect.designEffect)} ` +
                `effectiveBars=${f4(ss.keptDesignEffect.effectiveBars)}`);
        }
    }
    // Round 26 (R26-14): the forecast-comparison line — proper scores and the
    // Model Confidence Set. The MCS is the headline: which families cannot be
    // distinguished from the best, rather than a single sample-best winner.
    const fcBlock = extra.forecast;
    if (fcBlock) {
        const rendered = formatForecast(fcBlock);
        if (rendered) for (const line of rendered.split('\n')) lines.push(line);
    }
    // Run-level power honesty (round 24b): a null verdict from a run that could
    // not have detected a Sharpe of 1 is "underpowered", not "no edge". Name the
    // sample size that would settle it, so the next run can be sized.
    const pw = result.baseline && result.baseline.power;
    if (pw && Number.isFinite(pw.mdeSharpe)) {
        lines.push(`power:  MDE95 Sharpe=±${f4(pw.mdeSharpe)} over ${pw.bars} pooled bars` +
            (pw.underpowered
                ? ` — UNDERPOWERED: this run cannot rule out edges below that; ~${pw.barsToDetect1} pooled bars are needed to detect Sharpe ±1.0`
                : ''));
    }
    // Round 25: the honest (cluster-jackknife) power, when a panel exists.
    if (pw && Number.isFinite(pw.mdeSharpeDependent)) {
        lines.push(`power*: MDE95 Sharpe=±${f4(pw.mdeSharpeDependent)} under the cluster jackknife` +
            ` (i.i.d. variance understated by ${f4(pw.varianceInflation)}x; ${f4(pw.effectiveBars)} effective bars of ${pw.bars})` +
            (pw.underpoweredDependent ? ' — UNDERPOWERED' : ''));
    }
    // Round 26 (R26-8): the decision-grade report — the verdict, the concentration
    // readout and the next-run sizing knobs stated in one place, so a reader does
    // not have to reconstruct them from the per-candidate lines above.
    if (extra.decision) {
        const renderedDecision = formatDecision(extra.decision);
        if (renderedDecision) for (const line of renderedDecision.split('\n')) lines.push(line);
    }
    // Round 33 (lab R1): the long-sample readout beside the verdict — the same
    // arms scored contiguously over the full history, so a window artefact
    // (F-01) is visible on the summary itself.
    if (extra.fullHistory) {
        const renderedFull = formatFullHistory(extra.fullHistory);
        if (renderedFull) for (const line of renderedFull.split('\n')) lines.push(line);
    }
    lines.push(`audit: baseline ${auditVerdict(result.baseline)}`);
    return lines.join('\n');
}

// "candidate-a~candidate-b" for a family-correlation max pair. R28 (BUGS.md #55):
// prefer the labels the correlation object carries (`fc.labels`, the ACTIVE list
// the matrix was built from); the driver's `result.candidates` is the FULL list,
// so resolving against it names the wrong arms when an inactive candidate
// precedes an active one (the round-27 summary printed `sample-weights~multiprobe`
// for a `surprise~homeostasis` pair).
function familyPairLabel(pair, result, labels = null) {
    const label = (i) => {
        if (Array.isArray(labels) && labels[i] != null) return labels[i];
        const c = result && result.candidates ? result.candidates[i] : null;
        return c && c.variant ? c.variant.id : `#${i}`;
    };
    return `${label(pair.a)}~${label(pair.b)}`;
}

// ---------------------------------------------------------------------------
// CLI driver — reads a candle stream, runs the A/B, writes the run directory.
