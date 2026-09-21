// A better-sqlite3-compatible shim backed by sql.js (SQLite compiled to WASM).
// This lets the NeuLegion core run headlessly inside a browser Worker so its
// database-heavy code paths can be exercised without Node/native modules.
//
// Supported: new Database(path[, opts]), pragma, exec, prepare -> run/all/get/pluck,
// transaction (nested via SAVEPOINT), close, and BLOB <-> Uint8Array round-tripping.

import initSqlJs from "https://cdn.jsdelivr.net/npm/sql.js@1.11.0/dist/sql-wasm.js/+esm";

let SQL = null;
let SQLPromise = null;

export function __ensureSql() {
    if (SQL) return Promise.resolve(SQL);
    if (!SQLPromise) {
        SQLPromise = initSqlJs({
            locateFile: (f) => `https://cdn.jsdelivr.net/npm/sql.js@1.11.0/dist/${f}`,
        }).then((s) => { SQL = s; return s; });
    }
    return SQLPromise;
}

function vfs() {
    if (!globalThis.__vfs) {
        globalThis.__vfs = { files: new Map(), dbPaths: new Set(), dirs: new Set() };
    }
    return globalThis.__vfs;
}

const registry = new Map(); // absolute-ish path -> sql.js Database

class Statement {
    constructor(db, sql) {
        this._db = db;
        this._sql = sql;
        this._pluck = false;
    }

    pluck() { this._pluck = true; return this; }

    _bind(args) { return args.map((a) => (a === undefined ? null : a)); }

    run(...args) {
        this._db.run(this._sql, this._bind(args));
        const changes = this._db.getRowsModified();
        let lastInsertRowid = 0;
        try {
            const r = this._db.exec('SELECT last_insert_rowid() AS id');
            if (r[0] && r[0].values[0]) lastInsertRowid = r[0].values[0][0];
        } catch { /* ignore */ }
        return { changes, lastInsertRowid };
    }

    _rows(args) {
        const res = this._db.exec(this._sql, this._bind(args));
        if (!res || res.length === 0) return [];
        const { columns, values } = res[res.length - 1];
        return values.map((v) => {
            const o = {};
            for (let i = 0; i < columns.length; i++) o[columns[i]] = v[i];
            return o;
        });
    }

    all(...args) {
        const rows = this._rows(args);
        if (!this._pluck) return rows;
        return rows.map((r) => r[Object.keys(r)[0]]);
    }

    get(...args) {
        const rows = this._rows(args);
        if (rows.length === 0) return undefined;
        const r = rows[0];
        return this._pluck ? r[Object.keys(r)[0]] : r;
    }

    iterate(...args) { return this.all(...args)[Symbol.iterator](); }
    raw() { return this; }
}

class Database {
    constructor(dbPath, opts = {}) {
        if (!SQL) throw new Error('sql.js not initialized: await __ensureSql() before constructing Database');

        const key = String(dbPath);
        const v = vfs();

        if (registry.has(key)) {
            this._db = registry.get(key);
        } else {
            if (opts.readonly) {
                const err = new Error(`unable to open database file: ${key}`);
                err.code = 'SQLITE_CANTOPEN';
                throw err;
            }
            this._db = new SQL.Database();
            registry.set(key, this._db);
            v.dbPaths.add(key);
        }

        this._path = key;
        this._inTx = false;
        this._points = 0;
    }

    pragma(str) { return undefined; } // journal/synchronous/cache pragmas are no-ops for sql.js

    exec(sql) { this._db.exec(sql); return this; }

    prepare(sql) { return new Statement(this._db, sql); }

    transaction(fn) {
        const self = this;
        return (...args) => {
            if (self._inTx) {
                const name = `sp_${self._points++}`;
                self._db.exec(`SAVEPOINT ${name}`);
                try {
                    const r = fn(...args);
                    self._db.exec(`RELEASE ${name}`);
                    return r;
                } catch (e) {
                    self._db.exec(`ROLLBACK TO ${name}`);
                    self._db.exec(`RELEASE ${name}`);
                    throw e;
                }
            }
            self._inTx = true;
            self._db.exec('BEGIN');
            try {
                const r = fn(...args);
                self._db.exec('COMMIT');
                return r;
            } catch (e) {
                try { self._db.exec('ROLLBACK'); } catch { /* ignore */ }
                throw e;
            } finally {
                self._inTx = false;
            }
        };
    }

    close() { /* the in-memory database stays registered for other connections */ }

    // Test/diagnostic helpers (not part of better-sqlite3)
    __raw() { return this._db; }
    serialize() { return this._db.export(); }
}

Database.__registry = registry;
// The `fs` shim's recursive `rmSync` reads this to drop databases under a removed
// path (so a deleted-and-recreated fit directory can never serve stale state).
globalThis.__dbRegistry = registry;
export default Database;
export { Database };
