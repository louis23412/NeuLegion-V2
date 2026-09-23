// Node mirror of test/browser/entries/analyze.test.js.
//
// The A/B core is model-agnostic (the entry injects its signals), so the mirror
// runs the entry's `run()` and asserts every check passed. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { run } from '../browser/entries/analyze.test.js';

test('A/B analysis driver evaluates, audits and decides the variant family', async () => {
    const result = await run();
    assert.equal(
        result.failed, 0,
        `${result.failed}/${result.total} analyze checks failed:\n${JSON.stringify(result.failures, null, 2)}`,
    );
    assert.equal(result.total, 245, `expected exactly the 245 checks in the RUNBOOK.md §6 ledger, got ${result.total}`);
});
