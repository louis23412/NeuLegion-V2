// Node mirror of test/browser/entries/observer.test.js.
//
// The observer layer is pure except for its fs spool (which works on the real
// filesystem here), so the mirror runs the entry's `run()` and asserts every
// check passed. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { run } from '../browser/entries/observer.test.js';

test('observer metrics, alerts, report artifacts and collector', async () => {
    const result = await run();
    assert.equal(
        result.failed, 0,
        `${result.failed}/${result.total} observer checks failed:\n${JSON.stringify(result.failures, null, 2)}`,
    );
    assert.equal(result.total, 76, `expected exactly the 76 checks in the RUNBOOK.md §6 ledger, got ${result.total}`);
});
