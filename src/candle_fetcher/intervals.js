// src/candle_fetcher/intervals.js (round-100 split of src/candle_fetcher.js).
// Interval <-> millisecond conversion.
// Intervals
// ---------------------------------------------------------------------------

const UNIT_MS = Object.freeze({
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
});

export const MINUTE = 60_000;

// Floor for a full backfill: the first bitcoin block timestamp, before any
// exchange existed. Passing a real start to the exchanges is important — with
// no `start` they return the *latest* window, not the earliest.
export const DEFAULT_BACKFILL_START = Date.parse('2009-01-03T00:00:00Z');

export const INTERVALS = Object.freeze({
    '1m': 60_000,
    '3m': 180_000,
    '5m': 300_000,
    '15m': 900_000,
    '30m': 1_800_000,
    '1h': 3_600_000,
    '2h': 7_200_000,
    '4h': 14_400_000,
    '6h': 21_600_000,
    '8h': 28_800_000,
    '12h': 43_200_000,
    '1d': 86_400_000,
    '3d': 259_200_000,
    '1w': 604_800_000,
});

// Parses '15m' / '4h' / '1d' / '1w' (case-insensitive) into milliseconds.
// A raw number is passed through (already milliseconds).
export function intervalToMs(interval) {
    if (typeof interval === 'number') {
        if (!Number.isFinite(interval) || interval <= 0) throw new Error(`Invalid interval: ${interval}`);
        return interval;
    }
    const match = /^(\d+)([mhdw])$/.exec(String(interval).trim().toLowerCase());
    if (!match) throw new Error(`Unsupported interval: ${interval}`);
    const n = Number(match[1]);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`Unsupported interval: ${interval}`);
    return n * UNIT_MS[match[2]];
}

// Inverse of intervalToMs, for canonical spellings ('1h'); falls back to the
// raw millisecond count when the duration has no canonical name.
export function msToInterval(ms) {
    for (const [name, value] of Object.entries(INTERVALS)) {
        if (value === ms) return name;
    }
    return `${ms}ms`;
}
