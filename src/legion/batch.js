// NeuLegion legion component: per-candle batch processing pipeline
//
// Split out of the original monolithic src/mainController.js; the bodies are
// byte-identical apart from the shared mutable state being read/written as
// properties of the `state` holder (see ./state.js). src/mainController.js is
// now just the entry point that runs ./legion/runner.js.

import { state } from './state.js';
import { PriorityQueue } from './priorityQueue.js';
import { CONFIG } from './config.js';
import { memoryDb } from './database.js';
import { getCompatIdPos, getCompatIdNeg, purgeVolatilePos, purgeVolatileNeg, purgeCorePos, purgeCoreNeg, countCorePos, countCoreNeg, countVolPos, countVolNeg, getCountCorePos, getCountCoreNeg, getCountVolPos, getCountVolNeg, selectTopCorePos, selectTopCoreNeg, selectTopVolPos, selectTopVolNeg, selectAllMemoriesPos, selectAllMemoriesNeg, accessMemoryCorePos, accessMemoryCoreNeg, accessMemoryVolPos, accessMemoryVolNeg, boostCorePos, boostCoreNeg, boostVolatilePos, boostVolatileNeg, selectMemCorePos, selectMemCoreNeg, selectMemVolPos, selectMemVolNeg, getNeighbors, storeNewMemories, applyBulkDeltas } from './statements.js';
import { blobToVector, canonicalJSON, computeGaussianDistance } from './serialization.js';
import { runWorker, runConsolidationWorker } from './workers.js';
import { failureBudgetExceeded, describeFailure, finiteOr } from './sanitize.js';

// Record one isolated controller failure. The controller keeps its previous
// `lastSignal` (so persistence/broadcast stay well-formed) and the run
// continues; only a *budget* breach stops it (run integrity, ROADMAP P0-1).
const recordControllerFailure = (controller, error, batch) => {
    const record = describeFailure(controller, error);
    record.batch = batch;
    state.totalControllerFailures++;
    state.lastControllerFailures.push(record);
    if (state.lastControllerFailures.length > 50) state.lastControllerFailures.shift();
    if (controller && controller.lastSignal == null) controller.lastSignal = {};
    if (controller && !Number.isFinite(controller.signalSpeed)) controller.signalSpeed = 0;
    console.error(`[isolated] controller ${record.id} failed (${record.code}): ${record.message}`);
    return record;
};

