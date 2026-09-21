// Node mirror of test/browser/entries/evolve.test.js.
//
// The suite is pure (no HiveMind/database), so it needs no sql init; it accepts
// the options object for symmetry with the other mirrors. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { run } from '../browser/entries/evolve.test.js';

test('low-rank ES is an exact quadratic estimator with monotone convex descent', async () => {
    const result = await run({ ensureSql: async () => {} });
    assert.equal(
        result.failed, 0,
        `${result.failed}/${result.total} evolve checks failed:\n${JSON.stringify(result.failures, null, 2)}`,
    );
    assert.equal(result.total, 36, `expected exactly the 36 checks in the RUNBOOK.md §6 ledger, got ${result.total}`);
});
