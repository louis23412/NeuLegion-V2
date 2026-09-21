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

// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Exchanges
// ---------------------------------------------------------------------------
//
// Each source descriptor is a frozen record:
//   maxLimit         max rows the endpoint returns per request
//   supportsRange    whether it honors start/end (kraken: no, latest window only)
//   normalizeSymbol  user symbol ('BTCUSDT') -> exchange symbol
//   toSourceInterval canonical ms -> exchange interval token (null if unsupported)
//   buildUrl         ({symbol, interval, startTime, endTime, limit}) -> URL
//   parse            response JSON -> ascending normalized candle array
//
// All `parse` functions are total: they return [] for unexpected shapes rather
// than throwing, so one bad page cannot abort a multi-hour backfill.

const binanceInterval = {
    60_000: '1m', 180_000: '3m', 300_000: '5m', 900_000: '15m', 1_800_000: '30m',
    3_600_000: '1h', 7_200_000: '2h', 14_400_000: '4h', 21_600_000: '6h',
    28_800_000: '8h', 43_200_000: '12h', 86_400_000: '1d', 259_200_000: '3d', 604_800_000: '1w',
};

const bybitInterval = {
    60_000: '1', 180_000: '3', 300_000: '5', 900_000: '15', 1_800_000: '30',
    3_600_000: '60', 7_200_000: '120', 14_400_000: '240', 21_600_000: '360',
    43_200_000: '720', 86_400_000: 'D', 604_800_000: 'W',
};

const coinbaseGranularity = {
    60_000: 60, 300_000: 300, 900_000: 900, 3_600_000: 3_600, 21_600_000: 21_600, 86_400_000: 86_400,
};

const krakenInterval = {
    60_000: 1, 300_000: 5, 900_000: 15, 1_800_000: 30, 3_600_000: 60,
    14_400_000: 240, 86_400_000: 1_440, 604_800_000: 10_080,
};

