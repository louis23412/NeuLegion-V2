// End-to-end test of `consolidation_worker.js` inside the browser harness.
//
// The worker runs top-level code that reads `workerData`, opens the
// `memory_vault.db` (sql.js shim, keyed by path so a second connection sees
// our rows), consolidates, and posts a `delta`. The `node:worker_threads` shim
// exposes `__setWorkerData`/`parentPort`, so we can install the payload, capture
// the posted message, and import the real worker module — exercising the wiring
// (schema columns, config field names, blob decode, output shape), not just the
// extracted algorithms covered by `consolidation.test.js`.

import Database, { __ensureSql } from '../shims/better-sqlite3.js';
import path from '../shims/path.js';
import { __setWorkerData, parentPort } from '../shims/worker_threads.js';

const STATE = 'state/agent-e2e-consolidation';
const DB_PATH = path.join(STATE, 'main', 'memory_vault.db');

function vectorBlob(arr) {
    const f = new Float64Array(arr);
    return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
}

function createTables(db) {
    for (const t of ['volatile_positive', 'volatile_negative', 'core_positive', 'core_negative']) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS ${t} (
                protoId TEXT NOT NULL,
                compat_id INTEGER NOT NULL,
                mean BLOB NOT NULL,
                variance BLOB NOT NULL,
                size REAL NOT NULL,
                accessCount REAL NOT NULL,
                importance REAL NOT NULL,
                hash TEXT NOT NULL,
                lastAccessed INTEGER DEFAULT 0,
                usageCount INTEGER NOT NULL DEFAULT 0,
                merged_count INTEGER NOT NULL DEFAULT 1
            )
        `);
    }
}

function insertProto(db, table, { protoId, compatId, mean, variance, size, accessCount, importance, hash, lastAccessed, usageCount, mergedCount }) {
    db.prepare(`INSERT INTO ${table} (protoId, compat_id, mean, variance, size, accessCount, importance, hash, lastAccessed, usageCount, merged_count)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(protoId, compatId, vectorBlob(mean), vectorBlob(variance), size, accessCount, importance, hash, lastAccessed, usageCount, mergedCount);
}

const CONFIG = {
    volatileConsolidationLimit: 100,
    volatileConsolidationThreshold: 0.02,
    coreConsolidationLimit: 100,
    coreConsolidationThreshold: 0.01,
    volatileMemoryDecayFactor: 1,
    coreMemoryDecayFactor: 1,
    memoryDecayFloor: 1,
    consolidationPromoteCount: 2,
    maxHierarchyProtos: 250,
    coreMinNeighbors: 1,
    coreMaxNeighbors: 1,
    volatileMinNeighbors: 1,
    volatileMaxNeighbors: 1,
};

export async function run() {
    await __ensureSql();
    const checks = [];
    const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });

    const db = new Database(DB_PATH);
    createTables(db);

    const row = (id, table, importance, mergedCount = 1) => insertProto(db, table, {
        protoId: id, compatId: 7, mean: [0, 0], variance: [1, 1],
        size: 1, accessCount: 1, importance, hash: 'h_' + id,
        lastAccessed: 10, usageCount: 1, mergedCount
    });

    // volatile: three identical protos -> all merge into 'a' (merged_count 3)
    //           -> promoted to core (promoteCount = 2). The worker does NOT
    //           apply these deltas, so the hierarchy still sees all three rows.
    row('a', 'volatile_positive', 3);
    row('b', 'volatile_positive', 2);
    row('c', 'volatile_positive', 1);
    // core: two identical protos -> one merge, no promotions.
    row('d', 'core_positive', 2);
    row('e', 'core_positive', 1);

    let captured = null;
    parentPort.postMessage = (msg) => { captured = msg; };
    __setWorkerData({ compat_id: 7, isPositive: true, currentBatch: 10, config: CONFIG, stateFolder: STATE });

    let importError = null;
    try {
        await import('../../../src/consolidation_worker.js');
    } catch (e) {
        importError = e;
    }

    check('worker module imports without throwing', !importError, importError && importError.stack);
    check('worker posted a message', captured !== null, JSON.stringify(captured));
    if (!captured) return { total: checks.length, failed: checks.filter((c) => !c.pass).length, failures: checks.filter((c) => !c.pass), checks };

    check('worker reported success', captured.success === true, JSON.stringify(captured).slice(0, 300));
    check('worker reported no error', !captured.error, String(captured.error));

    const delta = captured.delta || {};
    check('delta carries compat_id and isPositive', delta.compat_id === 7 && delta.isPositive === true,
        JSON.stringify({ compat_id: delta.compat_id, isPositive: delta.isPositive }));

    const vol = delta.volatile || {};
    check('volatile merge emitted two updates (a absorbs b, then c)',
        Array.isArray(vol.updates) && vol.updates.length === 2, `updates=${vol.updates && vol.updates.length}`);
    check('volatile deletes the two absorbed sources',
        Array.isArray(vol.deletes) && ['b', 'c'].every((id) => vol.deletes.includes(id)), JSON.stringify(vol.deletes));
    check('volatile promotes the thrice-merged proto',
        Array.isArray(vol.promotes) && vol.promotes.length === 1 && vol.promotes[0].protoId === 'a',
        JSON.stringify(vol.promotes && vol.promotes.map((p) => p.protoId)));
    check('promotion is also deleted from volatile',
        vol.deletes.includes('a'), JSON.stringify(vol.deletes));
    check('promoted proto carries the summed size', vol.promotes && vol.promotes[0] && vol.promotes[0].size === 3,
        vol.promotes && String(vol.promotes[0].size));
    check('merge update decoded the blob means back to arrays',
        vol.updates && Array.isArray(vol.updates[0].mean) && vol.updates[0].mean.length === 2 && vol.updates[0].mean[0] === 0,
        JSON.stringify(vol.updates && vol.updates[0].mean));

    const core = delta.core || {};
    check('core merge emitted one update', Array.isArray(core.updates) && core.updates.length === 1,
        `updates=${core.updates && core.updates.length}`);
    check('core deletes the absorbed source', Array.isArray(core.deletes) && core.deletes.length === 1 && core.deletes[0] === 'e',
        JSON.stringify(core.deletes));
    check('core emits no promotions key', core.promotes === undefined, JSON.stringify(Object.keys(core)));

    const edges = delta.edges || {};
    check('hierarchy deleted every volatile + core proto for rebuild',
        Array.isArray(edges.deletes) && edges.deletes.length === 5,
        `deletes=${edges.deletes && edges.deletes.length}`);
    check('hierarchy emits directed edges', Array.isArray(edges.inserts) && edges.inserts.length > 0,
        `inserts=${edges.inserts && edges.inserts.length}`);
    check('hierarchy distances are finite numbers',
        edges.inserts && edges.inserts.every((e) => Number.isFinite(e.accum_distance)),
        JSON.stringify(edges.inserts && edges.inserts.slice(0, 2)));

    const negDb = new Database(DB_PATH);
    check('negative bank rows are untouched (isPositive filters by table)',
        negDb.prepare('SELECT COUNT(*) AS n FROM volatile_negative').get().n === 0);

    return { total: checks.length, failed: checks.filter((c) => !c.pass).length, failures: checks.filter((c) => !c.pass), checks };
}
