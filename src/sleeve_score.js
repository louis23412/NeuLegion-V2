// The sleeve-scoring composition (round 40): sleeve -> book -> risk -> gate.
// Driver-side: this module is the ONLY place that calls all three plugin tiers
// together with the analysis gate, which is exactly what the import law
// requires — plugins must not import each other or the gate (`contracts §H`),
// and the legacy tree must not import core, so the composition lives here, in
// the driver layer, beside `analyze.js`. Pure, no I/O, no RNG.
//
// `scoreSleeve(sleeveId, view, {costBps, panel})` is the object the `--sleeve`
// run mode will report: the sleeve plugin's own weights through the `single`
// book and the pinned `cap-band` risk spec, scored by the same
// `scoreBookReturns` arithmetic the gate uses, with the A2 factor-neutral
// hurdle and the A18 stress readouts beside it. Gate G2 is decided on this
// object (scored on data the frozen spec did not select on).

import { carryDispersionSleeve } from './plugins/sleeves/carry-dispersion.js';
import { toptraderFadeSleeve } from './plugins/sleeves/toptrader-fade.js';
import { oiChangeSleeve } from './plugins/sleeves/oi-change.js';
import { singleBook } from './plugins/books/single.js';
import { capBandRisk } from './plugins/risk/cap-band.js';
import { scoreBookReturns, scoreG5, stressHalves, worstBlock } from './analysis/portfolio.js';
import { factorNeutralSharpe } from './analysis/dependence.js';
import { parseFundingJsonl } from './analysis/carry.js';

export const SLEEVE_IDS = Object.freeze(['carry-dispersion', 'toptrader-fade', 'oi-change']);

const SLEEVES = Object.freeze({
    'carry-dispersion': carryDispersionSleeve,
    'toptrader-fade': toptraderFadeSleeve,
    'oi-change': oiChangeSleeve,
});

export function resolveSleeve(sleeveId) {
    const sleeve = SLEEVES[sleeveId];
    if (!sleeve) throw new Error(`sleeve_score: unknown sleeve "${String(sleeveId)}" (known: ${SLEEVE_IDS.join(', ')})`);
    return sleeve;
}

// The carry sleeve's view builder (round 42): parsed funding rows + spot closes
// -> the aligned {fRate, basisPnl, times} panel the R8 plugin scores.
//
// Three lab lessons are load-bearing here (L10-l/m/n/o), so they are contract,
// not comments: funding rows are BUCKETED by grid (sub-grid rows are summed —
// the SOL/FTX crash rows understated ~4x when grid-collapsed); the book grid is
// the INTERSECTION of buckets present in every stream (a silently zero-filled
// leading window would understate the joint book, same rule as the fixed-split
// book); and spot/mark legs are read at EXACT bucket-boundary timestamps only
// (no carry-forward — a frozen close while the mark moves fabricates ±5%/8h of
// basis). A period with no exact close on either leg has a null basis, which
// the book shells count as 0 through the shared `fin` (the R31c convention).
//
// Legs-separated contract (round 43): `basisPnl` is the spot-minus-perp basis
// ONLY — funding lives in `fRate` alone. Every consumer (`buildFundingBook`,
// the sleeve `returns`, `e12#buildXsSeries` legs) earns `basis + funding`, so
// a combined basis would double-count the funding leg (e74 read 2.02 vs the
// stored 6.18 with turnover intact — the weights matched, the P&L did not).
//
// `streams[j]` = { fundingRows: [{timestamp, fundingRate, markPrice}],
// spotCloses: [{timestamp, close}] }. Timestamps accept epoch ms or ISO. The
// spot leg reads EXACT bucket-boundary closes only (caller feeds end-labelled
// closes — the bar-label rule); the perp leg reads the bucket's last mark over
// the PREVIOUS bucket's last mark (lab loadCarryBook convention: in-bucket
// marks are jitter-tolerant, and a gap means null, never a stretched return).
// A shipped `markPrice` of 0 is the missing-mark sentinel (the files carry 0
// before 2023-10-31) — it is NEVER a price: reading it as one fabricates a
// −100 % perp return and a +100 % basis (e74 measured −5.3 % book prints from
// exactly this). Callers substitute an independent mark history for 0-marks
// (the lab's `data/mark_8h.json`); what is still missing stays null.
export function buildCarrySleeveView({ streams, gridMs = 28_800_000 } = {}) {
    if (!Array.isArray(streams) || !streams.length) throw new Error('buildCarrySleeveView: at least one stream is required');
    const ms = (t) => (typeof t === 'number' ? t : Date.parse(t));
    const perStream = streams.map((s, j) => {
        if (!s || !Array.isArray(s.fundingRows) || !s.fundingRows.length) {
            throw new Error(`buildCarrySleeveView: stream ${j} needs non-empty fundingRows`);
        }
        const buckets = new Map();
        for (const r of s.fundingRows) {
            const t = ms(r.timestamp);
            const rate = Number(r.fundingRate);
            if (!Number.isFinite(t) || !Number.isFinite(rate)) continue;
            const key = Math.floor(t / gridMs) * gridMs;
            const b = buckets.get(key) || { rate: 0, markLast: null, markLastTs: -Infinity };
            b.rate += rate;
            const mark = Number(r.markPrice);
            if (mark > 0 && Number.isFinite(mark) && t >= b.markLastTs) { b.markLast = mark; b.markLastTs = t; }
            buckets.set(key, b);
        }
        const closes = new Map();
        for (const c of (Array.isArray(s.spotCloses) ? s.spotCloses : [])) {
            const t = ms(c.timestamp);
            const close = Number(c.close);
            if (Number.isFinite(t) && Number.isFinite(close)) closes.set(t, close);
        }
        return { buckets, closes };
    });
    const common = [...perStream[0].buckets.keys()]
        .filter((key) => perStream.every((p) => p.buckets.has(key)))
        .sort((a, b) => a - b);
    if (!common.length) {
        return { fRate: [], basisPnl: [], times: [], gridMs, buckets: 0, streams: streams.length };
    }
    const fRate = [];
    const basisPnl = [];
    for (const key of common) {
        const fr = [];
        const bp = [];
        for (const p of perStream) {
            const b = p.buckets.get(key);
            fr.push(b.rate);
            const s1 = p.closes.get(key);
            const s0 = p.closes.get(key - gridMs);
            const spot = (Number.isFinite(s0) && Number.isFinite(s1) && s0 > 0)
                ? s1 / s0 - 1 : null;
            const prev = p.buckets.get(key - gridMs);
            const m0 = prev ? prev.markLast : null;
            const m1 = b.markLast;
            const perp = (Number.isFinite(m0) && Number.isFinite(m1) && m0 > 0)
                ? m1 / m0 - 1 : null;
            bp.push(spot === null || perp === null ? null : (spot - perp));
        }
        fRate.push(fr);
        basisPnl.push(bp);
    }
    return { fRate, basisPnl, times: common, gridMs, buckets: common.length, streams: streams.length };
}

