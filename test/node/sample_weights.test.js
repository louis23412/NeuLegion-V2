// Node mirror of test/browser/entries/sample_weights.test.js.
//
// The suite needs a real HiveMind (hence better-sqlite3), so it injects the
// real driver's no-op init and a temp state dir; the browser entry only lazily
// loads the sql.js shim when no `ensureSql` is supplied, so the CDN module is
// never touched here. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { run } from '../browser/entries/sample_weights.test.js';
import { labelledStateDir } from './helpers.js';

test('sample-uniqueness weighting is exact and the train step is linear in the weight', async () => {
    const result = await run({
        ensureSql: async () => {},
        stateDir: (label) => labelledStateDir(`nl-sample-weights-${label}`),
    });
    assert.equal(
        result.failed, 0,
        `${result.failed}/${result.total} sample_weights checks failed:\n${JSON.stringify(result.failures, null, 2)}`,
    );
    assert.equal(result.total, 57, `expected exactly the 57 checks in the RUNBOOK.md §6 ledger, got ${result.total}`);
});
