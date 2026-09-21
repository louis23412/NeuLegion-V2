// NeuLegion legion component: prepared statements and write transactions
//
// Split out of the original monolithic src/mainController.js; the bodies are
// byte-identical apart from the shared mutable state being read/written as
// properties of the `state` holder (see ./state.js). src/mainController.js is
// now just the entry point that runs ./legion/runner.js.

import { CONFIG } from './config.js';
import { db, memoryDb } from './database.js';
import { vectorToBlob, canonicalJSON, computeContentHash } from './serialization.js';

export const insertCompatPos = memoryDb.prepare('INSERT INTO compat_positive (compatibility) VALUES (?) ON CONFLICT(compatibility) DO NOTHING');
export const insertCompatNeg = memoryDb.prepare('INSERT INTO compat_negative (compatibility) VALUES (?) ON CONFLICT(compatibility) DO NOTHING');

export const getCompatIdPos = memoryDb.prepare('SELECT id FROM compat_positive WHERE compatibility = ?');
export const getCompatIdNeg = memoryDb.prepare('SELECT id FROM compat_negative WHERE compatibility = ?');

export const upsertVolatilePos = memoryDb.prepare(`
    INSERT INTO volatile_positive (protoId, compat_id, mean, variance, size, accessCount, importance, hash, usageCount)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(protoId) DO UPDATE SET
        mean = excluded.mean,
        variance = excluded.variance,
        size = excluded.size,
        accessCount = excluded.accessCount,
        importance = excluded.importance,
        hash = excluded.hash,
        usageCount = usageCount + 1
`);

export const upsertVolatileNeg = memoryDb.prepare(`
    INSERT INTO volatile_negative (protoId, compat_id, mean, variance, size, accessCount, importance, hash, usageCount)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(protoId) DO UPDATE SET
        mean = excluded.mean,
        variance = excluded.variance,
        size = excluded.size,
        accessCount = excluded.accessCount,
        importance = excluded.importance,
        hash = excluded.hash,
        usageCount = usageCount + 1
`);

export const purgeVolatilePos = memoryDb.prepare(`
    DELETE FROM volatile_positive
    WHERE protoId IN (
        SELECT protoId FROM volatile_positive
        ORDER BY lastAccessed ASC, importance ASC, accessCount ASC, merged_count ASC, protoId ASC
        LIMIT ?
    )
`);

export const purgeVolatileNeg = memoryDb.prepare(`
    DELETE FROM volatile_negative
    WHERE protoId IN (
        SELECT protoId FROM volatile_negative
        ORDER BY lastAccessed ASC, importance ASC, accessCount ASC, merged_count ASC, protoId ASC
        LIMIT ?
    )
`);

export const purgeCorePos = memoryDb.prepare(`
    DELETE FROM core_positive
    WHERE protoId IN (
        SELECT protoId FROM core_positive
        ORDER BY lastAccessed ASC, importance ASC, accessCount ASC, merged_count ASC, protoId ASC
        LIMIT ?
    )
`);

export const purgeCoreNeg = memoryDb.prepare(`
    DELETE FROM core_negative
    WHERE protoId IN (
        SELECT protoId FROM core_negative
        ORDER BY lastAccessed ASC, importance ASC, accessCount ASC, merged_count ASC, protoId ASC
        LIMIT ?
    )
`);

export const countCorePos = memoryDb.prepare('SELECT COUNT(*) FROM core_positive').pluck();
export const countCoreNeg = memoryDb.prepare('SELECT COUNT(*) FROM core_negative').pluck();
export const countVolPos = memoryDb.prepare('SELECT COUNT(*) FROM volatile_positive').pluck();
export const countVolNeg = memoryDb.prepare('SELECT COUNT(*) FROM volatile_negative').pluck();

export const getCountCorePos = memoryDb.prepare('SELECT COUNT(*) FROM core_positive WHERE compat_id = ?').pluck();
export const getCountCoreNeg = memoryDb.prepare('SELECT COUNT(*) FROM core_negative WHERE compat_id = ?').pluck();
export const getCountVolPos = memoryDb.prepare('SELECT COUNT(*) FROM volatile_positive WHERE compat_id = ?').pluck();
export const getCountVolNeg = memoryDb.prepare('SELECT COUNT(*) FROM volatile_negative WHERE compat_id = ?').pluck();

