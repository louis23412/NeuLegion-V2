// Run-integrity guards suite (ROADMAP P0-1/P0-2).
//
// Proves the pure boundary helpers that keep a bad datum, a malformed config or
// a corrupt row from aborting a run:
//   * sanitize.js  — finite coercion, safe JSON, signal/consensus sanitising,
//                    the controller-failure budget, config fingerprinting
//   * rng.js       — deterministic derivation of a per-worker seed
//   * sanitize.assertControllerArgs — fail-fast config validation
//
// None of these helpers are on a hot arithmetic path; each is an error-path or
// setup-path guard, so the golden fingerprints are unaffected (proven
// separately by golden.test.js).

import {
    finiteOr, finiteOrNull, safeParseJSON, sanitizeSignal, sanitizeConsensus,
    resolveFailureBudget, failureBudgetExceeded, describeFailure,
    stableHash, configFingerprint, STRUCTURE_CONFIG_KEYS, assertControllerArgs,
} from '../../../src/legion/sanitize.js';
import { mulberry32, hashString, deriveSeed, installSeededRandom } from '../../../src/legion/rng.js';
import fs from 'fs';
import path from 'path';
import { readCandles, readCloses } from '../../../src/analyze.js';

export async function run() {
    const checks = [];
    const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });

    // ---- A. finiteOr -------------------------------------------------------
    check('finiteOr passes a finite number through unchanged', Object.is(finiteOr(3.25, 9), 3.25));
    check('finiteOr coerces a numeric string', finiteOr('12.5', 0) === 12.5);
    check('finiteOr falls back on NaN/Infinity', finiteOr(NaN, 7) === 7 && finiteOr(Infinity, 7) === 7 && finiteOr(-Infinity, 7) === 7);
    check('finiteOr falls back on null/undefined/empty', finiteOr(null, 7) === 7 && finiteOr(undefined, 7) === 7 && finiteOr('', 7) === 7);
    check('finiteOr falls back on a non-numeric string', finiteOr('abc', 7) === 7 && finiteOr(' 1 ', 7) === 7);
    check('finiteOr default fallback is 0', finiteOr(NaN) === 0);

    // ---- B. finiteOrNull ---------------------------------------------------
    check('finiteOrNull keeps a finite number', finiteOrNull(0) === 0 && finiteOrNull(-2.5) === -2.5);
    check('finiteOrNull returns null for anything invalid', finiteOrNull(NaN) === null && finiteOrNull(Infinity) === null && finiteOrNull('x') === null && finiteOrNull(undefined) === null);

    // ---- C. safeParseJSON --------------------------------------------------
    check('safeParseJSON parses valid text', safeParseJSON('{"a":1}').a === 1);
    check('safeParseJSON returns fallback on corrupt text', safeParseJSON('{oops', 'FB') === 'FB');
    check('safeParseJSON returns fallback on empty/absent text', safeParseJSON('', 'FB') === 'FB' && safeParseJSON(undefined, 'FB') === 'FB' && safeParseJSON(null, 'FB') === 'FB');
    check('safeParseJSON never throws on a truncated array', safeParseJSON('[1,2,', 0) === 0);
    check('safeParseJSON keeps primitives', safeParseJSON('42') === 42 && safeParseJSON('null', 'FB') === null);

    // ---- D. sanitizeSignal -------------------------------------------------
    const cleanSignal = { entryPrice: 1, sellPrice: 2, stopLoss: 0.5, prob: 73.5, score: 12, tradeAcc: 1, trueAcc: 2 };
    const cleanOut = sanitizeSignal(cleanSignal);
    check('sanitizeSignal is value-identical for a clean signal',
        Object.keys(cleanSignal).every((k) => Object.is(cleanSignal[k], cleanOut[k])) && Object.keys(cleanOut).length === Object.keys(cleanSignal).length);
    const dirty = sanitizeSignal({ entryPrice: NaN, sellPrice: Infinity, stopLoss: 'x', prob: NaN, score: undefined, tradeAcc: 1, trueAcc: 2 });
    check('sanitizeSignal zeroes non-finite prices', dirty.entryPrice === 0 && dirty.sellPrice === 0 && dirty.stopLoss === 0);
    check('sanitizeSignal maps a non-finite prob to the -1 sentinel', dirty.prob === -1);
    check('sanitizeSignal zeroes other non-finite numerics', dirty.score === 0 && dirty.tradeAcc === 1);
    check('sanitizeSignal preserves non-numeric payloads by reference',
        (() => { const mb = { memories: [1] }; const out = sanitizeSignal({ prob: 1, memoryBroadcast: mb }); return out.memoryBroadcast === mb; })());
    check('sanitizeSignal returns non-objects as-is', sanitizeSignal(null) === null && sanitizeSignal(7) === 7);

    // ---- E. sanitizeConsensus ---------------------------------------------
    const cons = sanitizeConsensus({ confidence: NaN, entryPrice: 5, exitPrice: Infinity, stopLoss: 1, profitPct: NaN, stopLossPct: 1, direction: 'BUY' });
    check('sanitizeConsensus zeroes non-finite fields', cons.confidence === 0 && cons.exitPrice === 0 && cons.profitPct === 0);
    check('sanitizeConsensus keeps finite fields + direction', cons.entryPrice === 5 && cons.stopLoss === 1 && cons.direction === 'BUY');

    // ---- F. failure budget -------------------------------------------------
    check('budget: a 10% fraction of 128 is 13', resolveFailureBudget(128, 0.1) === 13);
    check('budget: a fraction never rounds to zero', resolveFailureBudget(4, 0.1) === 1);
    check('budget: >1 is absolute', resolveFailureBudget(128, 5) === 5);
    check('budget: 0 means any failure breaches', resolveFailureBudget(128, 0) === 1);
    check('budget: null/negative/non-finite means never breach', resolveFailureBudget(128, null) === Infinity && resolveFailureBudget(128, -1) === Infinity && resolveFailureBudget(128, NaN) === Infinity);
    check('failureBudgetExceeded uses the resolved budget',
        failureBudgetExceeded(13, 128, 0.1) === false && failureBudgetExceeded(14, 128, 0.1) === true);
    check('failureBudgetExceeded is never true with a null budget', failureBudgetExceeded(999, 128, null) === false);

    // ---- G. describeFailure ------------------------------------------------
    const rec = describeFailure({ group: 1, section: 0, layer: 2, id: 3 }, Object.assign(new Error('boom'), { code: 'WORKER_TIMEOUT' }));
    check('describeFailure formats the controller id', rec.id === 'G1S0L2C3');
    check('describeFailure carries the code + message', rec.code === 'WORKER_TIMEOUT' && rec.message === 'boom');
    check('describeFailure defaults code + unknown controller', describeFailure(null, new Error('x')).code === 'WORKER_ERROR' && describeFailure(null, new Error('x')).id === 'unknown');

    // ---- H. stableHash / configFingerprint --------------------------------
    check('stableHash is key-order independent', stableHash({ a: 1, b: [2, { c: 3, d: 4 }] }) === stableHash({ b: [2, { d: 4, c: 3 }], a: 1 }));
    check('stableHash differs for different values', stableHash({ a: 1 }) !== stableHash({ a: 2 }));
    check('stableHash is 8 hex chars', /^[0-9a-f]{8}$/.test(stableHash({ a: 1 })));

    const baseCfg = { forceMin: true, baseGroups: 2, baseSections: 2, baseLayers: 2, basePairs: 2, elderPairs: 2, maxTier: 4, tierWeightMultiplier: 0.35, basePop: 64, baseCache: 500, baseProcessCount: 1, broadcastRatio: 0.025, injectionRatio: 0.025, httpPort: 3000, file: '/x' };
    const fp = configFingerprint(baseCfg);
    check('configFingerprint is stable for the same structure', fp === configFingerprint({ ...baseCfg }));
    check('configFingerprint changes when a structure key changes', fp !== configFingerprint({ ...baseCfg, basePop: 65 }) && fp !== configFingerprint({ ...baseCfg, maxTier: 5 }));
    check('configFingerprint ignores non-structure keys', fp === configFingerprint({ ...baseCfg, httpPort: 1234, file: '/y' }));
    check('STRUCTURE_CONFIG_KEYS excludes paths/ports', !STRUCTURE_CONFIG_KEYS.includes('httpPort') && !STRUCTURE_CONFIG_KEYS.includes('file'));

    // ---- I. rng ------------------------------------------------------------
    const a = mulberry32(42); const b = mulberry32(42); const c = mulberry32(43);
    const seqA = [a(), a(), a()]; const seqB = [b(), b(), b()];
    check('mulberry32 is deterministic for a seed', seqA.every((v, i) => v === seqB[i]));
    check('mulberry32 differs across seeds', mulberry32(43)() !== mulberry32(42)());
    check('mulberry32 stays in [0,1)', [c(), c(), c()].every((v) => v >= 0 && v < 1));
    check('hashString is stable + deterministic', hashString('G0S1L0C3') === hashString('G0S1L0C3') && hashString('a') !== hashString('b'));
    check('deriveSeed is deterministic', deriveSeed(7, 'A') === deriveSeed(7, 'A'));
    check('deriveSeed differs per worker key', deriveSeed(7, 'A') !== deriveSeed(7, 'B') && deriveSeed(7, 'A') !== deriveSeed(8, 'A'));
    check('deriveSeed returns a uint32', Number.isInteger(deriveSeed(7, 'A')) && deriveSeed(7, 'A') >= 0 && deriveSeed(7, 'A') <= 0xFFFFFFFF);

    const originalRandom = Math.random;
    try {
        const r1 = installSeededRandom(123);
        const v1 = Math.random();
        installSeededRandom(123);
        const v2 = Math.random();
        check('installSeededRandom makes Math.random deterministic', v1 === v2);
        check('installSeededRandom returns the stream', typeof r1 === 'function' && r1() >= 0);
    } finally {
        Math.random = originalRandom;
    }
    check('Math.random restored after the seeded test', Math.random === originalRandom);

    // ---- J. controller arg validation -------------------------------------
    const good = { dp: '/tmp/x', cs: 120, es: 4, type: 'positive', tier: 1, priceObj: { atrFactor: 2, stopFactor: 1, minPriceMovement: 0.0025, maxPriceMovement: 0.05 } };
    check('assertControllerArgs accepts a valid config', (() => { try { assertControllerArgs(good); return true; } catch { return false; } })());
    const rejects = (patch) => { try { assertControllerArgs({ ...good, ...patch }); return false; } catch { return true; } };
    check('rejects an empty directory path', rejects({ dp: '' }));
    check('rejects a non-positive cacheSize', rejects({ cs: 0 }) || rejects({ cs: -1 }) || rejects({ cs: NaN }));
    check('rejects a non-positive ensembleSize', rejects({ es: 0 }) || rejects({ es: NaN }));
    check('rejects an unknown type', rejects({ type: 'sideways' }));
    check('rejects a non-finite tier', rejects({ tier: 0 }) || rejects({ tier: NaN }));
    check('rejects a missing priceObj', rejects({ priceObj: null }));
    check('rejects a non-finite atrFactor', rejects({ priceObj: { ...good.priceObj, atrFactor: NaN } }));
    check('rejects a zero minPriceMovement', rejects({ priceObj: { ...good.priceObj, minPriceMovement: 0 } }));
    check('rejects a negative stopFactor', rejects({ priceObj: { ...good.priceObj, stopFactor: -1 } }));

    // ---- K. R26-10: the reader's boundary-degradation matrix ----------------
    // A run must degrade, never abort, on the six boundary inputs the sweep
    // matrix names: empty, short, corrupt row, NaN, duplicate timestamp and
    // shuffled order. The A/B reads candle JSONL through `readCandles`/`readCloses`
    // before any component touches it, so this is the first guard in the chain.
    const dir = path.join('.nl-guards-test');
    try { if (typeof fs.mkdirSync === 'function') fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    const write = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p; };
    try {
        const empty = write('empty.jsonl', '');
        check('reader: an empty file yields no rows (no throw)', readCandles(empty).length === 0 && readCloses(empty).length === 0);
        const short = write('short.jsonl', JSON.stringify({ timestamp: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 }));
        check('reader: a one-row file yields exactly one row', readCandles(short).length === 1 && readCloses(short).length === 1);
        const corrupt = write('corrupt.jsonl', [JSON.stringify({ timestamp: 1, close: 10 }), '{oops', JSON.stringify({ timestamp: 2, close: 11 })].join('\n'));
        check('reader: a corrupt row is skipped, the valid rows survive',
            readCandles(corrupt).length === 2 && readCandles(corrupt).map((c) => c.close).join(',') === '10,11' &&
            readCloses(corrupt).join(',') === '10,11');
        const nan = write('nan.jsonl', [JSON.stringify({ timestamp: 1, close: null }), JSON.stringify({ timestamp: 2, close: 'abc' }), JSON.stringify({ timestamp: 3, close: 7 })].join('\n'));
        check('reader: NaN / non-numeric closes are skipped; a close-only row is filled to a usable OHLCV bar',
            readCandles(nan).length === 1 &&
            JSON.stringify(readCandles(nan)[0]) === JSON.stringify({ timestamp: 3, open: 7, high: 7, low: 7, close: 7, volume: 1 }));
        const dup = write('dup.jsonl', [JSON.stringify({ timestamp: 5, close: 1 }), JSON.stringify({ timestamp: 5, close: 2 })].join('\n'));
        check('reader: a duplicate timestamp degrades to two rows (the auditor, not the reader, is the dedupe gate)',
            readCandles(dup).length === 2 && readCandles(dup).map((c) => c.close).join(',') === '1,2');
        const shuffled = write('shuffled.jsonl', [JSON.stringify({ timestamp: 9, close: 9 }), JSON.stringify({ timestamp: 1, close: 1 }), JSON.stringify({ timestamp: 5, close: 5 })].join('\n'));
        check('reader: a shuffled stream is preserved in file order (the reader never reorders time)',
            readCandles(shuffled).map((c) => c.timestamp).join(',') === '9,1,5');
        check('reader: maxBars takes the most recent rows, not the first',
            readCandles(shuffled, { maxBars: 2 }).map((c) => c.timestamp).join(',') === '1,5');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }

    const failed = checks.filter((x) => !x.pass);
    return { total: checks.length, failed: failed.length, failures: failed, checks };
}
