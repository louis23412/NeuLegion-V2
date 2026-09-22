// Golden / bit-exactness regression lock for the hand-rolled core.
//
// `src/hivemind/hiveMind.js` is a single ~7.5k-line class whose behavior is
// chaotic: tiny changes to arithmetic order, to the seeded PRNG call sequence,
// or to a private-field assignment ripple into completely different weights
// after a few training steps. The behavioural suites (core / sanity /
// indicators / features) assert *properties*; this one asserts *exact bytes*.
//
// It runs a fully deterministic workload (seeded Math.random before every call,
// no wall-clock anywhere in the hivemind) and fingerprints the results with
// FNV-1a over a canonical rendering of the numbers. If a refactor changes any
// intermediate value, the hash changes and this suite fails — which is what
// makes large-scale restructuring (module extraction, mixin conversion,
// arithmetic hoisting) safe to attempt.
//
// When a change is INTENDED to alter numerics, update the constants at the
// bottom of this file in the same commit, and say why.
//
// Like the other entries it takes the standard `{ ensureSql, stateDir }` so the
// node mirror can run the SAME fingerprints against the real better-sqlite3
// driver (the sql.js shim is imported lazily, never statically: its CDN `https:`
// import is unresolvable in Node). The default `stateDir` reproduces the
// historical `state/golden-<label>` paths exactly, so browser fingerprints are
// unaffected — and none of the fingerprinted values derive from the path.

import HiveMind from '../../../src/hivemind/hiveMind.js';
import HiveMindController from '../../../src/hivemind/hiveMindController.js';

// ---------------------------------------------------------------- determinism

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function withSeed(seed, fn) {
    const real = Math.random;
    Math.random = mulberry32(seed);
    try { return fn(); } finally { Math.random = real; }
}

// Deterministic per-step input vectors: sinusoidal structure + noise + rare
// spikes, so protos form, merge and get pruned (exercising the LSH paths).
function makeInputs(inputSize, steps, seed = 7) {
    return withSeed(seed, () => {
        const rnd = Math.random;
        const rows = [];
        for (let s = 0; s < steps; s++) {
            const row = new Array(inputSize);
            for (let i = 0; i < inputSize; i++) {
                const base = Math.sin((s + i * 3) * 0.17) * 0.5 + 0.5;
                const noise = (rnd() - 0.5) * 0.4;
                const spike = (s % 37 === 0 && i % 5 === 0) ? (rnd() - 0.5) * 6 : 0;
                row[i] = base + noise + spike;
            }
            rows.push(row);
        }
        return rows;
    });
}

function makeCandles(n, { start = 100, seed = 1, trend = 0, vol = 1 } = {}) {
    const rnd = mulberry32(seed);
    const candles = [];
    let price = start;
    const baseTs = Date.parse('2024-01-01T00:00:00Z');
    for (let i = 0; i < n; i++) {
        const open = price;
        price = Math.max(0.5, price + trend * price + (rnd() - 0.5) * 2 * vol);
        const close = price;
        candles.push({
            timestamp: new Date(baseTs + i * 60000).toISOString(),
            open: Number(open.toFixed(4)),
            high: Number((Math.max(open, close) + rnd() * vol).toFixed(4)),
            low: Number((Math.min(open, close) - rnd() * vol).toFixed(4)),
            close: Number(close.toFixed(4)),
            volume: Math.round(1000 + rnd() * 5000),
        });
    }
    return candles;
}

// ---------------------------------------------------------------- fingerprint

// Canonical rendering: object keys sorted, every number stringified with its
// shortest round-trip representation (so Object.is-level distinctions like -0
// and NaN survive), typed arrays unwrapped.
function canonical(value, out) {
    if (value === null) { out.push('null'); return; }
    if (value === undefined) { out.push('undefined'); return; }
    const type = typeof value;
    if (type === 'number') { out.push(Object.is(value, -0) ? '-0' : String(value)); return; }
    if (type === 'string') { out.push(JSON.stringify(value)); return; }
    if (type === 'boolean' || type === 'bigint') { out.push(String(value)); return; }
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
        out.push('[');
        for (let i = 0; i < value.length; i++) canonical(value[i], out);
        out.push(']');
        return;
    }
    if (type === 'object') {
        out.push('{');
        for (const key of Object.keys(value).sort()) {
            out.push(key);
            canonical(value[key], out);
        }
        out.push('}');
        return;
    }
    if (type === 'function') { out.push('[fn]'); return; }
    out.push(String(value));
}

