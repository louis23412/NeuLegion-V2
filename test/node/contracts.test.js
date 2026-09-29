// Node mirror of test/browser/entries/contracts.test.js.
//
// The suite is pure (no HiveMind/database), but section H reads the source tree to
// enforce the import law, so this mirror supplies a filesystem reader AND a
// recursive listing (the listing is what catches a NEW file that violates the law
// while never appearing in the manifest).
//
//   node --test test/node/contracts.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { run } from '../browser/entries/contracts.test.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = here.replace(/[\\/]test[\\/]node[\\/]?$/, '');

async function listSourceFiles() {
    const out = [];
    const walk = async (dir, prefix) => {
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const rel = `${prefix}/${entry.name}`;
            if (entry.isDirectory()) await walk(`${dir}/${entry.name}`, rel);
            else if (entry.name.endsWith('.js')) out.push(rel);
        }
    };
    for (const root of ['core', 'plugins']) await walk(`${projectRoot}/src/${root}`, `src/${root}`);
    return out;
}

test('the V2 contract layer is well-formed, the port is exact, and the import law holds', async () => {
    const result = await run({
        readFile: (p) => readFile(`${projectRoot}/${p}`, 'utf8'),
        listFiles: () => listSourceFiles(),
    });
    const failures = result.failures || [];
    assert.equal(result.failed, 0, failures.map((f) => `${f.name}: ${f.detail}`).join('\n'));
    assert.equal(result.total, 201, `expected the 201 checks in the RUNBOOK.md §6 ledger, got ${result.total}`);
});
