// Sleeve view builders + file-text parsers (round-81 split): carry view,
// marks/positioning inputs, OI panels. Pure, no I/O.
import { parseFundingJsonl } from '../analysis/carry.js';

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
// (the vendored `src/data/marks_8h.json` via `--carry-marks`); what is still
// missing stays null.
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

// The `--sleeve` run-mode core (round 44, W2 acceptance): file TEXTS in, the
// G2 report object out. Pure, no I/O, no RNG — the CLI (`analyze.js`) only
// reads the files and writes the report; everything scored lives here so the
// browser harness pins it.
//
// `fundingTexts[j]` / `candleTexts[j]` are the per-stream JSONL bodies,
// positionally matched (the P4 `--carry-files` / `--files` convention).
// Candle rows are `{timestamp, close}` with open-labelled bars, so closes are
// end-labelled by `barMs` (the RUNNER bar-label rule) before the exact-boundary
// read. `carry-dispersion` runs on shipped funding + spot; the positioning
// sleeves (`oi-change`, `toptrader-fade`) need the ext OI file (`oiText`,
// round 80) and land `available:false` naming it when it is missing, so a run
// report always says what ran and what did not.
// Shipped funding marks cover ~2023-10 on (CYCLE-005); without a substituted
// mark history the view is confined to the marked window — reported, not
// hidden, as `markedFraction`.
// The ext-marks file parser (round 78, TODO 95): the vendored `marks_8h.json`
// shape — `{scale, symbols: {sym: {t0, stepMs, v}}}` with prices stored at
// `v/scale` on the grid `t0 + i*stepMs` — projected to `{symbol: Map<gridMs,
// price>}`. Pure, no I/O: the CLI reads the file, like the funding texts.
// Fail-closed on anything that is not that shape, so a corrupt marks file can
// never silently score as unmarked.
export function parseMarksJson(text) {
    let raw;
    try { raw = JSON.parse(String(text)); } catch {
        throw new Error('parseMarksJson: the marks file is not valid JSON');
    }
    if (!raw || typeof raw !== 'object' || !raw.symbols || typeof raw.symbols !== 'object' || Array.isArray(raw.symbols)) {
        throw new Error('parseMarksJson: the marks file needs a {scale, symbols: {sym: {t0, stepMs, v}}} shape');
    }
    const scale = raw.scale == null ? 100 : Number(raw.scale);
    if (!Number.isFinite(scale) || !(scale > 0)) throw new Error('parseMarksJson: scale must be a positive number');
    const out = {};
    for (const [sym, s] of Object.entries(raw.symbols)) {
        if (!s || typeof s !== 'object' || !Number.isFinite(s.t0) || !Number.isFinite(s.stepMs) || !(s.stepMs > 0) || !Array.isArray(s.v)) {
            throw new Error(`parseMarksJson: symbol "${String(sym)}" needs {t0, stepMs, v[]}`);
        }
        const m = new Map();
        for (let i = 0; i < s.v.length; i++) {
            if (s.v[i] == null) continue;
            const p = Number(s.v[i]) / scale;
            if (Number.isFinite(p) && p > 0) m.set(s.t0 + i * s.stepMs, p);
        }
        out[String(sym)] = m;
    }
    return out;
}

export function parseSleeveInputs({ fundingTexts, candleTexts, gridMs = 28_800_000, barMs = 3_600_000, marks = null, symbols = null, oi = null } = {}) {
    if (!Array.isArray(fundingTexts) || !Array.isArray(candleTexts) ||
        !fundingTexts.length || fundingTexts.length !== candleTexts.length) {
        throw new Error('parseSleeveInputs: fundingTexts and candleTexts must be non-empty parallel arrays');
    }
    if (marks != null && (!Array.isArray(symbols) || symbols.length !== fundingTexts.length)) {
        throw new Error('parseSleeveInputs: marks need symbols (one per stream, positionally matched) to select each stream\'s mark map');
    }
    if (oi != null && (!Array.isArray(symbols) || symbols.length !== fundingTexts.length)) {
        throw new Error('parseSleeveInputs: oi needs symbols (one per stream, positionally matched) to select each stream\'s OI series');
    }
    const streams = fundingTexts.map((text, j) => {
        const { rows } = parseFundingJsonl(text);
        let markRows = 0;
        let substitutedRows = 0;
        let sub = null;
        if (marks != null) {
            const key = String(symbols[j]).toLowerCase();
            const hit = Object.keys(marks).find((k) => k.toLowerCase() === key);
            if (hit == null) throw new Error(`parseSleeveInputs: no mark map for symbol "${String(symbols[j])}" (stream ${j})`);
            sub = marks[hit];
        }
        for (const r of rows) {
            if (r.markPrice > 0) { markRows += 1; continue; }
            if (sub) {
                const m = sub.get(Math.floor(r.timestamp / gridMs) * gridMs);
                if (Number.isFinite(m) && m > 0) { r.markPrice = m; substitutedRows += 1; }
            }
        }
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
        return { fundingRows: rows, spotCloses: closes, markRows, substitutedRows, fundingRowsTotal: rows.length };
    });
    const view = buildCarrySleeveView({ streams, gridMs });
    const cells = view.buckets * view.streams;
    const nullBasis = view.basisPnl.flat().filter((x) => x === null).length;
    const markedRows = streams.reduce((a, s) => a + s.markRows, 0);
    const fundingRows = streams.reduce((a, s) => a + s.fundingRowsTotal, 0);
    const marksSubstituted = streams.reduce((a, s) => a + s.substitutedRows, 0);
    let oiCoverageOiVal = null;
    let oiCoverageTopLS = null;
    if (oi != null) {
        attachPositioningPanels({ view, streams, symbols, oi, gridMs });
        const total = view.buckets * view.oiValue.length;
        const nonNull = (rows) => rows.reduce((a, s) => a + s.filter((v) => v !== null).length, 0);
        oiCoverageOiVal = total ? nonNull(view.oiValue) / total : 1;
        oiCoverageTopLS = total ? nonNull(view.topLS) / total : 1;
    }
    return {
        view,
        streams: streams.length,
        buckets: view.buckets,
        nullBasisFraction: cells ? nullBasis / cells : 1,
        markedFraction: fundingRows ? markedRows / fundingRows : 0,
        marksApplied: marks != null,
        marksSubstituted,
        oiApplied: oi != null,
        oiCoverageOiVal,
        oiCoverageTopLS,
    };
}

