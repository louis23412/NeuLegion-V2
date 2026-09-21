// Node mirror of test/browser/entries/lsh.test.js.
//
// The suite needs a real HiveMind (hence better-sqlite3), so it injects the
// real driver's no-op init and a temp state dir; the browser entry only lazily
// loads the sql.js shim when no `ensureSql` is supplied, so the CDN module is
// never touched here. The state dir must be memoised PER LABEL (the entry saves
// and then reloads from `stateDir('I')`), hence `labelledStateDir`. Run with
// `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { run } from '../browser/entries/lsh.test.js';
import { labelledStateDir } from './helpers.js';

test('hyperplane LSH preserves recall and obeys the theta/pi rounding law', async () => {
    const result = await run({
        ensureSql: async () => {},
        stateDir: (label) => labelledStateDir(`nl-lsh-${label}`),
    });
    assert.equal(
        result.failed, 0,
        `${result.failed}/${result.total} LSH checks failed:\n${JSON.stringify(result.failures, null, 2)}`,
    );
    assert.equal(result.total, 69, `expected exactly the 69 checks in the RUNBOOK.md §6 ledger, got ${result.total}`);
});
