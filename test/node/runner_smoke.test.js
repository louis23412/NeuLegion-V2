// Runner smoke + run-integrity (ROADMAP P0-1/P0-2/P0-3). Node-only: it drives
// the REAL `runner → batch → worker → HiveMindController` path (hence
// better-sqlite3) over a tiny synthetic stream with the compact dry-run config,
// then asserts the run-integrity behaviour end-to-end:
//   * a good stream completes its batches with no failures and finite signals;
//   * a malformed candle line is counted and skipped, never fatal;
//   * the canonical broadcast snapshot is finite and well-formed;
//   * a broken controller pool breaches the failure budget and stops the run
//     (rather than corrupting it or hanging).
//
// `npm test` runs this (and it uses a throwaway state dir, never the repo's).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { configureDryRun, writeSyntheticStream } from '../../src/dryrun.js';

// Configure the compact config ONCE and load the legion modules AFTER it, so the
// SQLite databases (opened at module-eval time) live in the throwaway dir.
let modsPromise = null;
async function load() {
    if (modsPromise) return modsPromise;
    modsPromise = (async () => {
        const stateFolder = configureDryRun({ batches: 1 });
        const { CONFIG } = await import('../../src/legion/config.js');
        const { state } = await import('../../src/legion/state.js');
        const { initLegion } = await import('../../src/legion/init.js');
        const { runStream } = await import('../../src/legion/runner.js');
        const { broadcastLegionState } = await import('../../src/legion/broadcast.js');
        const { processBatch } = await import('../../src/legion/batch.js');
        return { CONFIG, state, initLegion, runStream, broadcastLegionState, processBatch, stateFolder };
    })();
    return modsPromise;
}

test('a good synthetic stream completes with no failures', async () => {
    const { CONFIG, state, runStream, stateFolder } = await load();
    const file = path.join(stateFolder, 'good.jsonl');
    // maxCache (compact) + a couple of look-ahead candles.
    writeSyntheticStream(file, 24, { seed: 3 });

    const summary = await runStream({ file, maxBatches: 1, keepAlive: false });

    assert.equal(summary.completedBatches, 1, `stopped=${summary.stopped}`);
    assert.equal(summary.stopped, 'max-batches');
    assert.equal(summary.failedBatches, 0);
    assert.equal(summary.malformedCandleLines, 0);
    assert.equal(summary.totalControllerFailures, 0);
    assert.ok(summary.candleCounter >= 1);
    assert.ok(summary.totalBatchDurationMs >= 0 && Number.isFinite(summary.totalBatchDurationMs));
    assert.equal(state.failedBatches, 0);
    assert.equal(state.controllerFailures, 0);
});

test('every produced signal is finite and the snapshot is well-formed', async () => {
    const { state, broadcastLegionState } = await load();
    const controllers = state.structureMap.flat(3);
    assert.ok(controllers.length > 0);
    for (const c of controllers) {
        assert.ok(c.lastSignal && Object.keys(c.lastSignal).length > 0, `controller G${c.group}S${c.section}L${c.layer}C${c.id} has no signal`);
        for (const key of ['entryPrice', 'sellPrice', 'stopLoss', 'prob', 'score']) {
            assert.ok(Number.isFinite(c.lastSignal[key]), `${key} finite (got ${c.lastSignal[key]})`);
        }
    }

    const snap = broadcastLegionState('smoke', false);
    assert.ok(snap && snap.overview);
    assert.equal(snap.overview.failedBatches, 0);
    assert.ok(Number.isFinite(snap.overview.population) && snap.overview.population >= 0);
    assert.ok(Number.isFinite(snap.overview.runtimeSeconds));
    assert.ok(Array.isArray(snap.controllers.positive.voters) && snap.controllers.positive.voters.length > 0);
    for (const v of snap.controllers.positive.voters) {
        assert.ok(Number.isFinite(v.price.entryPrice));
        assert.ok(Number.isFinite(v.signalSpeed));
        assert.ok(Number.isFinite(v.stats.probability) || v.stats.probability === undefined);
    }
});

test('a malformed candle line is counted and skipped, never fatal', async () => {
    const { runStream, stateFolder } = await load();
    const file = path.join(stateFolder, 'mixed.jsonl');
    writeSyntheticStream(file, 24, { seed: 5 });
    // Prepend garbage so it is read BEFORE the batch completes (the runner stops
    // at maxBatches, so a trailing line would never be read).
    fs.writeFileSync(file, `oops this is not json\n${fs.readFileSync(file, 'utf8')}`);

    const before = (await load()).state.malformedCandleLines;
    const summary = await runStream({ file, maxBatches: 1, keepAlive: false });

    assert.equal(summary.malformedCandleLines, before + 1);
    assert.equal(summary.completedBatches, 1);
    assert.equal(summary.failedBatches, 0);
});

test('a broken controller pool breaches the failure budget and stops the run', async () => {
    const { CONFIG, state, initLegion, processBatch } = await load();

    state.structureDims = [
        CONFIG.baseGroups, CONFIG.baseSections, CONFIG.baseLayers,
        (CONFIG.basePairs * 2) + ((CONFIG.maxTier - 1) * (CONFIG.elderPairs * 2)),
    ];
    initLegion();

    // Force every slot to fail construction (an empty directory path is rejected
    // by assertControllerArgs inside the worker).
    const controllers = state.structureMap.flat(3);
    assert.ok(controllers.length >= 2, `need a >1 pool to exceed the budget, got ${controllers.length}`);
    for (const c of controllers) c.directoryPath = '';

    await assert.rejects(
        () => processBatch(),
        (err) => {
            assert.equal(err.code, 'CONTROLLER_FAILURE_BUDGET', err.message);
            return true;
        },
    );
    assert.equal(state.controllerFailures, controllers.length);
    assert.equal(state.totalControllerFailures, controllers.length);
    assert.ok(state.lastControllerFailures.length >= 1);
    assert.ok(state.lastControllerFailures.every((r) => r.code === 'WORKER_ERROR' && typeof r.id === 'string'));
});