export const selectTopCorePos = memoryDb.prepare(`
    SELECT 'core' AS source, protoId, mean, variance, size, accessCount, importance, hash, lastAccessed
    FROM core_positive
    WHERE compat_id = ?
    ORDER BY importance DESC, accessCount DESC, lastAccessed DESC
    LIMIT ?
`);

export const selectTopCoreNeg = memoryDb.prepare(`
    SELECT 'core' AS source, protoId, mean, variance, size, accessCount, importance, hash, lastAccessed
    FROM core_negative
    WHERE compat_id = ?
    ORDER BY importance DESC, accessCount DESC, lastAccessed DESC
    LIMIT ?
`);

export const selectTopVolPos = memoryDb.prepare(`
    SELECT 'volatile' AS source, protoId, mean, variance, size, accessCount, importance, hash, lastAccessed
    FROM volatile_positive
    WHERE compat_id = ?
    ORDER BY importance DESC, accessCount DESC, lastAccessed DESC
    LIMIT ?
`);

export const selectTopVolNeg = memoryDb.prepare(`
    SELECT 'volatile' AS source, protoId, mean, variance, size, accessCount, importance, hash, lastAccessed
    FROM volatile_negative
    WHERE compat_id = ?
    ORDER BY importance DESC, accessCount DESC, lastAccessed DESC
    LIMIT ?
`);

export const updateLastVolPos = memoryDb.prepare(
    'UPDATE volatile_positive SET lastAccessed = ? WHERE protoId = ?'
);
export const updateLastVolNeg = memoryDb.prepare(
    'UPDATE volatile_negative SET lastAccessed = ? WHERE protoId = ?'
);

export const existsInCorePos = memoryDb.prepare('SELECT 1 FROM core_positive WHERE protoId = ?').pluck();
export const existsInCoreNeg = memoryDb.prepare('SELECT 1 FROM core_negative WHERE protoId = ?').pluck();

export const existsInVolatilePos = memoryDb.prepare('SELECT 1 FROM volatile_positive WHERE protoId = ?').pluck();
export const existsInVolatileNeg = memoryDb.prepare('SELECT 1 FROM volatile_negative WHERE protoId = ?').pluck();

export const updateControllerStmt = db.prepare(`
    UPDATE legion_controllers
    SET signal_speed = ?,
        mem_connections = ?,
        child_connections = ?,
        last_signal = ?,
        signal_history = ?,
        prob_history = ?,
        score_history = ?,
        lifetime_min_score = ?,
        lifetime_max_score = ?,
        lifetime_min_prob = ?,
        lifetime_max_prob = ?,
        tier = ?
    WHERE group_id = ? AND section_id = ? AND layer_id = ? AND cluster_id = ?
`);

export const upsertCounterStmt = db.prepare(`
    INSERT INTO legion_state (singleton, candle_counter) VALUES (1, ?)
    ON CONFLICT(singleton) DO UPDATE SET candle_counter = excluded.candle_counter
`);

export const selectAllMemoriesPos = memoryDb.prepare(`
    SELECT 'core' AS source, protoId, mean, variance, size, accessCount, importance, hash, lastAccessed
    FROM core_positive
    WHERE compat_id = ?
    UNION ALL
    SELECT 'volatile' AS source, protoId, mean, variance, size, accessCount, importance, hash, lastAccessed
    FROM volatile_positive
    WHERE compat_id = ?
`);

export const selectAllMemoriesNeg = memoryDb.prepare(`
    SELECT 'core' AS source, protoId, mean, variance, size, accessCount, importance, hash, lastAccessed
    FROM core_negative
    WHERE compat_id = ?
    UNION ALL
    SELECT 'volatile' AS source, protoId, mean, variance, size, accessCount, importance, hash, lastAccessed
    FROM volatile_negative
    WHERE compat_id = ?
`);

export const accessMemoryCorePos = memoryDb.prepare(
    'UPDATE core_positive SET lastAccessed = ?, usageCount = usageCount + 1 WHERE protoId = ?'
);

export const accessMemoryCoreNeg = memoryDb.prepare(
    'UPDATE core_negative SET lastAccessed = ?, usageCount = usageCount + 1 WHERE protoId = ?'
);

