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
import { volTargetRisk } from './plugins/risk/vol-target.js';
import { scoreBookReturns, scoreG5, stressHalves, worstBlock } from './analysis/portfolio.js';
import { factorNeutralSharpe, clusterJackknife } from './analysis/dependence.js';
import { sharpeRatio, sharpeStandardError, deflatedSharpeRatio, skewness, kurtosis } from './analysis/performance.js';
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

// The sleeve DSR block (round 75): the G5 `dsr` knob, machine-scored.
//
// The walk-forward gate clears its DSR floor on the design-effect-adjusted
// sample (`walkforward#dependenceSummary` + `backtestMetrics#effectiveBars`,
// Bailey & Lopez de Prado (2014) — deflated Sharpe). The sleeve book has no folds, so the
// cluster unit is the G5's own block grid: the delete-one-block jackknife
// (`dependence#clusterJackknife`, Cameron & Miller 2015) over `blocks`
// contiguous calendar blocks — the same window in every stream is one market
// event, the project's documented cluster position (`dependence.js`) — gives
// the honest (cluster-robust) SE of the book Sharpe, `designEffect =
// (seCluster/seIid)^2` the variance inflation, and `effectiveBars =
// bars/designEffect` the sample the DSR floor uses. It absorbs serial
// dependence, block-concentration and non-normality together: an edge carried
// by one block makes the leave-one-out Sharpes disagree, the SE explodes, and
// the DSR collapses — the concentration veto the gate wants.
//
// Three outcomes, mirroring the walk-forward gate's own three states:
//   `deflated`    DE > 1 and at least two effective bars: the DSR is re-run
//                 on the effective sample (the `backtestMetrics` convention).
//   `full-sample` DE <= 1 (measurable, nothing over-confident to deflate):
//                 the unadjusted floor is the honest one — the gate's
//                 `not-needed` state, scored at the full sample, never a fail.
//   unavailable   unmeasurable (too short, non-finite, degenerate): fail-closed,
//                 `dsrAdjusted` stays null and the G5 knob fails as before.
// `trials` is 1: the shipped spec is one frozen recipe, stated, not banked —
// so this DSR is an UPPER bound on selection-adjusted confidence (the lab
// search history that produced the spec is unquantified and documented, not
// hidden). The `nStar < 2` guard (fewer than two effective bars) is a
// theoretical trip-wire — unreachable at the shipped block counts — kept so a
// single-block event can never manufacture a passing DSR.
// Units: everything runs in PER-BAR Sharpe with n in bars — Lo (2002)'s SE
// formula is stated in per-observation units, so annualizing the jackknife
// statistic while counting bars would make the design effect depend on the
// display annualization. The report annualizes only for display.
export const SLEEVE_DSR_BLOCKS = 6;
export const SLEEVE_DSR_TRIALS = 1;

