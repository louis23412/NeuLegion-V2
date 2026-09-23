// Node mirror of test/browser/entries/controller_invariants.test.js (R27-6).
//
// The suite needs the real better-sqlite3 driver and a real filesystem read for
// the shipped-candle timestamp lock, so it injects the real driver's no-op init,
// temp state dirs and an async file reader. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { run } from '../browser/entries/controller_invariants.test.js';
import { labelledStateDir } from './helpers.js';

test('controller determinism + open-book invariants hold', async () => {
    const result = await run({
        ensureSql: async () => {},
        stateDir: (label) => labelledStateDir(`nl-ctl-invariants-${label}`),
        readFile: async (p) => fs.promises.readFile(p, 'utf8'),
    });
    assert.equal(
        result.failed, 0,
        `${result.failed}/${result.total} controller_invariants checks failed:\n${JSON.stringify(result.failures, null, 2)}`,
    );
    assert.equal(result.total, 23, `expected exactly the 23 checks in the RUNBOOK.md §6 ledger, got ${result.total}`);
});
