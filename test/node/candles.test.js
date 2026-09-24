// Node mirror of test/browser/entries/candles.test.js.
//
// The audit is pure and environment-independent; only the file reader differs.
// This runs the exact same entry against the real filesystem (async read, so
// the 8 shipped JSONL streams can be parsed without blocking), and asserts
// every check passed. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { run } from '../browser/entries/candles.test.js';

test('shipped candle data passes integrity audit', async () => {
    const result = await run({
        readFile: async (p) => fs.promises.readFile(p, 'utf8'),
    });
    assert.equal(
        result.failed, 0,
        `${result.failed}/${result.total} candle-audit checks failed:\n${JSON.stringify(result.failures, null, 2)}`,
    );
    assert.equal(result.total, 192, `expected exactly the 192 checks in the RUNBOOK.md §6 ledger, got ${result.total}`);
});
