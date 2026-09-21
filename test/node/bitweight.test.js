// Node mirror of test/browser/entries/bitweight.test.js.
//
// The suite is pure (no HiveMind/database), so it needs no sql init; it accepts
// the options object for symmetry with the other mirrors. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { run } from '../browser/entries/bitweight.test.js';

test('bit-reliability law, weighted Hamming and the aligned-index prediction', async () => {
    const result = await run({ ensureSql: async () => {} });
    assert.equal(
        result.failed, 0,
        `${result.failed}/${result.total} bitweight checks failed:\n${JSON.stringify(result.failures, null, 2)}`,
    );
    assert.equal(result.total, 69, `expected exactly the 69 checks in the RUNBOOK.md §6 ledger, got ${result.total}`);
});
