// src/candle_fetcher/sources.js (round-100 split of src/candle_fetcher.js).
// Per-exchange descriptors: symbol mapping, URL construction, response parsing.
import { toEpochMs } from './candles.js';
import { intervalToMs, msToInterval } from './intervals.js';
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
