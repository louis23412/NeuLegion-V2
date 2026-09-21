// Node mirror of test/browser/entries/multiprobe.test.js.
//
// The real-index section needs a real HiveMind (hence better-sqlite3), so it
// injects the real driver's no-op init and a temp state dir; the browser entry
// only lazily loads the sql.js shim when no `ensureSql` is supplied, so the CDN
// module is never touched here. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { run } from '../browser/entries/multiprobe.test.js';
import { labelledStateDir } from './helpers.js';

test('margin-ordered multi-probe LSH dominates the prefix probe and covers the flipped set', async () => {
    const result = await run({
        ensureSql: async () => {},
        stateDir: (label) => labelledStateDir(`nl-multiprobe-${label}`),
    });
    assert.equal(
        result.failed, 0,
        `${result.failed}/${result.total} multi-probe checks failed:\n${JSON.stringify(result.failures, null, 2)}`,
    );
    assert.equal(result.total, 77, `expected exactly the 77 checks in the RUNBOOK.md §6 ledger, got ${result.total}`);
});
