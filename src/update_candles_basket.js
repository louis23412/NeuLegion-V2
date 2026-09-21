#!/usr/bin/env node
// update_candles_basket.js
//
// Keeps *every* candle file in `candles_audit.js#CANDLE_MANIFEST` fresh in one
// command. `fetch_candles.js` handles a single symbol; this script is the basket
// orchestrator: it reads the manifest (the single source of truth for which
// files the legion ships) and runs the CLI once per entry, sequentially so the
// exchange is never hammered and progress is readable.
//
// Usage
//   node src/update_candles_basket.js                 # incremental update, all symbols
//   node src/update_candles_basket.js --full          # backfill all symbols
//   node src/update_candles_basket.js --check         # report all files, no network
//   node src/update_candles_basket.js --symbols BTCUSDT,ETHUSDT
//   node src/update_candles_basket.js --page-delay 250 --quiet
//
// Exit code is non-zero if any symbol fails, so CI can gate on it.
//
// This script needs no dependencies (Node built-ins + local ESM), so a scheduled
// workflow can run it without `npm ci`/building better-sqlite3.

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { CANDLE_MANIFEST } from './candles_audit.js';

const CLI = fileURLToPath(new URL('./fetch_candles.js', import.meta.url));

const HELP = `NeuLegion basket candle updater

  node src/update_candles_basket.js [options]

  --full             backfill every symbol from its earliest bar
  --check            read + report only, no network, no write
  --quiet            one line per symbol
  --symbols <list>   comma-separated subset (default: all manifest symbols)
  --source <names>   comma-separated source preference order (passed through)
  --page-delay <ms>  pause between paginated requests (default 120)
  --limit <n>        cap on candles fetched per symbol
  --since <date>     ISO date / epoch to start a full backfill
  --help
`;

function parseArgs(argv) {
    const options = {
        full: false, check: false, quiet: false, symbols: null,
        source: null, pageDelay: null, limit: null, since: null, help: false,
    };
    const need = (i, name) => {
        if (i + 1 >= argv.length) throw new Error(`Missing value for ${name}`);
        return argv[i + 1];
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case '--full': options.full = true; break;
            case '--check': options.check = true; break;
            case '--quiet': options.quiet = true; break;
            case '--symbols': options.symbols = need(i, arg).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean); i++; break;
            case '--source': case '--sources': options.source = need(i, arg); i++; break;
            case '--page-delay': options.pageDelay = need(i, arg); i++; break;
            case '--limit': options.limit = need(i, arg); i++; break;
            case '--since': options.since = need(i, arg); i++; break;
            case '--help': case '-h': options.help = true; break;
            default:
                if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
        }
    }
    return options;
}

function runOne(entry, options) {
    const args = [CLI, '--symbol', entry.symbol, '--interval', entry.interval, '--out', entry.file];
    if (options.full) args.push('--full');
    if (options.check) args.push('--check');
    if (options.quiet) args.push('--quiet');
    if (options.source) args.push('--source', options.source);
    if (options.pageDelay) args.push('--page-delay', options.pageDelay);
    if (options.limit) args.push('--limit', options.limit);
    if (options.since) args.push('--since', options.since);

    return new Promise((resolve) => {
        const child = spawn(process.execPath, args, {
            stdio: options.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        });
        let out = '';
        let err = '';
        if (options.quiet) {
            child.stdout.on('data', (d) => { out += d; });
            child.stderr.on('data', (d) => { err += d; });
        }
        child.on('close', (code) => {
            if (options.quiet) {
                const line = (out + err).trim().split('\n').filter(Boolean).pop() || 'no output';
                console.log(`${code === 0 ? 'ok ' : 'ERR'} ${entry.symbol.padEnd(9)} ${line}`);
            }
            resolve({ symbol: entry.symbol, code, out, err });
        });
        child.on('error', (e) => resolve({ symbol: entry.symbol, code: 1, out: '', err: String(e && e.message || e) }));
    });
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { process.stdout.write(HELP); return; }

    const entries = options.symbols
        ? CANDLE_MANIFEST.filter((e) => options.symbols.includes(e.symbol))
        : CANDLE_MANIFEST;

    if (!entries.length) {
        console.error(`No matching symbols. Available: ${CANDLE_MANIFEST.map((e) => e.symbol).join(', ')}`);
        process.exitCode = 1;
        return;
    }

    if (!options.quiet) {
        console.log(`Basket ${options.check ? 'check' : options.full ? 'FULL backfill' : 'incremental update'} — ${entries.length} symbol(s)\n`);
    }

    const results = [];
    for (const entry of entries) {
        if (!options.quiet) console.log(`── ${entry.symbol} (${entry.interval}) -> ${entry.file}`);
        results.push(await runOne(entry, options));
    }

    const failed = results.filter((r) => r.code !== 0);
    if (!options.quiet) {
        console.log(`\nSummary: ${results.length - failed.length}/${results.length} ok`);
        for (const f of failed) console.log(`  FAILED ${f.symbol}: ${f.err.trim() || `exit ${f.code}`}`);
    }
    if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
});