export function fingerprint(value) {
    const parts = [];
    canonical(value, parts);
    const text = parts.join('\u0001');
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return { hash: (hash >>> 0).toString(16).padStart(8, '0'), length: text.length };
}

const PRICE = { atrFactor: 2, stopFactor: 1, minPriceMovement: 0.0025, maxPriceMovement: 0.05 };

// One of the TWO fingerprints in this suite that are not engine-portable
// (`hm:postReloadPrediction` is the other — see below, ROADMAP P2-3), and it is
// deliberately compared at 6 significant digits.
//
// Why: `predict()` returns an unrounded float64 observable of the live ensemble,
// and it is the only fingerprinted quantity that is neither an integer count nor
// a float32-quantised value (proto means/variances live in Float32Arrays) nor a
// rounded output (the controller's prices/scores). A *systematic last-ulp*
// difference in a transcendental — exactly what two V8 builds can have — moves
// these 9 values by 1-3 ulps (measured ~1e-16 relative) while moving every other
// fingerprint by nothing at all; the native better-sqlite3 run of this same entry
// reproduced 22/23 checks bit-for-bit and differed only here, with an identical
// canonical payload length. So an exact hash here locks the *JS engine*, not the
// model.
//
// 6 significant digits keeps a behavioural lock 10 orders of magnitude tighter
// than the measured engine noise (a real change in retrieval, training or
// ensembling moves a probability by >>1e-6) while making the fingerprint
// engine-portable. `run()` also returns the raw values, and
// `test/node/engine_portability.test.js` pins this invariant by re-running the
// entry under a simulated last-ulp drift. See `docs/BUGS.md` #16.
export const roundPredictions = (values) => values.map((p) => Number(p.toPrecision(6)));

const EXPECTED = {
    'hm:diagnostics': '740d2e1a',
    // Re-frozen once, deliberately: this fingerprint is the *rounded* live
    // prediction sequence (see `roundPredictions` above and docs/BUGS.md #16).
    // It was `a2ce390b` while it hashed the raw float64 values, which made it the
    // one engine-sensitive check in the suite.
    'hm:predictions': 'b6ca75d6',
    // Re-frozen for the same reason (ROADMAP P2-3): it now hashes the *rounded*
    // post-reload prediction, so the last raw-float64 fingerprinted observable is
    // engine-portable too (it was `f9cef898` while raw).
    // 'hm:postReloadPrediction' below.
    'hm:memberCounts': 'e3341ca5',
    'hm:broadcast': '31d90624',
    'hm:translate': '8e4e4d29',
    'hm:postReloadPrediction': '5f703135',
    // Re-frozen once, deliberately, for round 26 R26-0 (BUGS.md #33). The
    // controller block used to be fed the whole growing candle prefix
    // (`cache.slice(0, i)`); production feeds the last `cacheSize` candles, and
    // the `_updateOpenTrades` entry-timestamp guard (added in R26-0) makes the
    // prefix shape behave identically — but the *old* values pinned the
    // pre-guard trajectory, i.e. the mislabelled #33 stream. The controller feed
    // is now the production window. `ctl:signalCount` and `ctl:lastTrainingStep`
    // are unchanged; `hm:*` are untouched. Was: ctl:finalSignal `224a8b19`,
    // ctl:signalTrajectory `17d78ef3`, ctl:accuracyTotals `a0ece37d`.
    'ctl:finalSignal': 'a7b13a39',
    'ctl:signalTrajectory': '5d341253',
    'ctl:signalCount': '74386641',
    'ctl:lastTrainingStep': '6433cfe3',
    'ctl:accuracyTotals': '09d8fb5a',
};

