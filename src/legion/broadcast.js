// NeuLegion legion component: HTTP state server and status broadcasting
//
// Split out of the original monolithic src/mainController.js; the bodies are
// byte-identical apart from the shared mutable state being read/written as
// properties of the `state` holder (see ./state.js). src/mainController.js is
// now just the entry point that runs ./legion/runner.js.

import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { state } from './state.js';
import { CONFIG, scriptStart } from './config.js';
import { updateInfluenceValues } from './accuracy.js';
import { getLegionConsensus } from './signals.js';
import { finiteOr } from './sanitize.js';

export const spawnDedicatedHttpServer = (ip, { reportPath = null } = {}) => {
    // Loopback-only by default (the dashboard is local). `ip` is retained for
    // callers that explicitly want a LAN bind, but the default path uses
    // CONFIG.httpHost so no CORS allow-list is needed.
    const host = CONFIG.httpHost || ip || '127.0.0.1';

    state.httpWorker = new Worker(new URL('../http_server_worker.js', import.meta.url), {
        workerData : {
            host,
            port : CONFIG.httpPort,
            reportPath,
        }
    });

    state.httpPort = CONFIG.httpPort;
    state.httpHost = host;

    // The worker reports the actually-bound port (a busy port falls back to an
    // ephemeral one) so the CLI/tests can print/connect to the right URL.
    state.httpWorker.on('message', (msg) => {
        if (msg && msg.type === 'LISTENING') {
            state.httpPort = msg.port;
            state.httpHost = msg.host;
            state.httpListening = true;
            console.log(`[HTTP] monitor dashboard at http://${msg.host}:${msg.port}`);
        }
    });

    state.httpWorker.on('error', (err) => {
        // A dashboard failure is never fatal to the run.
        console.error('[HTTP Worker] Error:', err && err.message ? err.message : err);
    });

    state.httpWorker.on('exit', (code) => {
        state.httpListening = false;
        if (code !== 0) console.error(`[HTTP Worker] Exited with code ${code}`);
    });

    return state.httpWorker;
};

export const getCleanLegionState = () => {
    const cleanControllers = state.structureMap.flat(3).map((c) => {
        // A controller whose first batch was isolated has no signal yet; every
        // derived field must still be finite so the snapshot cannot poison the
        // dashboard/report with NaN (ROADMAP P0-1).
        const entryPrice = finiteOr(c.lastSignal?.entryPrice, 0);
        const exitPrice = finiteOr(c.lastSignal?.sellPrice, 0);
        const stopLoss = finiteOr(c.lastSignal?.stopLoss, 0);

        const profitPct = entryPrice !== 0 ? Math.abs(Number((((exitPrice - entryPrice) / entryPrice) * 100).toFixed(3))) : 0;
        const stopLossPct = entryPrice !== 0 ? Math.abs(Number((((stopLoss - entryPrice) / entryPrice) * 100).toFixed(3))) : 0;

        return {
            id : c.lastSignal?.controllerId,
            polarity : c.type,
            tier : c.tier,
            signalSpeed : Number((finiteOr(c.signalSpeed, 0) / 1000).toFixed(4)),

            influence : 0,

            params : {
                population : c.lastSignal?.pop,
                cacheSize : c.lastSignal?.cache,
                inputSize : c.lastSignal?.inputSize,
                candlesUsed : c.lastSignal?.candlesUsed,
                indicatorsUsed : c.lastSignal?.indicatorsUsed,
                atrFactor : c.lastSignal?.atrFactor,
                stopFactor : c.lastSignal?.stopFactor,
                minMove : c.lastSignal?.minPriceMovement,
                maxMove : c.lastSignal?.maxPriceMovement
            },

            price : {
                entryPrice,
                exitPrice,
                stopLoss,

                profitPct,
                stopLossPct
            },

            stats : {
                probability : c.lastSignal?.prob,
                accuracyScore : c.lastSignal?.score,

                tradeAccuracy : c.lastSignal?.tradeAcc,
                probabilityAccuracy : c.lastSignal?.trueAcc,
                trainingSteps : c.lastSignal?.lastTrainingStep,
                skippedTraining : c.lastSignal?.skippedTraining,
                openSimulations : c.lastSignal?.openSimulations,
                pendingClosedTrades : c.lastSignal?.pendingClosedTrades,
            },

            memory : {
                memoryConnections : c.memConnections,
                childConnections : c.childConnections,
                totalSent : c.lastSignal?.totalMemoriesSent,
                totalReceived : c.lastSignal?.totalMemoriesReceived,
                lastInjectedTotal : c.lastSignal?.lastMemoriesInjected,
                controllerMemories : c.lastSignal?.currentMemories,
                lastInjectionRatio : c.lastSignal?.lastMemoryChange,
                lastMemoriesPerMember : c.lastSignal?.lastMemoriesPerMember,
                lastBroadcastPeerMemories : c.lastSignal?.memoryBroadcast?.totalBroadcast,
                lastBroadcastVaultMemories : c.lastSignal?.memoryBroadcast?.vaultMemories
            }
        }
    });

    const rankedAllControllers = cleanControllers.sort((b, c) => c.stats.accuracyScore - b.stats.accuracyScore);

    const pControllers = rankedAllControllers.filter(a => a.polarity === 'positive').map((obj) => {
        const {polarity, ...newObj} = obj;
        return newObj;
    });

    const nControllers = rankedAllControllers.filter(a => a.polarity === 'negative').map((obj) => {
        const {polarity, ...newObj} = obj;
        return newObj;
    });

    return {
        positive : {
            voters : pControllers,
        },

        negative : {
            voters : nControllers  
        }
    };
}

