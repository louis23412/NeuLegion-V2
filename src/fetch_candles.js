#!/usr/bin/env node
// fetch_candles.js
//
// CLI wrapper that keeps the legion's candle stream (`src/candles.jsonl`)
// populated. All of the interesting logic — interval mapping, per-exchange URL
// construction and parsing, pagination, merge/dedupe/gaps, and JSONL
// (de)serialization — lives in `candle_fetcher.js`, which is network-free and
// covered by the test suite. This file is only: argv, filesystem, network.
//
// Usage
//   node src/fetch_candles.js                          # incremental update
//   node src/fetch_candles.js --full                   # backfill everything
//   node src/fetch_candles.js --full --limit 20000     # backfill at most 20k
//   node src/fetch_candles.js --symbol ETHUSDT --out src/data/candles_ethusdt.jsonl --full
//   node src/fetch_candles.js --check                  # report, do not write
//   node src/fetch_candles.js --dry-run                # fetch + report, do not write
//
// Options
//   --symbol <s>       exchange symbol, default BTCUSDT
//   --interval <i>     1m/5m/15m/30m/1h/2h/4h/1d/1w (default 1h)
//   --source <names>   comma-separated preference order
//                      (default binance,bybit,coinbase; each falls through
//                      on failure or an empty result)
//   --out <path>       output JSONL (default src/candles.jsonl)
//   --mode <m>         update (default) | full | refresh
//                        update  - fetch bars after the last stored one
//                        full    - backfill from the earliest available bar
//                        refresh - re-fetch the last N bars (--limit) and
//                                  overwrite them, repairing partial bars
//   --limit <n>        cap on candles fetched this run
//   --since <date>     ISO date/epoch to start a full backfill
//   --style <s>        iso | epoch-ms | epoch-seconds (default: keep the
//                      file's existing style, else iso)
//   --page-delay <ms>  pause between paginated requests (default 120)
//   --check            read + report only
//   --dry-run          fetch but do not write
//   --quiet
//   --help

import fs from 'fs';
import path from 'path';
import {
    DEFAULT_BACKFILL_START,
    SOURCE_NAMES,
    TIMESTAMP_STYLES,
    findGaps,
    intervalToMs,
    mergeCandles,
    msToInterval,
    parseCandlesJsonl,
    planUpdate,
    resolveSourceInterval,
    serializeCandles,
    summarizeCandles,
    fetchCandles,
    getSource,
} from './candle_fetcher.js';

const DEFAULT_OUT = path.join(import.meta.dirname, 'candles.jsonl');

const HELP = `NeuLegion candle fetcher

  node src/fetch_candles.js [options]

  --symbol <s>       exchange symbol (default BTCUSDT)
  --interval <i>     1m/5m/15m/30m/1h/2h/4h/1d/1w (default 1h)
  --source <names>   comma-separated preference order
                     (default ${SOURCE_NAMES.join(',')})
  --out <path>       output JSONL (default src/candles.jsonl)
  --mode <m>         update | full | refresh (default update)
  --limit <n>        cap on candles fetched this run
  --since <date>     ISO date or epoch ms to start a full backfill
  --style <s>        ${TIMESTAMP_STYLES.join(' | ')}
  --page-delay <ms>  pause between paginated requests (default 120)
  --check            read + report only, no network, no write
  --dry-run          fetch + report, but do not write
  --quiet            one-line summary
  --help
`;

function parseArgs(argv) {
    const options = {
        symbol: 'BTCUSDT',
        interval: '1h',
        sources: ['binance', 'bybit', 'coinbase'],
        out: DEFAULT_OUT,
        mode: null,
        limit: Infinity,
        since: 0,
        style: null,
        pageDelay: 120,
        check: false,
        dryRun: false,
        quiet: false,
        help: false,
    };

    const need = (i, name) => {
        if (i + 1 >= argv.length) throw new Error(`Missing value for ${name}`);
        return argv[i + 1];
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case '--symbol': options.symbol = need(i, arg); i++; break;
            case '--interval': options.interval = need(i, arg); i++; break;
            case '--source':
            case '--sources':
                options.sources = need(i, arg).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
                i++;
                break;
            case '--out': options.out = need(i, arg); i++; break;
            case '--mode': options.mode = need(i, arg).toLowerCase(); i++; break;
            case '--limit': options.limit = Number(need(i, arg)); i++; break;
            case '--since': {
                const raw = need(i, arg);
                const parsed = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
                options.since = Number.isFinite(parsed) ? parsed : 0;
                i++;
                break;
            }
            case '--style': options.style = need(i, arg).toLowerCase(); i++; break;
            case '--page-delay': options.pageDelay = Number(need(i, arg)); i++; break;
            case '--check': options.check = true; break;
            case '--dry-run': options.dryRun = true; break;
            case '--quiet': options.quiet = true; break;
            case '--help': case '-h': options.help = true; break;
            default:
                if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
        }
    }

    if (!Number.isFinite(options.limit) || options.limit <= 0) options.limit = Infinity;
    if (options.style && !TIMESTAMP_STYLES.includes(options.style)) {
        throw new Error(`Unknown --style "${options.style}" (expected ${TIMESTAMP_STYLES.join(', ')})`);
    }
    for (const name of options.sources) getSource(name);
    return options;
}

