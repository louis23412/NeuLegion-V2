// Node mirror of test/browser/entries/binarypc.test.js.
//
// The suite is pure (no HiveMind/database), so it needs no sql init; it accepts
// the options object for symmetry with the other mirrors. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { run } from '../browser/entries/binarypc.test.js';

test('binary principal components are exact and dominate random hashing (Eckart-Young)', async () => {
    const result = await run({ ensureSql: async () => {} });
    assert.equal(
        result.failed, 0,
        `${result.failed}/${result.total} binarypc checks failed:\n${JSON.stringify(result.failures, null, 2)}`,
    );
    assert.equal(result.total, 39, `expected exactly the 39 checks in the RUNBOOK.md §6 ledger, got ${result.total}`);
});
