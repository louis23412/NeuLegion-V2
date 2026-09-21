// Configuration env overrides (ROADMAP P0-2). Node-only: the overrides are
// applied at config module-evaluation time (BEFORE `legion/database.js` derives
// its paths from `CONFIG.stateFolder`), so they can only be observed from a
// fresh process. Each case spawns a child that prints the resolved CONFIG.
//
// Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const configUrl = pathToFileURL(path.join(projectRoot, 'src/legion/config.js')).href;

const printScript = [
    `import { CONFIG } from '${configUrl}';`,
    `console.log(JSON.stringify({`,
    `  stateFolder: CONFIG.stateFolder, file: CONFIG.file,`,
    `  httpPort: CONFIG.httpPort, httpHost: CONFIG.httpHost, httpEnabled: CONFIG.httpEnabled,`,
    `  seed: CONFIG.seed, maxBatches: CONFIG.maxBatches,`,
    `}));`,
].join('\n');

const runConfig = (env) => {
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', printScript], {
        cwd: projectRoot,
        env: { ...process.env, ...env },
        encoding: 'utf8',
    });
    assert.equal(res.status, 0, `child failed:\n${res.stderr}`);
    const lines = res.stdout.trim().split('\n').filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
};

test('no env overrides keeps the historical defaults', () => {
    const base = runConfig({});
    assert.ok(typeof base.stateFolder === 'string' && base.stateFolder.length > 0);
    assert.ok(typeof base.file === 'string' && base.file.endsWith('candles.jsonl'));
    assert.equal(base.httpPort, 3000);
    assert.equal(base.httpHost, '127.0.0.1');
    assert.equal(base.httpEnabled, true);
    assert.equal(base.seed, null);
    assert.equal(base.maxBatches, null);
});

test('every override is applied before the databases open', () => {
    const over = runConfig({
        NEULEGION_STATE: 'custom-state',
        NEULEGION_FILE: 'custom-candles.jsonl',
        NEULEGION_HTTP_PORT: '3210',
        NEULEGION_HTTP_HOST: '0.0.0.0',
        NEULEGION_HTTP: '0',
        NEULEGION_SEED: '777',
        NEULEGION_MAX_BATCHES: '5',
    });
    assert.ok(over.stateFolder.endsWith(`custom-state`), over.stateFolder);
    assert.ok(over.file.endsWith(`custom-candles.jsonl`), over.file);
    assert.equal(over.httpPort, 3210);
    assert.equal(over.httpHost, '0.0.0.0');
    assert.equal(over.httpEnabled, false);
    assert.equal(over.seed, 777);
    assert.equal(over.maxBatches, 5);
});