// Build the canonical per-batch snapshot. It is produced whether or not the
// dashboard worker is attached, so the observer (state.onBatchSnapshot) and the
// dry-run report share the exact payload the dashboard renders (ROADMAP P1).
export const buildLegionSnapshot = (status, updateTime = null, candle = null) => {
    const scriptUpdate = performance.now();
    const scriptUpdateTime = Number(((scriptUpdate - scriptStart) / 1000).toFixed(3));

    const controllers = getCleanLegionState();
    const { consensus, influenceList } = getLegionConsensus(candle);

    updateInfluenceValues(controllers, influenceList);

    const lastCandles = state.cache.slice(-10).map((x) => {
        return {
            id : x.timestamp,
            open : Number(x.open),
            close : Number(x.close),
            high : Number(x.high),
            low : Number(x.low),
            volume : Number(x.volume)
        }
    });

    const overview = {
        status,
        candleCounter: state.candleCounter,
        updateTime,
        runtimeSeconds : scriptUpdateTime,
        population : state.structureMap.flat(3).reduce((acc, val) => acc + finiteOr(val.lastSignal?.pop, 0), 0),
        candleRepairs : state.candleRepairs,
        controllerFailures : state.controllerFailures,
        totalControllerFailures : state.totalControllerFailures,
        consolidationFailures : state.consolidationFailures,
        failedBatches : state.failedBatches,
        quarantinedRows : state.quarantinedRows,
        malformedCandleLines : state.malformedCandleLines,
    };

    return {
        status,
        updateTime,
        runtimeSeconds : scriptUpdateTime,
        overview,
        consensus,
        lastCandles,
        controllers,
        alerts: Array.isArray(state.alerts) ? state.alerts : [],
        dateTime: new Date().toISOString(),
    };
};

export const broadcastLegionState = (status, statusOnly = false, updateTime = null, candle = null) => {
    const scriptUpdate = performance.now();
    const scriptUpdateTime = Number(((scriptUpdate - scriptStart) / 1000).toFixed(3));

    if (statusOnly) {
        if (state.httpWorker) {
            state.httpWorker.postMessage({
                type: 'UPDATE_STATUS',
                status,
                runtimeSeconds : scriptUpdateTime
            });
        }
        return null;
    }

    const snapshot = buildLegionSnapshot(status, updateTime, candle);

    if (state.httpWorker) {
        state.httpWorker.postMessage({
            type: 'UPDATE_FULL_STATE',
            overview: snapshot.overview,
            consensus: snapshot.consensus,
            lastCandles: snapshot.lastCandles,
            controllers: snapshot.controllers,
            alerts: snapshot.alerts,
        });
    }

    // Observer hook: read-only, must never affect the run.
    if (typeof state.onBatchSnapshot === 'function') {
        try {
            state.onBatchSnapshot(snapshot);
        } catch (err) {
            console.error('[observer] snapshot hook failed:', err && err.message ? err.message : err);
        }
    }

    return snapshot;
};


