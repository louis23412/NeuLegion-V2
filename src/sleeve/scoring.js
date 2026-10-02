// Sleeve scoring core (round-81 split): sleeve plugin -> single book ->
// cap-band risk -> gate arithmetic. Pure.
import { resolveSleeve } from './registry.js';
import { singleBook } from '../plugins/books/single.js';
import { capBandRisk } from '../plugins/risk/cap-band.js';
import { scoreBookReturns, stressHalves, worstBlock } from '../analysis/portfolio.js';
import { factorNeutralSharpe } from '../analysis/dependence.js';

// Round 110: opt-in risk-spec override (`--sleeve-cap=` / `--sleeve-band=`).
// `undefined` per field = the sleeve's pinned spec; `null` (or the string
// "none") = no cap / no band; else a number (cap > 0, band >= 0). Anything
// else throws naming the flag (BUGS.md #69: refuse loudly, never silently
// score a misread override). Returns null when neither flag was given.
export function parseSleeveRisk({ cap = undefined, band = undefined, bandEps = undefined } = {}) {
    if (cap === undefined && band === undefined && bandEps === undefined) return null;
    if (band !== undefined && bandEps !== undefined) {
        const normKey = (v) => (v === null ? 'none' : String(v).trim().toLowerCase());
        const normNum = (k) => ((k === 'none' || k === 'null') ? null : Number(k));
        const a = normKey(band), b = normKey(bandEps);
        const na = normNum(a), nb = normNum(b);
        const same = (na === null && nb === null) ? true : ((Number.isFinite(na) && Number.isFinite(nb)) ? na === nb : a === b);
        if (!same) throw new Error('analyze: --sleeve-band given twice with different values (BUGS.md #69)');
    }
    const one = (name, v, { min, minOk }) => {
        if (v === undefined) return undefined;
        if (v === null) return null;
        const s = String(v).trim().toLowerCase();
        if (s === 'none' || s === 'null') return null;
        if (s === '') throw new Error(`analyze: --sleeve-${name} is present but empty (a number or "none" is required — BUGS.md #69)`);
        const n = Number(s);
        if (!Number.isFinite(n) || !(n > min || (minOk && n === min))) {
            throw new Error(`analyze: --sleeve-${name} must be a number ${minOk ? '>= ' + min : '> ' + min} or "none" (got "${String(v)}" — BUGS.md #69)`);
        }
        return n;
    };
    return { cap: one('cap', cap, { min: 0, minOk: false }), bandEps: one('band', band === undefined ? bandEps : band, { min: 0, minOk: true }) };
}

export function scoreSleeve(sleeveId, view, { costBps = 0, panel = null, riskSpec = null } = {}) {
    const sleeve = resolveSleeve(sleeveId);
    const raw = sleeve.signal(view);
    if (!Array.isArray(raw) || !raw.length) {
        return { sleeveId, available: false, reason: 'the sleeve produced no weight rows on this view', costBps };
    }
    const book = singleBook.compose([{ rows: raw, weight: 1 }]);
    const pinned = { cap: sleeve.spec.cap ?? null, bandEps: sleeve.spec.bandEps ?? null };
    if (riskSpec != null && riskSpec.band !== undefined && riskSpec.bandEps !== undefined) {
        const key = (v) => (v === null ? 'none' : String(v).trim().toLowerCase());
        const num = (k) => ((k === 'none' || k === 'null') ? null : Number(k));
        const a = key(riskSpec.band), b = key(riskSpec.bandEps);
        const na = num(a), nb = num(b);
        const same = (na === null && nb === null) ? true : ((Number.isFinite(na) && Number.isFinite(nb)) ? na === nb : a === b);
        if (!same) throw new Error('scoreSleeve: riskSpec carries band and bandEps with different values (pass one — BUGS.md #69)');
    }
    const noOverride = riskSpec == null || (riskSpec.cap === undefined && riskSpec.band === undefined && riskSpec.bandEps === undefined);
    const eff = noOverride ? pinned : {
        cap: riskSpec.cap === undefined ? pinned.cap : riskSpec.cap,
        bandEps: (riskSpec.band !== undefined ? riskSpec.band : riskSpec.bandEps) === undefined ? pinned.bandEps : (riskSpec.band !== undefined ? riskSpec.band : riskSpec.bandEps),
    };
    const weightRows = noOverride
        ? capBandRisk.applyForSleeve(book.weightRows, sleeveId)
        : capBandRisk.applyToWeights(book.weightRows, eff);
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
        riskSpec: { cap: eff.cap, bandEps: eff.bandEps, overridden: !noOverride },
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
