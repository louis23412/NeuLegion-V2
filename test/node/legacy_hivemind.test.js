// Node mirror of test/browser/entries/legacy_hivemind.test.js.
//
// The adapter constructs a real `HiveMind`, so this mirror runs it against the
// native better-sqlite3 driver (the browser entry runs the sql.js shim) — the same
// convention as `golden.test.js`/`surprise.test.js`. `labelledStateDir` memoises
// per label so a repeated `stateDir('det-a')` resolves to the SAME database, which
// is what the adapter's determinism check assumes.
//
//   node --test test/node/legacy_hivemind.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { run } from '../browser/entries/legacy_hivemind.test.js';
import { labelledStateDir } from './helpers.js';

test('the legacy-hivemind adapter is a pass-through over the shipped engine', async () => {
    const result = await run({
        ensureSql: async () => {},
        stateDir: (label) => labelledStateDir(`nl-legacy-${label}`),
    });
    const failures = result.failures || [];
    assert.equal(result.failed, 0, failures.map((f) => `${f.name}: ${f.detail}`).join('\n'));
    assert.equal(result.total, 15, `expected the 15 checks in the RUNBOOK.md §6 ledger, got ${result.total}`);
});
