// Node mirror of test/browser/entries/walkforward.test.js.
//
// The real-candle section drives a live HiveMind (hence better-sqlite3) over a
// shipped symbol and reads that symbol's JSONL, so this mirror injects the real
// driver, a real `fs` reader, and a temp state dir. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { run } from '../browser/entries/walkforward.test.js';
import { labelledStateDir } from './helpers.js';

test('walk-forward harness evaluates a live HiveMind out-of-sample on real candles', async () => {
    const result = await run({
        ensureSql: async () => {},
        stateDir: (label) => labelledStateDir(`nl-walkforward-${label}`),
        readFile: (p) => readFile(p, 'utf8'),
    });
    assert.equal(
        result.failed, 0,
        `${result.failed}/${result.total} walk-forward checks failed:\n${JSON.stringify(result.failures, null, 2)}`,
    );
    assert.equal(result.total, 62, `expected exactly the 62 checks in the RUNBOOK.md §6 ledger, got ${result.total}`);
});
