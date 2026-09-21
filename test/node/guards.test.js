// Node mirror of test/browser/entries/guards.test.js.
//
// The guards are pure (no DB, no shims), so the mirror simply runs the entry's
// `run()` and asserts every check passed. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { run } from '../browser/entries/guards.test.js';

test('run-integrity guards hold (sanitize, rng, config fingerprint)', async () => {
    const result = await run();
    assert.equal(
        result.failed, 0,
        `${result.failed}/${result.total} guard checks failed:\n${JSON.stringify(result.failures, null, 2)}`,
    );
    assert.equal(result.total, 58, `expected exactly the 58 checks in the RUNBOOK.md §6 ledger, got ${result.total}`);
});
