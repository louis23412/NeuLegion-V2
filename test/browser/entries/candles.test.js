// Candle-data integrity suite for NeuLegion, executed inside a browser Worker
// via test/browser/harness.js (and mirrored by test/node/candles.test.js).
//
// `src/candles_audit.js` owns the pure invariants; this entry is the I/O shell
// that parses the shipped JSONL files and asserts those invariants. It always
// runs a set of synthetic self-tests of the auditor, and — when a file reader
// is available — audits every file in `CANDLE_MANIFEST`, including an exact
// cross-file check that two series from the same venue/interval (BTC/ETH) share
// an identical timestamp grid.

import {
    CANDLE_MANIFEST,
    CANDLE_FILES,
    MAX_MISSING_FRACTION,
    HOUR_MS,
    auditSeries,
    auditProblems,
} from '../../../src/candles_audit.js';
import { parseCandlesJsonl } from '../../../src/candle_fetcher.js';
import {
    DEFAULT_MAX_WICK_FRACTION,
    isImplausibleCandle,
    repairCandle,
    repairSeries,
    findImplausibleWicks,
    stripRepairFlags,
} from '../../../src/candle_quality.js';

const PROJECT_ROOT = import.meta.dirname
    ? import.meta.dirname.replace(/[\\/]test[\\/]browser[\\/]entries$/, '')
    : '';

function makeSeries(n, { start = Date.parse('2024-01-01T00:00:00Z'), intervalMs = HOUR_MS, base = 100 } = {}) {
    const out = [];
    let price = base;
    for (let i = 0; i < n; i++) {
        const open = price;
        price = price * (1 + 0.001 * Math.sin(i));
        const close = price;
        out.push({
            timestamp: start + i * intervalMs,
            open: Number(open.toFixed(6)),
            high: Math.max(open, close) * 1.001,
            low: Math.min(open, close) * 0.999,
            close: Number(close.toFixed(6)),
            volume: 1000 + i,
        });
    }
    return out;
}

function resolveReader(options) {
    if (options && typeof options.readFile === 'function') return options.readFile;
    if (globalThis.__fs && typeof globalThis.__fs.readTextFile === 'function') {
        return (p) => globalThis.__fs.readTextFile(p);
    }
    return null;
}

