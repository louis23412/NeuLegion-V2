// Run-directory / report artifact lifecycle (ROADMAP P0-2/P1-2). Node-only: it
// exercises the real `observer/report.js` against a real filesystem, including
// the parts the browser harness cannot (readdir-based retention pruning).
//
// Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    makeRunId, createRunDirectory, pruneRunDirectories,
    writeJson, readJson, appendSnapshot, appendLog, writeReport,
} from '../../src/observer/report.js';

test('run ids are deterministic, timestamped and seed-tagged', () => {
    assert.equal(makeRunId({ seed: 1, startedAt: Date.UTC(2026, 0, 2, 3, 4, 5) }), '20260102T030405-seed1');
    assert.equal(makeRunId({ seed: null, startedAt: Date.UTC(2026, 0, 2, 3, 4, 5) }), '20260102T030405-seednone');
    assert.equal(
        makeRunId({ seed: 7, startedAt: Date.UTC(2025, 11, 31, 23, 59, 59) }),
        '20251231T235959-seed7',
    );
});

test('run directory, manifest, spool, report and retention', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-report-'));
    try {
        const ids = [
            makeRunId({ seed: 1, startedAt: Date.UTC(2026, 0, 2, 3, 4, 5) }),
            makeRunId({ seed: 2, startedAt: Date.UTC(2026, 0, 2, 3, 4, 6) }),
            makeRunId({ seed: 3, startedAt: Date.UTC(2026, 0, 2, 3, 4, 7) }),
        ];
        assert.deepEqual(ids, ['20260102T030405-seed1', '20260102T030406-seed2', '20260102T030407-seed3']);

        const dirs = ids.map((id) => createRunDirectory(root, id));
        assert.ok(dirs.every((d) => fs.existsSync(d)));
        assert.ok(/runs[\\/]20260102T030407-seed3$/.test(dirs[2]));

        const runDir = dirs[2];
        writeJson(runDir, 'run.json', { runId: ids[2], seed: 3, configFingerprint: 'deadbeef' });
        assert.equal(readJson(runDir, 'run.json').seed, 3);
        assert.equal(readJson(runDir, 'run.json').configFingerprint, 'deadbeef');
        assert.equal(readJson(runDir, 'missing.json', { fb: true }).fb, true);

        assert.equal(appendSnapshot(runDir, { batch: 1, brier: 0.2 }), true);
        assert.equal(appendSnapshot(runDir, { batch: 2, brier: 0.25 }), true);
        assert.equal(appendLog(runDir, 'info', 'hello', { a: 1 }), true);

        writeReport(runDir, { version: 1, metrics: { brier: 0.25 } });

        const spool = fs.readFileSync(path.join(runDir, 'snapshots.jsonl'), 'utf8').trim().split('\n');
        assert.equal(spool.length, 2);
        assert.equal(JSON.parse(spool[1]).batch, 2);
        const log = fs.readFileSync(path.join(runDir, 'run.log'), 'utf8').trim().split('\n');
        assert.equal(JSON.parse(log[0]).message, 'hello');
        assert.equal(JSON.parse(log[0]).data.a, 1);
        assert.equal(readJson(runDir, 'report.json').version, 1);

        // Retention keeps the NEWEST `keep` directories (lexicographic order on
        // the timestamp-prefixed id is chronological).
        assert.deepEqual(pruneRunDirectories(root, 2), { removed: [ids[0]] });
        assert.equal(fs.existsSync(dirs[0]), false);
        assert.equal(fs.existsSync(dirs[1]), true);
        assert.equal(fs.existsSync(dirs[2]), true);

        assert.deepEqual(pruneRunDirectories(root, 0).removed, ids.slice(1));
        assert.equal(fs.existsSync(path.join(root, 'runs')), true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('pruning an absent runs/ root is a safe no-op', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-report-empty-'));
    try {
        assert.deepEqual(pruneRunDirectories(root, 5), { removed: [] });
        assert.deepEqual(pruneRunDirectories(path.join(root, 'does-not-exist'), 5), { removed: [] });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
