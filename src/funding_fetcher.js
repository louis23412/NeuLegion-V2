// Perpetual-funding-rate acquisition (round 29 -> 30, P4).
//
// The candle fetcher (`candle_fetcher.js`) is built around kline endpoints: a
// `symbol`+`interval` request whose rows are OHLCV arrays, paginated by
// `lastTimestamp + intervalMs`. Binance's funding history is a *different* endpoint
// on a *different* host (USDⓈ-M futures: `fapi/v1/fundingRate`) returning one row per
// funding period with `{fundingTime, fundingRate, markPrice}` — no OHLCV, no
// `interval` token, and a pagination rule of `fundingTime + 1ms`. Folding it into
// `SOURCES` would have forced a fake kline shape on it and broken the interval
// machinery for every other source, so it lives here, sharing the house style
// (`httpJson` retry/backoff, injectable `fetchFn`, counted-invalid JSONL parse) and
// handing its rows to the SHIPPED audit/consumer: `analysis/carry.js`
// (`auditFundingSeries`, `carryOnBarGrid`, `carryPanelStream`).
//
// Why an explicit `startTime` matters: asked without one, the endpoint returns only
// the most recent ~500 periods, so a naive full-history request silently truncates.
// `fetchFundingRates` therefore always sends a cursor, starting from
// `startTime || DEFAULT_FUNDING_BACKFILL_START`.

import { httpJson, defaultSleep, toEpochMs, TIMESTAMP_STYLES } from './candle_fetcher.js';

export const FUNDING_MINUTE = 60_000;

// The 8h funding period; the audit tolerates 4h periods too (see carry.js).
export const FUNDING_PERIOD_MS = 28_800_000;

// Binance lists perpetuals from 2019-09 (BTCUSDT's first funding is 2019-09-10).
export const DEFAULT_FUNDING_BACKFILL_START = Date.parse('2019-09-01T00:00:00Z');

export const FUNDING_SOURCES = Object.freeze({
    // Binance USDⓈ-M perpetuals. The public endpoint needs no key and caps a page at
    // 1000 rows. `markPrice` is present on most rows (it is absent on a few early
    // ones) and is OPTIONAL: the carry sleeve uses only `fundingRate`.
    binance: Object.freeze({
        name: 'binance',
        label: 'Binance USDⓈ-M funding history (fapi.binance.com/fapi/v1/fundingRate)',
        host: 'https://fapi.binance.com',
        maxLimit: 1000,
        normalizeSymbol: (symbol) => String(symbol).replace(/[-/_]/g, '').toUpperCase(),
        buildUrl: ({ symbol, startTime, endTime, limit }) => {
            const params = new URLSearchParams({ symbol, limit: String(limit) });
            if (Number.isFinite(startTime) && startTime > 0) params.set('startTime', String(startTime));
            if (Number.isFinite(endTime)) params.set('endTime', String(endTime));
            return `https://fapi.binance.com/fapi/v1/fundingRate?${params.toString()}`;
        },
        parse: (json) => {
            if (!Array.isArray(json)) return [];
            const out = [];
            for (const row of json) {
                if (!row || typeof row !== 'object') continue;
                // `fundingTime` is epoch ms on the wire; `fundingRate`/`markPrice` are
                // strings.
                out.push({
                    timestamp: toEpochMs(row.fundingTime),
                    fundingRate: row.fundingRate,
                    markPrice: row.markPrice,
                });
            }
            return out;
        },
    }),
});

export const FUNDING_SOURCE_NAMES = Object.freeze(Object.keys(FUNDING_SOURCES));

export function getFundingSource(name) {
    const source = FUNDING_SOURCES[name];
    if (!source) throw new Error(`funding_fetcher: unknown source "${name}" (known: ${FUNDING_SOURCE_NAMES.join(', ')})`);
    return source;
}

// One raw row -> the canonical shape `analysis/carry.js` consumes, or null when the
// row cannot be used (a bad row is dropped so a partially-written page still loads).
export function normalizeFundingRow(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const timestamp = toEpochMs(raw.timestamp);
    if (!Number.isFinite(timestamp)) return null;
    const fundingRate = Number(raw.fundingRate);
    if (!Number.isFinite(fundingRate)) return null;
    const markPrice = raw.markPrice == null ? null : Number(raw.markPrice);
    return { timestamp, fundingRate, markPrice: Number.isFinite(markPrice) ? markPrice : null };
}