export function sleeveDsr({ net, blocks = SLEEVE_DSR_BLOCKS, trials = SLEEVE_DSR_TRIALS } = {}) {
    const fail = (reason) => ({ available: false, reason, trials, blocks, dsrAdjusted: null });
    if (!Array.isArray(net) || net.length === 0) return fail('no scored book series');
    const T = net.length;
    const b = Number.isInteger(blocks) && blocks >= 2 ? blocks : SLEEVE_DSR_BLOCKS;
    if (T < 2 * b) return fail(`the book has ${T} bars — fewer than two bars per block over ${b} blocks`);
    for (const v of net) if (!Number.isFinite(v)) return fail('the scored book series is not finite');
    const perBar = sharpeRatio(net, { periodsPerYear: 1 });
    const sk = skewness(net);
    const ku = kurtosis(net);
    const base = Math.floor(T / b);
    const rem = T % b;
    const clusters = [];
    let from = 0;
    for (let c = 0; c < b; c++) {
        const size = base + (c < rem ? 1 : 0);
        clusters.push(net.slice(from, from + size));
        from += size;
    }
    const stat = (a) => sharpeRatio(a, { periodsPerYear: 1 });
    const jk = clusterJackknife({ clusters, statistic: stat });
    if (!Number.isFinite(jk.estimate) || !Number.isFinite(jk.se)) return fail('the delete-one-block jackknife is not finite');
    const seIid = sharpeStandardError({ sharpe: jk.estimate, n: T, skew: sk, kurtosis: ku });
    if (!(seIid > 0)) return fail('the i.i.d. Sharpe standard error is not positive');
    const designEffect = (jk.se / seIid) ** 2;
    if (!Number.isFinite(designEffect) || designEffect < 0) return fail('the variance inflation is not finite');
    let mode = 'full-sample';
    let n = T;
    if (designEffect > 1) {
        const nStar = Math.round(T / designEffect);
        if (nStar >= 2 && nStar < T) { mode = 'deflated'; n = nStar; }
        else if (nStar < 2) return fail('fewer than two effective bars — the edge is a single-block event');
    }
    const dsrAdjusted = deflatedSharpeRatio({ sharpe: perBar, n, skew: sk, kurtosis: ku, trials });
    const dsrFullSample = deflatedSharpeRatio({ sharpe: perBar, n: T, skew: sk, kurtosis: ku, trials });
    if (!Number.isFinite(dsrAdjusted) || !Number.isFinite(dsrFullSample)) return fail('the deflated Sharpe is not finite');
    return {
        available: true, dsrAdjusted, dsrFullSample, designEffect, effectiveBars: n,
        bars: T, clusters: b, trials, mode, seCluster: jk.se, seIid,
        perBarSharpe: perBar, skew: sk, kurtosis: ku, reason: null,
    };
}

// The yearly decay attribution (round 76, TODO 105): the scored book grouped by
// calendar year of the EARNING bucket (`buildFundingBook` earns legs[i] under
// weights set at i-1, so bar t of a (B-1)-bar book labels at `times[t+1]` — the
// caller passes exactly that; any length mismatch fail-closes, never trims).
// Per year: bar count + per-bar Sharpe (the `scoreBookReturns` convention; a
// sub-2-bar year is unmeasurable, `netSharpe: null`, never a fabricated 0).
// `slope` is the OLS slope of measurable yearly Sharpes on calendar year —
// descriptive, deliberately NOT a test: a p-value on ~8 yearly Sharpes would be
// theater, and the G5 `decay` knob stays a human attestation either way. This
// is the evidence the attestation reads, beside `stressHalves`/`worstBlock`.
export function sleeveYearly({ net, times } = {}) {
    const fail = (reason) => ({ available: false, reason, years: [], slope: null });
    if (!Array.isArray(net) || !Array.isArray(times)) return fail('the book series and its bar times are required');
    if (net.length === 0) return fail('no scored bars');
    if (times.length !== net.length) {
        return fail(`the bar times (${times.length}) do not match the scored bars (${net.length})`);
    }
    for (const v of net) if (!Number.isFinite(v)) return fail('the scored book series is not finite');
    for (const t of times) if (!Number.isFinite(t)) return fail('a bar time is not finite');
    const byYear = new Map();
    for (let i = 0; i < net.length; i++) {
        const year = new Date(times[i]).getUTCFullYear();
        if (!Number.isInteger(year)) return fail('a bar time does not parse to a year');
        if (!byYear.has(year)) byYear.set(year, []);
        byYear.get(year).push(net[i]);
    }
    const years = [...byYear.keys()].sort((a, b) => a - b).map((year) => {
        const bars = byYear.get(year);
        return { year, bars: bars.length, netSharpe: bars.length >= 2 ? sharpeRatio(bars, { periodsPerYear: 1 }) : null };
    });
    const fit = years.filter((y) => Number.isFinite(y.netSharpe));
    let slope = null;
    if (fit.length >= 2) {
        const n = fit.length;
        let sx = 0, sy = 0;
        for (const y of fit) { sx += y.year; sy += y.netSharpe; }
        const mx = sx / n, my = sy / n;
        let num = 0, den = 0;
        for (const y of fit) { num += (y.year - mx) * (y.netSharpe - my); den += (y.year - mx) * (y.year - mx); }
        slope = den > 0 ? num / den : null;
    }
    if (slope !== null && !Number.isFinite(slope)) return fail('the yearly slope is not finite');
    return { available: true, years, slope, reason: null };
}

