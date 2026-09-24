// Candle-fetcher suite for NeuLegion, executed inside a browser Worker via
// test/browser/harness.js.
//
// `src/candle_fetcher.js` owns everything about acquiring the legion's candle
// stream except the network and filesystem: interval mapping, per-exchange
// symbol/interval translation, URL construction, response parsing, forward
// pagination over a time window, merge/dedupe/gap analysis and JSONL
// (de)serialization. Because every network call goes through an injected
// `fetchFn`, the whole pipeline is exercised here against synthetic exchange
// responses — including pagination, retry/backoff, descending exchange feeds
// and the unclosed-bar guard.

import {
    SOURCES,
    SOURCE_NAMES,
    INTERVALS,
    TIMESTAMP_STYLES,
    DEFAULT_BACKFILL_START,
    intervalToMs,
    msToInterval,
    toEpochMs,
    normalizeCandle,
    isValidCandle,
    dropUnclosed,
    getSource,
    resolveSourceInterval,
    httpJson,
    fetchCandles,
    fetchCandlesAuto,
    dedupeCandles,
    mergeCandles,
    findGaps,
    summarizeCandles,
    formatCandle,
    serializeCandles,
    parseCandlesJsonl,
    detectTimestampStyle,
    planUpdate,
    planBackfill,
} from '../../../src/candle_fetcher.js';
import { parseFundingJsonl } from '../../../src/analysis/carry.js';
import {
    normalizeFundingRow, serializeFundingRates, fetchFundingRates, getFundingSource,
    DEFAULT_FUNDING_BACKFILL_START, FUNDING_PERIOD_MS,
} from '../../../src/funding_fetcher.js';

const MIN = 60_000;
const T0 = Date.parse('2024-01-01T00:00:00Z');
const noSleep = async () => {};

// Deterministic OHLCV series used as the fake exchange's book of record.
function series(n, { start = T0, intervalMs = MIN, base = 100 } = {}) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const open = base + i * 0.5;
        const close = open + 0.25;
        out.push({
            timestamp: start + i * intervalMs,
            open,
            high: close + 0.5,
            low: open - 0.5,
            close,
            volume: 10 + i,
        });
    }
    return out;
}

// Mimics an exchange that honors startTime/endTime/limit and caps pages at
// `pageSize`, exactly like the real REST endpoints.
function pagedFetch(data, { pageSize = 1000, log = [] } = {}) {
    return async (url) => {
        log.push(url);
        const params = new URL(url).searchParams;
        const startTime = Number(params.get('startTime') || params.get('start') || 0);
        const endParam = params.get('endTime') || params.get('end');
        const endTime = endParam ? (Number.isFinite(Number(endParam)) ? Number(endParam) : Date.parse(endParam)) : Infinity;
        const limit = Number(params.get('limit') || 500);
        const page = data
            .filter((c) => c.timestamp >= startTime && c.timestamp <= endTime)
            .slice(0, Math.min(limit, pageSize));
        const body = page.map((c) => [
            c.timestamp, String(c.open), String(c.high), String(c.low), String(c.close), String(c.volume),
        ]);
        return { ok: true, status: 200, json: async () => body };
    };
}

const binanceBody = (candles) => candles.map((c) => [
    c.timestamp, String(c.open), String(c.high), String(c.low), String(c.close), String(c.volume),
]);

