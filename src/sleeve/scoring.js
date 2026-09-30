// Sleeve scoring core (round-81 split): sleeve plugin -> single book ->
// cap-band risk -> gate arithmetic. Pure.
import { resolveSleeve } from './registry.js';
import { singleBook } from '../plugins/books/single.js';
import { capBandRisk } from '../plugins/risk/cap-band.js';
import { scoreBookReturns, stressHalves, worstBlock } from '../analysis/portfolio.js';
import { factorNeutralSharpe } from '../analysis/dependence.js';

export function scoreSleeve(sleeveId, view, { costBps = 0, panel = null } = {}) {
    const sleeve = resolveSleeve(sleeveId);
    const raw = sleeve.signal(view);
    if (!Array.isArray(raw) || !raw.length) {
        return { sleeveId, available: false, reason: 'the sleeve produced no weight rows on this view', costBps };
    }
    const book = singleBook.compose([{ rows: raw, weight: 1 }]);
    const weightRows = capBandRisk.applyForSleeve(book.weightRows, sleeveId);
    const gross = sleeve.returns(view, weightRows);
    const earnTimes = typeof sleeve.earnTimes === 'function' ? sleeve.earnTimes(view, weightRows) : null;
    const scored = scoreBookReturns(gross, weightRows, { costBps });
    if (!scored) {
        return { sleeveId, available: false, reason: 'the sleeve book did not score (non-finite returns or ragged weights)', costBps };
    }
    const fn = Array.isArray(panel) && panel.length
        ? factorNeutralSharpe(scored.net, panel)
        : { raw: scored.netSharpe, neutral: NaN, residual: null };
    return {
        sleeveId,
        available: true,
        costBps,
        spec: sleeve.spec,
        weightRows,
        earnTimes,
        gross: scored.gross,
        net: scored.net,
        grossSharpe: scored.grossSharpe,
        netSharpe: scored.netSharpe,
        turnover: scored.turnover,
        turnoverPerYear: scored.turnoverPerYear,
        breakEvenCostBps: scored.breakEvenCostBps,
        rawSharpe: fn.raw,
        neutralSharpe: fn.neutral,
        panelStreams: Array.isArray(panel) ? panel.length : 0,
        stress: stressHalves(scored.net),
        worstBlock: worstBlock(scored.net),
    };
}