export async function run(options = {}) {
    const checks = [];
    const failures = [];
    const check = (name, pass, info = '') => {
        checks.push({ name, pass, info });
        if (!pass) failures.push({ name, info });
    };

    // ------------------------------------------------------------------
    // 1. Auditor self-tests (independent of any file on disk)
    // ------------------------------------------------------------------
    const clean = makeSeries(500);
    const cleanReport = auditSeries(clean, { intervalMs: HOUR_MS, now: clean.at(-1).timestamp + HOUR_MS });
    check('audit: clean synthetic series has no problems', auditProblems(cleanReport).length === 0, JSON.stringify(auditProblems(cleanReport)));
    check('audit: clean series counts', cleanReport.count === 500 && cleanReport.gaps === 0 && cleanReport.missingCandles === 0, JSON.stringify({ count: cleanReport.count, gaps: cleanReport.gaps }));

    const badOHLC = makeSeries(20).map((c, i) => (i === 7 ? { ...c, high: c.low - 1 } : c));
    check('audit: inverted high/low is detected', auditProblems(auditSeries(badOHLC, { intervalMs: HOUR_MS, now: Infinity })).some((p) => /OHLC/.test(p)));

    const dup = makeSeries(20).map((c, i) => (i === 10 ? { ...c, timestamp: makeSeries(20)[9].timestamp } : c));
    check('audit: duplicate timestamp is detected', auditProblems(auditSeries(dup, { intervalMs: HOUR_MS, now: Infinity })).some((p) => /duplicate/.test(p)));

    const offGrid = makeSeries(20).map((c, i) => (i === 3 ? { ...c, timestamp: c.timestamp + 1234 } : c));
    check('audit: off-grid timestamp is detected', auditProblems(auditSeries(offGrid, { intervalMs: HOUR_MS, now: Infinity })).some((p) => /off-grid/.test(p)));

    const unclosed = makeSeries(20);
    const unclosedNow = unclosed.at(-1).timestamp + 1;
    check('audit: still-forming bar is detected', auditProblems(auditSeries(unclosed, { intervalMs: HOUR_MS, now: unclosedNow })).some((p) => /still-forming/.test(p)));

    const holed = [...makeSeries(10), ...makeSeries(10, { start: Date.parse('2024-01-02T00:00:00Z') })];
    const holedReport = auditSeries(holed, { intervalMs: HOUR_MS, now: Infinity });
    check('audit: gaps and missing candles are counted', holedReport.gaps === 1 && holedReport.missingCandles === 14, JSON.stringify({ gaps: holedReport.gaps, missing: holedReport.missingCandles }));

    const mostlyMissing = makeSeries(2).concat(makeSeries(2, { start: Date.parse('2024-02-01T00:00:00Z') }));
    check('audit: missing-fraction budget is enforced', auditProblems(auditSeries(mostlyMissing, { intervalMs: HOUR_MS, now: Infinity })).some((p) => /missing fraction/.test(p)));
    check('audit: report is null-safe on empty series', (() => { const r = auditSeries([], { now: Infinity }); return r.count === 0 && auditProblems(r).length === 1; })());

    // ------------------------------------------------------------------
    // 1b. Candle-quality (implausible-wick winsorization) self-tests
    // ------------------------------------------------------------------
    const normalBar = { timestamp: 0, open: 100, high: 103, low: 98, close: 102, volume: 5 };
    check('quality: an ordinary bar is not implausible', !isImplausibleCandle(normalBar));
    check('quality: repair leaves an ordinary bar untouched', repairCandle(normalBar).repaired === false);

    const glitchBar = { timestamp: Date.parse('2020-03-12T10:00:00Z'), open: 3.0634, high: 3.0765, low: 0.0001, close: 2.4693, volume: 6364776.5 };
    check('quality: a flash wick is implausible', isImplausibleCandle(glitchBar));
    const fixedGlitch = repairCandle(glitchBar);
    check('quality: repair collapses the wick to the body extreme', fixedGlitch.repaired === true && fixedGlitch.low === Math.min(glitchBar.open, glitchBar.close), JSON.stringify(fixedGlitch));
    check('quality: repair preserves close/open/volume/timestamp', fixedGlitch.close === glitchBar.close && fixedGlitch.open === glitchBar.open && fixedGlitch.volume === glitchBar.volume && fixedGlitch.timestamp === glitchBar.timestamp);
    check('quality: repaired bar is OHLC-valid', fixedGlitch.high >= Math.max(fixedGlitch.open, fixedGlitch.close) && fixedGlitch.low <= Math.min(fixedGlitch.open, fixedGlitch.close) && fixedGlitch.low <= fixedGlitch.high);
    const twice = repairCandle(fixedGlitch);
    check('quality: repair is idempotent', twice.repaired === false && twice.low === fixedGlitch.low && twice.high === fixedGlitch.high);

    // A genuine large-range bar must survive: body 100->60, low 55 (a 8.3% wick
    // beyond the body) is well inside the 50% budget.
    const realBar = { timestamp: 0, open: 100, high: 100, low: 55, close: 60, volume: 5 };
    check('quality: a genuine extreme bar survives', !isImplausibleCandle(realBar));
    check('quality: a 55%-of-body wick survives the default threshold', !isImplausibleCandle({ timestamp: 0, open: 100, high: 100, low: 45, close: 100, volume: 5 }));
    check('quality: a >90%-of-body wick is flagged', isImplausibleCandle({ timestamp: 0, open: 100, high: 100, low: 5, close: 100, volume: 5 }));
    check('quality: an absurd upward spike is flagged', isImplausibleCandle({ timestamp: 0, open: 100, high: 250, low: 100, close: 100, volume: 5 }));
    check('quality: stripRepairFlags restores the canonical shape', (() => { const s = stripRepairFlags(fixedGlitch); return !('repaired' in s) && !('repair' in s) && s.low === fixedGlitch.low; })());

    const mixed = [normalBar, glitchBar, realBar];
    const repairedMixed = repairSeries(mixed);
    check('quality: repairSeries reports exactly the changed bars', repairedMixed.repairedCount === 1 && repairedMixed.repairs.length === 1 && repairedMixed.repairs[0].timestamp === glitchBar.timestamp, JSON.stringify(repairedMixed.repairs));
    check('quality: repairSeries does not mutate its input', mixed[1].low === 0.0001);
    check('quality: default wick fraction is 0.9', DEFAULT_MAX_WICK_FRACTION === 0.9);

    // ------------------------------------------------------------------
    // 2. Shipped-file audit (needs a reader)
    // ------------------------------------------------------------------
    const reader = resolveReader(options);
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const parsedByGroup = new Map();
    const parsedBySymbol = new Map();

    check('manifest: file list is non-empty and unique', CANDLE_FILES.length >= 1 && new Set(CANDLE_FILES).size === CANDLE_FILES.length, `${CANDLE_FILES.length} files`);

    if (!reader) {
        check('shipped files: reader available', false, 'no readFile option and no globalThis.__fs');
    } else {
        let totalRows = 0;
        let totalBytes = 0;
        let totalWicks = 0;
        const repairedBySymbol = new Map();
        for (const entry of CANDLE_MANIFEST) {
            const path = `${PROJECT_ROOT}/${entry.file}`;
            let text;
            try {
                text = await reader(path);
            } catch (error) {
                check(`${entry.symbol}: file readable`, false, `${path}: ${String((error && error.message) || error)}`);
                continue;
            }
            const parsed = parseCandlesJsonl(text);
            const report = auditSeries(parsed.candles, { intervalMs: HOUR_MS, now });
            const problems = auditProblems(report);
            check(`${entry.symbol}: parses with zero invalid lines`, parsed.invalid === 0 && parsed.blank <= 1, `invalid=${parsed.invalid} blank=${parsed.blank}`);
            check(`${entry.symbol}: passes integrity audit`, problems.length === 0, problems.join('; '));
            check(`${entry.symbol}: rows >= minRows`, report.count >= entry.minRows, `${report.count} >= ${entry.minRows}`);
            check(`${entry.symbol}: missing fraction <= ${(MAX_MISSING_FRACTION * 100).toFixed(1)}%`, report.missingFraction <= MAX_MISSING_FRACTION, `${(report.missingFraction * 100).toFixed(4)}%`);
            check(`${entry.symbol}: positive price range`, report.minLow > 0 && report.maxHigh > report.minLow, `${report.minLow} .. ${report.maxHigh}`);
            totalRows += report.count;
            totalBytes += text.length;

            // Implausible-wick handling: report, then prove the sanitizer clears
            // every one of them without breaking the structural audit.
            const wicks = findImplausibleWicks(parsed.candles);
            totalWicks += wicks.length;
            const repaired = repairSeries(parsed.candles);
            repairedBySymbol.set(entry.symbol, repaired);
            check(`${entry.symbol}: repair clears all implausible wicks`, findImplausibleWicks(repaired.candles).length === 0, `${wicks.length} found`);
            check(`${entry.symbol}: repair count matches detection`, repaired.repairedCount === wicks.length, `${repaired.repairedCount}/${wicks.length}`);
            check(`${entry.symbol}: repaired series still passes audit`, auditProblems(auditSeries(repaired.candles, { intervalMs: HOUR_MS, now })).length === 0);

            const group = parsedByGroup.get(entry.group) || [];
            group.push({ entry, report, candles: parsed.candles });
            parsedByGroup.set(entry.group, group);
            parsedBySymbol.set(entry.symbol, { entry, report, candles: parsed.candles });
        }
        check('shipped files: aggregate row count', totalRows >= 500_000, `${totalRows} rows`);
        check('shipped files: aggregate size is reasonable (< 200MB)', totalBytes > 0 && totalBytes < 200 * 1024 * 1024, `${(totalBytes / 1024 / 1024).toFixed(1)}MB`);
        check('shipped files: implausible-wick budget (<= 2 across all files)', totalWicks <= 2, `${totalWicks} implausible wick(s)`);

        const linkRepairs = repairedBySymbol.get('LINKUSDT');
        if (linkRepairs) {
            const known = linkRepairs.repairs.find((r) => r.timestamp === Date.parse('2020-03-12T10:00:00Z'));
            check('shipped files: known LINKUSDT flash print is repaired', !!known && known.low && known.low.from === 0.0001, JSON.stringify(known || null));
        }

        // Exact cross-file grid equality for the BTC/ETH anchor pair (same
        // venue + interval + start); this catches any row drift between the two
        // files that a per-file audit alone cannot.
        const btc = parsedBySymbol.get('BTCUSDT');
        const eth = parsedBySymbol.get('ETHUSDT');
        if (btc && eth) {
            const sameGrid = btc.candles.length === eth.candles.length
                && btc.report.first === eth.report.first
                && btc.report.last === eth.report.last
                && btc.candles.every((c, i) => c.timestamp === eth.candles[i].timestamp);
            check('BTC/ETH share an identical timestamp grid', sameGrid, `btc=${btc.report.count} eth=${eth.report.count} first=${btc.report.first}/${eth.report.first}`);
        }

        // Freshness is informational (it depends on when the updater last ran),
        // so it is reported but never used to fail the suite.
        const newest = Math.max(...[...parsedBySymbol.values()].map((v) => v.report.last ?? 0));
        const staleDays = (now - newest) / 86_400_000;
        check('shipped files: newest bar is recent (informational)', staleDays < 30, `${staleDays.toFixed(2)} days old`);
    }

    return { total: checks.length, failed: failures.length, failures, checks };
}
