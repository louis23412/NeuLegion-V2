// NeuLegion legion component: worker-thread dispatch
//
// Split out of the original monolithic src/mainController.js; the bodies are
// byte-identical apart from the shared mutable state being read/written as
// properties of the `state` holder (see ./state.js). src/mainController.js is
// now just the entry point that runs ./legion/runner.js.
//
// Run integrity (ROADMAP P0-1): every dispatch is settle-once and watchdogged,
// so a worker that hangs, crashes or posts a malformed message rejects with a
// *typed* error instead of suspending `Promise.all` forever. The rejection is
// caught and isolated by ./batch.js.

import { Worker } from 'node:worker_threads';
import { state } from './state.js';
import { CONFIG } from './config.js';
import { canonicalJSON } from './serialization.js';
import { getControllerParams } from './structure.js';
import { deriveSeed } from './rng.js';

export const WORKER_TIMEOUT = 'WORKER_TIMEOUT';
export const WORKER_ERROR = 'WORKER_ERROR';
export const WORKER_EXIT = 'WORKER_EXIT';
export const WORKER_MESSAGE = 'WORKER_MESSAGE';

const workerError = (code, message) => Object.assign(new Error(message), { code });

// Bring up the seeded RNG inside a worker exactly once, before any model math
// runs. With CONFIG.seed == null this is a no-op (native randomness), so the
// golden fingerprints and the existing tests are unaffected.
const workerDataFor = (id, extra = {}) => ({
    ...extra,
    seed: CONFIG.seed == null ? null : deriveSeed(CONFIG.seed, id),
});

export const runWorker = async (controller) => {
    const params = getControllerParams(controller.group, controller.section, controller.layer);
    const { cacheSize, atrFactor, stopFactor, minPriceMovement, maxPriceMovement, pop } = params;

    const recentCandles = state.cache.slice(-cacheSize);

    const mainId = `${controller.group}${controller.section}${controller.layer}${controller.id}`;
    const mainCompat = controller.lastSignal?.memoryBroadcast?.compatibility;

    const peerSharedMem = state.structureMap.flat(3)
        .filter((c) => {
            const peerId = `${c.group}${c.section}${c.layer}${c.id}`;
            const peerCompat = c.lastSignal?.memoryBroadcast?.compatibility;

            return (
                mainCompat &&
                mainId !== peerId &&
                c.type === controller.type &&
                c.tier === controller.tier &&
                canonicalJSON(mainCompat ?? {}) === canonicalJSON(peerCompat ?? {})
            );
        })
        .map(c => c.lastSignal?.memoryBroadcast ?? {});

    const childSharedMem = (state.structureMap[controller.group][controller.section][controller.layer])
        .filter((c) => {
            return (
                mainCompat &&
                c.type === controller.type &&
                controller.tier > 1 && 
                c.tier < controller.tier
            );
        })
        .map(c => c.lastSignal?.memoryBroadcast ?? {});

    controller.memConnections = peerSharedMem.length;
    controller.childConnections = childSharedMem.length;

    return runWorkerThread({
        url: new URL('../worker.js', import.meta.url),
        label: `G${controller.group}S${controller.section}L${controller.layer}C${controller.id}`,
        workerData: workerDataFor(mainId, {
            id: `G${controller.group}S${controller.section}L${controller.layer}C${controller.id}`,
            directoryPath: controller.directoryPath,
            cacheSize,
            pop,
            cache: recentCandles,
            type: controller.type,
            tier : controller.tier,
            priceObj: {
                atrFactor,
                stopFactor,
                minPriceMovement,
                maxPriceMovement,
            },
            processCount: CONFIG.baseProcessCount,
            forceMin: CONFIG.forceMin,
            bcR : CONFIG.broadcastRatio,
            injR : CONFIG.injectionRatio,
            sharedMem : peerSharedMem,
            childMem : childSharedMem
        }),
        // A signal worker must post a `signal` object; a bare/absent message is a
        // failure, not a success with an undefined signal.
        accept: (msg) => msg && !msg.error && msg.signal && typeof msg.signal === 'object',
        spawn: (url, workerData) => new Worker(url, { workerData }),
        onSuccess: (msg) => ({
            controller,
            signal: msg.signal,
            duration: msg.duration,
            quarantinedRows: Number.isFinite(msg.quarantinedRows) ? msg.quarantinedRows : 0,
        }),
    });
};

