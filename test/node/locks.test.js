// Node mirror for the lock-registry suite. Runs the browser entry's `run()` with
// a filesystem reader so the research-note existence checks execute unshimmed.
//
//   node --test test/node/locks.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { run } from '../browser/entries/locks.test.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = here.replace(/[\\/]test[\\/]node[\\/]?$/, '');

test('lock registry: every component classified and grounded', async () => {
    const result = await run({ readFile: (p) => readFile(p, 'utf8') });
    const failures = result.failures || [];
    assert.equal(result.failed, 0, failures.map((f) => `${f.name}: ${f.detail}`).join('\n'));
    assert.equal(result.total, 41, `expected exactly the 41 checks in the RUNBOOK.md §6 ledger, got ${result.total}`);
});
