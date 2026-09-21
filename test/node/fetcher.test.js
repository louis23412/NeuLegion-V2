// Node mirror of test/browser/entries/fetcher.test.js.
//
// `candle_fetcher.js` is pure ESM with no Node built-ins and no top-level side
// effects, so — unlike the shim-based mirrors — this suite imports the exact
// module the CLI uses. Network access is injected, so nothing here touches the
// internet. Run with `npm test`.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    SOURCES, SOURCE_NAMES, INTERVALS, TIMESTAMP_STYLES, DEFAULT_BACKFILL_START,
    intervalToMs, msToInterval, toEpochMs, normalizeCandle, isValidCandle,
    dropUnclosed, getSource, resolveSourceInterval, httpJson, fetchCandles,
    fetchCandlesAuto, dedupeCandles, mergeCandles, findGaps, summarizeCandles,
    formatCandle, serializeCandles, parseCandlesJsonl, detectTimestampStyle,
    timestampStyleOf, planUpdate, planBackfill,
} from '../../src/candle_fetcher.js';

const MIN = 60_000;
const T0 = Date.parse('2024-01-01T00:00:00Z');
const noSleep = async () => {};

function series(n, { start = T0, intervalMs = MIN, base = 100 } = {}) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const open = base + i * 0.5;
        const close = open + 0.25;
        out.push({ timestamp: start + i * intervalMs, open, high: close + 0.5, low: open - 0.5, close, volume: 10 + i });
    }
    return out;
}

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
        return { ok: true, status: 200, json: async () => page.map((c) => [c.timestamp, String(c.open), String(c.high), String(c.low), String(c.close), String(c.volume)]) };
    };
}

test('intervals: parsing, round-trip and rejection', () => {
    assert.equal(intervalToMs('1m'), 60_000);
    assert.equal(intervalToMs('1h'), 3_600_000);
    assert.equal(intervalToMs('4h'), 14_400_000);
    assert.equal(intervalToMs('1d'), 86_400_000);
    assert.equal(intervalToMs('1w'), 604_800_000);
    assert.equal(intervalToMs(' 15M '), 900_000);
    assert.equal(intervalToMs(120_000), 120_000);
    assert.throws(() => intervalToMs('1y'));
    assert.throws(() => intervalToMs(''));
    assert.throws(() => intervalToMs(0));
    for (const [name, ms] of Object.entries(INTERVALS)) assert.equal(msToInterval(ms), name);
    assert.equal(msToInterval(7_200_000), '2h');
    assert.equal(msToInterval(120_000), '120000ms');
});

test('toEpochMs: epoch seconds, milliseconds, ISO and junk', () => {
    assert.equal(toEpochMs(1_704_067_200), 1_704_067_200_000);
    assert.equal(toEpochMs(1_704_067_200_000), 1_704_067_200_000);
    assert.equal(toEpochMs('2024-01-01T00:00:00.000Z'), 1_704_067_200_000);
    assert.equal(toEpochMs('1704067200'), 1_704_067_200_000);
    for (const bad of ['', '   ', null, undefined, 'not-a-date', NaN]) assert.ok(Number.isNaN(toEpochMs(bad)), String(bad));
});

test('normalizeCandle: accepts well-formed rows, rejects malformed ones', () => {
    const good = { timestamp: T0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 };
    assert.ok(isValidCandle(good));
    assert.equal(normalizeCandle({ timestamp: String(T0), open: '1', high: '2', low: '0.5', close: '1.5', volume: '3' }).close, 1.5);
    assert.equal(normalizeCandle({ ...good, high: 0.4 }), null);
    assert.equal(normalizeCandle({ ...good, high: 1.2 }), null);
    assert.equal(normalizeCandle({ ...good, low: 0 }), null);
    assert.equal(normalizeCandle({ ...good, volume: -1 }), null);
    assert.equal(normalizeCandle({ timestamp: T0, open: 1 }), null);
    assert.equal(normalizeCandle(null), null);
    assert.equal(normalizeCandle({ ...good, timestamp: '' }), null);
});

test('dropUnclosed: excludes the still-forming bar only', () => {
    assert.equal(dropUnclosed(series(20), MIN, T0 + 10 * MIN + 1).length, 10);
    assert.equal(dropUnclosed(series(20), MIN, T0 + 9 * MIN + MIN).length, 10);
});

