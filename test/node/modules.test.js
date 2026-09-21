// Node mirror of test/browser/entries/modules.test.js.
//
// The structural checks are environment-independent, so this simply runs the
// browser entry's `run()` (its relative imports resolve in Node too) and asserts
// that every check passed. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { run } from '../browser/entries/modules.test.js';

test('HiveMind component split is structurally sound', async () => {
    const result = await run();
    assert.equal(
        result.failed, 0,
        `${result.failed}/${result.total} structural checks failed:\n${JSON.stringify(result.failures, null, 2)}`,
    );
    assert.equal(result.total, 50, `expected exactly the 50 checks in the RUNBOOK.md §6 ledger, got ${result.total}`);
});
