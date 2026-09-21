// Graceful shutdown (ROADMAP P0-2). Node-only: it boots the real
// `src/mainController.js` as a child process on a compact config with a long
// synthetic stream, sends SIGINT mid-run, and asserts the process exits cleanly
// AND leaves a checkpointed run directory (manifest + report) behind.
//
// SIGINT is not delivered the same way on Windows, so the test is skipped there.
//
// Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const srcUrl = (rel) => pathToFileURL(path.join(projectRoot, rel)).href;
const posix = (p) => p.split(path.sep).join('/');

test('SIGINT checkpoints and writes the run report', { skip: process.platform === 'win32' }, async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-shutdown-'));
    const streamFile = path.join(stateDir, 'candles.jsonl');
    const childFile = path.join(stateDir, 'child.mjs');

    fs.writeFileSync(childFile, [
        `import { CONFIG } from '${srcUrl('src/legion/config.js')}';`,
        `import { configureDryRun, writeSyntheticStream } from '${srcUrl('src/dryrun.js')}';`,
        `const stateFolder = process.env.NL_STATE;`,
        `configureDryRun({ batches: 100000, stateFolder });`,
        `writeSyntheticStream('${posix(streamFile)}', 4000);`,
        `CONFIG.file = '${posix(streamFile)}';`,
        `CONFIG.maxRunDirectories = 3;`,
        `await import('${srcUrl('src/mainController.js')}');`,
        '',
    ].join('\n'));

    let out = '';
    const child = spawn(process.execPath, [childFile], {
        cwd: projectRoot,
        env: { ...process.env, NL_STATE: stateDir },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });

    // Wait until the run is actually processing a batch, then interrupt it.
    await new Promise((resolve) => {
        const t0 = Date.now();
        const iv = setInterval(() => {
            if (/Processing candle/.test(out) || Date.now() - t0 > 10000) { clearInterval(iv); resolve(); }
        }, 100);
    });
    child.kill('SIGINT');

    const code = await new Promise((resolve) => {
        child.on('exit', (c) => resolve(c));
        setTimeout(() => { child.kill('SIGKILL'); resolve('timeout'); }, 20000);
    });
    assert.equal(code, 0, `child exited ${code}\n--- child output ---\n${out.slice(-3000)}`);

    const runsRoot = path.join(stateDir, 'runs');
    assert.ok(fs.existsSync(runsRoot), `no runs/ directory\n${out.slice(-1500)}`);
    const runs = fs.readdirSync(runsRoot);
    assert.ok(runs.length >= 1, 'no run directory was created');

    const runDir = path.join(runsRoot, runs[0]);
    for (const name of ['run.json', 'report.json']) {
        assert.ok(fs.existsSync(path.join(runDir, name)), `${name} missing from ${runDir}`);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    assert.ok(typeof manifest.configFingerprint === 'string' && manifest.configFingerprint.length > 0);
    assert.ok(Number.isFinite(manifest.startedAt));

    const report = JSON.parse(fs.readFileSync(path.join(runDir, 'report.json'), 'utf8'));
    assert.ok(report.metrics && Number.isFinite(report.metrics.brier), JSON.stringify(report.metrics));

    fs.rmSync(stateDir, { recursive: true, force: true });
});
