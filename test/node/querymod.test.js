// Node mirror of test/browser/entries/querymod.test.js.
//
// The suite is pure (no SQL, no HiveMind), so the mirror just runs it and
// asserts the check count. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { run } from '../browser/entries/querymod.test.js';

test('dynamic query modification matches the LSH theorems and the denoising law', async () => {
    const result = await run();
    assert.equal(
        result.failed, 0,
        `${result.failed}/${result.total} query-modification checks failed:\n${JSON.stringify(result.failures, null, 2)}`,
    );
    assert.equal(result.total, 51, `expected exactly the 51 checks in the RUNBOOK.md §6 ledger, got ${result.total}`);
});