export const runConsolidationWorker = async (compat_id, isPositive, currentBatch) => {
    return runWorkerThread({
        url: new URL('../consolidation_worker.js', import.meta.url),
        label: `consolidation:${compat_id}:${isPositive ? 'pos' : 'neg'}`,
        workerData: workerDataFor(`${compat_id}${isPositive ? 'p' : 'n'}`, {
            compat_id,
            isPositive,
            currentBatch,
            config: {
                volatileConsolidationThreshold: CONFIG.volatileConsolidationThreshold,
                coreConsolidationThreshold: CONFIG.coreConsolidationThreshold,
                volatileConsolidationLimit: CONFIG.volatileConsolidationLimit,
                coreConsolidationLimit: CONFIG.coreConsolidationLimit,
                consolidationPromoteCount: CONFIG.consolidationPromoteCount,
                memoryDecayFloor: CONFIG.memoryDecayFloor,
                volatileMemoryDecayFactor: CONFIG.volatileMemoryDecayFactor,
                coreMemoryDecayFactor: CONFIG.coreMemoryDecayFactor,
                maxHierarchyProtos: CONFIG.maxHierarchyProtos,
                coreMinNeighbors: CONFIG.coreMinNeighbors,
                coreMaxNeighbors: CONFIG.coreMaxNeighbors,
                volatileMinNeighbors: CONFIG.volatileMinNeighbors,
                volatileMaxNeighbors: CONFIG.volatileMaxNeighbors,
            }
        }),
        accept: (msg) => msg && !msg.error && msg.delta != null,
        spawn: (url, workerData) => new Worker(url, { workerData }),
        onSuccess: (msg) => msg.delta,
    });
};

// Settle-once worker dispatch with a watchdog. `accept` classifies a posted
// message; `onSuccess` maps an accepted message to the resolved value.
//
// Every failure mode — an explicit `{error}` payload, an 'error' event, a
// non-zero exit, a malformed message, or a watchdog timeout — rejects with a
// typed Error carrying `code`. The worker is always terminated, and the
// watchdog timer is cleared, exactly once.
export const runWorkerThread = ({ url, label, workerData, accept, spawn, onSuccess, timeoutMs = CONFIG.workerTimeoutMs }) => {
    return new Promise((resolve, reject) => {
        let worker;
        try {
            worker = spawn(url, workerData);
        } catch (err) {
            reject(workerError(WORKER_ERROR, `[${label}] failed to spawn worker: ${err.message}`));
            return;
        }

        let settled = false;
        let timer = null;

        const finish = (fn, arg) => {
            if (settled) return;
            settled = true;
            if (timer) { clearTimeout(timer); timer = null; }
            try { Promise.resolve(worker.terminate()).catch(() => {}); } catch { /* already gone */ }
            fn(arg);
        };

        if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
            timer = setTimeout(
                () => finish(reject, workerError(WORKER_TIMEOUT, `[${label}] worker timed out after ${timeoutMs}ms`)),
                timeoutMs,
            );
            if (typeof timer.unref === 'function') timer.unref();
        }

        worker.on('message', (msg) => {
            if (msg && msg.error) {
                finish(reject, workerError(WORKER_ERROR, `[${label}] ${msg.error}`));
                return;
            }
            if (!accept(msg)) {
                finish(reject, workerError(WORKER_MESSAGE, `[${label}] worker posted a malformed message`));
                return;
            }
            finish(resolve, onSuccess(msg));
        });

        worker.on('error', (err) => finish(reject, workerError(WORKER_ERROR, `[${label}] ${err && err.message ? err.message : err}`)));

        worker.on('exit', (code) => {
            if (code === 0) return;
            finish(reject, workerError(WORKER_EXIT, `[${label}] worker exited with code ${code}`));
        });
    });
};