export const accessMemoryVolPos = memoryDb.prepare(
    'UPDATE volatile_positive SET lastAccessed = ?, usageCount = usageCount + 1 WHERE protoId = ?'
);

export const accessMemoryVolNeg = memoryDb.prepare(
    'UPDATE volatile_negative SET lastAccessed = ?, usageCount = usageCount + 1 WHERE protoId = ?'
);

export const boostCorePos = memoryDb.prepare(`
    UPDATE core_positive
    SET importance = importance * ?,
        accessCount = accessCount * ?,
        size = size * ?,
        lastAccessed = ?,
        usageCount = usageCount + 1
    WHERE protoId = ?
`);

export const boostCoreNeg = memoryDb.prepare(`
    UPDATE core_negative
    SET importance = importance * ?,
        accessCount = accessCount * ?,
        size = size * ?,
        lastAccessed = ?,
        usageCount = usageCount + 1
    WHERE protoId = ?
`);

export const boostVolatilePos = memoryDb.prepare(`
    UPDATE volatile_positive
    SET importance = importance * ?,
        accessCount = accessCount * ?,
        size = size * ?,
        lastAccessed = ?,
        usageCount = usageCount + 1
    WHERE protoId = ?
`);

export const boostVolatileNeg = memoryDb.prepare(`
    UPDATE volatile_negative
    SET importance = importance * ?,
        accessCount = accessCount * ?,
        size = size * ?,
        lastAccessed = ?,
        usageCount = usageCount + 1
    WHERE protoId = ?
`);

export const boostExistingVolatilePos = memoryDb.prepare(`
    UPDATE volatile_positive
    SET importance = importance * ?,
        accessCount = accessCount * ?,
        size = size * ?,
        lastAccessed = ?,
        usageCount = usageCount + 1
    WHERE protoId = ?
`);

export const boostExistingVolatileNeg = memoryDb.prepare(`
    UPDATE volatile_negative
    SET importance = importance * ?,
        accessCount = accessCount * ?,
        size = size * ?,
        lastAccessed = ?,
        usageCount = usageCount + 1
    WHERE protoId = ?
`);

export const updateVolatilePosMain = memoryDb.prepare(`
    UPDATE volatile_positive
    SET mean = ?, variance = ?, size = ?, accessCount = ?, importance = ?, hash = ?, lastAccessed = ?, usageCount = ?, merged_count = ?
    WHERE protoId = ?
`);

export const updateVolatileNegMain = memoryDb.prepare(`
    UPDATE volatile_negative
    SET mean = ?, variance = ?, size = ?, accessCount = ?, importance = ?, hash = ?, lastAccessed = ?, usageCount = ?, merged_count = ?
    WHERE protoId = ?
`);

