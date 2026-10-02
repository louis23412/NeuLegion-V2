// Sleeve report composition (round-81 split): texts in, G2 report out.
// Pure, no I/O — the CLI only reads files and writes the report.
import { SLEEVE_IDS } from './registry.js';
import { parseSleeveInputs, parseMarksJson, parseOiJson } from './view.js';
import { scoreSleeve } from './scoring.js';
import { sleeveDsr, sleeveYearly, yearlyReport, sleeveFirstLast, firstLastReport, dsrReport } from './evidence.js';
import { parseSleeveSizing, scoreSleeveSized, SIZED_SLEEVE_DEFAULTS } from './sizing.js';
import { factorNeutralSharpe } from '../analysis/dependence.js';
import { scoreG5, worstBlock } from '../analysis/portfolio.js';

// The earn-time grid for the yearly attribution (round 80) now rides on the
// sleeve: positioning sleeves expose optional `earnTimes(view, weightRows)`
// (registered on the sleeve contract), and the carry sleeve — which has none —
// falls back to `times.slice(1)`. Any length mismatch fail-closes, never trims.

export function runSleeveReport({ sleeveId, fundingTexts, candleTexts, costBps = 4, gridMs = 28_800_000, barMs = 3_600_000, sizingTarget = null, sizingWindow = SIZED_SLEEVE_DEFAULTS.window, marksText = null, symbols = null, oiText = null } = {}) {
    if (!SLEEVE_IDS.includes(sleeveId)) {
        return { sleeveId, available: false, reason: `unknown sleeve "${String(sleeveId)}" (known: ${SLEEVE_IDS.join(', ')})`, costBps };
    }
    const positioning = sleeveId !== 'carry-dispersion';
    if (positioning && oiText == null) {
        return {
            sleeveId, available: false, costBps,
            reason: 'the positioning sleeves need --oi-file (open-interest JSON, default src/data/oi_8h.json); only carry-dispersion runs on funding + spot',
        };
    }
    if (!positioning && oiText != null) {
        throw new Error('runSleeveReport: oiText needs a positioning sleeve (oi-change, toptrader-fade)');
    }
    if (positioning && marksText != null) {
        throw new Error('runSleeveReport: marksText needs the carry sleeve (carry-dispersion)');
    }
    let marks = null;
    if (marksText != null) {
        if (!Array.isArray(symbols) || symbols.length !== fundingTexts.length) {
            throw new Error('runSleeveReport: marksText needs symbols (one per stream, positionally matched to the funding texts)');
        }
        try {
            marks = parseMarksJson(marksText);
        } catch (err) {
            return { sleeveId, available: false, reason: String(err && err.message ? err.message : err), costBps };
        }
    }
    let oi = null;
    if (oiText != null) {
        if (!Array.isArray(symbols) || symbols.length !== fundingTexts.length) {
            throw new Error('runSleeveReport: oiText needs symbols (one per stream, positionally matched to the funding texts)');
        }
        try {
            oi = parseOiJson(oiText);
        } catch (err) {
            return { sleeveId, available: false, reason: String(err && err.message ? err.message : err), costBps };
        }
    }
    let parsed;
    try {
        parsed = parseSleeveInputs({ fundingTexts, candleTexts, gridMs, barMs, marks, symbols, oi });
    } catch (err) {
        return { sleeveId, available: false, reason: String(err && err.message ? err.message : err), costBps };
    }
    const { view } = parsed;
    if (!view.buckets) {
        return { sleeveId, available: false, reason: 'the streams share no funding bucket (empty intersection)', costBps };
    }
    const scored = scoreSleeve(sleeveId, view, { costBps });
    if (!scored.available) return { ...scored, streams: parsed.streams, buckets: parsed.buckets };
    const panel = positioning
        ? view.spotRet[0].map((_, j) => view.spotRet.map((row) => (row[j] === null ? 0 : row[j])))
        : view.fRate[0].map((_, j) => view.fRate.map((row, i) => row[j] + (view.basisPnl[i][j] === null ? 0 : view.basisPnl[i][j])));
    const earnTimes = Array.isArray(scored.earnTimes) ? scored.earnTimes : view.times.slice(1, 1 + scored.net.length);
    if (earnTimes.length !== scored.net.length) {
        return { sleeveId, available: false, costBps, reason: 'the earn-time grid does not match the scored bars (fail-closed yearly attribution)' };
    }
    const fn = factorNeutralSharpe(scored.net, panel);
    const dsr = sleeveDsr({ net: scored.net });
    const g5 = scoreG5({
        net: scored.net, costBps, blocks: 6, dsrAdjusted: dsr.available ? dsr.dsrAdjusted : null,
        neutralSharpe: fn.neutral, decayDocumented: false, unseenData: false,
    });
    const rep = {
        sleeveId, available: true, costBps,
        streams: parsed.streams, buckets: parsed.buckets,
        nullBasisFraction: positioning ? null : parsed.nullBasisFraction,
        markedFraction: positioning ? null : parsed.markedFraction,
        marks: parsed.marksApplied ? { substituted: parsed.marksSubstituted } : null,
        oi: parsed.oiApplied ? { coverageOiVal: parsed.oiCoverageOiVal, coverageTopLS: parsed.oiCoverageTopLS } : null,
        netAnnual: scored.netSharpe * Math.sqrt(365 * 3),
        turnoverAnnual: scored.turnover * (365 * 3) / scored.net.length,
        breakEvenCostBps: scored.breakEvenCostBps,
        neutralAnnual: fn.neutral * Math.sqrt(365 * 3),
        rawAnnual: fn.raw * Math.sqrt(365 * 3),
        stress: scored.stress, worstBlock: scored.worstBlock,
        dsr: dsrReport(dsr),
        yearly: yearlyReport(sleeveYearly({ net: scored.net, times: earnTimes })),
        firstLast: firstLastReport(sleeveFirstLast({ net: scored.net })),
        g5verdict: g5.verdict, g5reasons: g5.reasons,
        g5knobs: g5.knobs.map((k) => ({ knob: k.knob, pass: k.pass, note: k.note })),
    };
    const sizing = parseSleeveSizing({ sizing: sizingTarget, window: sizingWindow });
    if (sizing.sized) {
        const sized = scoreSleeveSized(sleeveId, view, {
            costBps, target: sizing.target, window: sizing.window, panel,
        });
        rep.sizing = { target: sizing.target, window: sizing.window };
        if (sized.available) {
            rep.sized = {
                available: true,
                target: sizing.target, window: sizing.window,
                baseNetAnnual: sized.baseNetSharpe * Math.sqrt(365 * 3),
                netAnnual: sized.netSharpe * Math.sqrt(365 * 3),
                neutralAnnual: sized.neutralSharpe * Math.sqrt(365 * 3),
                turnoverAnnual: sized.turnover * (365 * 3) / sized.net.length,
                breakEvenCostBps: sized.breakEvenCostBps,
                skipped: sized.skipped, scoredBars: sized.scoredBars,
                bookVolMean: sized.bookVolMean,
                stress: sized.stress, worstBlock: sized.worstBlock,
                dsr: dsrReport(sleeveDsr({ net: sized.net })),
                yearly: yearlyReport(sleeveYearly({ net: sized.net, times: earnTimes })),
                firstLast: firstLastReport(sleeveFirstLast({ net: sized.net })),
            };
        } else {
            rep.sized = { available: false, reason: sized.reason };
        }
    }
    return rep;
}