export const SOURCES = Object.freeze({
    binance: Object.freeze({
        name: 'binance',
        label: 'Binance public data (data-api.binance.vision)',
        maxLimit: 1000,
        supportsRange: true,
        normalizeSymbol: (symbol) => String(symbol).replace(/[-/_]/g, '').toUpperCase(),
        toSourceInterval: (ms) => binanceInterval[ms] ?? null,
        buildUrl: ({ symbol, interval, startTime, endTime, limit }) => {
            const params = new URLSearchParams({ symbol, interval, limit: String(limit) });
            if (Number.isFinite(startTime) && startTime > 0) params.set('startTime', String(startTime));
            if (Number.isFinite(endTime)) params.set('endTime', String(endTime));
            return `https://data-api.binance.vision/api/v3/klines?${params.toString()}`;
        },
        parse: (json) => {
            if (!Array.isArray(json)) return [];
            const out = [];
            for (const k of json) {
                if (!Array.isArray(k) || k.length < 6) continue;
                out.push({ timestamp: k[0], open: k[1], high: k[2], low: k[3], close: k[4], volume: k[5] });
            }
            return out.sort((a, b) => toEpochMs(a.timestamp) - toEpochMs(b.timestamp));
        },
    }),

    bybit: Object.freeze({
        name: 'bybit',
        label: 'Bybit v5 market kline',
        maxLimit: 1000,
        supportsRange: true,
        normalizeSymbol: (symbol) => String(symbol).replace(/[-/_]/g, '').toUpperCase(),
        toSourceInterval: (ms) => bybitInterval[ms] ?? null,
        buildUrl: ({ symbol, interval, startTime, endTime, limit }) => {
            const params = new URLSearchParams({
                category: 'spot', symbol, interval, limit: String(limit),
            });
            if (Number.isFinite(startTime) && startTime > 0) params.set('start', String(startTime));
            if (Number.isFinite(endTime)) params.set('end', String(endTime));
            return `https://api.bybit.com/v5/market/kline?${params.toString()}`;
        },
        parse: (json) => {
            const rows = json?.result?.list;
            if (!Array.isArray(rows)) return [];
            const out = [];
            for (const k of rows) {
                if (!Array.isArray(k) || k.length < 6) continue;
                out.push({ timestamp: k[0], open: k[1], high: k[2], low: k[3], close: k[4], volume: k[5] });
            }
            return out.sort((a, b) => toEpochMs(a.timestamp) - toEpochMs(b.timestamp));
        },
    }),

    coinbase: Object.freeze({
        name: 'coinbase',
        label: 'Coinbase Exchange candles',
        maxLimit: 300,
        supportsRange: true,
        normalizeSymbol: (symbol) => {
            const s = String(symbol).toUpperCase().replace(/[/_]/g, '-');
            if (s.includes('-')) return s;
            if (s.endsWith('USDT')) return `${s.slice(0, -4)}-USD`;
            if (s.endsWith('USD')) return `${s.slice(0, -3)}-USD`;
            return s;
        },
        toSourceInterval: (ms) => coinbaseGranularity[ms] ?? null,
        buildUrl: ({ symbol, interval, startTime, endTime, limit }) => {
            const params = new URLSearchParams({
                granularity: String(interval), limit: String(limit),
            });
            if (Number.isFinite(startTime) && startTime > 0) params.set('start', new Date(startTime).toISOString());
            if (Number.isFinite(endTime)) params.set('end', new Date(endTime).toISOString());
            return `https://api.exchange.coinbase.com/products/${symbol}/candles?${params.toString()}`;
        },
        parse: (json) => {
            if (!Array.isArray(json)) return [];
            const out = [];
            for (const k of json) {
                if (!Array.isArray(k) || k.length < 6) continue;
                out.push({ timestamp: k[0], open: k[3], high: k[2], low: k[1], close: k[4], volume: k[5] });
            }
            return out.sort((a, b) => toEpochMs(a.timestamp) - toEpochMs(b.timestamp));
        },
    }),

    kraken: Object.freeze({
        name: 'kraken',
        label: 'Kraken OHLC (latest window only)',
        maxLimit: 720,
        supportsRange: false,
        normalizeSymbol: (symbol) => {
            const s = String(symbol).toUpperCase().replace(/[-/_]/g, '');
            if (s.endsWith('USDT')) return `${s.slice(0, -4).replace('BTC', 'XBT')}USD`;
            return s.replace('BTC', 'XBT');
        },
        toSourceInterval: (ms) => krakenInterval[ms] ?? null,
        buildUrl: ({ symbol, interval }) => {
            const params = new URLSearchParams({ pair: symbol, interval: String(interval) });
            return `https://api.kraken.com/0/public/OHLC?${params.toString()}`;
        },
        parse: (json) => {
            const result = json?.result;
            if (!result || typeof result !== 'object') return [];
            const key = Object.keys(result).find((k) => Array.isArray(result[k]));
            if (!key) return [];
            const out = [];
            for (const k of result[key]) {
                if (!Array.isArray(k) || k.length < 7) continue;
                out.push({ timestamp: k[0], open: k[1], high: k[2], low: k[3], close: k[4], volume: k[6] });
            }
            return out.sort((a, b) => toEpochMs(a.timestamp) - toEpochMs(b.timestamp));
        },
    }),
});

export const SOURCE_NAMES = Object.freeze(Object.keys(SOURCES));

export function getSource(name) {
    const source = SOURCES[String(name).toLowerCase()];
    if (!source) throw new Error(`Unknown source "${name}" (expected one of: ${SOURCE_NAMES.join(', ')})`);
    return source;
}

