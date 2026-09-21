// Node mirror for the analysis supercharges suite. The suite is pure (no I/O),
// so it runs identically under node:test.
//
//   node --test test/node/analysis.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../browser/entries/analysis.test.js';

test('analysis: performance/splits/labels/uniqueness exactness', async () => {
    const result = await run();
    const failures = result.failures || [];
    assert.equal(result.failed, 0, failures.map((f) => `${f.name}: ${f.detail}`).join('\n'));
    assert.equal(result.total, 437, `expected exactly the 437 checks in the RUNBOOK.md §6 ledger, got ${result.total}`);
});