export function formatSleeveReport(r) {
    if (!r || r.available !== true) {
        return `[sleeve] ${r && r.sleeveId ? r.sleeveId : 'unknown'}: unavailable — ${r && r.reason ? r.reason : 'no reason'}`;
    }
    const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : 'n/a');
    const f4 = (v) => (Number.isFinite(v) ? v.toFixed(4) : 'n/a');
    const dsrLine = (d) => d && d.available === true
        ? `dsr ${d.mode} ${f4(d.dsrAdjusted)} (DE ${f2(d.designEffect)}, ${d.effectiveBars}/${d.bars} effective bars, trials=${d.trials})`
        : 'dsr unscored';
    const yearlyLine = (y) => {
        if (!y || y.available !== true || !y.years.length) return 'yearly unscored';
        const first = y.years[0], last = y.years[y.years.length - 1];
        const s = (v) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(2) : 'n/a');
        return `yearly per-bar Sharpe ${first.year} ${s(first.netSharpe)} → ${last.year} ${s(last.netSharpe)}` +
            ` (slope ${y.slope == null ? 'n/a' : s(y.slope) + '/yr'}, ${y.years.length}y)`;
    };
    const firstLastLine = (f) => {
        if (!f || f.available !== true) return 'first-last unscored';
        const s = (v) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(2) : 'n/a');
        return `first-last per-bar Sharpe ${s(f.first.perBarSharpe)} → ${s(f.second.perBarSharpe)}` +
            ` (Δ ${s(f.diff)} ± ${(1.96 * f.seDiff).toFixed(2)})`;
    };
    const attest = (r.g5reasons || []).filter((x) => x === 'decay' || x === 'unseen');
    const marksLine = (m) => m && m.substituted > 0
        ? `  marks +${m.substituted} ext rows (shipped marks kept where positive)`
        : null;
    const basisLine = r.sleeveId === 'carry-dispersion'
        ? `  null-basis ${(100 * r.nullBasisFraction).toFixed(2)}%, marked ${(100 * r.markedFraction).toFixed(1)}%`
        : (r.oi
            ? `  oi coverage oiVal ${(100 * r.oi.coverageOiVal).toFixed(1)}%, topLS ${(100 * r.oi.coverageTopLS).toFixed(1)}%`
            : '  oi unscored');
    const lines = [
        `[sleeve] ${r.sleeveId} @${r.costBps}bps over ${r.buckets} buckets x ${r.streams} streams`,
        `  net ${f2(r.netAnnual)} / neutral ${f2(r.neutralAnnual)} (raw ${f2(r.rawAnnual)}), turnover ${f2(r.turnoverAnnual)}/yr, break-even ${f2(r.breakEvenCostBps)} bps`,
        basisLine,
        `  ${dsrLine(r.dsr)}`,
        `  ${yearlyLine(r.yearly)}`,
        `  ${firstLastLine(r.firstLast)}`,
        `  G5 verdict ${r.g5verdict} (${r.g5reasons.join(',')})${attest.length ? ` — the operator run owns ${attest.join('/')}` : ''}`,
    ];
    const ml = marksLine(r.marks);
    if (ml) lines.splice(3, 0, ml);
    if (r.sized) {
        lines.push(r.sized.available === true
            ? `  sized @${r.sized.target}/bar (w${r.sized.window}, bookVol ${r.sized.bookVolMean.toExponential(2)}): net ${f2(r.sized.netAnnual)} (base ${f2(r.sized.baseNetAnnual)}), turnover ${f2(r.sized.turnoverAnnual)}/yr, break-even ${f2(r.sized.breakEvenCostBps)} bps, skipped ${r.sized.skipped}/${r.sized.skipped + r.sized.scoredBars}; ${dsrLine(r.sized.dsr)}`
            : `  sized unavailable — ${r.sized.reason}`);
    }
    return lines.join('\n');
}