test('sources: registry, symbols, intervals, url construction', () => {
    assert.deepEqual(SOURCE_NAMES, ['binance', 'bybit', 'coinbase', 'kraken']);
    assert.throws(() => getSource('ftx'));

    assert.equal(SOURCES.binance.normalizeSymbol('btc-usdt'), 'BTCUSDT');
    assert.equal(SOURCES.coinbase.normalizeSymbol('BTCUSDT'), 'BTC-USD');
    assert.equal(SOURCES.coinbase.normalizeSymbol('BTC-USD'), 'BTC-USD');
    assert.equal(SOURCES.kraken.normalizeSymbol('BTCUSDT'), 'XBTUSD');

    const bn = new URL(SOURCES.binance.buildUrl({ symbol: 'BTCUSDT', interval: '1h', startTime: 1, endTime: 2, limit: 1000 })).searchParams;
    assert.equal(bn.get('symbol'), 'BTCUSDT');
    assert.equal(bn.get('interval'), '1h');
    assert.equal(bn.get('limit'), '1000');
    assert.equal(bn.get('startTime'), '1');
    assert.equal(bn.get('endTime'), '2');

    const cb = new URL(SOURCES.coinbase.buildUrl({ symbol: 'BTC-USD', interval: 3600, startTime: T0, endTime: T0 + 3_600_000, limit: 300 })).searchParams;
    assert.equal(cb.get('granularity'), '3600');
    assert.equal(cb.get('start'), new Date(T0).toISOString());

    const bb = new URL(SOURCES.bybit.buildUrl({ symbol: 'BTCUSDT', interval: '60', startTime: 5, endTime: 9, limit: 1000 })).searchParams;
    assert.equal(bb.get('category'), 'spot');
    assert.equal(bb.get('start'), '5');
    assert.equal(bb.get('end'), '9');

    assert.equal(resolveSourceInterval(SOURCES.binance, '1h').token, '1h');
    assert.equal(resolveSourceInterval(SOURCES.bybit, '1h').token, '60');
    assert.equal(resolveSourceInterval(SOURCES.coinbase, '1h').token, 3600);
    assert.equal(resolveSourceInterval(SOURCES.kraken, '1h').token, 60);
    assert.equal(resolveSourceInterval(SOURCES.binance, '4h').ms, 14_400_000);
    assert.throws(() => resolveSourceInterval(SOURCES.coinbase, '2h'), /does not support/);
});

test('sources: response parsing is correct and total', () => {
    const bnc = SOURCES.binance.parse([[T0, '1.0', '2.0', '0.5', '1.5', '7.0', 0, 0, 0, 0, 0, 0]]);
    assert.equal(bnc.length, 1);
    assert.deepEqual([Number(bnc[0].open), Number(bnc[0].high), Number(bnc[0].low), Number(bnc[0].close), Number(bnc[0].volume)], [1, 2, 0.5, 1.5, 7]);
    assert.deepEqual(SOURCES.binance.parse('nonsense'), []);

    const byb = SOURCES.bybit.parse({ result: { list: [[T0 + MIN, 1, 2, 0.5, 1.5, 7, 9], [T0, 1, 2, 0.5, 1.5, 7, 9]] } });
    assert.equal(byb.length, 2);
    assert.equal(byb[0].timestamp, T0);
    assert.deepEqual(SOURCES.bybit.parse({}), []);

    const cbb = SOURCES.coinbase.parse([[T0 / 1000, 0.5, 2.0, 1.0, 1.5, 7.0]]);
    assert.equal(cbb.length, 1);
    assert.deepEqual([Number(cbb[0].open), Number(cbb[0].high), Number(cbb[0].low), Number(cbb[0].close)], [1, 2, 0.5, 1.5]);
    assert.deepEqual(SOURCES.coinbase.parse({ nope: 1 }), []);

    const krk = SOURCES.kraken.parse({ error: [], result: { XXBTZUSD: [[T0 / 1000, '1.0', '2.0', '0.5', '1.5', '1.4', '7.0', 12]] } });
    assert.equal(krk.length, 1);
    assert.equal(Number(krk[0].volume), 7);
    assert.deepEqual(SOURCES.kraken.parse({ error: [] }), []);
});