export async function run() {
    const checks = [];
    const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });

    // ---------------------------------------------------------------- intervals
    check('intervalToMs canonical values',
        intervalToMs('1m') === 60_000 && intervalToMs('1h') === 3_600_000 &&
        intervalToMs('4h') === 14_400_000 && intervalToMs('1d') === 86_400_000 &&
        intervalToMs('1w') === 604_800_000,
        `${intervalToMs('1m')},${intervalToMs('1h')},${intervalToMs('4h')},${intervalToMs('1d')},${intervalToMs('1w')}`);
    check('intervalToMs is case-insensitive and trims', intervalToMs(' 15M ') === 900_000, String(intervalToMs(' 15M ')));
    check('intervalToMs passes numbers through', intervalToMs(120_000) === 120_000);
    check('intervalToMs rejects garbage',
        (() => { try { intervalToMs('1y'); return false; } catch { return true; } })() &&
        (() => { try { intervalToMs(''); return false; } catch { return true; } })() &&
        (() => { try { intervalToMs(0); return false; } catch { return true; } })());
    check('msToInterval rounds-trips every canonical interval',
        Object.entries(INTERVALS).every(([name, ms]) => msToInterval(ms) === name));
    check('msToInterval falls back for odd durations', msToInterval(120_000) === '120000ms', msToInterval(120_000));

    // ------------------------------------------------------------- timestamps
    check('toEpochMs: epoch seconds', toEpochMs(1_704_067_200) === 1_704_067_200_000);
    check('toEpochMs: epoch milliseconds', toEpochMs(1_704_067_200_000) === 1_704_067_200_000);
    check('toEpochMs: ISO string', toEpochMs('2024-01-01T00:00:00.000Z') === 1_704_067_200_000);
    check('toEpochMs: numeric string treated as epoch', toEpochMs('1704067200') === 1_704_067_200_000);
    check('toEpochMs: blank/garbage -> NaN',
        Number.isNaN(toEpochMs('')) && Number.isNaN(toEpochMs('   ')) && Number.isNaN(toEpochMs(null)) &&
        Number.isNaN(toEpochMs('not-a-date')) && Number.isNaN(toEpochMs(NaN)));

    // ---------------------------------------------------------------- candles
    const good = { timestamp: T0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 };
    check('normalizeCandle accepts a well-formed candle', isValidCandle(good));
    check('normalizeCandle coerces string numbers',
        normalizeCandle({ timestamp: String(T0), open: '1', high: '2', low: '0.5', close: '1.5', volume: '3' }).close === 1.5);
    check('normalizeCandle rejects inverted high/low', normalizeCandle({ ...good, high: 0.4 }) === null);
    check('normalizeCandle rejects high below body', normalizeCandle({ ...good, high: 1.2 }) === null);
    check('normalizeCandle rejects non-positive prices', normalizeCandle({ ...good, low: 0, open: 0 }) === null);
    check('normalizeCandle rejects negative volume', normalizeCandle({ ...good, volume: -1 }) === null);
    check('normalizeCandle rejects missing fields',
        normalizeCandle({ timestamp: T0, open: 1 }) === null && normalizeCandle(null) === null);
    check('normalizeCandle rejects non-finite timestamps', normalizeCandle({ ...good, timestamp: '' }) === null);

    check('dropUnclosed removes the forming bar',
        dropUnclosed(series(20), MIN, T0 + 10 * MIN + 1).length === 10,
        String(dropUnclosed(series(20), MIN, T0 + 10 * MIN + 1).length));
    check('dropUnclosed keeps exactly-closed bars',
        dropUnclosed(series(20), MIN, T0 + 9 * MIN + MIN).length === 10);

    // ---------------------------------------------------------------- exchanges
    check('exactly four sources registered',
        SOURCE_NAMES.length === 4 && SOURCE_NAMES.every((n) => SOURCES[n].name === n), SOURCE_NAMES.join(','));
    check('getSource throws on unknown source', (() => { try { getSource('ftx'); return false; } catch { return true; } })());

    check('binance symbol normalization',
        SOURCES.binance.normalizeSymbol('btc-usdt') === 'BTCUSDT' &&
        SOURCES.binance.normalizeSymbol('ETH/USDT') === 'ETHUSDT');
    check('coinbase symbol normalization',
        SOURCES.coinbase.normalizeSymbol('BTCUSDT') === 'BTC-USD' &&
        SOURCES.coinbase.normalizeSymbol('ETHUSDT') === 'ETH-USD' &&
        SOURCES.coinbase.normalizeSymbol('BTC-USD') === 'BTC-USD');
    check('kraken symbol normalization',
        SOURCES.kraken.normalizeSymbol('BTCUSDT') === 'XBTUSD' && SOURCES.kraken.normalizeSymbol('ETHUSDT') === 'ETHUSD');

    check('binance url carries symbol/interval/limit/startTime',
        (() => {
            const url = SOURCES.binance.buildUrl({ symbol: 'BTCUSDT', interval: '1h', startTime: 1, endTime: 2, limit: 1000 });
            const p = new URL(url).searchParams;
            return p.get('symbol') === 'BTCUSDT' && p.get('interval') === '1h' && p.get('limit') === '1000' &&
                p.get('startTime') === '1' && p.get('endTime') === '2';
        })());
    check('coinbase url encodes start/end as ISO and granularity in seconds',
        (() => {
            const url = SOURCES.coinbase.buildUrl({ symbol: 'BTC-USD', interval: 3600, startTime: T0, endTime: T0 + 3600_000, limit: 300 });
            const p = new URL(url).searchParams;
            return p.get('granularity') === '3600' && p.get('start') === new Date(T0).toISOString();
        })());
    check('bybit url uses start/end millisecond params',
        (() => {
            const p = new URL(SOURCES.bybit.buildUrl({ symbol: 'BTCUSDT', interval: '60', startTime: 5, endTime: 9, limit: 1000 })).searchParams;
            return p.get('category') === 'spot' && p.get('start') === '5' && p.get('end') === '9' && p.get('interval') === '60';
        })());

    check('resolveSourceInterval maps to exchange tokens',
        resolveSourceInterval(SOURCES.binance, '1h').token === '1h' &&
        resolveSourceInterval(SOURCES.bybit, '1h').token === '60' &&
        resolveSourceInterval(SOURCES.coinbase, '1h').token === 3600 &&
        resolveSourceInterval(SOURCES.kraken, '1h').token === 60,
        JSON.stringify([SOURCES.binance.toSourceInterval(3_600_000), SOURCES.bybit.toSourceInterval(3_600_000)]));
    check('resolveSourceInterval reports unsupported granularity',
        (() => { try { resolveSourceInterval(SOURCES.coinbase, '2h'); return false; } catch (e) { return /does not support/.test(e.message); } })());
    check('resolveSourceInterval returns the interval in ms',
        resolveSourceInterval(SOURCES.binance, '4h').ms === 14_400_000);

    // Parser fixtures, shaped exactly like the live responses captured from
    // each exchange (binance/bybit ascending-ish, coinbase/kraken descending).
    // Parsers emit the raw exchange strings; `normalizeCandle` is what coerces
    // them to numbers, so the field-order checks read through Number().
    const bnc = SOURCES.binance.parse([[T0, '1.0', '2.0', '0.5', '1.5', '7.0', 0, 0, 0, 0, 0, 0]]);
    check('binance parser field order', bnc.length === 1 && Number(bnc[0].open) === 1 && Number(bnc[0].high) === 2 && Number(bnc[0].low) === 0.5 && Number(bnc[0].close) === 1.5 && Number(bnc[0].volume) === 7,
        JSON.stringify(bnc[0]));
    const bnb = SOURCES.binance.parse('nonsense');
    check('binance parser is total (bad shape -> [])', Array.isArray(bnb) && bnb.length === 0);

    const byb = SOURCES.bybit.parse({ result: { list: [[T0 + MIN, '1.0', '2.0', '0.5', '1.5', '7.0', '9'], [T0, '1.0', '2.0', '0.5', '1.5', '7.0', '9']] } });
    check('bybit parser reads result.list and sorts ascending',
        byb.length === 2 && byb[0].timestamp === T0 && byb[1].timestamp === T0 + MIN);
    check('bybit parser is total', SOURCES.bybit.parse({}).length === 0 && SOURCES.bybit.parse(null).length === 0);

    const cbb = SOURCES.coinbase.parse([[T0 / 1000, 0.5, 2.0, 1.0, 1.5, 7.0]]);
    check('coinbase parser field order (time,low,high,open,close,volume)',
        cbb.length === 1 && cbb[0].timestamp === T0 / 1000 && Number(cbb[0].open) === 1 && Number(cbb[0].high) === 2 && Number(cbb[0].low) === 0.5 && Number(cbb[0].close) === 1.5,
        JSON.stringify(cbb[0]));
    check('coinbase parser is total', SOURCES.coinbase.parse({ nope: 1 }).length === 0);

    const krk = SOURCES.kraken.parse({ error: [], result: { XXBTZUSD: [[T0 / 1000, '1.0', '2.0', '0.5', '1.5', '1.4', '7.0', 12]] } });
    check('kraken parser reads volume from index 6',
        krk.length === 1 && Number(krk[0].volume) === 7 && krk[0].timestamp === T0 / 1000 && Number(krk[0].close) === 1.5,
        JSON.stringify(krk[0]));
    check('kraken parser is total', SOURCES.kraken.parse({ error: [] }).length === 0);

    // ------------------------------------------------------------------ httpJson
    {
        let attempts = 0;
        const fn = async () => {
            attempts++;
            if (attempts < 3) return { ok: false, status: 500, json: async () => ({}) };
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
        };
        const out = await httpJson('http://x', { fetchFn: fn, sleep: noSleep, baseDelayMs: 1 });
        check('httpJson retries 5xx then succeeds', attempts === 3 && out.ok === true, `attempts=${attempts}`);
    }
    {
        let attempts = 0;
        const fn = async () => { attempts++; return { ok: false, status: 429, json: async () => ({}) }; };
        let threw = false;
        try { await httpJson('http://x', { fetchFn: fn, sleep: noSleep, baseDelayMs: 1, retries: 2 }); } catch { threw = true; }
        check('httpJson gives up after retries on persistent 429', threw && attempts === 3, `attempts=${attempts}`);
    }
    {
        let attempts = 0;
        const fn = async () => { attempts++; return { ok: false, status: 400, json: async () => ({}) }; };
        let threw = false;
        try { await httpJson('http://x', { fetchFn: fn, sleep: noSleep, baseDelayMs: 1, retries: 5 }); } catch { threw = true; }
        check('httpJson fails fast on non-retryable 4xx', threw && attempts === 1, `attempts=${attempts}`);
    }
    {
        let attempts = 0;
        const fn = async () => { attempts++; if (attempts === 1) throw new Error('socket'); return { ok: true, status: 200, json: async () => [1] }; };
        const out = await httpJson('http://x', { fetchFn: fn, sleep: noSleep, baseDelayMs: 1 });
        check('httpJson retries network errors', attempts === 2 && out[0] === 1);
    }

    // ------------------------------------------------------------- pagination
    {
        const data = series(2500);
        const log = [];
        const result = await fetchCandles('binance', {
            symbol: 'BTCUSDT', interval: '1m',
            startTime: data[0].timestamp, endTime: data[2499].timestamp + MIN,
            fetchFn: pagedFetch(data, { log }), sleep: noSleep, pageDelayMs: 0,
            now: data[2499].timestamp + 2 * MIN,
        });
        check('pagination walks every page', result.candles.length === 2500, String(result.candles.length));
        check('pagination issues one request per page', result.requests === 3, String(result.requests));
        check('pagination results are ascending and unique',
            result.candles.every((c, i) => i === 0 || c.timestamp > result.candles[i - 1].timestamp));
        check('pagination reports the fetched range',
            result.start === data[0].timestamp && result.end === data[2499].timestamp);
        check('pagination sends startTime on subsequent pages',
            /startTime=/.test(log[1]) && log.length === 3, String(log.length));
    }
    {
        const data = series(2500);
        const result = await fetchCandles('binance', {
            symbol: 'BTCUSDT', interval: '1m',
            startTime: data[0].timestamp, endTime: data[2499].timestamp + MIN,
            limit: 1500,
            fetchFn: pagedFetch(data), sleep: noSleep, pageDelayMs: 0,
            now: data[2499].timestamp + 2 * MIN,
        });
        check('limit caps total candles', result.candles.length === 1500, String(result.candles.length));
        check('limit shrinks the final page request', result.requests === 2, String(result.requests));
        check('limit keeps the earliest candles', result.candles[0].timestamp === data[0].timestamp);
    }
    {
        const data = series(100);
        const result = await fetchCandles('binance', {
            symbol: 'BTCUSDT', interval: '1m',
            startTime: data[0].timestamp, endTime: data[0].timestamp + 9 * MIN,
            fetchFn: pagedFetch(data), sleep: noSleep, pageDelayMs: 0,
            now: data[99].timestamp + 2 * MIN,
        });
        check('endTime is inclusive and clamps the window', result.candles.length === 10, String(result.candles.length));
        check('endTime drops later candles', result.candles[result.candles.length - 1].timestamp === data[9].timestamp);
    }
    {
        const data = series(10);
        const result = await fetchCandles('binance', {
            symbol: 'BTCUSDT', interval: '1m', startTime: data[0].timestamp, endTime: data[9].timestamp,
            fetchFn: pagedFetch(data), sleep: noSleep, pageDelayMs: 0,
            now: data[3].timestamp + MIN + 1,
        });
        check('unclosed bars are dropped by default', result.candles.length === 4, String(result.candles.length));
        const kept = await fetchCandles('binance', {
            symbol: 'BTCUSDT', interval: '1m', startTime: data[0].timestamp, endTime: data[9].timestamp,
            fetchFn: pagedFetch(data), sleep: noSleep, pageDelayMs: 0, dropUnclosedCandles: false,
        });
        check('dropUnclosedCandles:false keeps every bar', kept.candles.length === 10, String(kept.candles.length));
    }
    {
        // A page that is exactly full then exhausted must terminate.
        const data = series(1200);
        const result = await fetchCandles('binance', {
            symbol: 'BTCUSDT', interval: '1m', startTime: data[0].timestamp, endTime: data[1199].timestamp + MIN,
            fetchFn: pagedFetch(data), sleep: noSleep, pageDelayMs: 0, now: data[1199].timestamp + 2 * MIN,
        });
        check('an exhausted series terminates cleanly', result.candles.length === 1200 && result.requests === 2,
            `${result.candles.length}/${result.requests}`);
    }
    {
        // Regression: an omitted startTime must mean "from the earliest bar",
        // not "the exchange's newest page" (which silently truncates a
        // backfill to a single page).
        const data = series(1200);
        const log = [];
        const result = await fetchCandles('binance', {
            symbol: 'BTCUSDT', interval: '1m', endTime: data[1199].timestamp + MIN, limit: 1300,
            fetchFn: pagedFetch(data, { log }), sleep: noSleep, pageDelayMs: 0, now: data[1199].timestamp + 2 * MIN,
        });
        check('omitted startTime backfills from the earliest bar',
            result.candles.length === 1200 && result.requests === 2 &&
            new URL(log[0]).searchParams.get('startTime') === String(DEFAULT_BACKFILL_START),
            `${result.candles.length}/${result.requests}/${new URL(log[0]).searchParams.get('startTime')}`);
        check('omitted startTime fetches the whole series, not just the newest page',
            result.candles[0].timestamp === data[0].timestamp);
    }
    {
        const log = [];
        const fn = async (url) => {
            log.push(url);
            const p = new URL(url).searchParams;
            const limit = Number(p.get('limit'));
            const start = Number(p.get('start') || 0);
            const page = series(Math.min(limit, 1000), { start: Math.max(start, T0) });
            return { ok: true, status: 200, json: async () => ({ result: { list: page.map((c) => [c.timestamp, c.open, c.high, c.low, c.close, c.volume, 0]).reverse() } }) };
        };
        const result = await fetchCandles('bybit', {
            symbol: 'BTCUSDT', interval: '1m', startTime: T0, endTime: T0 + 999 * MIN,
            fetchFn: fn, sleep: noSleep, pageDelayMs: 0, now: T0 + 999 * MIN + 2 * MIN,
        });
        check('descending exchange feed is normalized to ascending',
            result.candles.length === 1000 && result.candles.every((c, i) => i === 0 || c.timestamp > result.candles[i - 1].timestamp),
            String(result.candles.length));
        check('descending feed maps to the bybit endpoint', /api\.bybit\.com/.test(log[0]));
    }
    {
        const data = series(50);
        const fn = async () => ({
            ok: true, status: 200,
            json: async () => ({ error: [], result: { XXBTZUSD: data.map((c) => [c.timestamp / 1000, String(c.open), String(c.high), String(c.low), String(c.close), '0', String(c.volume), 1]) } }),
        });
        const result = await fetchCandles('kraken', {
            symbol: 'BTCUSDT', interval: '1m', fetchFn: fn, sleep: noSleep,
            now: data[49].timestamp + 2 * MIN,
        });
        check('non-ranged source fetches a single window', result.requests === 1 && result.candles.length === 50,
            `${result.requests}/${result.candles.length}`);
    }
    {
        const data = series(5);
        const result = await fetchCandles('binance', {
            symbol: 'BTCUSDT', interval: '1m', startTime: data[0].timestamp, endTime: data[4].timestamp + MIN,
            fetchFn: async () => ({ ok: true, status: 200, json: async () => [] }),
            sleep: noSleep, pageDelayMs: 0, now: data[4].timestamp + 2 * MIN,
        });
        check('an empty response yields an empty result (no throw)', result.candles.length === 0 && result.start === null);
    }
    {
        const data = series(30);
        const result = await fetchCandles('binance', {
            symbol: 'BTCUSDT', interval: '1m', startTime: data[0].timestamp, endTime: data[29].timestamp + MIN,
            fetchFn: async () => ({ ok: true, status: 200, json: async () => binanceBody(data) }),
            sleep: noSleep, pageDelayMs: 0, now: data[29].timestamp + 2 * MIN,
        });
        check('result echoes source/symbol/interval metadata',
            result.source === 'binance' && result.symbol === 'BTCUSDT' && result.intervalMs === MIN,
            JSON.stringify({ s: result.source, sym: result.symbol }));
    }
    {
        const data = series(20);
        const pages = [];
        await fetchCandles('binance', {
            symbol: 'BTCUSDT', interval: '1m', startTime: data[0].timestamp, endTime: data[19].timestamp + MIN,
            fetchFn: pagedFetch(data), sleep: noSleep, pageDelayMs: 0, now: data[19].timestamp + 2 * MIN,
            onPage: (info) => pages.push(info),
        });
        check('onPage reports each page', pages.length === 1 && pages[0].page.length === 20 && pages[0].index === 1);
    }

    // ------------------------------------------------------------ auto fallback
    {
        const data = series(5);
        const fn = async (url) => {
            if (/binance/.test(url)) return { ok: false, status: 403, json: async () => ({}) };
            return { ok: true, status: 200, json: async () => ({ result: { list: data.map((c) => [c.timestamp, c.open, c.high, c.low, c.close, c.volume, 0]) } }) };
        };
        const result = await fetchCandlesAuto({
            sources: ['binance', 'bybit'], symbol: 'BTCUSDT', interval: '1m',
            startTime: data[0].timestamp, endTime: data[4].timestamp + MIN,
            fetchFn: fn, sleep: noSleep, now: data[4].timestamp + 2 * MIN,
        });
        check('auto falls through to the next source', result.source === 'bybit' && result.candles.length === 5,
            `${result.source}/${result.candles.length}`);
        check('auto records the failed sources', result.failures.length === 1 && result.failures[0].source === 'binance',
            JSON.stringify(result.failures));
    }

    // ----------------------------------------------------------- merge / gaps
    {
        const a = series(3);
        // A valid replacement bar at a[2]'s timestamp (different close) to prove
        // the incoming value wins the dedupe.
        const variant = { ...a[2], open: a[2].open, close: a[2].open, high: a[2].open + 0.5, low: a[2].open - 0.5 };
        const fresh = series(1, { start: a[2].timestamp + MIN })[0];
        const merged = mergeCandles(a, [variant, fresh]);
        check('merge dedupes by timestamp', merged.length === 4, String(merged.length));
        check('merge sorts ascending', merged.every((c, i) => i === 0 || c.timestamp > merged[i - 1].timestamp));
        check('merge lets the incoming candle win',
            merged.find((c) => c.timestamp === a[2].timestamp).close === variant.close,
            String(merged.find((c) => c.timestamp === a[2].timestamp).close));
        check('merge ignores invalid rows', mergeCandles(a, [{ timestamp: 'x', open: 1 }]).length === 3,
            String(mergeCandles(a, [{ timestamp: 'x', open: 1 }]).length));
    }
    {
        const withHole = [...series(5), ...series(3, { start: T0 + 8 * MIN })];
        const gaps = findGaps(withHole, MIN);
        check('findGaps detects a hole and counts missing bars', gaps.length === 1 && gaps[0].missing === 3,
            JSON.stringify(gaps));
        check('findGaps returns nothing for a contiguous series', findGaps(series(10), MIN).length === 0);
        check('findGaps respects maxGaps', findGaps([...series(2), ...series(2, { start: T0 + 5 * MIN }), ...series(2, { start: T0 + 12 * MIN })], MIN, { maxGaps: 1 }).length === 1);
    }
    check('dedupeCandles keeps the last occurrence',
        dedupeCandles([{ timestamp: T0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
                       { timestamp: T0, open: 1, high: 10, low: 0.5, close: 9, volume: 1 }])[0].close === 9);

    // -------------------------------------------------------------- jsonl io
    check('formatCandle iso style', JSON.parse(formatCandle(good, 'iso')).timestamp === '2024-01-01T00:00:00.000Z');
    check('formatCandle epoch-ms style', JSON.parse(formatCandle(good, 'epoch-ms')).timestamp === T0);
    check('formatCandle epoch-seconds style', JSON.parse(formatCandle(good, 'epoch-seconds')).timestamp === T0 / 1000);
    {
        const text = serializeCandles(series(3), 'iso');
        check('serializeCandles emits one JSON object per line', text.split('\n').length === 3 && !text.endsWith('\n'));
        const parsed = parseCandlesJsonl(text);
        check('jsonl round-trips exactly',
            parsed.candles.length === 3 && parsed.invalid === 0 && parsed.candles[1].close === series(3)[1].close);
        check('parseCandlesJsonl reports the raw timestamp style', parsed.style === 'iso', parsed.style);
    }
    {
        const parsed = parseCandlesJsonl('\n{"timestamp":"2024-01-01T00:00:00Z","open":1,"high":2,"low":0.5,"close":1.5,"volume":3}\nnot json\n{"timestamp":"","open":1}\n{"timestamp":"2024-01-02T00:00:00Z","open":1,"high":2,"low":0.5,"close":1.5,"volume":3}\n');
        check('parseCandlesJsonl skips blanks, counts junk and invalid candles',
            parsed.candles.length === 2 && parsed.invalid === 2 && parsed.blank === 2,
            JSON.stringify({ c: parsed.candles.length, i: parsed.invalid, b: parsed.blank }));
        check('parseCandlesJsonl sorts ascending', parsed.candles[0].timestamp < parsed.candles[1].timestamp);
        check('parseCandlesJsonl does not count a blank line as invalid', parsed.invalid === 2);
    }
    check('parseCandlesJsonl detects epoch-ms files',
        parseCandlesJsonl(`${JSON.stringify({ timestamp: T0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 })}`).style === 'epoch-ms');
    check('parseCandlesJsonl detects epoch-seconds files',
        parseCandlesJsonl(`${JSON.stringify({ timestamp: T0 / 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 })}`).style === 'epoch-seconds');
    check('parseCandlesJsonl defaults to iso for an empty file', parseCandlesJsonl('').style === 'iso');
    check('detectTimestampStyle: iso', detectTimestampStyle([{ timestamp: '2024-01-01T00:00:00.000Z' }]) === 'iso');
    check('detectTimestampStyle: epoch-ms', detectTimestampStyle([{ timestamp: T0 }]) === 'epoch-ms');
    check('detectTimestampStyle: epoch-seconds', detectTimestampStyle([{ timestamp: T0 / 1000 }]) === 'epoch-seconds');
    check('detectTimestampStyle: numeric string', detectTimestampStyle([{ timestamp: String(T0) }]) === 'epoch-ms');
    check('detectTimestampStyle defaults to iso for empty input', detectTimestampStyle([]) === 'iso' && detectTimestampStyle(null) === 'iso');
    check('TIMESTAMP_STYLES is complete', TIMESTAMP_STYLES.length === 3);

    // ------------------------------------------------------------- planning
    {
        const store = { candles: series(10) };
        const plan = planUpdate(store, { interval: '1m', now: T0 + 20 * MIN });
        check('planUpdate resumes after the last stored bar',
            plan.incremental === true && plan.startTime === T0 + 10 * MIN && plan.lastStored === T0 + 9 * MIN,
            JSON.stringify(plan));
        const fresh = planUpdate({ candles: [] }, { interval: '1m', now: T0 + 20 * MIN });
        check('planUpdate starts from zero on an empty store', fresh.incremental === false && fresh.startTime === 0);
    }
    check('planBackfill computes the interval and window',
        planBackfill({ interval: '1h', startTime: T0, endTime: T0 + 10 * 3_600_000 }).maxCandles === 11);
    check('planBackfill honors the maxCandles cap', planBackfill({ interval: '1h', maxCandles: 5 }).maxCandles === 5);

    // -------------------------------------------------- P4: perpetual funding
    // `src/funding_fetcher.js` (round 29 -> 30, P4): the USDⓈ-M funding series is a
    // different endpoint/host/row-shape from klines, so it has its own fetcher that
    // hands rows to the shipped consumer (`analysis/carry.js`). Same discipline as
    // above: every network call goes through an injected `fetchFn`.
    const goodFunding = normalizeFundingRow({ timestamp: T0, fundingRate: '0.00010000', markPrice: '42000.5' });
    check('funding: normalizeFundingRow coerces the wire shape (string rate, epoch-ms time, optional mark)',
        goodFunding.timestamp === T0 && goodFunding.fundingRate === 0.0001 && goodFunding.markPrice === 42000.5);
    check('funding: normalizeFundingRow needs a finite rate (a missing mark is fine; a bad row is null)',
        normalizeFundingRow({ timestamp: 1, fundingRate: 0 }).markPrice === null &&
        normalizeFundingRow({ timestamp: 2, fundingRate: 'x' }) === null &&
        normalizeFundingRow({ timestamp: 3 }) === null &&
        normalizeFundingRow({ timestamp: 'nonsense', fundingRate: 0.1 }) === null &&
        normalizeFundingRow(null) === null && normalizeFundingRow('junk') === null);
    const fundSrc = getFundingSource('binance');
    const wireRows = fundSrc.parse([
        { fundingTime: T0, fundingRate: '0.00010000', markPrice: '42000.5' },
        { fundingTime: T0 + 1, fundingRate: 'x' },
        'junk', null,
    ]);
    check('funding: the binance source maps `fundingTime` -> `timestamp`',
        wireRows.length === 2 && wireRows[0].timestamp === T0 && wireRows[0].fundingRate === '0.00010000' &&
        normalizeFundingRow(wireRows[1]) === null);
    check('funding: the URL targets the USDⓈ-M funding endpoint with an explicit startTime and a page limit',
        fundSrc.buildUrl({ symbol: 'BTCUSDT', startTime: T0, endTime: T0 + 3 * FUNDING_PERIOD_MS, limit: 1000 }) ===
        `https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1000&startTime=${T0}&endTime=${T0 + 3 * FUNDING_PERIOD_MS}`);
    check('funding: getFundingSource rejects an unknown source',
        (() => { try { getFundingSource('ftx'); return false; } catch (e) { return /unknown source/.test(e.message); } })());
    check('funding: the default backfill start is the perp listing era (2019-09), never `0`',
        DEFAULT_FUNDING_BACKFILL_START === Date.parse('2019-09-01T00:00:00Z') && FUNDING_PERIOD_MS === 8 * 3_600_000);
    check('funding: formatFundingRow round-trips through the consumer parser, in both encodings',
        (() => {
            const rows = [goodFunding, { timestamp: T0 + FUNDING_PERIOD_MS, fundingRate: -0.0002, markPrice: null }];
            const iso = serializeFundingRates(rows).split('\n');
            const back = parseFundingJsonl(serializeFundingRates(rows));
            const backMs = parseFundingJsonl(serializeFundingRates(rows, 'epoch-ms'));
            return iso[0] === `{"timestamp":"${new Date(T0).toISOString()}","fundingRate":0.0001,"markPrice":42000.5}` &&
                !/markPrice/.test(iso[1]) &&
                back.rows.length === 2 && back.invalid === 0 && back.blank === 0 && back.rows[1].markPrice === null &&
                backMs.rows[0].timestamp === T0 && backMs.rows[1].fundingRate === -0.0002;
        })());
    {
        const wire = Array.from({ length: 5 }, (_, i) => ({
            fundingTime: T0 + i * FUNDING_PERIOD_MS, fundingRate: String(0.0001 * (i + 1)), markPrice: '100',
        }));
        const pageFn = (pageSize) => async (url) => {
            const params = new URL(url).searchParams;
            const startTime = Number(params.get('startTime'));
            const limit = Math.min(pageSize, Number(params.get('limit')));
            return { ok: true, status: 200, json: async () => wire.filter((r) => r.fundingTime >= startTime).slice(0, limit) };
        };
        const endTime = T0 + 10 * FUNDING_PERIOD_MS;
        let calls = 0;
        const limited = await fetchFundingRates('binance', {
            symbol: 'BTCUSDT', startTime: T0, endTime, limit: 3,
            fetchFn: async (u) => { calls++; return pageFn(1000)(u); }, sleep: noSleep, now: T0 + 100 * FUNDING_PERIOD_MS,
        });
        check('funding: paginates from an explicit startTime and honours the total `limit` in one request',
            limited.length === 3 && limited[0].timestamp === T0 && limited[2].timestamp === T0 + 2 * FUNDING_PERIOD_MS && calls === 1,
            JSON.stringify({ rows: limited.length, calls }));
        // A one-row page forces the cursor to advance by exactly one period: the
        // endpoint's `startTime` is INCLUSIVE, so without the strict `+1ms` cursor the
        // first row would be re-fetched forever.
        let walkCalls = 0;
        const walked = await fetchFundingRates('binance', {
            symbol: 'BTCUSDT', startTime: T0, endTime,
            fetchFn: async (u) => { walkCalls++; return pageFn(1)(u); }, sleep: noSleep, now: T0 + 100 * FUNDING_PERIOD_MS,
        });
        check('funding: a one-row page still advances (fundingTime + 1ms) and yields every row exactly once',
            walked.length === 5 && walkCalls === 6 &&
            walked.every((r, i) => r.timestamp === T0 + i * FUNDING_PERIOD_MS && Math.abs(r.fundingRate - 0.0001 * (i + 1)) <= 1e-15),
            JSON.stringify({ rows: walked.length, calls: walkCalls }));
        const futureDated = await fetchFundingRates('binance', {
            symbol: 'BTCUSDT', startTime: T0, endTime, fetchFn: pageFn(1000), sleep: noSleep, now: T0,
        });
        check('funding: a period dated after `now` is never stored (a funding row is realized at its own timestamp)',
            futureDated.length === 1 && futureDated[0].timestamp === T0, JSON.stringify(futureDated.length));
    }

    // ------------------------------------------------------------- summarize
    {
        const summary = summarizeCandles(series(10), MIN);
        check('summarizeCandles counts and spans', summary.count === 10 && summary.gaps === 0 && summary.missingCandles === 0,
            JSON.stringify(summary));
        check('summarizeCandles reports price extremes',
            summary.minLow === series(10)[0].low && summary.maxHigh === series(10)[9].high);
        check('summarizeCandles handles empty input', summarizeCandles([]).count === 0);
        const holed = summarizeCandles([...series(3), ...series(3, { start: T0 + 5 * MIN })], MIN);
        check('summarizeCandles surfaces gaps', holed.gaps === 1 && holed.missingCandles === 2, JSON.stringify(holed));
    }

    return { total: checks.length, failed: checks.filter((c) => !c.pass).length, failures: checks.filter((c) => !c.pass), checks };
}