export async function run(options = {}) {
    if (options.ensureSql) await options.ensureSql();
    else {
        const shim = await import('../shims/better-sqlite3.js');
        await shim.__ensureSql();
    }
    const stateDir = options.stateDir || ((label) => `state/golden-${label}`);
    const checks = [];
    const actual = {};
    const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });
    const verify = (name, value) => {
        const { hash, length } = fingerprint(value);
        actual[name] = hash;
        const expected = EXPECTED[name];
        if (expected === '') {
            check(name, true, `CAPTURE ${hash} (len ${length})`);
        } else {
            check(name, hash === expected, `expected ${expected}, got ${hash} (len ${length})`);
        }
    };

    // ---- A. direct HiveMind training trajectory -------------------------------
    const predictions = [];
    try {
        const rows = makeInputs(12, 60, 7);
        let hm = null;
        const traj = withSeed(11, () => {
            const instance = new HiveMind(stateDir('hm'), 3, 12, 'G', true);
            for (let step = 0; step < rows.length; step++) {
                withSeed(1000 + step, () => instance.train(rows[step], step % 2));
                if (step % 7 === 0) {
                    predictions.push(withSeed(90000 + step, () => instance.predict(rows[step])));
                }
            }
            return instance;
        });
        hm = traj;

        const diag = hm.diagnostics();
        verify('hm:diagnostics', diag);
        verify('hm:predictions', roundPredictions(predictions));
        verify('hm:memberCounts', diag.members.map((m) => [m.semantic, m.attention, m.adaptive, m.coreEpisodic, m.bucketEntries]));

        check('hm: trained 60 steps', diag.trainingStepCount === 60, String(diag.trainingStepCount));
        check('hm: weights are finite', diag.weights.nonFinite === 0, String(diag.weights.nonFinite));
        check('hm: gradients are finite', diag.gradients.nonFinite === 0, String(diag.gradients.nonFinite));
        check('hm: LSH index is consistent', diag.lshConsistent === true, JSON.stringify(diag.problems));
        check('hm: predictions are probabilities', predictions.every((p) => p >= 0 && p <= 1), JSON.stringify(predictions));
        check('hm: predictions are not all equal', new Set(predictions.map(String)).size > 1, JSON.stringify(predictions));

        const bc = withSeed(4242, () => hm.broadcastMemory(rows[0], 0.025));
        verify('hm:broadcast', bc);
        const tr = withSeed(4243, () => hm.translateMemory(bc.memories, rows[0], 0.025));
        verify('hm:translate', tr);
        check('hm: broadcast/translate shapes', Array.isArray(bc.memories) && Number.isFinite(tr.injectedRatio));

        // Persistence: persist explicitly, reload, then run the identical seeded
        // predict on both instances.
        //
        // KNOWN FINDING (docs/BUGS.md — "state is not bit-idempotent through
        // SQLite"): a reloaded instance is only *numerically* equal to the live
        // one, not bit-equal. There are two independent causes:
        //   1. the BLOB columns are float32 while the in-memory matrices are
        //      float64, so the model is quantised on reload; and
        //   2. derived state is recomputed rather than restored — the loaded
        //      `_priorityIndices` is truncated to `_priorityMax` (the runtime uses
        //      `priorityMax * tempOverloadFactor`), and `projNorms` /
        //      `_cachedAvgVariance` are recomputed from the (identical) protos,
        //      whereas the live instance can hold stale cached values.
        // The check guards against a regression that makes the gap larger. It can
        // only be tightened to Object.is() once BOTH are addressed (float64 blobs
        // alone are not sufficient — see docs/BUGS.md for the measured breakdown).
        // `broadcastMemory`/`translateMemory` above mutate the memory banks, and
        // `predict()` runs the same maintenance pass (decay/prune) that training
        // does, so both instances must be driven through the identical predict
        // before their structures are compared.
        hm.dumpState();
        const reloaded = withSeed(11, () => new HiveMind(stateDir('hm'), 3, 12, 'G', true));
        const originalPrediction = withSeed(90000 + 56, () => hm.predict(rows[56]));
        const reloadPrediction = withSeed(90000 + 56, () => reloaded.predict(rows[56]));
        verify('hm:postReloadPrediction', roundPredictions([reloadPrediction]));
        const reloadGap = Math.abs(reloadPrediction - originalPrediction) / Math.max(1e-12, Math.abs(originalPrediction));
        check('hm: reload stays numerically equal (known float32-quantisation gap)',
            reloadGap < 1e-4,
            `${reloadPrediction} vs ${originalPrediction} (rel ${reloadGap.toExponential(3)})`);
        check('hm: reloaded memory structure matches live',
            fingerprint(reloaded.diagnostics().members).hash === fingerprint(hm.diagnostics().members).hash,
            'memory-bank populations or LSH bucket contents differ after an identical reload+predict');
    } catch (error) {
        check('hm: trajectory completed', false, error && error.stack ? error.stack : String(error));
    }

    // ---- B. controller signal trajectory --------------------------------------
    try {
        const cache = makeCandles(160, { seed: 3, trend: 0.0004, vol: 0.8 });
        const hashes = [];
        let last = null;
        let steps = 0;
        // The controller is fed the **production window shape** — the last
        // `cacheSize` (120) candles of the growing cache, exactly what
        // `legion/workers.js` passes (`state.cache.slice(-cacheSize)`) — rather
        // than the whole growing prefix. The prefix shape re-inserts the trimmed
        // history on every call and (before round 26) closed trades on bars older
        // than their entry (`BUGS.md` #33); the guard in `_updateOpenTrades` now
        // prevents that, and `core.test.js` pins the guard directly. This loop
        // pins the number the shipped path actually produces.
        for (let i = 40; i <= cache.length; i++) {
            const slice = cache.slice(Math.max(0, i - 120), i);
            last = withSeed(2000 + i, () => new HiveMindController(
                'G', stateDir('ctl'), 120, 4, 'positive', 1, PRICE, true,
            ).getSignal(slice, 1, 0.025, 0.025, [], []));
            if (last && !last.error) steps++;
            hashes.push(fingerprint(last).hash);
        }
        verify('ctl:finalSignal', last);
        verify('ctl:signalTrajectory', hashes);
        verify('ctl:signalCount', steps);
        verify('ctl:lastTrainingStep', last && last.lastTrainingStep);
        verify('ctl:accuracyTotals', last && [last.tradeAcc, last.trueAcc, last.score, last.totalMemoriesSent, last.totalMemoriesReceived]);

        check('ctl: produced signals for every warm step', steps === cache.length - 39, `${steps}/${cache.length - 39}`);
        check('ctl: final signal is internally consistent',
            last && !last.error && last.entryPrice === cache.at(-1).close && last.sellPrice > last.entryPrice && last.stopLoss < last.entryPrice,
            JSON.stringify({ entry: last && last.entryPrice, sell: last && last.sellPrice, stop: last && last.stopLoss }));
        check('ctl: signal fields stay finite',
            last && ['entryPrice', 'sellPrice', 'stopLoss', 'score', 'tradeAcc', 'trueAcc', 'prob'].every((k) => Number.isFinite(last[k])),
            JSON.stringify(last));
    } catch (error) {
        check('ctl: trajectory completed', false, error && error.stack ? error.stack : String(error));
    }

    return {
        total: checks.length,
        failed: checks.filter((c) => !c.pass).length,
        failures: checks.filter((c) => !c.pass),
        checks,
        fingerprints: actual,
        // Raw (unrounded) live predictions, for debugging and for the
        // engine-portability study — the *fingerprint* of this array is the one
        // observable that moves under a last-ulp transcendental drift, so the
        // raw values are what a divergence report needs. Reporting them does
        // not change any check.
        predictions,
    };
}
