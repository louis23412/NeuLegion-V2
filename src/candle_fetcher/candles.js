// src/candle_fetcher/candles.js (round-100 split of src/candle_fetcher.js).
// Normalized-candle validation and the unclosed-bar guard.
// ---------------------------------------------------------------------------
// Numbers / timestamps
// ---------------------------------------------------------------------------

const numeric = (value) => {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed === '') return NaN;
        return Number(trimmed);
    }
    return NaN;
};

// Accepts epoch seconds, epoch milliseconds, or an ISO-8601 string and returns
// epoch milliseconds (NaN when unparseable). The 1e12 boundary separates
// seconds (1.7e9 today) from milliseconds (1.7e12 today) with room to spare
// until the year ~33658.
export function toEpochMs(value) {
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return NaN;
        return Math.abs(value) < 1e12 ? value * 1000 : value;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed === '') return NaN;
        if (/^-?\d+(\.\d+)?$/.test(trimmed)) return toEpochMs(Number(trimmed));
        const parsed = Date.parse(trimmed);
        return Number.isFinite(parsed) ? parsed : NaN;
    }
    return NaN;
}

// A normalized candle is `{ timestamp, open, high, low, close, volume }` with
// timestamp in epoch ms and every value a finite number. Returns null for
// anything that does not satisfy that (non-positive prices, negative volume,
// inverted high/low) so malformed exchange rows can never reach the legion.
export function normalizeCandle(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const timestamp = toEpochMs(raw.timestamp);
    const open = numeric(raw.open);
    const high = numeric(raw.high);
    const low = numeric(raw.low);
    const close = numeric(raw.close);
    const volume = numeric(raw.volume);
    if (![timestamp, open, high, low, close, volume].every(Number.isFinite)) return null;
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) return null;
    if (volume < 0) return null;
    if (high < low || high < open || high < close || low > open || low > close) return null;
    return { timestamp, open, high, low, close, volume };
}

export const isValidCandle = (candle) => normalizeCandle(candle) !== null;

// Drops candles whose period has not closed yet (`timestamp + intervalMs` is
// in the future). Every exchange emits a live, still-forming bar as its most
// recent row; feeding an unclosed bar into training would leak a partial
// return, so it is excluded by default.
export function dropUnclosed(candles, intervalMs, now = Date.now()) {
    return candles.filter((c) => c.timestamp + intervalMs <= now);
}
