// Node-only: pins that the golden lock is ENGINE-PORTABLE — i.e. that no golden
// fingerprint depends on a JS engine's last-ulp transcendental behaviour.
//
// Why this exists. `hm:predictions` used to hash the RAW float64 `predict()`
// return values, so it was the one fingerprint in the suite that moved when the
// arithmetic primitives moved by an ulp. On the real better-sqlite3 driver,
// 22/23 golden checks were bit-identical and only `hm:predictions` differed,
// with an identical canonical payload length (a last-digit difference, not a
// different value) — and the golden workload does no database work until its
// final `dumpState()`, so the cause is pure JS, not the driver. It is now the
// only fingerprint compared rounded (6 significant digits); `docs/BUGS.md` #17
// records the finding and the fix.
//
// This test institutionalises the invariant so a future fingerprint cannot
// silently re-introduce the problem. It runs the full golden entry ONCE with a
// systematic +1-ulp drift applied to EVERY `Math.exp` result — the shape of a
// real engine difference (two V8 builds, or a different engine) — and asserts:
//   (a) the drift was actually applied (call count), and
//   (b) all 23 checks still pass, which is only possible because the rounded
//       `hm:predictions` absorbs it: pre-fix, this exact setup failed 1/23
//       (`hm:predictions` a2ce390b -> 81f63c94) with every other hash unchanged.
// It then re-derives the discriminating power directly from the returned raw
// values: a 1-ulp move in them changes the RAW fingerprint but not the rounded
// one that the lock uses.
//
// One golden pass per process, deliberately: it keeps this mirror identical in
// shape to `golden.test.js` rather than depending on cross-run process state.
// (Repeated in-process runs of an entry are known to be hazardous — the browser
// harness cannot do them at all; see "Test-harness limitations" in docs/BUGS.md.)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { run, fingerprint, roundPredictions } from '../browser/entries/golden.test.js';
import { labelledStateDir } from './helpers.js';

// Exactly +1 ulp, via the bit pattern (works for normals of either sign).
const CELL = new DataView(new ArrayBuffer(8));
function bump1ulp(v) {
    if (!Number.isFinite(v) || v === 0) return v;
    CELL.setFloat64(0, v);
    let bits = CELL.getBigUint64(0);
    bits += v > 0 ? 1n : -1n;
    CELL.setBigUint64(0, bits);
    return CELL.getFloat64(0);
}

test('golden fingerprints are invariant under a last-ulp transcendental drift', async () => {
    const realExp = Math.exp;
    let expCalls = 0;
    let result;
    Math.exp = (x) => { expCalls++; return bump1ulp(realExp(x)); };
    try {
        result = await run({
            ensureSql: async () => {},
            stateDir: (label) => labelledStateDir(`nl-golden-portable-${label}`),
        });
    } finally {
        Math.exp = realExp;
    }

    assert.ok(expCalls > 100000, `the drift was not applied (${expCalls} Math.exp calls)`);

    const prints = Object.entries(result.fingerprints || {}).map(([k, v]) => `${k}=${v}`).join(' ');
    assert.equal(
        result.failed, 0,
        `${result.failed}/${result.total} golden checks failed under a last-ulp transcendental drift `
        + `(${prints}):\n${JSON.stringify(result.failures, null, 2)}`,
    );
    assert.equal(result.total, 23, `expected the full golden lock, got ${result.total} checks`);

    // Teeth: the returned predictions are the drifted ones, and a further 1-ulp
    // move in them is visible to a RAW fingerprint but not to the rounded one the
    // lock uses. (If `hm:predictions` ever goes back to hashing raw values, the
    // run above fails; if the rounding ever gets looser, this stays meaningful
    // because it is stated as an exact equality on the rounded hash.)
    const raw = result.predictions;
    const bumped = raw.map(bump1ulp);
    assert.ok(
        raw.some((p, i) => p !== bumped[i]),
        `test setup: the 1-ulp bump must move at least one returned prediction (${JSON.stringify(raw)})`,
    );
    assert.notEqual(
        fingerprint(raw).hash, fingerprint(bumped).hash,
        'test setup: raw float64 predictions must be ulp-visible to the fingerprint',
    );
    assert.equal(
        fingerprint(roundPredictions(raw)).hash, fingerprint(roundPredictions(bumped)).hash,
        'the 6-significant-digit rounding must absorb a 1-ulp move in the predictions',
    );
    assert.equal(
        fingerprint(roundPredictions(raw)).hash, result.fingerprints['hm:predictions'],
        'the returned raw predictions must be the ones `hm:predictions` was hashed from',
    );
});