export const insertCorePosMain = memoryDb.prepare(`
    INSERT INTO core_positive (protoId, compat_id, mean, variance, size, accessCount, importance, hash, lastAccessed, usageCount, merged_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export const insertCoreNegMain = memoryDb.prepare(`
    INSERT INTO core_negative (protoId, compat_id, mean, variance, size, accessCount, importance, hash, lastAccessed, usageCount, merged_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export const updateCorePosMain = memoryDb.prepare(`
    UPDATE core_positive
    SET mean = ?, variance = ?, size = ?, accessCount = ?, importance = ?, hash = ?, lastAccessed = ?, usageCount = ?, merged_count = ?
    WHERE protoId = ?
`);

export const updateCoreNegMain = memoryDb.prepare(`
    UPDATE core_negative
    SET mean = ?, variance = ?, size = ?, accessCount = ?, importance = ?, hash = ?, lastAccessed = ?, usageCount = ?, merged_count = ?
    WHERE protoId = ?
`);

export const deleteProtoEdgesForProtoMain = memoryDb.prepare(`
    DELETE FROM proto_edges 
    WHERE source = ? AND polarity = ? AND (parent_proto = ? OR child_proto = ?)
`);

export const insertProtoEdgeMain = memoryDb.prepare(`
    INSERT INTO proto_edges (source, polarity, parent_proto, child_proto, accum_distance)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source, polarity, parent_proto, child_proto) DO NOTHING
`);

export const selectMemCorePos = memoryDb.prepare('SELECT mean, variance, size, accessCount, importance, hash, lastAccessed FROM core_positive WHERE protoId = ?');
export const selectMemCoreNeg = memoryDb.prepare('SELECT mean, variance, size, accessCount, importance, hash, lastAccessed FROM core_negative WHERE protoId = ?');
export const selectMemVolPos = memoryDb.prepare('SELECT mean, variance, size, accessCount, importance, hash, lastAccessed FROM volatile_positive WHERE protoId = ?');
export const selectMemVolNeg = memoryDb.prepare('SELECT mean, variance, size, accessCount, importance, hash, lastAccessed FROM volatile_negative WHERE protoId = ?');

export const insertSimStmt = db.prepare(`
    INSERT INTO open_simulations (id, direction, entryPrice, exitPrice, stopLoss, confidence)
    VALUES (?, ?, ?, ?, ?, ?)
`);

export const selectAllSims = db.prepare(`
    SELECT id, direction, entryPrice, exitPrice, stopLoss, confidence
    FROM open_simulations
`);

export const deleteOpenSim = db.prepare(`DELETE FROM open_simulations WHERE id = ?`);

export const upsertAccValue = db.prepare(`
    INSERT INTO legion_accuracy (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

export const selectAccValue = db.prepare(`
    SELECT value FROM legion_accuracy WHERE key = ?
`);

export const getNeighbors = memoryDb.prepare(`
    SELECT parent_proto AS neighbor_proto, accum_distance FROM proto_edges WHERE source = ? AND polarity = ? AND child_proto = ?
    UNION ALL
    SELECT child_proto AS neighbor_proto, accum_distance FROM proto_edges WHERE source = ? AND polarity = ? AND parent_proto = ?
`);

export const storeNewMemories = memoryDb.transaction((results, currentBatch) => {
    const posCompatSet = new Set();
    const negCompatSet = new Set();
    const posMems = [];
    const negMems = [];

    for (const { signal, controller } of results) {
        if (!signal?.memoryBroadcast?.compatibility || !signal?.memoryBroadcast?.memories?.length) continue;

        const mb = signal.memoryBroadcast;
        const compatStr = canonicalJSON(mb.compatibility);
        const isPositive = controller.type === 'positive';

        (isPositive ? posCompatSet : negCompatSet).add(compatStr);

        const targetArray = isPositive ? posMems : negMems;
        for (const indivMem of mb.memories) {
            if (!indivMem?.mean || !indivMem?.variance || !indivMem?.protoId) continue;
            targetArray.push({ mem: indivMem, compatStr });
        }
    }

    for (const str of posCompatSet) insertCompatPos.run(str);
    for (const str of negCompatSet) insertCompatNeg.run(str);

    const posIdMap = {};
    for (const str of posCompatSet) {
        const row = getCompatIdPos.get(str);
        if (row) posIdMap[str] = row.id;
    }
    const negIdMap = {};
    for (const str of negCompatSet) {
        const row = getCompatIdNeg.get(str);
        if (row) negIdMap[str] = row.id;
    }

    for (const { mem, compatStr } of posMems) {
        const compat_id = posIdMap[compatStr];
        if (!compat_id) continue;

        const contentHash = computeContentHash(mem.mean);
        const protoId = mem.protoId;

        const inCore = existsInCorePos.get(protoId);
        const inVol  = existsInVolatilePos.get(protoId);

        if (inCore) {
            boostCorePos.run(
                CONFIG.baseAccessBoost, 
                CONFIG.baseAccessBoost, 
                CONFIG.baseAccessBoost, 
                currentBatch, 
                protoId
            );
        } else if (inVol) {
            boostExistingVolatilePos.run(
                CONFIG.baseAccessBoost, 
                CONFIG.baseAccessBoost, 
                CONFIG.baseAccessBoost, 
                currentBatch, 
                protoId
            );
        } else {
            upsertVolatilePos.run(
                protoId,
                compat_id,
                vectorToBlob(mem.mean),
                vectorToBlob(mem.variance),
                CONFIG.newMemorySize,
                CONFIG.newMemoryAccessCount,
                CONFIG.newMemoryImportance,
                contentHash
            );
            updateLastVolPos.run(currentBatch, protoId);
        }
    }

    for (const { mem, compatStr } of negMems) {
        const compat_id = negIdMap[compatStr];
        if (!compat_id) continue;

        const contentHash = computeContentHash(mem.mean);
        const protoId = mem.protoId;

        const inCore = existsInCoreNeg.get(protoId);
        const inVol  = existsInVolatileNeg.get(protoId);

        if (inCore) {
            boostCoreNeg.run(
                CONFIG.baseAccessBoost, 
                CONFIG.baseAccessBoost, 
                CONFIG.baseAccessBoost, 
                currentBatch, 
                protoId
            );
        } else if (inVol) {
            boostExistingVolatileNeg.run(
                CONFIG.baseAccessBoost, 
                CONFIG.baseAccessBoost, 
                CONFIG.baseAccessBoost, 
                currentBatch, 
                protoId
            );
        } else {
            upsertVolatileNeg.run(
                protoId,
                compat_id,
                vectorToBlob(mem.mean),
                vectorToBlob(mem.variance),
                CONFIG.newMemorySize,
                CONFIG.newMemoryAccessCount,
                CONFIG.newMemoryImportance,
                contentHash
            );
            updateLastVolNeg.run(currentBatch, protoId);
        }
    }

    return { posIdMap, negIdMap };
});

export const applyBulkDeltas = memoryDb.transaction((deltas) => {
    const deletes = { volPos: [], volNeg: [], corePos: [], coreNeg: [] };
    const updates = { volPos: [], volNeg: [], corePos: [], coreNeg: [] };
    const promotes = { corePos: [], coreNeg: [] };

    for (const delta of deltas) {
        const isPos = delta.isPositive;
        const v = delta.volatile;
        const c = delta.core;

        deletes[isPos ? 'volPos' : 'volNeg'].push(...v.deletes);
        deletes[isPos ? 'corePos' : 'coreNeg'].push(...c.deletes);

        v.updates.forEach(u => {
            updates[isPos ? 'volPos' : 'volNeg'].push([
                vectorToBlob(u.mean), vectorToBlob(u.variance),
                u.size, u.accessCount, u.importance, u.hash,
                u.lastAccessed, u.usageCount, u.merged_count, u.protoId
            ]);
        });
        c.updates.forEach(u => {
            updates[isPos ? 'corePos' : 'coreNeg'].push([
                vectorToBlob(u.mean), vectorToBlob(u.variance),
                u.size, u.accessCount, u.importance, u.hash,
                u.lastAccessed, u.usageCount, u.merged_count, u.protoId
            ]);
        });

        v.promotes.forEach(p => {
            promotes[isPos ? 'corePos' : 'coreNeg'].push([
                p.protoId, delta.compat_id,
                vectorToBlob(p.mean), vectorToBlob(p.variance),
                p.size, p.accessCount, p.importance, p.hash,
                p.lastAccessed, p.usageCount, p.merged_count
            ]);
        });

        delta.edges.deletes.forEach(d => {
            deleteProtoEdgesForProtoMain.run(d.source, d.polarity, d.protoId, d.protoId);
        });
        delta.edges.inserts.forEach(e => {
            insertProtoEdgeMain.run(e.source, e.polarity, e.parent_proto, e.child_proto, e.accum_distance);
        });
    }

    const applyChunkedDelete = (table, ids) => {
        if (!ids.length) return;
        const chunkSize = 400;
        for (let i = 0; i < ids.length; i += chunkSize) {
            const chunk = ids.slice(i, i + chunkSize);
            const ph = chunk.map(() => '?').join(',');
            memoryDb.prepare(`DELETE FROM ${table} WHERE protoId IN (${ph})`).run(...chunk);
        }
    };

    applyChunkedDelete('volatile_positive', deletes.volPos);
    applyChunkedDelete('volatile_negative', deletes.volNeg);
    applyChunkedDelete('core_positive', deletes.corePos);
    applyChunkedDelete('core_negative', deletes.coreNeg);

    updates.volPos.forEach(p => updateVolatilePosMain.run(...p));
    updates.volNeg.forEach(p => updateVolatileNegMain.run(...p));
    updates.corePos.forEach(p => updateCorePosMain.run(...p));
    updates.coreNeg.forEach(p => updateCoreNegMain.run(...p));

    promotes.corePos.forEach(p => insertCorePosMain.run(...p));
    promotes.coreNeg.forEach(p => insertCoreNegMain.run(...p));
});
