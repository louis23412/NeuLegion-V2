// Node mirror of test/browser/entries/golden.test.js.
//
// The golden entry is the bit-exactness lock: FNV-1a fingerprints of a fully
// deterministic training + controller trajectory. Every BIT_EXACT status in
// test/lock-registry.js rests on those 11 hashes, but until this mirror existed
// they had ONLY ever been checked through the sql.js shim in the browser harness
// — so "bit-exact" was, strictly, a claim about the shim's SQLite.
//
// This runs the identical entry against the REAL better-sqlite3 driver. Ten of
// the eleven fingerprints are expected to reproduce exactly, and the reasons are
// structural rather than lucky:
//   * the prototype loader reads with a full
//     `ORDER BY idx[, window|entry_idx], proto_idx` and places protos by index
//     (persistence/load.js), so driver row order cannot leak into the arrays;
//   * model matrices and prototype means/variances are persisted as raw
//     float32/float64 BLOBs, which round-trip byte-exact on both drivers;
//   * `diagnostics()` (the bulk of the fingerprinted payload) contains no
//     path-, clock- or driver-derived field, so it is a pure function of the
//     model state (verified by running the entry with an injected state
//     directory: all 11 hashes are unchanged).
// The exception is `hm:predictions`, and it is not about SQLite at all: it is
// the one fingerprint over raw, unrounded float64 `predict()` output, so a
// last-ulp difference in any transcendental (which two V8 builds can have) is
// visible there and nowhere else. The native run of this entry reproduced
// 22/23 checks bit-for-bit and differed ONLY on `hm:predictions`, with an
// identical canonical payload length — so the entry now hashes that one
// quantity rounded to 6 significant digits. `test/node/engine_portability.test.js`
// pins the invariant by running the entry under a simulated 1-ulp `Math.exp`
// drift and requiring all 23 checks to still hold. Recorded as `BUGS.md` #17
// (and #16 for the mirror itself).
// A mismatch on any OTHER hash is a finding, not a flake: it would mean the
// arithmetic is driver-dependent (e.g. an order- or representation-sensitive
// load path).
//
// The state dir is memoised per label: the controller is constructed once per
// simulated bar (121 times), so every `stateDir('ctl')` call must resolve to the
// SAME database, exactly as the browser default (`state/golden-ctl`) does.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { run } from '../browser/entries/golden.test.js';
import { labelledStateDir } from './helpers.js';

test('golden fingerprints are bit-identical on the native driver', async () => {
    const result = await run({
        ensureSql: async () => {},
        stateDir: (label) => labelledStateDir(`nl-golden-${label}`),
    });
    const prints = Object.entries(result.fingerprints || {}).map(([k, v]) => `${k}=${v}`).join(' ');
    assert.equal(
        result.failed, 0,
        `${result.failed}/${result.total} golden checks failed (${prints}):\n${JSON.stringify(result.failures, null, 2)}`,
    );
    assert.equal(result.total, 23, `expected the full golden lock, got ${result.total} checks`);
    assert.equal(Object.keys(result.fingerprints || {}).length, 11, 'expected 11 fingerprints');
});
