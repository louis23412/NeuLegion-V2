// candle_quality.js
//
// Data-quality layer for the candle streams: detect and winsorize physically
// implausible intrabar wicks. `candle_fetcher.js` acquires data and
// `candles_audit.js` verifies structural invariants (OHLC consistency, monotonic
// timestamps, gaps); this module handles the one class of defect that is
// *structurally valid but economically impossible* — a single-bar print that is
// orders of magnitude away from the bar body.
//
// Motivation (real defect found in the shipped data): LINKUSDT 1h
// 2020-03-12T10:00 (the COVID "Black Thursday" flash crash) records
// `open 3.0634, high 3.0765, low 0.0001, close 2.4693` — a low 99.997% below
// the body. It satisfies every OHLC invariant, so a structural audit cannot
// see it, but it poisons ATR/range features for the following `period` bars (a
// ~30,000x true-range spike) and therefore the whole model's inputs. Venue
// glitches of this shape recur (flash prints, bad ticks, thin-order-book
// cascades), so the fix is a general, scale-free rule applied at consumption,
// not a hand-edit of one row.
//
// The rule is deliberately conservative and *winsorizing* rather than
// interpolating: an implausible wick is collapsed to the bar body extreme (the
// nearer of open/close), never replaced with an invented price level. Genuine
// extreme bars survive, because the threshold is a fraction of the bar's own
// body price — a real 40% cascade bar is untouched at the default threshold,
// while a 99.997% excursion is removed. The transform is idempotent, preserves
// every OHLC invariant, and never touches open/close/volume/timestamp.

// Fraction of the body price beyond which a wick is treated as implausible.
// Default 0.9 = "a wick may extend at most 90% of the body price beyond it".
// This is deliberately extreme so that only prints that are *physically*
// impossible are touched: a genuine large-range bar (a listing-day spike, a
// crash whose wick is 55% of the body, a 40% cascade) is left alone, while a
// near-total excursion to ~zero (the LINKUSDT 2020 flash print, a 99.997%
// wick) is collapsed. Lower it to clean more aggressively, raise it to be more
// permissive; audits report the count either way.
export const DEFAULT_MAX_WICK_FRACTION = 0.9;

// True when `low`/`high` break the wick budget for this bar. Pure, allocation-free.
export function isImplausibleCandle(candle, { maxWickFraction = DEFAULT_MAX_WICK_FRACTION } = {}) {
    if (!candle || typeof candle !== 'object') return false;
    const { open, high, low, close } = candle;
    if (![open, high, low, close].every((v) => typeof v === 'number' && Number.isFinite(v))) return false;
    const bodyMin = Math.min(open, close);
    const bodyMax = Math.max(open, close);
    if (low < bodyMin * (1 - maxWickFraction)) return true;
    if (high > bodyMax * (1 + maxWickFraction)) return true;
    return false;
}

// Returns a repaired copy `{ ...candle, low, high, repaired, repair }`, or the
// same object with `repaired: false` when nothing needed changing. Never mutates.
export function repairCandle(candle, { maxWickFraction = DEFAULT_MAX_WICK_FRACTION } = {}) {
    if (!candle || typeof candle !== 'object') return candle;
    const { open, high, low, close } = candle;
    if (![open, high, low, close].every((v) => typeof v === 'number' && Number.isFinite(v))) {
        return { ...candle, repaired: false };
    }
    const bodyMin = Math.min(open, close);
    const bodyMax = Math.max(open, close);
    let nextLow = low;
    let nextHigh = high;
    const repair = {};
    if (low < bodyMin * (1 - maxWickFraction)) { nextLow = bodyMin; repair.low = { from: low, to: nextLow }; }
    if (high > bodyMax * (1 + maxWickFraction)) { nextHigh = bodyMax; repair.high = { from: high, to: nextHigh }; }
    if (nextLow === low && nextHigh === high) return { ...candle, repaired: false };
    return { ...candle, low: nextLow, high: nextHigh, repaired: true, repair };
}

// Repairs a whole series; returns fresh candles plus a report. `candles` is not
// mutated. `repairs` lists every changed bar (timestamp + field + from/to) so a
// run can log exactly what was cleaned.
export function repairSeries(candles, { maxWickFraction = DEFAULT_MAX_WICK_FRACTION } = {}) {
    if (!Array.isArray(candles)) throw new Error('repairSeries: candles must be an array');
    const out = new Array(candles.length);
    const repairs = [];
    let repairedCount = 0;
    for (let i = 0; i < candles.length; i++) {
        const fixed = repairCandle(candles[i], { maxWickFraction });
        out[i] = fixed;
        if (fixed && fixed.repaired) {
            repairedCount++;
            repairs.push({ index: i, timestamp: candles[i].timestamp, ...fixed.repair });
        }
    }
    return { candles: out, repairedCount, repairs };
}

// Lists implausible bars without repairing them (for audits/reports).
export function findImplausibleWicks(candles, options = {}) {
    if (!Array.isArray(candles)) throw new Error('findImplausibleWicks: candles must be an array');
    const out = [];
    for (let i = 0; i < candles.length; i++) {
        if (isImplausibleCandle(candles[i], options)) out.push({ index: i, timestamp: candles[i].timestamp, candle: candles[i] });
    }
    return out;
}

// Normalizes a repaired candle back to the canonical shape used by the rest of
// the pipeline (drops the bookkeeping flags). Handy at the boundary where a
// caller wants plain candles back.
export function stripRepairFlags(candle) {
    if (!candle || typeof candle !== 'object') return candle;
    const { repaired, repair, ...rest } = candle;
    void repaired;
    void repair;
    return rest;
}