test('httpJson: retry policy', async () => {
    let attempts = 0;
    const flaky = async () => (++attempts < 3 ? { ok: false, status: 500 } : { ok: true, status: 200, json: async () => ({ ok: true }) });
    assert.deepEqual(await httpJson('http://x', { fetchFn: flaky, sleep: noSleep, baseDelayMs: 1 }), { ok: true });
    assert.equal(attempts, 3);

    let limited = 0;
    await assert.rejects(() => httpJson('http://x', {
        fetchFn: async () => { limited++; return { ok: false, status: 429 }; },
        sleep: noSleep, baseDelayMs: 1, retries: 2,
    }));
    assert.equal(limited, 3);

    let fatal = 0;
    await assert.rejects(() => httpJson('http://x', {
        fetchFn: async () => { fatal++; return { ok: false, status: 400 }; },
        sleep: noSleep, baseDelayMs: 1, retries: 5,
    }));
    assert.equal(fatal, 1, 'non-retryable 4xx must not be retried');

    let network = 0;
    const out = await httpJson('http://x', {
        fetchFn: async () => { network++; if (network === 1) throw new Error('socket'); return { ok: true, status: 200, json: async () => [1] }; },
        sleep: noSleep, baseDelayMs: 1,
    });
    assert.deepEqual(out, [1]);
    assert.equal(network, 2);
});

test('fetchCandles: paginates the whole window', async () => {
    const data = series(2500);
    const log = [];
    const result = await fetchCandles('binance', {
        symbol: 'BTCUSDT', interval: '1m',
        startTime: data[0].timestamp, endTime: data[2499].timestamp + MIN,
        fetchFn: pagedFetch(data, { log }), sleep: noSleep, pageDelayMs: 0,
        now: data[2499].timestamp + 2 * MIN,
    });
    assert.equal(result.candles.length, 2500);
    assert.equal(result.requests, 3);
    assert.equal(log.length, 3);
    assert.ok(result.candles.every((c, i) => i === 0 || c.timestamp > result.candles[i - 1].timestamp));
    assert.equal(result.start, data[0].timestamp);
    assert.equal(result.end, data[2499].timestamp);
    assert.match(log[1], /startTime=/);
});

test('fetchCandles: limit caps and shrinks the final page', async () => {
    const data = series(2500);
    const result = await fetchCandles('binance', {
        symbol: 'BTCUSDT', interval: '1m',
        startTime: data[0].timestamp, endTime: data[2499].timestamp + MIN, limit: 1500,
        fetchFn: pagedFetch(data), sleep: noSleep, pageDelayMs: 0, now: data[2499].timestamp + 2 * MIN,
    });
    assert.equal(result.candles.length, 1500);
    assert.equal(result.requests, 2);
    assert.equal(result.candles[0].timestamp, data[0].timestamp);
});

test('fetchCandles: endTime clamps inclusively and an exhausted series terminates', async () => {
    const data = series(100);
    const clamped = await fetchCandles('binance', {
        symbol: 'BTCUSDT', interval: '1m',
        startTime: data[0].timestamp, endTime: data[0].timestamp + 9 * MIN,
        fetchFn: pagedFetch(data), sleep: noSleep, pageDelayMs: 0, now: data[99].timestamp + 2 * MIN,
    });
    assert.equal(clamped.candles.length, 10);
    assert.equal(clamped.candles.at(-1).timestamp, data[9].timestamp);

    const big = series(1200);
    const exhausted = await fetchCandles('binance', {
        symbol: 'BTCUSDT', interval: '1m',
        startTime: big[0].timestamp, endTime: big[1199].timestamp + MIN,
        fetchFn: pagedFetch(big), sleep: noSleep, pageDelayMs: 0, now: big[1199].timestamp + 2 * MIN,
    });
    assert.equal(exhausted.candles.length, 1200);
    assert.equal(exhausted.requests, 2);
});

test('fetchCandles: omitted startTime backfills from the earliest bar', async () => {
    const data = series(1200);
    const log = [];
    const result = await fetchCandles('binance', {
        symbol: 'BTCUSDT', interval: '1m', endTime: data[1199].timestamp + MIN, limit: 1300,
        fetchFn: pagedFetch(data, { log }), sleep: noSleep, pageDelayMs: 0, now: data[1199].timestamp + 2 * MIN,
    });
    assert.equal(result.candles.length, 1200);
    assert.equal(result.requests, 2);
    assert.equal(result.candles[0].timestamp, data[0].timestamp);
    assert.equal(new URL(log[0]).searchParams.get('startTime'), String(DEFAULT_BACKFILL_START));
});

