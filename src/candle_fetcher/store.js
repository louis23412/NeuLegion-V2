// src/candle_fetcher/store.js (round-100 split of src/candle_fetcher.js).
// Merge/dedupe/gaps, JSONL serialization, and backfill planning.
import { normalizeCandle } from './candles.js';
import { intervalToMs } from './intervals.js';
// ---------------------------------------------------------------------------
// Merge / dedupe / gaps
// ---------------------------------------------------------------------------

export function dedupeCandles(candles) {
    const byTimestamp = new Map();
    for (const raw of candles) {
        const candle = normalizeCandle(raw);
        if (!candle) continue;
        byTimestamp.set(candle.timestamp, candle);
    }
    return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
}

// Merges an existing series with newly fetched candles. Later entries win for
// a given timestamp (so a corrected/re-fetched bar replaces the stored one).
export function mergeCandles(existing, incoming) {
    const byTimestamp = new Map();
    for (const raw of existing) {
        const candle = normalizeCandle(raw);
        if (candle) byTimestamp.set(candle.timestamp, candle);
    }
    for (const raw of incoming) {
        const candle = normalizeCandle(raw);
        if (candle) byTimestamp.set(candle.timestamp, candle);
    }
    return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
}

// Reports every missing bar in a series (exchange outages, listing gaps,
// pagination mistakes). `missing` is the number of absent candles between two
// adjacent stored ones; a well-formed single-symbol series returns [].
export function findGaps(candles, intervalMs, { maxGaps = Infinity } = {}) {
    const gaps = [];
    const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
    for (let i = 1; i < sorted.length; i++) {
        const delta = sorted[i].timestamp - sorted[i - 1].timestamp;
        if (delta > intervalMs) {
            gaps.push({
                from: sorted[i - 1].timestamp + intervalMs,
                to: sorted[i].timestamp,
                missing: Math.round(delta / intervalMs) - 1,
            });
            if (gaps.length >= maxGaps) break;
        }
    }
    return gaps;
}

export function summarizeCandles(candles, intervalMs = null) {
    if (!candles.length) return { count: 0 };
    const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const summary = {
        count: sorted.length,
        start: first.timestamp,
        end: last.timestamp,
        startIso: new Date(first.timestamp).toISOString(),
        endIso: new Date(last.timestamp).toISOString(),
        spanDays: (last.timestamp - first.timestamp) / 86_400_000,
        firstClose: first.close,
        lastClose: last.close,
        minLow: Infinity,
        maxHigh: -Infinity,
        totalVolume: 0,
    };
    for (const c of sorted) {
        if (c.low < summary.minLow) summary.minLow = c.low;
        if (c.high > summary.maxHigh) summary.maxHigh = c.high;
        summary.totalVolume += c.volume;
    }
    if (intervalMs) {
        const gaps = findGaps(sorted, intervalMs);
        summary.gaps = gaps.length;
        summary.missingCandles = gaps.reduce((acc, g) => acc + g.missing, 0);
    }
    return summary;
}

// ---------------------------------------------------------------------------
// JSONL serialization
// ---------------------------------------------------------------------------
//
// The on-disk stream is one JSON object per line. `timestampStyle` records how
// the file encodes time so an update never rewrites (and therefore never
// churns) the stored prefixes:
//   'iso'           ISO-8601 string      ("2024-01-01T00:00:00.000Z")
//   'epoch-ms'      integer milliseconds  (1704067200000)
//   'epoch-seconds' integer seconds       (1704067200)

export const TIMESTAMP_STYLES = Object.freeze(['iso', 'epoch-ms', 'epoch-seconds']);

export function formatCandle(candle, style = 'iso') {
    const { timestamp } = candle;
    let ts;
    if (style === 'epoch-seconds') ts = Math.floor(timestamp / 1000);
    else if (style === 'epoch-ms') ts = timestamp;
    else ts = new Date(timestamp).toISOString();
    return JSON.stringify({
        timestamp: ts,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
    });
}

export function serializeCandles(candles, style = 'iso') {
    return candles.map((c) => formatCandle(c, style)).join('\n');
}

// Line-at-a-time JSONL parse. Blank lines are skipped, unparseable lines are
// counted (never thrown) so a partially-written file still loads. The returned
// `style` is inferred from the *raw* first timestamp (before normalization
// collapses every encoding to epoch ms), which lets an update run rewrite the
// file in exactly the encoding it already used.
export function parseCandlesJsonl(text) {
    const candles = [];
    let invalid = 0;
    let blank = 0;
    let style = null;
    for (const line of String(text).split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') { blank++; continue; }
        let parsed;
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            invalid++; continue;
        }
        if (style === null && parsed && typeof parsed === 'object') style = timestampStyleOf(parsed.timestamp);
        const candle = normalizeCandle(parsed);
        if (candle) candles.push(candle);
        else invalid++;
    }
    return { candles: candles.sort((a, b) => a.timestamp - b.timestamp), invalid, blank, style: style ?? 'iso' };
}

// Classifies a raw timestamp value (as it appears in a file or exchange
// payload) as one of TIMESTAMP_STYLES.
export function timestampStyleOf(value) {
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return 'iso';
        return Math.abs(value) < 1e12 ? 'epoch-seconds' : 'epoch-ms';
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed !== '' && /^-?\d+(\.\d+)?$/.test(trimmed)) return timestampStyleOf(Number(trimmed));
    }
    return 'iso';
}

// Infers the timestamp encoding of a raw (not normalized) candle array.
export const detectTimestampStyle = (candles) =>
    timestampStyleOf(candles && candles.length ? candles[0].timestamp : undefined);

// ---------------------------------------------------------------------------
// Backfill planning
// ---------------------------------------------------------------------------

// Given what is already on disk and the interval, returns the window an update
// run should fetch: from the bar after the last stored one through now.
export function planUpdate(store, { interval, now = Date.now() } = {}) {
    const intervalMs = intervalToMs(interval);
    const candles = store.candles ?? [];
    if (candles.length === 0) return { startTime: 0, endTime: now, intervalMs, incremental: false };
    const last = candles[candles.length - 1].timestamp;
    return { startTime: last + intervalMs, endTime: now, intervalMs, incremental: true, lastStored: last };
}

export function planBackfill({ interval, startTime = 0, endTime = Date.now(), maxCandles = Infinity } = {}) {
    const intervalMs = intervalToMs(interval);
    const span = Math.max(0, endTime - startTime);
    const available = startTime > 0 ? Math.floor(span / intervalMs) + 1 : Infinity;
    return { intervalMs, startTime, endTime, maxCandles: Math.min(maxCandles, available) };
}
