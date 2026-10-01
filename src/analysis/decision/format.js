// src/analysis/decision/format.js (round-97 split of src/analysis/decision.js).
// Decision format section.

import { isNum } from './measures.js';



// Compact, deterministic summary lines for the run summary.
export function formatDecision(decision) {
    if (!decision) return 'decision: unavailable';
    const lines = [];
    const v = decision.verdict || {};
    lines.push(`decision: ${v.promote ? 'PROMOTE' : 'keep-off'}${v.candidateId ? ` (${v.candidateId})` : ''}` + (v.reasons && v.reasons.length ? ` | binding: ${v.reasons[0]}` : ''));
    // R28 (BUGS.md #55): the knife-edge margin, so a 0.00124 miss is visible.
    const th = v.tightestHurdle;
    if (th && isNum(th.margin)) {
        lines.push(`  margin: tightest hurdle ${th.hurdle} value=${fmtPrec(th.value)} threshold=${fmtPrec(th.threshold)} margin=${th.margin >= 0 ? '+' : ''}${fmtPrec(th.margin)}${th.failed === false ? ' (passed)' : ''}`);
    }
    const pol = decision.training && decision.training.labelPolicy;
    if (pol != null) {
        const runPol = decision.training.runLabelPolicy;
        lines.push(`  label policy: referent=${pol}${runPol != null && runPol !== pol ? ` run=${runPol}` : ''}`);
    }
    const c = decision.concentration;
    if (c && c.available) {
        const top = (c.topKs || []).map((t) => `top${t.k}=${t.share == null ? 'n/a' : `${(t.share * 100).toFixed(1)}%`}`).join(' ');
        const range = c.deleteOneCluster && c.deleteOneCluster.available
            ? ` | LOO Sharpe [${fmt(c.deleteOneCluster.min)}, ${fmt(c.deleteOneCluster.max)}] worst=#${c.deleteOneCluster.worstIndex}`
            : '';
        lines.push(`  concentration: grossPos=${fmt(c.positiveSum)} grossNeg=${fmt(c.negativeSum)} ${top}${range}`);
    } else {
        lines.push(`  concentration: n/a (${c ? c.reason : 'none'})`);
    }
    const n = decision.nextRun;
    if (n && n.available) {
        lines.push(`  nextRun: single-series effBars=${fmt(n.effectiveBars)} MDE95=${fmt(n.mde95)}` +
            (n.mde95Dependent == null ? '' : ` (dep ${fmt(n.mde95Dependent)})`) +
            ` breakEven=${n.breakEvenBps == null ? 'n/a' : `${fmt(n.breakEvenBps)}bps`}` +
            (n.pairedUnits && n.pairedUnits.available && n.pairedUnits.neededForObserved != null
                ? ` | paired clusters need=${n.pairedUnits.neededForObserved} have=${n.pairedUnits.nClusters}` +
                  (n.pairedUnits.neededForObservedPower80 != null ? ` need(80%)=${n.pairedUnits.neededForObservedPower80}` : '')
                : '') +
            (n.cheapestFlip && n.cheapestFlip.available ? ` | cheapest flip: ${n.cheapestFlip.kind}` : ''));
    } else {
        lines.push(`  nextRun: n/a (${n ? n.reason : 'none'})`);
    }
    return lines.join('\n');
}

const fmt = (x) => (isNum(x) ? x.toFixed(3) : 'n/a');
const fmtPrec = (x) => (isNum(x) ? (Math.abs(x) >= 1 ? x.toFixed(4) : x.toPrecision(5)) : 'n/a');