test('fetchCandles: unclosed-bar guard is opt-out', async () => {
    const data = series(10);
    const opts = { symbol: 'BTCUSDT', interval: '1m', startTime: data[0].timestamp, endTime: data[9].timestamp, sleep: noSleep, pageDelayMs: 0 };
    const dropped = await fetchCandles('binance', { ...opts, fetchFn: pagedFetch(data), now: data[3].timestamp + MIN + 1 });
    assert.equal(dropped.candles.length, 4);
    const kept = await fetchCandles('binance', { ...opts, fetchFn: pagedFetch(data), dropUnclosedCandles: false });
    assert.equal(kept.candles.length, 10);
});

test('fetchCandles: descending exchange feed is normalized ascending', async () => {
    const log = [];
    const fn = async (url) => {
        log.push(url);
        const params = new URL(url).searchParams;
        const limit = Number(params.get('limit'));
        const page = series(Math.min(limit, 1000), { start: T0 });
        return { ok: true, status: 200, json: async () => ({ result: { list: page.map((c) => [c.timestamp, c.open, c.high, c.low, c.close, c.volume, 0]).reverse() } }) };
    };
    const result = await fetchCandles('bybit', {
        symbol: 'BTCUSDT', interval: '1m', startTime: T0, endTime: T0 + 999 * MIN,
        fetchFn: fn, sleep: noSleep, pageDelayMs: 0, now: T0 + 999 * MIN + 2 * MIN,
    });
    assert.equal(result.candles.length, 1000);
    assert.ok(result.candles.every((c, i) => i === 0 || c.timestamp > result.candles[i - 1].timestamp));
    assert.match(log[0], /api\.bybit\.com/);
});

test('fetchCandles: non-ranged source fetches one window; empty response is safe', async () => {
    const data = series(50);
    const krakenFn = async () => ({
        ok: true, status: 200,
        json: async () => ({ error: [], result: { XXBTZUSD: data.map((c) => [c.timestamp / 1000, c.open, c.high, c.low, c.close, 0, c.volume, 1]) } }),
    });
    const kraken = await fetchCandles('kraken', { symbol: 'BTCUSDT', interval: '1m', fetchFn: krakenFn, sleep: noSleep, now: data[49].timestamp + 2 * MIN });
    assert.equal(kraken.requests, 1);
    assert.equal(kraken.candles.length, 50);

    const empty = await fetchCandles('binance', {
        symbol: 'BTCUSDT', interval: '1m', startTime: T0, endTime: T0 + 4 * MIN,
        fetchFn: async () => ({ ok: true, status: 200, json: async () => [] }), sleep: noSleep, pageDelayMs: 0,
    });
    assert.equal(empty.candles.length, 0);
    assert.equal(empty.start, null);
});

test('fetchCandlesAuto: falls through failing sources and records them', async () => {
    const data = series(5);
    const fn = async (url) => {
        if (/binance/.test(url)) return { ok: false, status: 403 };
        return { ok: true, status: 200, json: async () => ({ result: { list: data.map((c) => [c.timestamp, c.open, c.high, c.low, c.close, c.volume, 0]) } }) };
    };
    const result = await fetchCandlesAuto({
        sources: ['binance', 'bybit'], symbol: 'BTCUSDT', interval: '1m',
        startTime: data[0].timestamp, endTime: data[4].timestamp + MIN,
        fetchFn: fn, sleep: noSleep, now: data[4].timestamp + 2 * MIN,
    });
    assert.equal(result.source, 'bybit');
    assert.equal(result.candles.length, 5);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].source, 'binance');
});

test('merge / dedupe / gaps', () => {
    const a = series(3);
    const variant = { ...a[2], close: a[2].open, high: a[2].open + 0.5, low: a[2].open - 0.5 };
    const fresh = series(1, { start: a[2].timestamp + MIN })[0];
    const merged = mergeCandles(a, [variant, fresh]);
    assert.equal(merged.length, 4);
    assert.ok(merged.every((c, i) => i === 0 || c.timestamp > merged[i - 1].timestamp));
    assert.equal(merged.find((c) => c.timestamp === a[2].timestamp).close, variant.close);
    assert.equal(mergeCandles(a, [{ timestamp: 'x', open: 1 }]).length, 3);

    const withHole = [...series(5), ...series(3, { start: T0 + 8 * MIN })];
    const gaps = findGaps(withHole, MIN);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].missing, 3);
    assert.equal(gaps[0].from, T0 + 5 * MIN);
    assert.equal(findGaps(series(10), MIN).length, 0);
    assert.equal(findGaps([...series(2), ...series(2, { start: T0 + 5 * MIN }), ...series(2, { start: T0 + 12 * MIN })], MIN, { maxGaps: 1 }).length, 1);

    assert.equal(dedupeCandles([
        { timestamp: T0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
        { timestamp: T0, open: 1, high: 10, low: 0.5, close: 9, volume: 1 },
    ])[0].close, 9);
});