// The positioning panels (round 80, TODO 110): the OI/toptrader sleeves read
// { oiValue, topLS, spotRet } on the SAME bucket grid as the carry view, so
// one parsed input scores every sleeve. `oiValue[j][i]` / `topLS[j][i]` are
// the per-symbol OI-notional / top-trader-ratio series aligned to
// `view.times` (exact grid keys, null where the harvest has no row — the
// sleeves mask nulls, never zero-fill); `spotRet[i][j]` is the exact-boundary
// spot return over (times[i-1], times[i]] (the `buildCarrySleeveView` spot
// rule: end-labelled closes read at exact bucket boundaries only, no
// carry-forward). Series are selected by case-insensitive symbol name, like
// marks. Pure, no I/O.
function attachPositioningPanels({ view, streams, symbols, oi, gridMs }) {
    const closeMaps = streams.map((s) => {
        const m = new Map();
        for (const c of (Array.isArray(s.spotCloses) ? s.spotCloses : [])) {
            const t = typeof c.timestamp === 'number' ? c.timestamp : Date.parse(c.timestamp);
            const close = Number(c.close);
            if (Number.isFinite(t) && Number.isFinite(close)) m.set(t, close);
        }
        return m;
    });
    view.oiValue = [];
    view.topLS = [];
    for (let j = 0; j < streams.length; j++) {
        const key = String(symbols[j]).toLowerCase();
        const hit = Object.keys(oi).find((k) => k.toLowerCase() === key);
        if (hit == null) throw new Error(`parseSleeveInputs: no OI series for symbol "${String(symbols[j])}" (stream ${j})`);
        const o = [];
        const l = [];
        for (const t of view.times) {
            o.push(oi[hit].oiVal.has(t) ? oi[hit].oiVal.get(t) : null);
            l.push(oi[hit].topLS.has(t) ? oi[hit].topLS.get(t) : null);
        }
        view.oiValue.push(o);
        view.topLS.push(l);
    }
    view.spotRet = view.times.map((t) => closeMaps.map((m) => {
        const s1 = m.get(t);
        const s0 = m.get(t - gridMs);
        return Number.isFinite(s0) && Number.isFinite(s1) && s0 > 0 ? s1 / s0 - 1 : null;
    }));
}

// The ext-OI file parser (round 80, TODO 110): the vendored `oi_8h.json`
// shape — `{symbols: {sym: {t0, stepMs, oiVal[], topLS[]}}}` with levels on
// the grid `t0 + i*stepMs` (`takerLS`/`oi` pass through unparsed: no sleeve
// reads them) — projected to `{symbol: {oiVal: Map<gridMs, level>,
// topLS: Map<gridMs, ratio>}}`. Pure, no I/O: the CLI reads the file, like
// the funding texts. Fail-closed on anything that is not that shape, and
// null/non-positive levels never enter a map, so a corrupt OI file can never
// silently score as positioned.
export function parseOiJson(text) {
    let raw;
    try { raw = JSON.parse(String(text)); } catch {
        throw new Error('parseOiJson: the OI file is not valid JSON');
    }
    if (!raw || typeof raw !== 'object' || !raw.symbols || typeof raw.symbols !== 'object' || Array.isArray(raw.symbols)) {
        throw new Error('parseOiJson: the OI file needs a {symbols: {sym: {t0, stepMs, oiVal[], topLS[]}}} shape');
    }
    const out = {};
    for (const [sym, s] of Object.entries(raw.symbols)) {
        if (!s || typeof s !== 'object' || !Number.isFinite(s.t0) || !Number.isFinite(s.stepMs) || !(s.stepMs > 0) ||
            !Array.isArray(s.oiVal) || !Array.isArray(s.topLS)) {
            throw new Error(`parseOiJson: symbol "${String(sym)}" needs {t0, stepMs, oiVal[], topLS[]}`);
        }
        const oiVal = new Map();
        const topLS = new Map();
        for (let i = 0; i < s.oiVal.length; i++) {
            const v = Number(s.oiVal[i]);
            if (Number.isFinite(v) && v > 0) oiVal.set(s.t0 + i * s.stepMs, v);
        }
        for (let i = 0; i < s.topLS.length; i++) {
            const v = Number(s.topLS[i]);
            if (Number.isFinite(v) && v > 0) topLS.set(s.t0 + i * s.stepMs, v);
        }
        out[String(sym)] = { oiVal, topLS };
    }
    return out;
}
