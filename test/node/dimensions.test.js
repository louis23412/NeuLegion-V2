// Node mirror of test/browser/entries/dimensions.test.js.
//
// The suite constructs real `HiveMind` instances (hence better-sqlite3), so this
// mirror injects the real driver and an isolated temp state dir per label. Run
// with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { run } from '../browser/entries/dimensions.test.js';
import { labelledStateDir } from './helpers.js';

test('dimensions: structure-scaling contract for both forceMin branches', async () => {
    const result = await run({
        ensureSql: async () => {},
        stateDir: (label) => labelledStateDir(`nl-dimensions-${label}`),
    });
    assert.equal(
        result.failed, 0,
        `${result.failed}/${result.total} dimension checks failed:\n${JSON.stringify(result.failures, null, 2)}`,
    );
    assert.equal(result.total, 185, `expected exactly the 185 checks in the RUNBOOK.md §6 ledger, got ${result.total}`);
});