test('jsonl serialization: styles round-trip and parse tolerates junk', () => {
    const good = { timestamp: T0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 };
    assert.equal(JSON.parse(formatCandle(good, 'iso')).timestamp, '2024-01-01T00:00:00.000Z');
    assert.equal(JSON.parse(formatCandle(good, 'epoch-ms')).timestamp, T0);
    assert.equal(JSON.parse(formatCandle(good, 'epoch-seconds')).timestamp, T0 / 1000);
    assert.equal(TIMESTAMP_STYLES.length, 3);

    const text = serializeCandles(series(3), 'iso');
    assert.equal(text.split('\n').length, 3);
    const parsed = parseCandlesJsonl(text);
    assert.equal(parsed.candles.length, 3);
    assert.equal(parsed.invalid, 0);
    assert.equal(parsed.style, 'iso');

    const mixed = parseCandlesJsonl('\n{"timestamp":"2024-01-01T00:00:00Z","open":1,"high":2,"low":0.5,"close":1.5,"volume":3}\nnot json\n{"timestamp":"","open":1}\n{"timestamp":"2024-01-02T00:00:00Z","open":1,"high":2,"low":0.5,"close":1.5,"volume":3}\n');
    assert.equal(mixed.candles.length, 2);
    assert.equal(mixed.invalid, 2);
    assert.equal(mixed.blank, 2);
    assert.ok(mixed.candles[0].timestamp < mixed.candles[1].timestamp);

    assert.equal(parseCandlesJsonl(JSON.stringify({ timestamp: T0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 })).style, 'epoch-ms');
    assert.equal(parseCandlesJsonl(JSON.stringify({ timestamp: T0 / 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 })).style, 'epoch-seconds');
    assert.equal(parseCandlesJsonl('').style, 'iso');

    assert.equal(detectTimestampStyle([{ timestamp: '2024-01-01T00:00:00.000Z' }]), 'iso');
    assert.equal(detectTimestampStyle([{ timestamp: T0 }]), 'epoch-ms');
    assert.equal(detectTimestampStyle([{ timestamp: T0 / 1000 }]), 'epoch-seconds');
    assert.equal(detectTimestampStyle([{ timestamp: String(T0) }]), 'epoch-ms');
    assert.equal(detectTimestampStyle([]), 'iso');
    assert.equal(detectTimestampStyle(null), 'iso');
    assert.equal(timestampStyleOf(undefined), 'iso');
});

test('planning and summarization', () => {
    const plan = planUpdate({ candles: series(10) }, { interval: '1m', now: T0 + 20 * MIN });
    assert.equal(plan.incremental, true);
    assert.equal(plan.startTime, T0 + 10 * MIN);
    assert.equal(plan.lastStored, T0 + 9 * MIN);
    const fresh = planUpdate({ candles: [] }, { interval: '1m', now: T0 + 20 * MIN });
    assert.equal(fresh.incremental, false);
    assert.equal(fresh.startTime, 0);
    assert.equal(planBackfill({ interval: '1h', startTime: T0, endTime: T0 + 10 * 3_600_000 }).maxCandles, 11);
    assert.equal(planBackfill({ interval: '1h', maxCandles: 5 }).maxCandles, 5);

    const summary = summarizeCandles(series(10), MIN);
    assert.equal(summary.count, 10);
    assert.equal(summary.gaps, 0);
    assert.equal(summary.missingCandles, 0);
    assert.equal(summary.minLow, series(10)[0].low);
    assert.equal(summary.maxHigh, series(10)[9].high);
    assert.equal(summarizeCandles([]).count, 0);
    const holed = summarizeCandles([...series(3), ...series(3, { start: T0 + 5 * MIN })], MIN);
    assert.equal(holed.gaps, 1);
    assert.equal(holed.missingCandles, 2);
});