// The JSON-safe projection of a `sleeveYearly` result for the report artifact.
export function yearlyReport(y) {
    if (!y || y.available !== true) {
        return { available: false, slope: null, years: [], reason: (y && y.reason) || 'unscored' };
    }
    return {
        available: true, slope: y.slope, reason: null,
        years: y.years.map((r) => ({ year: r.year, bars: r.bars, netSharpe: r.netSharpe })),
    };
}

// The formal first-vs-last comparison (round 77, TODO 105): the scored book
// split into calendar halves at floor(T/2) — the same split `stressHalves`
// reads, so each per-half Sharpe matches the stress readout exactly — with a
// per-half Lo (2002) standard error and 95% interval, plus the second-minus-
// first difference with its combined SE. Descriptive, deliberately NOT a test:
// the halves are serially dependent, so the i.i.d. intervals understate the
// honest uncertainty (the DSR's cluster-robust SE beside it is the honest
// one), and the G5 `decay` knob stays a human attestation. This is the
// evidence the attestation reads: whether the second half sits below the
// first, and by how much with what (understated) precision.
export function sleeveFirstLast({ net } = {}) {
    const fail = (reason) => ({ available: false, reason, first: null, second: null, diff: null, seDiff: null, ciLow: null, ciHigh: null });
    if (!Array.isArray(net)) return fail('the book series is not an array');
    if (net.length < 4) return fail(`the book has ${net.length} bars — fewer than two bars per half`);
    for (const v of net) if (!Number.isFinite(v)) return fail('the scored book series is not finite');
    const h = Math.floor(net.length / 2);
    const half = (a) => {
        const perBarSharpe = sharpeRatio(a, { periodsPerYear: 1 });
        const sk = skewness(a);
        const ku = kurtosis(a);
        const se = sharpeStandardError({ sharpe: perBarSharpe, n: a.length, skew: sk, kurtosis: ku });
        if (!Number.isFinite(perBarSharpe) || !Number.isFinite(se)) return null;
        return {
            n: a.length, perBarSharpe, skew: sk, kurtosis: ku, se,
            ciLow: perBarSharpe - 1.96 * se, ciHigh: perBarSharpe + 1.96 * se,
        };
    };
    const first = half(net.slice(0, h));
    const second = half(net.slice(h));
    if (!first || !second) return fail('a half-book Sharpe interval is not finite');
    const diff = second.perBarSharpe - first.perBarSharpe;
    const seDiff = Math.sqrt(first.se * first.se + second.se * second.se);
    if (!Number.isFinite(seDiff)) return fail('the half-difference standard error is not finite');
    return {
        available: true, first, second, diff, seDiff,
        ciLow: diff - 1.96 * seDiff, ciHigh: diff + 1.96 * seDiff, reason: null,
    };
}

// The JSON-safe projection of a `sleeveFirstLast` result for the report artifact.
export function firstLastReport(f) {
    if (!f || f.available !== true) {
        return { available: false, first: null, second: null, diff: null, seDiff: null, ciLow: null, ciHigh: null, reason: (f && f.reason) || 'unscored' };
    }
    const proj = (x) => ({ n: x.n, perBarSharpe: x.perBarSharpe, se: x.se, ciLow: x.ciLow, ciHigh: x.ciHigh });
    return {
        available: true, first: proj(f.first), second: proj(f.second),
        diff: f.diff, seDiff: f.seDiff, ciLow: f.ciLow, ciHigh: f.ciHigh, reason: null,
    };
}

// The JSON-safe projection of a `sleeveDsr` result for the report artifact.
export function dsrReport(d) {
    if (!d || d.available !== true) {
        return { available: false, trials: SLEEVE_DSR_TRIALS, dsrAdjusted: null, reason: (d && d.reason) || 'unscored' };
    }
    return {
        available: true, trials: d.trials, mode: d.mode,
        dsrAdjusted: d.dsrAdjusted, dsrFullSample: d.dsrFullSample,
        designEffect: d.designEffect, effectiveBars: d.effectiveBars, bars: d.bars,
        clusters: d.clusters, seCluster: d.seCluster, seIid: d.seIid,
        perBarSharpe: d.perBarSharpe, reason: null,
    };
}

