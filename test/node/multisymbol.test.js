// Node mirror of test/browser/entries/multisymbol.test.js.
//
// Runs the exact same entry against the real filesystem (async reads, so the
// eight shipped JSONL streams parse without blocking) and the real
// better-sqlite3 driver, and asserts every check passed. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { run } from '../browser/entries/multisymbol.test.js';

test('every shipped symbol keeps its trade direction across the price range', async () => {
    const result = await run({
        ensureSql: async () => {},
        readFile: async (p) => fs.promises.readFile(p, 'utf8'),
    });
    assert.equal(
        result.failed, 0,
        `${result.failed}/${result.total} multi-symbol checks failed:\n${JSON.stringify(result.failures, null, 2)}`,
    );
    assert.equal(result.total, 28, `expected exactly the 28 checks in the RUNBOOK.md §6 ledger, got ${result.total}`);
    assert.equal(result.summary.length, 8, `expected 8 symbols, got ${result.summary.length}`);
});