export const processBatch = async () => {
    const currentBatch = state.candleCounter;
    let progressTracker = 0;
    const results = [];

    const allControllers = state.structureMap.flat(3);
    let batchFailures = 0;

    for (let index = 0; index < allControllers.length; index += CONFIG.maxWorkers) {
        const chunk = allControllers.slice(index, index + CONFIG.maxWorkers);
        const settled = await Promise.allSettled(chunk.map(controller => runWorker(controller)));

        for (let i = 0; i < settled.length; i++) {
            const outcome = settled[i];
            const controller = chunk[i];
            progressTracker++;

            if (outcome.status === 'fulfilled') {
                results.push(outcome.value);
                continue;
            }

            batchFailures++;
            recordControllerFailure(controller, outcome.reason, currentBatch);
        }
    }

    state.controllerFailures = batchFailures;

    if (batchFailures > 0) {
        const poolSize = allControllers.length;
        console.error(`[batch ${currentBatch}] ${batchFailures}/${poolSize} controller(s) failed and were isolated; continuing with the remaining ${results.length}.`);

        if (failureBudgetExceeded(batchFailures, poolSize, CONFIG.controllerFailureBudget)) {
            const err = new Error(
                `Controller failure budget exceeded at batch ${currentBatch}: ${batchFailures}/${poolSize} failed (budget=${CONFIG.controllerFailureBudget}).`
            );
            err.code = 'CONTROLLER_FAILURE_BUDGET';
            throw err;
        }
    }

    for (const { controller, signal, duration, quarantinedRows } of results) {
        state.quarantinedRows += finiteOr(quarantinedRows, 0);
        controller.lastSignal = signal;

        const safeDuration = finiteOr(duration, 0);
        controller.signalSpeed = safeDuration;
        controller.signalHistory.push(safeDuration);
        if (controller.signalHistory.length > 100) controller.signalHistory.shift();

        controller.probHistory.push(finiteOr(signal.prob, -1));
        if (controller.probHistory.length > 100) controller.probHistory.shift();

        controller.scoreHistory.push(finiteOr(signal.score, 0));
        if (controller.scoreHistory.length > 100) controller.scoreHistory.shift();

        if (signal.score > 0 && signal.score < controller.lifetimeMinScore) controller.lifetimeMinScore = signal.score;
        if (signal.score > 0 && signal.score > controller.lifetimeMaxScore) controller.lifetimeMaxScore = signal.score;

        if (signal.prob < controller.lifetimeMinProb && signal.prob !== -1) controller.lifetimeMinProb = signal.prob;
        if (signal.prob > controller.lifetimeMaxProb && signal.prob !== -1) controller.lifetimeMaxProb = signal.prob;

        const mb = controller.lastSignal.memoryBroadcast;

        if (mb && typeof mb.totalBroadcast === 'number' && mb.totalBroadcast > 0 && mb.compatibility && Array.isArray(mb.memories)) {
            const isPositive = controller.type === 'positive';
            const compatStr = canonicalJSON(mb.compatibility);

            const compatRow = (isPositive ? getCompatIdPos : getCompatIdNeg).get(compatStr);
            if (!compatRow) {
                mb.vaultAccess = [];
                mb.vaultMemories = 0;
                continue;
            }

            const compat_id = compatRow.id;

            const getCountCore = isPositive ? getCountCorePos : getCountCoreNeg;
            const getCountVol = isPositive ? getCountVolPos : getCountVolNeg;
            const selectAll = isPositive ? selectAllMemoriesPos : selectAllMemoriesNeg;
            const selectTopCore = isPositive ? selectTopCorePos : selectTopCoreNeg;
            const selectTopVol = isPositive ? selectTopVolPos : selectTopVolNeg;

            const countCore = getCountCore.get(compat_id) || 0;
            const countVol = getCountVol.get(compat_id) || 0;
            const totalCount = countCore + countVol;

            let rows;
            if (totalCount === 0) {
                mb.vaultAccess = [];
                mb.vaultMemories = 0;
                continue;
            } else if (totalCount <= CONFIG.maxVaultCandidates) {
                rows = selectAll.all(compat_id, compat_id);
            } else {
                const coreBias = 0.7;
                let limitCore = Math.round(CONFIG.maxVaultCandidates * coreBias);
                let limitVol = CONFIG.maxVaultCandidates - limitCore;

                limitCore = Math.min(limitCore, countCore || 0);
                limitVol = Math.min(limitVol, countVol || 0);

                if (countVol > 0 && limitVol < 100) {
                    const add = 100 - limitVol;
                    limitVol = 100;
                    limitCore = Math.max(0, limitCore - add);
                }

                const coreRows = selectTopCore.all(compat_id, limitCore);
                const volRows = selectTopVol.all(compat_id, limitVol);
                rows = [...coreRows, ...volRows];
            }

            let vaultCandidates = rows.map(row => ({
                source: row.source,
                protoId: row.protoId,
                mean: blobToVector(row.mean),
                variance: blobToVector(row.variance),
                size: row.size,
                accessCount: row.accessCount,
                importance: row.importance,
                contentHash: row.hash,
                lastAccessed: row.lastAccessed || 0
            }));

            vaultCandidates.forEach(cand => {
                const delta = currentBatch - cand.lastAccessed;
                if (delta <= 0) {
                    cand.decayMultiplier = 1;
                    return;
                }
                const decayFactor = cand.source === 'core' ? CONFIG.coreMemoryDecayFactor : CONFIG.volatileMemoryDecayFactor;
                const multiplier = Math.pow(decayFactor, delta);
                cand.decayMultiplier = multiplier;
                cand.size = Math.max(CONFIG.memoryDecayFloor, cand.size * multiplier);
                cand.accessCount = Math.max(CONFIG.memoryDecayFloor, cand.accessCount * multiplier);
                cand.importance = Math.max(CONFIG.memoryDecayFloor, cand.importance * multiplier);
            });

            if (vaultCandidates.length === 0) {
                mb.vaultAccess = [];
                mb.vaultMemories = 0;
                continue;
            }

            let hasQuery = false;
            let queryMean = null;
            let queryVar = null;
            let totalSize = 0;

            if (mb.memories.length > 0) {
                const firstMean = mb.memories[0]?.mean;
                if (firstMean && Array.isArray(firstMean)) {
                    const d = firstMean.length;
                    queryMean = new Array(d).fill(0);
                    const weightedVar = new Array(d).fill(0);

                    for (const mem of mb.memories) {
                        if (!mem.mean || !mem.variance || !Array.isArray(mem.mean)) continue;
                        const s = mem.size ?? 1;
                        totalSize += s;
                        for (let j = 0; j < d; j++) {
                            queryMean[j] += s * mem.mean[j];
                        }
                    }

                    if (totalSize > 0) {
                        for (let j = 0; j < d; j++) queryMean[j] /= totalSize;

                        for (const mem of mb.memories) {
                            if (!mem.mean || !mem.variance) continue;
                            const s = mem.size ?? 1;
                            for (let j = 0; j < d; j++) {
                                const dm = mem.mean[j] - queryMean[j];
                                weightedVar[j] += s * (mem.variance[j] + dm * dm);
                            }
                        }

                        queryVar = weightedVar.map(v => Math.max(v / totalSize, 1e-8));
                        hasQuery = true;
                    }
                }
            }

            if (hasQuery) {
                const distValues = [];
                for (const cand of vaultCandidates) {
                    cand.dist = computeGaussianDistance(queryMean, queryVar, cand.mean, cand.variance);
                    distValues.push(cand.dist);
                }

                distValues.sort((a, b) => a - b);
                const p80Idx = Math.floor(distValues.length * 0.8);
                let temp = distValues[p80Idx] || 1;
                if (temp <= 0) temp = 1;

                for (const cand of vaultCandidates) {
                    cand.similarity = Math.exp(-cand.dist / temp);
                }
            } else {
                for (const cand of vaultCandidates) {
                    cand.similarity = 1;
                }
            }

            let numToSelect = Math.max(1, Math.floor(mb.totalBroadcast * 0.4));
            numToSelect = Math.min(numToSelect, vaultCandidates.length);

            const selectedVault = [];

            vaultCandidates.sort((a, b) => {
                const scoreA = Math.pow(a.similarity, 4) * (a.importance + a.accessCount);
                const scoreB = Math.pow(b.similarity, 4) * (b.importance + b.accessCount);
                return scoreB - scoreA;
            });

            for (let i = 0; i < numToSelect; i++) {
                const selected = vaultCandidates[i];

                const accessStmt = selected.source === 'core'
                    ? (isPositive ? accessMemoryCorePos : accessMemoryCoreNeg)
                    : (isPositive ? accessMemoryVolPos : accessMemoryVolNeg);
                accessStmt.run(currentBatch, selected.protoId);

                selectedVault.push({
                    protoId: selected.protoId,
                    mean: selected.mean,
                    variance: selected.variance,
                    size: Math.max(CONFIG.memoryDecayFloor, selected.size / selected.decayMultiplier),
                    accessCount: Math.max(CONFIG.memoryDecayFloor, selected.accessCount / selected.decayMultiplier),
                    importance: Math.max(CONFIG.memoryDecayFloor, selected.importance / selected.decayMultiplier),
                    contentHash: selected.contentHash,
                    isCore: selected.source === 'core'
                });
            }

            const additionalVault = [];
            const capAdditional = mb.totalBroadcast - selectedVault.length;

            if (capAdditional > 0 && selectedVault.length > 0) {
                const coreSeeds = selectedVault.filter(m => m.isCore).map(m => m.protoId);
                const volSeeds = selectedVault.filter(m => !m.isCore).map(m => m.protoId);

                const types = [
                    {
                        source: 'core',
                        seeds: coreSeeds,
                        thresh: CONFIG.coreHierarchyThreshold,
                        decayF: CONFIG.coreMemoryDecayFactor,
                        selectStmt: isPositive ? selectMemCorePos : selectMemCoreNeg,
                        accessStmt: isPositive ? accessMemoryCorePos : accessMemoryCoreNeg
                    },
                    {
                        source: 'volatile',
                        seeds: volSeeds,
                        thresh: CONFIG.volatileHierarchyThreshold,
                        decayF: CONFIG.volatileMemoryDecayFactor,
                        selectStmt: isPositive ? selectMemVolPos : selectMemVolNeg,
                        accessStmt: isPositive ? accessMemoryVolPos : accessMemoryVolNeg
                    }
                ];

                for (const type of types) {
                    if (type.seeds.length === 0) continue;

                    const pq = new PriorityQueue();
                    const dist = new Map();
                    const visited = new Set();

                    for (const seed of type.seeds) {
                        pq.push({ protoId: seed, accumDist: 0, depth: 0 });
                        dist.set(seed, 0);
                    }

                    const sourceStr = type.source;
                    const polarityStr = isPositive ? 'positive' : 'negative';

                    while (pq.size > 0 && additionalVault.length < capAdditional) {
                        const curr = pq.pop();
                        if (visited.has(curr.protoId)) continue;
                        visited.add(curr.protoId);

                        if (curr.accumDist > 0) {
                            const row = type.selectStmt.get(curr.protoId);
                            if (!row) continue;

                            const delta = currentBatch - (row.lastAccessed || 0);
                            const mult = delta > 0 ? Math.pow(type.decayF, delta) : 1.0;

                            const decayedSize = Math.max(CONFIG.memoryDecayFloor, row.size * mult);
                            const decayedAccess = Math.max(CONFIG.memoryDecayFloor, row.accessCount * mult);
                            const decayedImportance = Math.max(CONFIG.memoryDecayFloor, row.importance * mult);

                            const similarity = Math.exp(-curr.accumDist / type.thresh);
                            const effectiveBoost = CONFIG.performanceBoostFactor * similarity;

                            const finalSize = Math.max(CONFIG.memoryDecayFloor, decayedSize * effectiveBoost);
                            const finalAccess = Math.max(CONFIG.memoryDecayFloor, decayedAccess * effectiveBoost);
                            const finalImportance = Math.max(CONFIG.memoryDecayFloor, decayedImportance * effectiveBoost);

                            additionalVault.push({
                                protoId: curr.protoId,
                                mean: blobToVector(row.mean),
                                variance: blobToVector(row.variance),
                                size: finalSize,
                                accessCount: finalAccess,
                                importance: finalImportance,
                                contentHash: row.hash,
                                isCore: type.source === 'core'
                            });

                            type.accessStmt.run(currentBatch, curr.protoId);
                        }

                        if (curr.depth >= CONFIG.hierarchyTraversalDepth) continue;

                        const neighborRows = getNeighbors.all(
                            sourceStr, polarityStr, curr.protoId,
                            sourceStr, polarityStr, curr.protoId
                        );

                        for (const nr of neighborRows) {
                            const neighId = nr.neighbor_proto;
                            if (visited.has(neighId)) continue;

                            const edgeDist = nr.accum_distance;
                            const newAccum = curr.accumDist + edgeDist;

                            const existing = dist.get(neighId);
                            if (existing === undefined || newAccum < existing) {
                                dist.set(neighId, newAccum);
                                pq.push({ protoId: neighId, accumDist: newAccum, depth: curr.depth + 1 });
                            }
                        }
                    }
                }
            }

            selectedVault.push(...additionalVault);
            mb.vaultAccess = selectedVault;
            mb.vaultMemories = selectedVault.length;
        } else {
            if (mb) {
                mb.vaultAccess = [];
                mb.vaultMemories = 0;
            }
        }
    }

    const performing = [];
    for (const res of results) {
        const ctrl = res.controller;
        const mb = ctrl.lastSignal?.memoryBroadcast;
        if (mb?.vaultMemories > 0) {
            const recent = ctrl.scoreHistory.slice(-10);
            if (recent.length > 0) {
                const avgScore = recent.reduce((a, b) => a + b, 0) / recent.length;
                performing.push({ ctrl, avgScore, mb });
            }
        }
    }

    if (performing.length > 0) {
        performing.sort((a, b) => b.avgScore - a.avgScore);

        memoryDb.transaction(() => {
            for (const res of results) {
                const mb = res.controller?.lastSignal?.memoryBroadcast;
                if (!mb?.vaultAccess?.length) continue;

                const isPositive = res.controller.type === 'positive';
                const avgScore = res.controller.scoreHistory.slice(-10).reduce((a,b)=>a+b,0) / 10 || 0;
                const isTopPerformer = avgScore >= (performing.length ? performing[Math.floor(performing.length * 0.3)]?.avgScore || 0 : 0);

                const boostF = isTopPerformer ? CONFIG.performanceBoostFactor : CONFIG.baseAccessBoost;

                for (const mem of mb.vaultAccess) {
                    const stmt = mem.isCore
                        ? (isPositive ? boostCorePos : boostCoreNeg)
                        : (isPositive ? boostVolatilePos : boostVolatileNeg);

                    stmt.run(boostF, boostF, boostF, currentBatch, mem.protoId);
                }
            }
        })();
    }

    const { posIdMap, negIdMap } = storeNewMemories(results, currentBatch);

    const consolidationTasks = [];
    for (const compat_id of Object.values(posIdMap)) {
        if (compat_id) consolidationTasks.push({ compat_id, isPositive: true });
    }
    for (const compat_id of Object.values(negIdMap)) {
        if (compat_id) consolidationTasks.push({ compat_id, isPositive: false });
    }

    const allDeltas = [];
    let consolidationFailures = 0;

    for (let index = 0; index < consolidationTasks.length; index += CONFIG.maxWorkers) {
        const chunk = consolidationTasks.slice(index, index + CONFIG.maxWorkers);
        const settled = await Promise.allSettled(
            chunk.map(task => runConsolidationWorker(task.compat_id, task.isPositive, currentBatch)),
        );

        for (let i = 0; i < settled.length; i++) {
            const outcome = settled[i];
            if (outcome.status === 'fulfilled') {
                allDeltas.push(outcome.value);
                continue;
            }
            consolidationFailures++;
            const task = chunk[i];
            console.error(`[isolated] consolidation failed (compat ${task.compat_id}, ${task.isPositive ? 'pos' : 'neg'}): ${outcome.reason && outcome.reason.message}`);
        }
    }

    state.consolidationFailures = consolidationFailures;
    state.totalConsolidationFailures += consolidationFailures;

    applyBulkDeltas(allDeltas);

    const coreCapacity = Math.floor(CONFIG.memoryVaultCapacity * CONFIG.coreCapacityRatio);

    const corePosCount = countCorePos.get();
    const coreNegCount = countCoreNeg.get();
    let coreTotal = corePosCount + coreNegCount;

    let purgedCores = 0;
    if (coreTotal > coreCapacity) {
        const excess = coreTotal - coreCapacity;

        const proportionPos = coreTotal > 0 ? corePosCount / coreTotal : 0.5;
        const purgeCorePosCount = Math.round(excess * proportionPos);
        const purgeCoreNegCount = excess - purgeCorePosCount;

        if (purgeCorePosCount > 0) {
            const { changes } = purgeCorePos.run(purgeCorePosCount);
            purgedCores += changes;
        }
        if (purgeCoreNegCount > 0) {
            const { changes } = purgeCoreNeg.run(purgeCoreNegCount);
            purgedCores += changes;
        }

        coreTotal -= purgedCores;
    }

    let currentTotal = countCorePos.get() + countCoreNeg.get() + countVolPos.get() + countVolNeg.get();

    if (currentTotal > CONFIG.memoryVaultCapacity) {
        const volPos = countVolPos.get();
        const volNeg = countVolNeg.get();
        const volatileTotal = volPos + volNeg;

        let excess = currentTotal - CONFIG.memoryVaultCapacity;
        if (volatileTotal < excess) excess = volatileTotal;

        const purgeVolPosCount = volatileTotal > 0 ? Math.round(excess * (volPos / volatileTotal)) : 0;
        const purgeVolNegCount = excess - purgeVolPosCount;

        let purgedVol = 0;
        if (purgeVolPosCount > 0) {
            const { changes } = purgeVolatilePos.run(purgeVolPosCount);
            purgedVol += changes;
        }
        if (purgeVolNegCount > 0) {
            const { changes } = purgeVolatileNeg.run(purgeVolNegCount);
            purgedVol += changes;
        }

        currentTotal -= purgedVol;
    }
};
