import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import path from 'path';

import {
    decayAndSortMemories,
    mergeMemories,
    collectPromotions,
    buildHierarchy
} from './consolidation_logic.js';
import { installSeededRandom } from './legion/rng.js';

// Deterministic runs (ROADMAP P0-2): consolidation tie-breaks draw from
// Math.random, so the same per-worker seed discipline applies here. No-op when
// unseeded.
if (workerData.seed != null) installSeededRandom(workerData.seed);

const { compat_id, isPositive, currentBatch, config, stateFolder: stateFolderOverride } = workerData;

// Production passes no `stateFolder`, so this resolves to <src>/../state. Tests
// may pass one to run against an isolated temporary directory.
const stateFolder = stateFolderOverride || path.join(import.meta.dirname, '..', 'state');
const dbPath = path.join(stateFolder, 'main', 'memory_vault.db');

const memoryDb = new Database(dbPath);
memoryDb.pragma('journal_mode = WAL');
memoryDb.pragma('synchronous = NORMAL');
memoryDb.pragma('temp_store = MEMORY');
memoryDb.pragma('cache_size = -128000');
memoryDb.pragma('query_only = ON');

const polarity = isPositive ? 'positive' : 'negative';

const blobToVector = (blob) => {
    if (!Buffer.isBuffer(blob) || blob.length === 0 || blob.length % 8 !== 0) return [];
    const f64 = new Float64Array(blob.buffer, blob.byteOffset, blob.length / 8);
    return Array.from(f64); // keeps compatibility with existing number[] code
};

const consolidateVolatile = () => {
    const volTable = isPositive ? 'volatile_positive' : 'volatile_negative';
    const loadStmt = memoryDb.prepare(`
        SELECT protoId, mean, variance, size, accessCount, importance, hash, lastAccessed, usageCount, merged_count
        FROM ${volTable}
        WHERE compat_id = ?
        ORDER BY importance DESC, accessCount DESC, lastAccessed DESC
        LIMIT ?
    `);

    const rows = loadStmt.all(compat_id, config.volatileConsolidationLimit);
    if (rows.length < 2) return { updates: [], deletes: [], promotes: [] };

    const mems = rows.map(r => ({
        protoId: r.protoId,
        mean: blobToVector(r.mean),
        variance: blobToVector(r.variance),
        size: r.size,
        accessCount: r.accessCount,
        importance: r.importance,
        hash: r.hash,
        lastAccessed: r.lastAccessed,
        usageCount: r.usageCount,
        merged_count: r.merged_count || 1
    }));

    decayAndSortMemories(mems, {
        decayFactor: config.volatileMemoryDecayFactor,
        memoryDecayFloor: config.memoryDecayFloor,
        currentBatch
    });

    const merged = mergeMemories(mems, {
        threshold: config.volatileConsolidationThreshold,
        currentBatch
    });
    const promoted = collectPromotions(mems, config.consolidationPromoteCount, currentBatch);

    return {
        updates: merged.updates,
        deletes: [...merged.deletes, ...promoted.deletes],
        promotes: promoted.promotes
    };
};

const consolidateCore = () => {
    const coreTable = isPositive ? 'core_positive' : 'core_negative';
    const loadStmt = memoryDb.prepare(`
        SELECT protoId, mean, variance, size, accessCount, importance, hash, lastAccessed, usageCount, merged_count
        FROM ${coreTable}
        WHERE compat_id = ?
        ORDER BY importance DESC, accessCount DESC, lastAccessed DESC
        LIMIT ?
    `);

    const rows = loadStmt.all(compat_id, config.coreConsolidationLimit);
    if (rows.length < 2) return { updates: [], deletes: [] };

    const mems = rows.map(r => ({
        protoId: r.protoId,
        mean: blobToVector(r.mean),
        variance: blobToVector(r.variance),
        size: r.size,
        accessCount: r.accessCount,
        importance: r.importance,
        hash: r.hash,
        lastAccessed: r.lastAccessed,
        usageCount: r.usageCount,
        merged_count: r.merged_count || 1
    }));

    decayAndSortMemories(mems, {
        decayFactor: config.coreMemoryDecayFactor,
        memoryDecayFloor: config.memoryDecayFloor,
        currentBatch
    });

    return mergeMemories(mems, {
        threshold: config.coreConsolidationThreshold,
        currentBatch
    });
};

const buildPrototypeHierarchy = (memType) => {
    const decayFactor = memType === 'core' ? config.coreMemoryDecayFactor : config.volatileMemoryDecayFactor;
    const table = memType === 'core'
        ? (isPositive ? 'core_positive' : 'core_negative')
        : (isPositive ? 'volatile_positive' : 'volatile_negative');

    const loadStmt = memoryDb.prepare(`
        SELECT protoId, mean, variance, size, accessCount, importance, hash, lastAccessed
        FROM ${table}
        WHERE compat_id = ?
    `);

    const rows = loadStmt.all(compat_id);
    if (rows.length < 2) return { deletes: [], inserts: [] };

    const protos = rows.map(r => ({
        protoId: r.protoId,
        mean: blobToVector(r.mean),
        variance: blobToVector(r.variance),
        size: r.size,
        accessCount: r.accessCount,
        importance: r.importance,
        hash: r.hash,
        lastAccessed: r.lastAccessed
    }));

    return buildHierarchy(protos, {
        memType,
        polarity,
        decayFactor,
        memoryDecayFloor: config.memoryDecayFloor,
        currentBatch,
        maxHierarchyProtos: config.maxHierarchyProtos,
        minNeighbors: memType === 'core' ? config.coreMinNeighbors : config.volatileMinNeighbors,
        maxNeighbors: memType === 'core' ? config.coreMaxNeighbors : config.volatileMaxNeighbors
    });
};

try {
    const volatileChanges = consolidateVolatile();
    const volatileEdges = buildPrototypeHierarchy('volatile');
    const coreChanges = consolidateCore();
    const coreEdges = buildPrototypeHierarchy('core');

    parentPort.postMessage({
        success: true,
        delta: {
            compat_id,
            isPositive,
            volatile: volatileChanges,
            core: coreChanges,
            edges: {
                deletes: [...volatileEdges.deletes, ...coreEdges.deletes],
                inserts: [...volatileEdges.inserts, ...coreEdges.inserts]
            }
        }
    });
} catch (err) {
    parentPort.postMessage({ error: err.message || String(err) });
}
