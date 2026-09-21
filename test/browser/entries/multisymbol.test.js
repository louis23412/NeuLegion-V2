// Multi-symbol replay suite for NeuLegion.
//
// The legion was developed against a single stream (BTCUSDT) whose prices sit in
// the thousands, so the controller's price arithmetic was only ever exercised in
// that regime. The shipped dataset now spans eight Binance 1h symbols, including
// sub-cent pairs, and that immediately surfaced the hardcoded 2-dp target grid:
// DOGEUSDT at $0.0013 truncated every target to 0.00, silently turning a
// "positive" controller into a short whose stop was hit on the next bar (see
// docs/BUGS.md and src/price_precision.js).
//
// This entry replays each symbol through the real controller around its
// *lowest-priced* window (the harshest regime) and asserts the directional
// contract holds for both polarities, that the signal fields stay finite, and
// that training still happens. It is the regression guard for the fix.
//
// Like candles.test.js it takes an optional `readFile` so the node mirror can run
// against the real filesystem; in the browser harness it reads via `__fs`. It
// also takes the standard `{ ensureSql }` option and loads the sql.js shim
// LAZILY: a static import of the shim would drag its CDN `https:` module into the
// node mirror, where the default ESM loader rejects that scheme
// (`ERR_UNSUPPORTED_ESM_URL_SCHEME`).

import { CANDLE_MANIFEST } from '../../../src/candles_audit.js';
import HiveMindController from '../../../src/hivemind/hiveMindController.js';

const PROJECT_ROOT = import.meta.dirname
    ? import.meta.dirname.replace(/[\\/]test[\\/]browser[\\/]entries$/, '')
    : '';

const PRICE = { atrFactor: 2, stopFactor: 1, minPriceMovement: 0.0025, maxPriceMovement: 0.05 };
const WINDOW = 150;
const STEP = 5;

function resolveReader(options) {
    if (options && typeof options.readFile === 'function') return options.readFile;
    if (globalThis.__fs && typeof globalThis.__fs.readTextFile === 'function') {
        return (p) => globalThis.__fs.readTextFile(p);
    }
    return null;
}

// The window that ends near the symbol's global minimum close: the price scale
// at which the target grid is least forgiving.
function harshestWindow(candles) {
    let mi = 0;
    for (let i = 0; i < candles.length; i++) if (candles[i].close < candles[mi].close) mi = i;
    const start = Math.max(0, Math.min(mi - 40, candles.length - WINDOW));
    return candles.slice(start, start + WINDOW);
}

function signalProblems(signal, polarity) {
    const bad = [];
    for (const k of ['entryPrice', 'sellPrice', 'stopLoss', 'score', 'tradeAcc', 'trueAcc', 'prob']) {
        if (typeof signal[k] !== 'number' || !Number.isFinite(signal[k])) bad.push(`${k}=${signal[k]}`);
    }
    if (polarity === 'positive') {
        if (!(signal.sellPrice > signal.entryPrice)) bad.push(`long target not above entry (${signal.sellPrice} <= ${signal.entryPrice})`);
        if (!(signal.stopLoss < signal.entryPrice)) bad.push(`long stop not below entry (${signal.stopLoss} >= ${signal.entryPrice})`);
    } else {
        if (!(signal.sellPrice < signal.entryPrice)) bad.push(`short target not below entry (${signal.sellPrice} >= ${signal.entryPrice})`);
        if (!(signal.stopLoss > signal.entryPrice)) bad.push(`short stop not above entry (${signal.stopLoss} <= ${signal.entryPrice})`);
    }
    if (signal.sellPrice <= 0 || signal.stopLoss <= 0) bad.push(`non-positive target (${signal.sellPrice}/${signal.stopLoss})`);
    if (signal.prob !== -1 && (signal.prob < 0 || signal.prob > 100)) bad.push(`prob out of range (${signal.prob})`);
    return bad;
}

export async function run(options = {}) {
    if (options.ensureSql) await options.ensureSql();
    else {
        const shim = await import('../shims/better-sqlite3.js');
        await shim.__ensureSql();
    }
    const readFile = resolveReader(options);
    const checks = [];
    const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });

    if (!readFile) {
        check('multi-symbol replay (no reader available - skipped)', true, 'no readFile');
        const failed = checks.filter((c) => !c.pass);
        return { total: checks.length, failed: failed.length, failures: failed, checks };
    }

    const summary = [];
    const allProblems = [];

    for (const entry of CANDLE_MANIFEST) {
        const path = `${PROJECT_ROOT}/${entry.file}`;
        let candles = [];
        try {
            const text = await readFile(path);
            candles = text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
        } catch (e) {
            allProblems.push(`${entry.symbol}: read failed (${e && e.message})`);
            continue;
        }
        if (candles.length < WINDOW + 1) { allProblems.push(`${entry.symbol}: too few candles`); continue; }

        const window = harshestWindow(candles);
        let minClose = Infinity;
        for (const c of candles) if (c.close < minClose) minClose = c.close;
        let inversions = 0;
        let steps = 0;
        let lastStep = 0;
        let sawPrediction = false;

        for (const polarity of ['positive', 'negative']) {
            const dir = new HiveMindController('M', `state/ms-${entry.symbol}-${polarity}`, 120, 4, polarity, 1, PRICE, true);
            for (let i = 40; i <= window.length; i += STEP) {
                const slice = window.slice(0, i);
                let signal = null;
                try {
                    signal = dir.getSignal(slice, 1, 0.025, 0.025, [], []);
                } catch (e) {
                    allProblems.push(`${entry.symbol}/${polarity}: threw at i=${i} (${e && e.message})`);
                    break;
                }
                if (!signal || signal.error) { allProblems.push(`${entry.symbol}/${polarity}: error at i=${i} (${signal && signal.error})`); break; }
                steps++;
                const problems = signalProblems(signal, polarity);
                if (problems.length) {
                    inversions++;
                    if (allProblems.length < 12) allProblems.push(`${entry.symbol}/${polarity}: ${problems.join('; ')}`);
                }
                if (signal.prob !== -1) sawPrediction = true;
                lastStep = signal.lastTrainingStep;
            }
        }

        summary.push({ symbol: entry.symbol, minClose, entry: window.at(-1).close, steps, inversions, lastStep, sawPrediction });
        check(`${entry.symbol}: replay produced signals`, steps > 0, `steps=${steps}`);
        check(`${entry.symbol}: no direction inversions at its lowest-price window`, inversions === 0,
            `inversions=${inversions}`);
        check(`${entry.symbol}: model trained and predicted`, lastStep > 0 && sawPrediction,
            `lastStep=${lastStep} pred=${sawPrediction}`);
    }

    check('every manifest symbol was replayed', summary.length === CANDLE_MANIFEST.length,
        `${summary.length}/${CANDLE_MANIFEST.length}`);
    check('the replay covers a sub-dollar regime (the bug trigger)', summary.some((s) => s.minClose < 1),
        JSON.stringify(summary.map((s) => [s.symbol, s.minClose])));
    check('the replay covers a high-price regime', summary.some((s) => s.minClose > 1000),
        JSON.stringify(summary.map((s) => [s.symbol, s.minClose])));
    check('no symbol produced a direction inversion anywhere', allProblems.length === 0,
        allProblems.slice(0, 6).join(' | '));

    const failed = checks.filter((c) => !c.pass);
    return { total: checks.length, failed: failed.length, failures: failed, checks, summary };
}
