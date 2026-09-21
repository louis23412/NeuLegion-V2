// Node mirror of test/browser/entries/price_precision.test.js.
//
// The module is pure, so the browser entry runs unchanged under Node; this only
// asserts every check passed. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { run } from '../browser/entries/price_precision.test.js';

test('price precision keeps the target grid finer than the minimum movement', async () => {
    const result = await run();
    assert.equal(
        result.failed, 0,
        `${result.failed}/${result.total} price-precision checks failed:\n${JSON.stringify(result.failures, null, 2)}`,
    );
    assert.equal(result.total, 29, `expected exactly the 29 checks in the RUNBOOK.md §6 ledger, got ${result.total}`);
});