export function runSleeveReport({ sleeveId, fundingTexts, candleTexts, costBps = 4, gridMs = 28_800_000, barMs = 3_600_000, sizingTarget = null, sizingWindow = SIZED_SLEEVE_DEFAULTS.window } = {}) {
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
    const dsr = sleeveDsr({ net: scored.net });
    const g5 = scoreG5({
        net: scored.net, costBps, blocks: 6, dsrAdjusted: dsr.available ? dsr.dsrAdjusted : null,
        neutralSharpe: fn.neutral, decayDocumented: false, unseenData: false,
    });
    const rep = {
        sleeveId, available: true, costBps,
        streams: parsed.streams, buckets: parsed.buckets,
        nullBasisFraction: parsed.nullBasisFraction, markedFraction: parsed.markedFraction,
        netAnnual: scored.netSharpe * Math.sqrt(365 * 3),
        turnoverAnnual: scored.turnover * (365 * 3) / scored.net.length,
        breakEvenCostBps: scored.breakEvenCostBps,
        neutralAnnual: fn.neutral * Math.sqrt(365 * 3),
        rawAnnual: fn.raw * Math.sqrt(365 * 3),
        stress: scored.stress, worstBlock: scored.worstBlock,
        dsr: dsrReport(dsr),
        yearly: yearlyReport(sleeveYearly({ net: scored.net, times: view.times.slice(1) })),
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
                yearly: yearlyReport(sleeveYearly({ net: sized.net, times: view.times.slice(1) })),
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
    const lines = [
        `[sleeve] ${r.sleeveId} @${r.costBps}bps over ${r.buckets} buckets x ${r.streams} streams`,
        `  net ${f2(r.netAnnual)} / neutral ${f2(r.neutralAnnual)} (raw ${f2(r.rawAnnual)}), turnover ${f2(r.turnoverAnnual)}/yr, break-even ${f2(r.breakEvenCostBps)} bps`,
        `  null-basis ${(100 * r.nullBasisFraction).toFixed(2)}%, marked ${(100 * r.markedFraction).toFixed(1)}%`,
        `  ${dsrLine(r.dsr)}`,
        `  ${yearlyLine(r.yearly)}`,
        `  ${firstLastLine(r.firstLast)}`,
        `  G5 verdict ${r.g5verdict} (${r.g5reasons.join(',')})${attest.length ? ` — the operator run owns ${attest.join('/')}` : ''}`,
    ];
    if (r.sized) {
        lines.push(r.sized.available === true
            ? `  sized @${r.sized.target}/bar (w${r.sized.window}, bookVol ${r.sized.bookVolMean.toExponential(2)}): net ${f2(r.sized.netAnnual)} (base ${f2(r.sized.baseNetAnnual)}), turnover ${f2(r.sized.turnoverAnnual)}/yr, break-even ${f2(r.sized.breakEvenCostBps)} bps, skipped ${r.sized.skipped}/${r.sized.skipped + r.sized.scoredBars}; ${dsrLine(r.sized.dsr)}`
            : `  sized unavailable — ${r.sized.reason}`);
    }
    return lines.join('\n');
}

// The `--sleeve-sizing` composition (round 69): the scored sleeve book, sized
// through the vol-target risk plugin behind the driver seam.
//
// Sizing is a risk result (F-16/F-106/F-112/F-115): the vol forecast is a
// causal trailing RMS of the sleeve's own gross book (strictly-before-t, the
// e105 convention, default window 24 eight-hour bars); the TARGET is
// caller-supplied (a measurement the operator chooses per run, never banked —
// the plugin takes it as input for the same reason). Skipped bars (no history
// yet, dead vol) run flat — scale 0 on both the return and the weight row —
// so the re-score's turnover prices the exposure actually traded and
// `scoreBookReturns` keeps the gate's own arithmetic untouched. Open-loop
// vol-targeting is documented to spike turnover/leverage under estimation
// error (Devanathan et al. 2026, `voltarget2603`); the registered per-sleeve
// cap (4x) is the guard, and a feedback-control sizing rule is the recorded
// follow-up, not this round.
export const SIZED_SLEEVE_DEFAULTS = Object.freeze({ window: 24, ddCap: 0.05 });

export function trailingBookVol(gross, { window = SIZED_SLEEVE_DEFAULTS.window } = {}) {
    if (!Array.isArray(gross)) return null;
    const w = Number(window);
    if (!Number.isInteger(w) || !(w > 0)) throw new Error('trailingBookVol: window must be a positive integer');
    const out = new Array(gross.length);
    for (let t = 0; t < gross.length; t++) {
        let sumSq = 0;
        let n = 0;
        for (let k = Math.max(0, t - w); k < t; k++) {
            const r = gross[k];
            if (!Number.isFinite(r)) continue;
            sumSq += r * r;
            n++;
        }
        out[t] = n ? Math.sqrt(sumSq / n) : NaN;
    }
    return out;
}

// The pure `--sleeve-sizing` option parser (pinned by §P, called by the CLI):
// absent means the default unsized report (byte-identical path); present is a
// positive per-bar vol target, the string `adaptive` (any case) for the
// trailing-mean target (the F-115/F-117 convention: the target re-estimated
// causally at ≈ book vol, mean scale ≈ 1 — a scalar far above book vol just
// levers to the cap, F-116), or the string `drawdown` (any case) for the
// adaptive target closed through the drawdown governor below (F-118). The
// window defaults to 24.
export function parseSleeveSizing({ sizing, window } = {}) {
    if (sizing == null) return { sized: false, target: null, window: SIZED_SLEEVE_DEFAULTS.window };
    const w = window == null ? SIZED_SLEEVE_DEFAULTS.window : Number(window);
    if (!Number.isInteger(w) || !(w > 0)) {
        throw new Error(`analyze: --sleeve-sizing-window must be a positive integer (got "${String(window)}")`);
    }
    if (typeof sizing === 'string') {
        const mode = sizing.trim().toLowerCase();
        if (mode === 'adaptive' || mode === 'drawdown') return { sized: true, target: mode, window: w };
    }
    const target = Number(sizing);
    if (!Number.isFinite(target) || !(target > 0)) {
        throw new Error(`analyze: --sleeve-sizing needs a positive per-bar vol target, "adaptive" or "drawdown" (got "${String(sizing)}" — BUGS.md #69)`);
    }
    return { sized: true, target, window: w };
}

// The adaptive target series (round 70): the expanding causal mean of the
// vol forecast — targets[t] reads only vols[0..t], each of which reads only
// returns strictly before its bar, so the whole chain is causal. A bar with
// no finite-positive vol history yet carries NaN, which the plugin skips
// (never an infinite scale). This is the e105 convention with the lab's
// WARMUP span choice removed: the mean runs over every scored bar, not over
// bars past an arbitrary cutoff.
export function adaptiveTargets(vols) {
    if (!Array.isArray(vols)) return null;
    const out = new Array(vols.length);
    let sum = 0;
    let n = 0;
    for (let t = 0; t < vols.length; t++) {
        const v = vols[t];
        if (Number.isFinite(v) && v > 0) { sum += v; n++; }
        out[t] = n ? sum / n : NaN;
    }
    return out;
}

// The drawdown governor (round 73, F-118): the feedback-control follow-up the
// open-loop vol-targeting literature records (`voltarget2603`) — CLOSE the
// loop on the base book's own trailing drawdown instead of scaling blindly.
// `governor[t]` multiplies the adaptive target: 1 at (or above) the trailing
// peak, ramping linearly to 0 at a DDCAP drawdown, so a sagging book is
// progressively de-sized before the cap binds. Causal by construction (bar t
// reads only the equity compounded from bars strictly before t; pinned by a
// prefix-identity check). The 5% cap is pre-registered from the lab (the
// adaptive book's own DD is ~3%, the unsized ~8% — e108): the crash-brake
// frame is the cash-overlay V-shape brake (`cashoverlay2606`), and the
// restart variant stays lab-side until it is cost-accounted (`ddrestart2303`).
export function drawdownGovernor(returns, { cap = SIZED_SLEEVE_DEFAULTS.ddCap } = {}) {
    if (!Array.isArray(returns)) return null;
    const c = Number(cap);
    if (!Number.isFinite(c) || !(c > 0)) throw new Error('drawdownGovernor: cap must be a positive fraction');
    const out = new Array(returns.length);
    let eq = 1;
    let peak = 1;
    for (let t = 0; t < returns.length; t++) {
        const dd = peak > 0 ? (peak - eq) / peak : 0;
        out[t] = Math.min(1, Math.max(0, 1 - dd / c));
        const r = returns[t];
        if (Number.isFinite(r)) eq = eq * (1 + r);
        if (eq > peak) peak = eq;
    }
    return out;
}

export function scoreSleeveSized(sleeveId, view, { costBps = 0, target, window = SIZED_SLEEVE_DEFAULTS.window, panel = null } = {}) {
    const adaptive = target === 'adaptive';
    const drawdown = target === 'drawdown';
    const t = (adaptive || drawdown) ? NaN : Number(target);
    if (!adaptive && !drawdown && (!Number.isFinite(t) || !(t > 0))) {
        return { sleeveId, available: false, reason: 'sizing needs a positive per-bar vol target, "adaptive" or "drawdown"', costBps };
    }
    const base = scoreSleeve(sleeveId, view, { costBps });
    if (!base.available) return { ...base, sizing: null };
    const vols = trailingBookVol(base.gross, { window });
    const adapt = adaptiveTargets(vols);
    const gov = drawdown ? drawdownGovernor(base.gross) : null;
    const targets = adaptive ? adapt : drawdown ? adapt.map((a, i) => a * gov[i]) : t;
    const sized = volTargetRisk.sizingForSleeve(base.gross, vols, sleeveId, targets);
    if (!sized.available) return { sleeveId, available: false, reason: sized.reason, costBps };
    const byIndex = new Map(sized.index.map((bar, i) => [bar, sized.scales[i]]));
    const scales = base.gross.map((_, bar) => (byIndex.has(bar) ? byIndex.get(bar) : 0));
    const scaledGross = base.gross.map((r, bar) => scales[bar] * r);
    const scaledWeights = base.weightRows.map((row, bar) => row.map((w) => scales[bar] * w));
    const rescored = scoreBookReturns(scaledGross, scaledWeights, { costBps });
    if (!rescored) {
        return { sleeveId, available: false, reason: 'the sized sleeve book did not score', costBps };
    }
    const fn = Array.isArray(panel) && panel.length
        ? factorNeutralSharpe(rescored.net, panel)
        : { raw: rescored.netSharpe, neutral: NaN, residual: null };
    let bookVolSum = 0;
    for (const bar of sized.index) bookVolSum += vols[bar];
    return {
        sleeveId, available: true, costBps, target: adaptive ? 'adaptive' : drawdown ? 'drawdown' : t, window,
        baseNetSharpe: base.netSharpe, baseTurnover: base.turnover,
        baseBreakEvenCostBps: base.breakEvenCostBps,
        skipped: sized.skipped, scoredBars: sized.scored,
        bookVolMean: bookVolSum / sized.scored,
        gross: rescored.gross, net: rescored.net,
        grossSharpe: rescored.grossSharpe, netSharpe: rescored.netSharpe,
        turnover: rescored.turnover, turnoverPerYear: rescored.turnoverPerYear,
        breakEvenCostBps: rescored.breakEvenCostBps,
        rawSharpe: fn.raw, neutralSharpe: fn.neutral,
        panelStreams: Array.isArray(panel) ? panel.length : 0,
        stress: stressHalves(rescored.net), worstBlock: worstBlock(rescored.net),
    };
}