// Serializes rows as JSONL in the same encoding family the candle files use. The
// shipped funding files are ISO (`serializeFundingRates(rows)`); the style is
// explicit so an update run can preserve whatever encoding the file already has.
export function formatFundingRow(row, style = 'iso') {
    let ts;
    if (style === 'epoch-seconds') ts = Math.floor(row.timestamp / 1000);
    else if (style === 'epoch-ms') ts = row.timestamp;
    else ts = new Date(row.timestamp).toISOString();
    return JSON.stringify({
        timestamp: ts,
        fundingRate: row.fundingRate,
        ...(row.markPrice == null ? {} : { markPrice: row.markPrice }),
    });
}

export const serializeFundingRates = (rows, style = 'iso') => rows.map((r) => formatFundingRow(r, style)).join('\n');

// Walks [startTime, endTime] forward one funding period at a time. Always returns
// ascending, de-duplicated, fully-realized rows (a funding row is realized *at* its
// own timestamp, so `now` only drops rows dated in the future).
export async function fetchFundingRates(sourceName, {
    symbol,
    startTime = 0,
    endTime = Date.now(),
    limit = Infinity,
    fetchFn = globalThis.fetch,
    sleep = defaultSleep,
    pageDelayMs = 120,
    maxRequests = 100_000,
    retries = 4,
    now = Date.now(),
    onPage = null,
} = {}) {
    const source = typeof sourceName === 'string' ? getFundingSource(sourceName) : sourceName;
    if (!source || typeof source.buildUrl !== 'function') throw new Error('fetchFundingRates: a funding source is required');
    const exchangeSymbol = source.normalizeSymbol(symbol);
    const windowStart = Number.isFinite(startTime) && startTime > 0 ? startTime : DEFAULT_FUNDING_BACKFILL_START;

    const collected = [];
    const seen = new Set();
    let requests = 0;
    let cursor = windowStart;
    while (requests < maxRequests) {
        const pageLimit = Math.min(source.maxLimit, Math.max(1, limit - collected.length));
        const json = await httpJson(source.buildUrl({
            symbol: exchangeSymbol, startTime: cursor, endTime, limit: pageLimit,
        }), { fetchFn, retries, sleep });
        requests++;

        const page = [];
        for (const raw of source.parse(json)) {
            const row = normalizeFundingRow(raw);
            if (!row) continue;
            if (row.timestamp < cursor) continue;      // the endpoint is inclusive
            if (row.timestamp > endTime) continue;
            if (row.timestamp > now) continue;         // never store an unrealized period
            if (seen.has(row.timestamp)) continue;
            seen.add(row.timestamp);
            page.push(row);
        }
        page.sort((a, b) => a.timestamp - b.timestamp);
        if (onPage) onPage({ page, index: requests, collected: collected.length });

        if (page.length === 0) break;
        for (const row of page) collected.push(row);
        if (collected.length >= limit) break;

        // Advance past the last row: the endpoint's `startTime` is inclusive, so the
        // next request must start strictly after it or it would repeat the row.
        const next = page[page.length - 1].timestamp + 1;
        if (next <= cursor) break;                     // the exchange stopped advancing
        cursor = next;
        if (cursor > endTime) break;
        // NOTE (unlike the kline loop): a SHORT page is not treated as "history
        // exhausted" here. The funding endpoint's page size is a server-side cap, so a
        // short page can be a transient (and would otherwise silently truncate a
        // backfill); only an EMPTY page (or the endTime/cursor guards and `maxRequests`)
        // ends the walk.
        await sleep(pageDelayMs);
    }
    return collected;
}

// The `--fetch`-style convenience wrapper: one symbol, serialized JSONL.
export async function fetchFundingSeries(sourceName, symbol, options = {}) {
    const rows = await fetchFundingRates(sourceName, { ...options, symbol });
    return { symbol: String(symbol).toUpperCase(), rows, text: serializeFundingRates(rows, options.style || 'iso') };
}

export { TIMESTAMP_STYLES };
