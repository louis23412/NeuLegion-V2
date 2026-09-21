// NeuLegion legion component: candle stream runner
//
// Split out of the original monolithic src/mainController.js; the bodies are
// byte-identical apart from the shared mutable state being read/written as
// properties of the `state` holder (see ./state.js). src/mainController.js is
// now just the entry point that runs ./legion/runner.js.
//
// Run integrity (ROADMAP P0-1/P0-3): the loop is now explicit —
//   * a malformed candle line is counted and skipped, never fatal;
//   * a failed batch is logged and the stream CONTINUES (only a controller
//     failure budget or `maxFailedBatches` consecutive failures stop it);
//   * the loop can be bounded (`maxBatches`) and returns a structured summary,
//     which is what makes the end-to-end dry-run / runner smoke test possible;
//   * `processCandles()` (the CLI entry) keeps the historical keep-alive.

import fs from 'fs';
import readline from 'readline';
import { performance } from 'node:perf_hooks';
import { state } from './state.js';
import { CONFIG } from './config.js';
import { spawnDedicatedHttpServer, broadcastLegionState } from './broadcast.js';
import { saveLegionState } from './persistence.js';
import { initLegion } from './init.js';
import { processBatch } from './batch.js';
import { getLocalIP } from './net.js';
import { isImplausibleCandle, repairCandle, stripRepairFlags } from '../candle_quality.js';

