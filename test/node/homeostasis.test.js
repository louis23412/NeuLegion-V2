// Node mirror of test/browser/entries/homeostasis.test.js.
//
// The suite needs a real HiveMind (hence better-sqlite3), so it injects the
// real driver's no-op init and a temp state dir; the browser entry only lazily
// loads the sql.js shim when no `ensureSql` is supplied, so the CDN module is
// never touched here. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { run } from '../browser/entries/homeostasis.test.js';
import { labelledStateDir } from './helpers.js';

test('homeostatic plasticity is bounded, contractive, and bit-exact when off', async () => {
    const result = await run({
        ensureSql: async () => {},
        stateDir: (label) => labelledStateDir(`nl-homeostasis-${label}`),
    });
    assert.equal(
        result.failed, 0,
        `${result.failed}/${result.total} homeostasis checks failed:\n${JSON.stringify(result.failures, null, 2)}`,
    );
    assert.equal(result.total, 30, `expected exactly the 30 checks in the RUNBOOK.md §6 ledger, got ${result.total}`);
});