// Resolves an interval string against a source, throwing a helpful error when
// the exchange simply does not publish that granularity (e.g. Coinbase only
// serves 1m/5m/15m/1h/6h/1d).
export function resolveSourceInterval(source, interval) {
    const ms = intervalToMs(interval);
    const token = source.toSourceInterval(ms);
    if (token === null || token === undefined) {
        throw new Error(`${source.name} does not support interval ${msToInterval(ms)}`);
    }
    return { ms, token };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Single JSON GET with exponential backoff. Retries on 429/5xx and on network
// errors; throws immediately on other 4xx (a bad symbol/interval is not going
// to fix itself). `fetchFn` is injectable so tests never touch the network.
export async function httpJson(url, {
    fetchFn = globalThis.fetch,
    retries = 4,
    baseDelayMs = 300,
    timeoutMs = 45_000,
    sleep = defaultSleep,
} = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        let timer = null;
        let retryable = true;
        try {
            const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
            if (controller) timer = setTimeout(() => controller.abort(), timeoutMs);
            const response = await fetchFn(url, controller ? { signal: controller.signal } : undefined);
            if (response && response.ok) return await response.json();

            const status = response ? response.status : 0;
            retryable = status === 429 || status === 418 || status >= 500;
            lastError = new Error(`HTTP ${status} for ${url}`);
        } catch (error) {
            lastError = error;
            retryable = true;
        } finally {
            if (timer) clearTimeout(timer);
        }

        if (!retryable) throw lastError;
        if (attempt < retries) await sleep(baseDelayMs * Math.pow(2, attempt));
    }
    throw lastError ?? new Error(`Request failed: ${url}`);
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

// Walks [startTime, endTime] forward in `maxLimit`-sized pages, normalizing
// and validating every row. `limit` caps the *total* number of candles
// returned (Infinity for a full backfill). Always returns ascending, unique,
// fully-closed candles.
//
// `startTime` semantics: 0 / omitted / non-finite means "from the earliest bar
// the exchange has" (DEFAULT_BACKFILL_START). Pass an explicit recent start
// (e.g. `Date.now() - 500 * intervalMs`) to request only the latest window —
// worth being explicit about, because an exchange asked for no start returns
// its *newest* page, so silently forwarding `0` would truncate a backfill.
export async function fetchCandles(sourceName, {
    symbol,
    interval,
    startTime = 0,
    endTime = Date.now(),
    limit = Infinity,
    fetchFn = globalThis.fetch,
    sleep = defaultSleep,
    pageDelayMs = 120,
    maxRequests = 100_000,
    retries = 4,
    dropUnclosedCandles = true,
    now = Date.now(),
    onPage = null,
} = {}) {
    const source = typeof sourceName === 'string' ? getSource(sourceName) : sourceName;
    const { ms: intervalMs, token: sourceInterval } = resolveSourceInterval(source, interval);
    const exchangeSymbol = source.normalizeSymbol(symbol);

    const collected = [];
    let requests = 0;
    const windowStart = Number.isFinite(startTime) && startTime > 0 ? startTime : DEFAULT_BACKFILL_START;

    if (!source.supportsRange) {
        requests++;
        const json = await httpJson(source.buildUrl({
            symbol: exchangeSymbol, interval: sourceInterval,
            startTime: windowStart, endTime, limit: source.maxLimit,
        }), { fetchFn, retries, sleep });
        for (const raw of source.parse(json)) {
            const candle = normalizeCandle(raw);
            if (candle) collected.push(candle);
        }
    } else {
        let cursor = windowStart;
        let guard = 0;
        while (requests < maxRequests && guard++ < maxRequests) {
            const pageLimit = Math.min(source.maxLimit, Math.max(1, limit - collected.length));
            const json = await httpJson(source.buildUrl({
                symbol: exchangeSymbol, interval: sourceInterval,
                startTime: cursor, endTime, limit: pageLimit,
            }), { fetchFn, retries, sleep });
            requests++;

            const page = [];
            for (const raw of source.parse(json)) {
                const candle = normalizeCandle(raw);
                if (!candle) continue;
                if (candle.timestamp < cursor) continue;
                if (candle.timestamp > endTime) continue;
                page.push(candle);
            }

            if (onPage) onPage({ page, index: requests, collected: collected.length });

            if (page.length === 0) break;

            for (const candle of page) collected.push(candle);
            if (collected.length >= limit) break;

            const last = page[page.length - 1].timestamp;
            const next = last + intervalMs;
            if (next <= cursor) break; // exchange stopped advancing
            cursor = next;
            if (cursor > endTime) break;
            if (page.length < pageLimit) break; // exhausted the available history
            await sleep(pageDelayMs);
        }
    }

    let candles = dedupeCandles(collected);
    if (dropUnclosedCandles) candles = dropUnclosed(candles, intervalMs, now);
    if (Number.isFinite(limit)) candles = candles.slice(0, limit);

    return {
        candles,
        source: source.name,
        symbol: exchangeSymbol,
        interval,
        intervalMs,
        requests,
        start: candles.length ? candles[0].timestamp : null,
        end: candles.length ? candles[candles.length - 1].timestamp : null,
    };
}

// Tries sources in order until one returns data. Used by the CLI so a blocked
// or rate-limited exchange falls through automatically.
export async function fetchCandlesAuto({
    sources = ['binance', 'bybit', 'coinbase'],
    onFallback = null,
    ...options
} = {}) {
    const failures = [];
    for (const name of sources) {
        try {
            const result = await fetchCandles(name, options);
            if (result.candles.length > 0 || name === sources[sources.length - 1]) {
                return { ...result, failures };
            }
            failures.push({ source: name, error: 'no candles returned' });
            if (onFallback) onFallback(name, 'no candles returned');
        } catch (error) {
            failures.push({ source: name, error: String(error && error.message || error) });
            if (onFallback) onFallback(name, failures[failures.length - 1].error);
        }
    }
    return { candles: [], source: null, failures };
}

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