export function scoreSleeve(sleeveId, view, { costBps = 0, panel = null } = {}) {
    const sleeve = resolveSleeve(sleeveId);
    const raw = sleeve.signal(view);
    if (!Array.isArray(raw) || !raw.length) {
        return { sleeveId, available: false, reason: 'the sleeve produced no weight rows on this view', costBps };
    }
    const book = singleBook.compose([{ rows: raw, weight: 1 }]);
    const weightRows = capBandRisk.applyForSleeve(book.weightRows, sleeveId);
    const gross = sleeve.returns(view, weightRows);
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

// The `--sleeve` run-mode core (round 44, W2 acceptance): file TEXTS in, the
// G2 report object out. Pure, no I/O, no RNG — the CLI (`analyze.js`) only
// reads the files and writes the report; everything scored lives here so the
// browser harness pins it.
//
// `fundingTexts[j]` / `candleTexts[j]` are the per-stream JSONL bodies,
// positionally matched (the P4 `--carry-files` / `--files` convention).
// Candle rows are `{timestamp, close}` with open-labelled bars, so closes are
// end-labelled by `barMs` (the RUNNER bar-label rule) before the exact-boundary
// read. Only `carry-dispersion` is runnable on shipped data (funding + spot);
// the positioning sleeves name their missing input and land `available:false`
// instead of throwing, so a run report always says what ran and what did not.
// Shipped funding marks cover ~2023-10 on (CYCLE-005); without a substituted
// mark history the view is confined to the marked window — reported, not
// hidden, as `markedFraction`.
export function parseSleeveInputs({ fundingTexts, candleTexts, gridMs = 28_800_000, barMs = 3_600_000 } = {}) {
    if (!Array.isArray(fundingTexts) || !Array.isArray(candleTexts) ||
        !fundingTexts.length || fundingTexts.length !== candleTexts.length) {
        throw new Error('parseSleeveInputs: fundingTexts and candleTexts must be non-empty parallel arrays');
    }
    const streams = fundingTexts.map((text, j) => {
        const { rows } = parseFundingJsonl(text);
        let markRows = 0;
        for (const r of rows) if (r.markPrice > 0) markRows += 1;
        const closes = [];
        for (const line of String(candleTexts[j]).split('\n')) {
            const t = line.trim();
            if (!t) continue;
            let c;
            try { c = JSON.parse(t); } catch { continue; }
            const ts = typeof c.timestamp === 'number' ? c.timestamp : Date.parse(c.timestamp);
            const close = Number(c.close);
            if (Number.isFinite(ts) && Number.isFinite(close)) closes.push({ timestamp: ts + barMs, close });
        }
        return { fundingRows: rows, spotCloses: closes, markRows, fundingRowsTotal: rows.length };
    });
    const view = buildCarrySleeveView({ streams, gridMs });
    const cells = view.buckets * view.streams;
    const nullBasis = view.basisPnl.flat().filter((x) => x === null).length;
    const markedRows = streams.reduce((a, s) => a + s.markRows, 0);
    const fundingRows = streams.reduce((a, s) => a + s.fundingRowsTotal, 0);
    return {
        view,
        streams: streams.length,
        buckets: view.buckets,
        nullBasisFraction: cells ? nullBasis / cells : 1,
        markedFraction: fundingRows ? markedRows / fundingRows : 0,
    };
}

export function runSleeveReport({ sleeveId, fundingTexts, candleTexts, costBps = 4, gridMs = 28_800_000, barMs = 3_600_000 } = {}) {
    if (!SLEEVE_IDS.includes(sleeveId)) {
        return { sleeveId, available: false, reason: `unknown sleeve "${String(sleeveId)}" (known: ${SLEEVE_IDS.join(', ')})`, costBps };
    }
    if (sleeveId !== 'carry-dispersion') {
        return {
            sleeveId, available: false, costBps,
            reason: 'the positioning sleeves need operator data the repo does not ship (toptrader ratios / open interest); only carry-dispersion runs on funding + spot',
        };
    }
    let parsed;
    try {
        parsed = parseSleeveInputs({ fundingTexts, candleTexts, gridMs, barMs });
    } catch (err) {
        return { sleeveId, available: false, reason: String(err && err.message ? err.message : err), costBps };
    }
    const { view } = parsed;
    if (!view.buckets) {
        return { sleeveId, available: false, reason: 'the streams share no funding bucket (empty intersection)', costBps };
    }
    const scored = scoreSleeve(sleeveId, view, { costBps });
    if (!scored.available) return { ...scored, streams: parsed.streams, buckets: parsed.buckets };
    const panel = view.fRate[0].map((_, j) => view.fRate.map((row, i) => row[j] + (view.basisPnl[i][j] === null ? 0 : view.basisPnl[i][j])));
    const fn = factorNeutralSharpe(scored.net, panel);
    const g5 = scoreG5({
        net: scored.net, costBps, blocks: 6, dsrAdjusted: null,
        neutralSharpe: fn.neutral, decayDocumented: false, unseenData: false,
    });
    return {
        sleeveId, available: true, costBps,
        streams: parsed.streams, buckets: parsed.buckets,
        nullBasisFraction: parsed.nullBasisFraction, markedFraction: parsed.markedFraction,
        netAnnual: scored.netSharpe * Math.sqrt(365 * 3),
        turnoverAnnual: scored.turnover * (365 * 3) / scored.net.length,
        breakEvenCostBps: scored.breakEvenCostBps,
        neutralAnnual: fn.neutral * Math.sqrt(365 * 3),
        rawAnnual: fn.raw * Math.sqrt(365 * 3),
        stress: scored.stress, worstBlock: scored.worstBlock,
        g5verdict: g5.verdict, g5reasons: g5.reasons,
        g5knobs: g5.knobs.map((k) => ({ knob: k.knob, pass: k.pass, note: k.note })),
    };
}

export function formatSleeveReport(r) {
    if (!r || r.available !== true) {
        return `[sleeve] ${r && r.sleeveId ? r.sleeveId : 'unknown'}: unavailable — ${r && r.reason ? r.reason : 'no reason'}`;
    }
    const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : 'n/a');
    return [
        `[sleeve] ${r.sleeveId} @${r.costBps}bps over ${r.buckets} buckets x ${r.streams} streams`,
        `  net ${f2(r.netAnnual)} / neutral ${f2(r.neutralAnnual)} (raw ${f2(r.rawAnnual)}), turnover ${f2(r.turnoverAnnual)}/yr, break-even ${f2(r.breakEvenCostBps)} bps`,
        `  null-basis ${(100 * r.nullBasisFraction).toFixed(2)}%, marked ${(100 * r.markedFraction).toFixed(1)}%`,
        `  G5 verdict ${r.g5verdict} (${r.g5reasons.join(',')}) — the operator run owns dsr/decay/unseen`,
    ].join('\n');
}
