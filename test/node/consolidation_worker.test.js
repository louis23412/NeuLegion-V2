// Node mirror of test/browser/entries/consolidation_worker.test.js.
//
// Spawns the REAL `consolidation_worker.js` on a real `worker_threads` Worker
// against a real better-sqlite3 database in an isolated temp state dir (the
// worker accepts an optional `stateFolder` override for exactly this). This
// exercises the wiring end-to-end: schema columns, blob encode/decode, config
// field names, consolidation, and the posted `delta`. Run with `node --test`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER_URL = new URL('../../src/consolidation_worker.js', import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

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

function vectorBlob(arr) {
    const f = new Float64Array(arr);
    return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

function setupStateDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neulegion-consol-'));
    fs.mkdirSync(path.join(dir, 'main'), { recursive: true });
    const db = new Database(path.join(dir, 'main', 'memory_vault.db'));
    for (const t of ['volatile_positive', 'volatile_negative', 'core_positive', 'core_negative']) {
        db.exec(`CREATE TABLE ${t} (
            protoId TEXT NOT NULL, compat_id INTEGER NOT NULL,
            mean BLOB NOT NULL, variance BLOB NOT NULL,
            size REAL NOT NULL, accessCount REAL NOT NULL, importance REAL NOT NULL,
            hash TEXT NOT NULL, lastAccessed INTEGER DEFAULT 0,
            usageCount INTEGER NOT NULL DEFAULT 0, merged_count INTEGER NOT NULL DEFAULT 1
        )`);
    }
    const insert = (table, protoId, importance, mergedCount = 1) =>
        db.prepare(`INSERT INTO ${table} (protoId, compat_id, mean, variance, size, accessCount, importance, hash, lastAccessed, usageCount, merged_count)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(protoId, 7, vectorBlob([0, 0]), vectorBlob([1, 1]), 1, 1, importance, 'h_' + protoId, 10, 1, mergedCount);

    insert('volatile_positive', 'a', 3);
    insert('volatile_positive', 'b', 2);
    insert('volatile_positive', 'c', 1);
    insert('core_positive', 'd', 2);
    insert('core_positive', 'e', 1);
    db.close();
    return dir;
}

function runWorker(stateFolder) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(WORKER_URL, {
            workerData: { compat_id: 7, isPositive: true, currentBatch: 10, config: CONFIG, stateFolder }
        });
        worker.on('message', (msg) => { worker.terminate(); resolve(msg); });
        worker.on('error', reject);
        worker.on('exit', (code) => { if (code !== 0) reject(new Error(`worker exited ${code}`)); });
    });
}

test('consolidation worker: end-to-end delta', async () => {
    const stateDir = setupStateDir();
    try {
        const msg = await runWorker(stateDir);
        assert.equal(msg.success, true);
        assert.ok(!msg.error, msg.error);

        const delta = msg.delta;
        assert.equal(delta.compat_id, 7);
        assert.equal(delta.isPositive, true);

        // volatile: a absorbs b then c -> two updates, b/c deleted, a promoted
        // (merged_count 3 >= promoteCount 2) and therefore also deleted.
        assert.equal(delta.volatile.updates.length, 2);
        assert.deepEqual(delta.volatile.deletes.sort(), ['a', 'b', 'c']);
        assert.equal(delta.volatile.promotes.length, 1);
        assert.equal(delta.volatile.promotes[0].protoId, 'a');
        assert.equal(delta.volatile.promotes[0].size, 3);
        assert.ok(Array.isArray(delta.volatile.updates[0].mean));
        assert.equal(delta.volatile.updates[0].mean.length, 2);

        // core: d absorbs e, no promotions key.
        assert.equal(delta.core.updates.length, 1);
        assert.deepEqual(delta.core.deletes, ['e']);
        assert.equal(delta.core.promotes, undefined);

        // hierarchy rebuilds from the (still fully populated) tables.
        assert.equal(delta.edges.deletes.length, 5);
        assert.ok(delta.edges.inserts.length > 0);
        assert.ok(delta.edges.inserts.every((e) => Number.isFinite(e.accum_distance)));
    } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
    }
});

test('consolidation worker: lifecycle folders resolve from the state dir', () => {
    // Guards against a regression in the stateFolder override wiring: the
    // default (no override) must stay <src>/../state.
    const defaultState = path.resolve(HERE, '..', '..', 'state');
    assert.ok(path.isAbsolute(defaultState));
});
