// candle_fetcher.js
//
// Pure, dependency-free candle acquisition toolkit for NeuLegion.
//
// The legion trains off a JSONL candle stream (`CONFIG.file`, by default
// `src/candles.jsonl`). This module owns everything about *getting that data*
// that can be tested without a network:
//
//   * interval <-> milliseconds conversion,
//   * per-exchange symbol/interval mapping and URL construction,
//   * per-exchange response parsing into one normalized candle shape,
//     `{ timestamp, open, high, low, close, volume }` (timestamp = epoch ms),
//   * forward pagination over an arbitrary [startTime, endTime) window,
//   * merge/dedupe/sort against an existing file, gap detection, and
//     JSONL serialization that preserves the file's existing timestamp style.
//
// `src/fetch_candles.js` is the thin CLI shell: network + filesystem only.
// Everything here takes an injected `fetchFn`, so the full pagination and
// merge logic is exercised by the test suite against captured fixtures.
//
// Round-100 foundations split: the implementation lives in src/candle_fetcher/
// (five parts); this file carries the exact contract so every importer keeps
// working.
export { MINUTE, DEFAULT_BACKFILL_START, INTERVALS, intervalToMs, msToInterval } from './candle_fetcher/intervals.js';
export { toEpochMs, normalizeCandle, isValidCandle, dropUnclosed } from './candle_fetcher/candles.js';
export { SOURCES, SOURCE_NAMES, getSource, resolveSourceInterval } from './candle_fetcher/sources.js';
export { defaultSleep, httpJson, fetchCandles, fetchCandlesAuto } from './candle_fetcher/fetch.js';
export { dedupeCandles, mergeCandles, findGaps, summarizeCandles, TIMESTAMP_STYLES, formatCandle, serializeCandles, parseCandlesJsonl, timestampStyleOf, detectTimestampStyle, planUpdate, planBackfill } from './candle_fetcher/store.js';