// Run the candle stream. Returns a structured summary once the stream stops.
// `keepAlive` reproduces the historical `processCandles()` behaviour of never
// resolving (the CLI relies on it: the HTTP dashboard keeps the process alive).
export const runStream = async ({
    file = CONFIG.file,
    maxBatches = CONFIG.maxBatches,
    keepAlive = true,
    onBatch = null,
    ipAddress = null,
    reportPath = null,
} = {}) => {
    const fileStream = fs.createReadStream(file);
    const rd = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
    });

    state.structureDims = [
        CONFIG.baseGroups, CONFIG.baseSections, CONFIG.baseLayers,
        (CONFIG.basePairs * 2) + ((CONFIG.maxTier - 1) * (CONFIG.elderPairs * 2))
    ];

    const rebuildCounter = initLegion();

    if (CONFIG.httpEnabled && !state.httpWorker) {
        spawnDedicatedHttpServer(ipAddress ?? getLocalIP(), { reportPath });
    }

    const maxGroup = state.structureDims[0] - 1;
    const maxSection = state.structureDims[1] - 1;
    const maxLayer = state.structureDims[2] - 1;
    const maxCacheFactor = (1 + CONFIG.groupCacheBoost * maxGroup) * (1 + CONFIG.sectionCacheBoost * maxSection) * (1 + CONFIG.layerCacheBoost * maxLayer);
    const maxCache = Math.round(CONFIG.baseCache * maxCacheFactor);

    let finalTime = 0;
    let completedBatches = 0;
    let consecutiveFailedBatches = 0;
    let stopped = null;

    for await (const line of rd) {
        if (!line.trim()) continue;

        let candle;
        try {
            candle = JSON.parse(line);
        } catch (e) {
            // A single malformed line must not abort a long run: count it and
            // move on (ROADMAP P0-1).
            state.malformedCandleLines++;
            console.error(`Invalid JSON line skipped (total ${state.malformedCandleLines}).`);
            continue;
        }

        // Winsorize implausible wicks before they reach the indicator pipeline
        // (see src/candle_quality.js). The check is a no-op for the overwhelming
        // majority of bars, so the clean-data path stays allocation-free.
        if (CONFIG.candleWickRepair && isImplausibleCandle(candle, { maxWickFraction: CONFIG.candleMaxWickFraction })) {
            candle = stripRepairFlags(repairCandle(candle, { maxWickFraction: CONFIG.candleMaxWickFraction }));
            state.candleRepairs++;
            console.log(`Repaired implausible wick at ${candle.timestamp} (total ${state.candleRepairs}).`);
        }

        state.cache.push(candle);
        if (state.cache.length > maxCache) {
            state.cache = state.cache.slice(-maxCache);
        }

        if (state.cache.length !== maxCache) continue;

        state.candleCounter++;
        if (state.candleCounter <= rebuildCounter) continue;

        const finalStart = performance.now();

        const updateMessage = `Processing candle #${state.candleCounter}...`;
        console.log(updateMessage);
        broadcastLegionState(updateMessage, true);

        let batchOk = true;
        try {
            await processBatch();
        } catch (err) {
            batchOk = false;
            state.failedBatches++;
            consecutiveFailedBatches++;
            console.error(`[batch ${state.candleCounter}] processBatch failed: ${err && err.message ? err.message : err}`);
            broadcastLegionState(`batch error - ${err && err.message ? err.message : err}`, true);

            const budgetBreach = err && err.code === 'CONTROLLER_FAILURE_BUDGET';
            if (budgetBreach || consecutiveFailedBatches >= CONFIG.maxFailedBatches) {
                try { saveLegionState(); } catch (saveErr) { console.error('saveLegionState after failure failed:', saveErr && saveErr.message); }
                stopped = budgetBreach ? 'controller-failure-budget' : 'failed-batches';
                console.error(`Stopping after batch ${state.candleCounter}: ${stopped}.`);
                fileStream.destroy();
                rd.close();
                break;
            }
        }
        if (batchOk) consecutiveFailedBatches = 0;

        try {
            saveLegionState();
        } catch (err) {
            // Persistence failure is logged, not fatal: the previous checkpoint
            // stays valid (its transaction rolled back) and the run continues.
            console.error(`[batch ${state.candleCounter}] saveLegionState failed: ${err && err.message ? err.message : err}`);
        }

        const finalEnd = performance.now();
        finalTime = Number(((finalEnd - finalStart) / 1000).toFixed(3));
        state.lastBatchDurationMs = finalEnd - finalStart;
        state.totalBatchDurationMs += state.lastBatchDurationMs;

        const finalMessage = `completed in ${finalTime} seconds`;
        console.log(finalMessage);
        broadcastLegionState(finalMessage, false, finalTime, state.cache.at(-1));

        completedBatches++;

        if (typeof onBatch === 'function') {
            try {
                onBatch({
                    batch: state.candleCounter,
                    ok: batchOk,
                    durationMs: state.lastBatchDurationMs,
                    completedBatches,
                });
            } catch (err) {
                console.error('[runner] onBatch hook failed:', err && err.message ? err.message : err);
            }
        }

        if (CONFIG.cutoff && state.candleCounter % CONFIG.cutoff === 0) {
            console.log('Cutoff reached, HTTP state server is still running.');
            broadcastLegionState('stopped - cutoff', true);
            fileStream.destroy();
            rd.close();
            stopped = 'cutoff';
            break;
        }

        if (Number.isFinite(maxBatches) && completedBatches >= maxBatches) {
            console.log(`maxBatches (${maxBatches}) reached; stopping after ${completedBatches} batch(es).`);
            broadcastLegionState('stopped - max batches', true);
            fileStream.destroy();
            rd.close();
            stopped = 'max-batches';
            break;
        }
    }

    if (!stopped) {
        console.log('End of file reached, HTTP state server is still running.');
        broadcastLegionState(`stopped - end of file`, true);
        stopped = 'end-of-file';
    }

    const summary = {
        stopped,
        completedBatches,
        candleCounter: state.candleCounter,
        failedBatches: state.failedBatches,
        totalControllerFailures: state.totalControllerFailures,
        totalConsolidationFailures: state.totalConsolidationFailures,
        malformedCandleLines: state.malformedCandleLines,
        candleRepairs: state.candleRepairs,
        lastBatchDurationMs: state.lastBatchDurationMs,
        totalBatchDurationMs: state.totalBatchDurationMs,
    };

    if (keepAlive) await new Promise(() => {});
    return summary;
};

// CLI entry point (unchanged contract: reads CONFIG.file and stays alive).
export const processCandles = async () => runStream();
