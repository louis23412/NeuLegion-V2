// Node-only suite: R26-4's acceptance criterion, which the browser harness cannot
// prove.
//
// The parallel fold loop dispatches each fold-pass to a real `worker_threads`
// worker (`src/analysis/fold_worker.js`), so it can only be exercised on the
// native driver. This suite runs a REAL `runAnalysis` twice over the same candles —
// once serial (`concurrency 1`) and once with two fold-passes in flight — and
// asserts the acceptance criterion directly: `folds.jsonl` is byte-identical, and
// so is the verdict (everything but the wall-clock `timings`). The audit stays
// serial and reads the same scored signals, so its passes must be identical too.
//
// Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runAnalysis } from '../../src/analyze.js';

const TRAIN = 40;
const TEST = 5;
const BARS = 70;

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

test('R26-4: the parallel fold loop produces a byte-identical folds.jsonl and verdict (native)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neulegion-parallel-'));
    try {
        const file = path.join(root, 'candles.jsonl');
        writeCandles(file, BARS);

        const runWith = (concurrency) => runAnalysis({
            file,
            maxBars: BARS,
            trainSize: TRAIN,
            testSize: TEST,
            stateFolder: path.join(root, `state-${concurrency}`),
            variantIds: ['surprise'],
            model: 'controller',
            writeFiles: true,
            audit: true,
            auditProbesPerFold: 1,
            foldLog: 'all',
            modelRetention: 'discard',
            progressMs: -1,
            concurrency,
        });

        const serial = await runWith(1);
        const parallel = await runWith(2);

        const read = (runDir, name) => fs.readFileSync(path.join(runDir, name), 'utf8');
        const foldsSerial = read(serial.runDir, 'folds.jsonl');
        const foldsParallel = read(parallel.runDir, 'folds.jsonl');

        if (foldsSerial !== foldsParallel) {
            const a = foldsSerial.split('\n');
            const b = foldsParallel.split('\n');
            const at = a.findIndex((line, i) => line !== b[i]);
            assert.fail(`folds.jsonl differs at line ${at} (${a.length} vs ${b.length} lines):\n${a[at]}\n${b[at]}`);
        }

        // The verdict built from the journal must not move either (only timings,
        // which are wall-clock and deliberately excluded).
        const strip = (r) => JSON.stringify({
            baseline: { model: r.baseline.model, pooledMetrics: r.baseline.pooledMetrics },
            candidates: r.candidates.map((c) => ({ id: c.id, promote: c.promote, reasons: c.reasons, model: c.model, pooledMetrics: c.pooledMetrics })),
            summary: r.summary,
        });
        assert.equal(strip(parallel.report), strip(serial.report), 'the parallel verdict moved');

        // The width is recorded, so a report is never ambiguous about how it ran.
        assert.equal(JSON.parse(read(serial.runDir, 'run.json')).concurrency, 1);
        assert.equal(JSON.parse(read(parallel.runDir, 'run.json')).concurrency, 2);
        assert.equal(serial.report.concurrency, 1);
        assert.equal(parallel.report.concurrency, 2);

        // The per-fold model diagnostics (R26-2) survive the worker round-trip.
        assert.ok(parallel.report.baseline.model && parallel.report.baseline.model.trained === true,
            'the parallel run must still carry a trained baseline model block');
        assert.deepEqual(parallel.report.baseline.model.raw, serial.report.baseline.model.raw,
            'the worker-pooled label counters must match the serial counters');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
