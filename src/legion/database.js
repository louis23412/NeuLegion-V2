// NeuLegion legion component: legion SQLite databases and schema
//
// Split out of the original monolithic src/mainController.js; the bodies are
// byte-identical apart from the shared mutable state being read/written as
// properties of the `state` holder (see ./state.js). src/mainController.js is
// now just the entry point that runs ./legion/runner.js.

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { CONFIG } from './config.js';

fs.existsSync(path.join(CONFIG.stateFolder, 'main')) ? null : fs.mkdirSync(path.join(CONFIG.stateFolder, 'main'), { recursive: true });

export const db = new Database(path.join(CONFIG.stateFolder, 'main', 'legion_state.db'), { fileMustExist: false });
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('temp_store = MEMORY');
db.pragma('cache_size = -32000');

export const memoryDb = new Database(path.join(CONFIG.stateFolder, 'main', 'memory_vault.db'), { fileMustExist: false });
memoryDb.pragma('journal_mode = WAL');
memoryDb.pragma('synchronous = NORMAL');
memoryDb.pragma('temp_store = MEMORY');
memoryDb.pragma('cache_size = -128000');

db.exec(`
    CREATE TABLE IF NOT EXISTS legion_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        candle_counter INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS legion_controllers (
        group_id INTEGER NOT NULL,
        section_id INTEGER NOT NULL,
        layer_id INTEGER NOT NULL,
        cluster_id INTEGER NOT NULL,
        controller_type TEXT NOT NULL,
        directory_path TEXT NOT NULL,
        signal_speed REAL NOT NULL DEFAULT 0,
        mem_connections INTEGER NOT NULL DEFAULT 0,
        child_connections INTEGER NOT NULL DEFAULT 0,
        last_signal TEXT NOT NULL DEFAULT '{}',
        signal_history TEXT NOT NULL DEFAULT '[]',
        prob_history TEXT NOT NULL DEFAULT '[]',
        score_history TEXT NOT NULL DEFAULT '[]',
        lifetime_min_score REAL NOT NULL DEFAULT 100,
        lifetime_max_score REAL NOT NULL DEFAULT 0,
        lifetime_min_prob  REAL NOT NULL DEFAULT 100,
        lifetime_max_prob  REAL NOT NULL DEFAULT 0,
        tier INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (group_id, section_id, layer_id, cluster_id)
    );

    CREATE TABLE IF NOT EXISTS open_simulations (
        id TEXT PRIMARY KEY,
        direction TEXT NOT NULL,
        entryPrice REAL NOT NULL,
        exitPrice REAL NOT NULL,
        stopLoss REAL NOT NULL,
        confidence REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS legion_accuracy (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
`);

memoryDb.exec(`
    CREATE TABLE IF NOT EXISTS compat_positive (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        compatibility TEXT UNIQUE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS compat_negative (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        compatibility TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS core_positive (
        protoId TEXT PRIMARY KEY,
        compat_id INTEGER NOT NULL REFERENCES compat_positive(id),
        mean BLOB NOT NULL,
        variance BLOB NOT NULL,
        size REAL NOT NULL,
        accessCount REAL NOT NULL,
        importance REAL NOT NULL,
        hash TEXT NOT NULL,
        lastAccessed INTEGER DEFAULT 0,
        usageCount INTEGER NOT NULL DEFAULT 0,
        merged_count INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS core_negative (
        protoId TEXT PRIMARY KEY,
        compat_id INTEGER NOT NULL REFERENCES compat_negative(id),
        mean BLOB NOT NULL,
        variance BLOB NOT NULL,
        size REAL NOT NULL,
        accessCount REAL NOT NULL,
        importance REAL NOT NULL,
        hash TEXT NOT NULL,
        lastAccessed INTEGER DEFAULT 0,
        usageCount INTEGER NOT NULL DEFAULT 0,
        merged_count INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS volatile_positive (
        protoId TEXT PRIMARY KEY,
        compat_id INTEGER NOT NULL REFERENCES compat_positive(id),
        mean BLOB NOT NULL,
        variance BLOB NOT NULL,
        size REAL NOT NULL,
        accessCount REAL NOT NULL,
        importance REAL NOT NULL,
        hash TEXT NOT NULL,
        lastAccessed INTEGER DEFAULT 0,
        usageCount INTEGER NOT NULL DEFAULT 0,
        merged_count INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS volatile_negative (
        protoId TEXT PRIMARY KEY,
        compat_id INTEGER NOT NULL REFERENCES compat_negative(id),
        mean BLOB NOT NULL,
        variance BLOB NOT NULL,
        size REAL NOT NULL,
        accessCount REAL NOT NULL,
        importance REAL NOT NULL,
        hash TEXT NOT NULL,
        lastAccessed INTEGER DEFAULT 0,
        usageCount INTEGER NOT NULL DEFAULT 0,
        merged_count INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS proto_edges (
        source TEXT NOT NULL CHECK(source IN ('core', 'volatile')),
        polarity TEXT NOT NULL CHECK(polarity IN ('positive', 'negative')),
        parent_proto TEXT NOT NULL,
        child_proto TEXT NOT NULL,
        accum_distance REAL NOT NULL,
        PRIMARY KEY (source, polarity, parent_proto, child_proto)
    );

    CREATE INDEX IF NOT EXISTS idx_compat_core_pos ON core_positive (compat_id);
    CREATE INDEX IF NOT EXISTS idx_compat_core_neg ON core_negative (compat_id);
    CREATE INDEX IF NOT EXISTS idx_compat_vol_pos ON volatile_positive (compat_id);
    CREATE INDEX IF NOT EXISTS idx_compat_vol_neg ON volatile_negative (compat_id);

    CREATE INDEX IF NOT EXISTS idx_purge_vol_pos ON volatile_positive (lastAccessed ASC, importance ASC, accessCount ASC, merged_count ASC, protoId ASC);
    CREATE INDEX IF NOT EXISTS idx_purge_vol_neg ON volatile_negative (lastAccessed ASC, importance ASC, accessCount ASC, merged_count ASC, protoId ASC);
    CREATE INDEX IF NOT EXISTS idx_purge_core_pos ON core_positive (lastAccessed ASC, importance ASC, accessCount ASC, merged_count ASC, protoId ASC);
    CREATE INDEX IF NOT EXISTS idx_purge_core_neg ON core_negative (lastAccessed ASC, importance ASC, accessCount ASC, merged_count ASC, protoId ASC);

    CREATE INDEX IF NOT EXISTS idx_top_core_pos ON core_positive (compat_id, importance DESC, accessCount DESC, lastAccessed DESC);
    CREATE INDEX IF NOT EXISTS idx_top_core_neg ON core_negative (compat_id, importance DESC, accessCount DESC, lastAccessed DESC);
    CREATE INDEX IF NOT EXISTS idx_top_vol_pos ON volatile_positive (compat_id, importance DESC, accessCount DESC, lastAccessed DESC);
    CREATE INDEX IF NOT EXISTS idx_top_vol_neg ON volatile_negative (compat_id, importance DESC, accessCount DESC, lastAccessed DESC);

    CREATE INDEX IF NOT EXISTS idx_proto_edges_child ON proto_edges (source, polarity, child_proto);
    CREATE INDEX IF NOT EXISTS idx_proto_edges_parent ON proto_edges (source, polarity, parent_proto);
`);

