// Node-only suite: R26-12's acceptance criterion, which the browser harness
// cannot prove.
//
// The shim cannot run two real controllers in one Worker and compare them
// (sql.js names every in-memory database from `Math.random()`, so a replaced
// seeded `Math.random` can alias two DBs — see "Test-harness limitations" in
// docs/BUGS.md). On the native driver each path is its own file, so this suite
// runs a REAL `runAnalysis` twice — once with the historical per-call checkpoint
// (`--save-interval=1`) and once with the A/B default (`Infinity`) — and asserts
// the acceptance criterion directly: the fold journal is byte-identical, and so
// is the verdict. Only the recorded `saveInterval` and the wall-clock may differ.
//
// Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runAnalysis } from '../../src/analyze.js';

const TRAIN = 40;
const TEST = 10;
const BARS = 80;

// A deterministic, non-degenerate synthetic candle series (a slow cycle plus a
// drift), written as the JSONL the reader expects.
function writeCandles(file, n) {
    const rows = [];
    let close = 100;
    const base = Date.parse('2024-01-01T00:00:00Z');
    for (let i = 0; i < n; i++) {
        const open = close;
        close = Math.max(1, close * (1 + Math.sin(i * 0.3) * 0.012 + 0.0005));
        rows.push(JSON.stringify({
            timestamp: new Date(base + i * 3600000).toISOString(),
            open,
            high: Math.max(open, close) + 0.2,
            low: Math.min(open, close) - 0.2,
            close,
            volume: 100 + (i % 7),
        }));
    }
    fs.writeFileSync(file, rows.join('\n'));
}

test('R26-12: the A/B checkpoint throttle is off the arithmetic path (native)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neulegion-throttle-'));
    try {
        const file = path.join(root, 'candles.jsonl');
        writeCandles(file, BARS);

        const runWith = (saveInterval) => runAnalysis({
            file,
            maxBars: BARS,
            trainSize: TRAIN,
            testSize: TEST,
            stateFolder: path.join(root, `state-${saveInterval === 1 ? 'one' : 'inf'}`),
            variantIds: ['surprise'],
            model: 'controller',
            writeFiles: true,
            audit: false,
            foldLog: 'all',
            modelRetention: 'discard',
            progressMs: -1,
            saveInterval,
        });

        const deep = await runWith(1);
        const never = await runWith(Infinity);

        const read = (runDir, name) => fs.readFileSync(path.join(runDir, name), 'utf8');
        const foldsDeep = read(deep.runDir, 'folds.jsonl');
        const foldsNever = read(never.runDir, 'folds.jsonl');

        // The acceptance criterion: a byte-identical fold journal. The journal
        // carries the bar indices, emitted positions, realised returns and
        // metrics of every scored pass — i.e. everything the verdict is made of.
        if (foldsDeep !== foldsNever) {
            const a = foldsDeep.split('\n');
            const b = foldsNever.split('\n');
            const at = a.findIndex((line, i) => line !== b[i]);
            assert.fail(`folds.jsonl differs at line ${at} (${a.length} vs ${b.length} lines):\n${a[at]}\n${b[at]}`);
        }

        // …and so is the verdict built from it.
        const cmp = (label, x, y) => assert.equal(JSON.stringify(x), JSON.stringify(y), `${label} moved between saveInterval=1 and Infinity`);
        cmp('baseline pooledMetrics', deep.report.baseline.pooledMetrics, never.report.baseline.pooledMetrics);
        cmp('candidate decisions', deep.report.candidates.map((c) => [c.id, c.promote, c.reasons]), never.report.candidates.map((c) => [c.id, c.promote, c.reasons]));
        cmp('candidate metrics', deep.report.candidates.map((c) => c.pooledMetrics), never.report.candidates.map((c) => c.pooledMetrics));
        cmp('summary', deep.report.summary, never.report.summary);

        // The throttle itself is recorded, so a report is never ambiguous about
        // whether it paid for per-call checkpoints.
        assert.equal(JSON.parse(read(deep.runDir, 'run.json')).saveInterval, 1);
        assert.equal(JSON.parse(read(never.runDir, 'run.json')).saveInterval, 'inf');
        assert.equal(deep.report.saveInterval, 1);
        assert.equal(never.report.saveInterval, 'inf');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('R26-12: the controller defaults to a per-call dump and flushes on demand', async () => {
    const { default: HiveMindController } = await import('../../src/hivemind/hiveMindController.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neulegion-flush-'));
    try {
        const c = new HiveMindController('FL', root, 120, 4, 'positive', 1, {
            atrFactor: 2, stopFactor: 1, minPriceMovement: 0.0025, maxPriceMovement: 0.05,
        }, true);
        assert.equal(c._saveInterval, 1, 'the production default must dump on every prediction/training call');
        assert.equal(c.flushState(), null, 'flushState is a no-op before the mind exists');

        const mind = new (await import('../../src/hivemind/hiveMind.js')).default(root, 4, c._inputSize, 'FL', true);
        c._hivemind = mind;
        c._saveInterval = Infinity;
        let dumps = 0;
        const real = mind.dumpState.bind(mind);
        mind.dumpState = (...a) => { dumps++; return real(...a); };
        const status = c.flushState();
        assert.ok(status && status.status, `flushState should report the save status, got ${JSON.stringify(status)}`);
        assert.equal(dumps, 1, 'flushState must write the state exactly once, ignoring the interval');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
