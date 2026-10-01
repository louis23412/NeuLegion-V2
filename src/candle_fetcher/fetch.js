// src/candle_fetcher/fetch.js (round-100 split of src/candle_fetcher.js).
// HTTP with backoff plus forward pagination over [startTime, endTime).
import { normalizeCandle, dropUnclosed } from './candles.js';
import { DEFAULT_BACKFILL_START } from './intervals.js';
import { getSource, resolveSourceInterval } from './sources.js';
import { dedupeCandles } from './store.js';
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