function readStore(file) {
    if (!fs.existsSync(file)) return { exists: false, candles: [], invalid: 0, style: 'iso', bytes: 0 };
    const text = fs.readFileSync(file, 'utf8');
    const parsed = parseCandlesJsonl(text);
    return {
        exists: true,
        candles: parsed.candles,
        invalid: parsed.invalid,
        style: parsed.style,
        bytes: Buffer.byteLength(text),
    };
}

function atomicWrite(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
}

const fmt = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : 'n/a');

async function fetchWithFallback(options, window) {
    const failures = [];
    for (let i = 0; i < options.sources.length; i++) {
        const name = options.sources[i];
        try {
            const source = getSource(name);
            resolveSourceInterval(source, options.interval);
            const result = await fetchCandles(source, {
                symbol: options.symbol,
                interval: options.interval,
                startTime: window.startTime,
                endTime: window.endTime,
                limit: window.limit,
                pageDelayMs: options.pageDelay,
            });
            if (result.candles.length > 0) return { ...result, failures };
            failures.push({ source: name, error: 'no candles returned' });
        } catch (error) {
            failures.push({ source: name, error: String((error && error.message) || error) });
        }
        if (!options.quiet && i < options.sources.length - 1) {
            console.log(`  ${name} unavailable (${failures[failures.length - 1].error}); trying next source...`);
        }
    }
    return { candles: [], source: null, failures };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        process.stdout.write(HELP);
        return;
    }

    const intervalMs = intervalToMs(options.interval);
    const store = readStore(options.out);

    if (options.check) {
        if (!store.exists) {
            console.log(`${options.out}: not found`);
            return;
        }
        const summary = summarizeCandles(store.candles, intervalMs);
        console.log(`${options.out}`);
        console.log(`  candles   : ${summary.count} (${store.invalid} invalid line(s), ${store.bytes} bytes)`);
        console.log(`  range     : ${summary.startIso} -> ${summary.endIso} (${summary.spanDays.toFixed(1)} days)`);
        console.log(`  price     : ${summary.minLow} .. ${summary.maxHigh} (last close ${summary.lastClose})`);
        console.log(`  gaps      : ${summary.gaps} (${summary.missingCandles} missing candles)`);
        console.log(`  style     : ${store.style}`);
        return;
    }

    const mode = options.mode ?? (store.exists && store.candles.length > 0 ? 'update' : 'full');
    let window;
    if (mode === 'full') {
        window = { startTime: options.since || DEFAULT_BACKFILL_START, endTime: Date.now(), limit: options.limit };
    } else if (mode === 'refresh') {
        const n = Number.isFinite(options.limit) ? options.limit : 500;
        window = { startTime: Math.max(0, Date.now() - n * intervalMs), endTime: Date.now(), limit: options.limit };
    } else {
        const plan = planUpdate(store, { interval: options.interval });
        if (!plan.incremental) {
            window = { startTime: options.since || DEFAULT_BACKFILL_START, endTime: plan.endTime, limit: options.limit };
        } else {
            window = { startTime: plan.startTime, endTime: plan.endTime, limit: options.limit };
            if (window.startTime > window.endTime) {
                if (!options.quiet) console.log(`${options.out}: already up to date (last bar ${fmt(plan.lastStored)}).`);
                return;
            }
        }
    }

    if (!options.quiet) {
        console.log(`fetching ${options.symbol} ${options.interval} from [${options.sources.join(' -> ')}]`);
        console.log(`  window   : ${fmt(window.startTime)} -> ${fmt(window.endTime)}`);
        console.log(`  mode     : ${mode}${Number.isFinite(options.limit) ? ` (limit ${options.limit})` : ''}`);
    }

    const fetched = await fetchWithFallback(options, window);
    for (const failure of fetched.failures) {
        if (!options.quiet) console.log(`  ! ${failure.source}: ${failure.error}`);
    }
    if (!fetched.candles.length) {
        console.error('no candles fetched from any source');
        process.exitCode = 1;
        return;
    }

    const existing = mode === 'update' ? store.candles : (mode === 'refresh' ? store.candles : []);
    const merged = mergeCandles(existing, fetched.candles);
    const style = options.style ?? store.style ?? 'iso';
    const summary = summarizeCandles(merged, intervalMs);

    if (!options.dryRun) atomicWrite(options.out, serializeCandles(merged, style));

    if (options.quiet) {
        console.log(`${fetched.source}: +${fetched.candles.length} candles, file now ${merged.length} (${summary.startIso} -> ${summary.endIso})${options.dryRun ? ' [dry-run]' : ''}`);
        return;
    }

    console.log(`  source   : ${fetched.source} (${fetched.requests} request(s))`);
    console.log(`  fetched  : ${fetched.candles.length} new candle(s)`);
    console.log(`  file     : ${merged.length} candles -> ${options.out}${options.dryRun ? ' [dry-run, not written]' : ''}`);
    console.log(`  range    : ${summary.startIso} -> ${summary.endIso} (${summary.spanDays.toFixed(1)} days, style ${style})`);
    console.log(`  gaps     : ${summary.gaps} (${summary.missingCandles} missing candles)`);
    const gaps = findGaps(merged, intervalMs, { maxGaps: 5 });
    for (const gap of gaps) {
        console.log(`    - missing ${gap.missing} bar(s) around ${fmt(gap.from)}`);
    }
}

main().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
});
