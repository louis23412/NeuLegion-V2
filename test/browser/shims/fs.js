// Minimal `fs` shim. SQLite database files live in an in-memory registry
// (see shims/better-sqlite3.js) so `existsSync` reflects databases that have
// been opened/created during the current run. Other paths are read from the
// workspace-backed virtual filesystem exposed on `globalThis.__vfs`.

function vfs() {
    if (!globalThis.__vfs) {
        globalThis.__vfs = { files: new Map(), dbPaths: new Set(), dirs: new Set() };
    }
    return globalThis.__vfs;
}

export function existsSync(p) {
    const key = String(p);
    const v = vfs();
    return v.dbPaths.has(key) || v.files.has(key) || v.dirs.has(key);
}

export function mkdirSync(p, opts = {}) {
    const v = vfs();
    const key = String(p);
    v.dirs.add(key);
    if (opts && opts.recursive) {
        let cur = key;
        while (cur && cur !== '.' && cur !== '/') {
            const i = cur.lastIndexOf('/');
            if (i < 0) break;
            cur = cur.slice(0, i);
            v.dirs.add(cur);
        }
    }
    return undefined;
}

export function readFileSync(p, encoding) {
    const v = vfs();
    const key = String(p);
    if (!v.files.has(key)) {
        const err = new Error(`ENOENT: no such file or directory, open '${key}'`);
        err.code = 'ENOENT';
        throw err;
    }
    const data = v.files.get(key);
    if (encoding) return new TextDecoder().decode(data);
    return data;
}

export function writeFileSync(p, data) {
    const v = vfs();
    const key = String(p);
    let bytes;
    if (typeof data === 'string') bytes = new TextEncoder().encode(data);
    else if (data instanceof Uint8Array) bytes = data.slice();
    else bytes = new Uint8Array(data);
    v.files.set(key, bytes);
    return undefined;
}

// Append (create-on-first-write). `observer/report.js#appendLog`/`appendJsonl`
// feature-detect this, so without it the run journal and the `analyze` fold
// stream would silently no-op in the harness.
export function appendFileSync(p, data) {
    const v = vfs();
    const key = String(p);
    const add = typeof data === 'string'
        ? new TextEncoder().encode(data)
        : (data instanceof Uint8Array ? data : new Uint8Array(data));
    const prev = v.files.get(key);
    if (prev) {
        const out = new Uint8Array(prev.length + add.length);
        out.set(prev, 0);
        out.set(add, prev.length);
        v.files.set(key, out);
    } else {
        v.files.set(key, add.slice());
    }
    return undefined;
}

// Recursive-aware rm (Node's `rmSync(p, { recursive: true, force: true })`): the
// exact key AND every key beneath it are dropped, so a discarded per-fit model
// directory really disappears (analyze.js reclaims `state/runs/<id>/models/<fit>`).
// It also drops any sql.js database still registered under the removed path — the
// better-sqlite3 shim publishes its registry on `globalThis.__dbRegistry` — so a
// re-used path can never serve a stale, deleted database.
export function rmSync(p) {
    const v = vfs();
    const key = String(p);
    const prefix = `${key}/`;
    for (const set of [v.files, v.dbPaths]) {
        for (const k of [...set.keys()]) if (k === key || k.startsWith(prefix)) set.delete(k);
    }
    for (const d of [...v.dirs]) if (d === key || d.startsWith(prefix)) v.dirs.delete(d);
    const registry = globalThis.__dbRegistry;
    if (registry && typeof registry.keys === 'function') {
        for (const k of [...registry.keys()]) {
            if (k === key || k.startsWith(prefix)) {
                try { const db = registry.get(k); if (db && typeof db.close === 'function') db.close(); } catch { /* ignore */ }
                registry.delete(k);
            }
        }
    }
}

export function renameSync(from, to) {
    const v = vfs();
    const src = String(from), dst = String(to);
    if (v.files.has(src)) { v.files.set(dst, v.files.get(src)); v.files.delete(src); }
    if (v.dirs.has(src)) { v.dirs.delete(src); v.dirs.add(dst); }
    return undefined;
}

// Immediate children of a directory, as Node's `readdirSync` reports them —
// including the `{ withFileTypes: true }` Dirent shape (`name` + `isDirectory()`),
// which `observer/report.js#pruneRunDirectories` relies on. Used to assert a
// reclaimed `models/` directory is empty.
export function readdirSync(p, opts = {}) {
    const v = vfs();
    const key = String(p).replace(/\/+$/, '');
    const prefix = `${key}/`;
    const children = new Map(); // name -> isDirectory
    for (const set of [v.files, v.dbPaths]) {
        for (const k of set.keys()) {
            if (!k.startsWith(prefix)) continue;
            const rest = k.slice(prefix.length);
            const cut = rest.indexOf('/');
            const name = cut === -1 ? rest : rest.slice(0, cut);
            if (!children.has(name)) children.set(name, cut !== -1);
        }
    }
    for (const d of v.dirs) {
        if (!d.startsWith(prefix)) continue;
        const rest = d.slice(prefix.length);
        const cut = rest.indexOf('/');
        const name = cut === -1 ? rest : rest.slice(0, cut);
        children.set(name, true);
    }
    if (opts && opts.withFileTypes) {
        return [...children.entries()].map(([name, isDir]) => ({
            name,
            isDirectory: () => isDir,
            isFile: () => !isDir,
        }));
    }
    return [...children.keys()];
}

// Unique temp directory (used by tools that stage per-run scratch, e.g.
// analyze.js's model state dir when it is not writing a run directory).
let mkdtempCounter = 0;
export function mkdtempSync(prefix) {
    const v = vfs();
    const dir = `${String(prefix)}${String(mkdtempCounter++).padStart(6, '0')}`;
    v.dirs.add(dir);
    return dir;
}

// Async line source used by mainController's readline loop. Tests push lines
// into `globalThis.__vfs.candleLines` / provide a path keyed by resolved name.
export function createReadStream(p) {
    const v = vfs();
    const key = String(p);
    const lines = v.files.has(key)
        ? new TextDecoder().decode(v.files.get(key)).split('\n')
        : (v.candleLines || []);
    const handlers = {};
    const stream = {
        destroy() { stream.destroyed = true; },
        destroyed: false,
        on(evt, cb) { handlers[evt] = cb; return stream; },
        async *[Symbol.asyncIterator]() {
            for (const line of lines) {
                if (stream.destroyed) return;
                yield `${line}\n`;
            }
        },
    };
    return stream;
}

const api = {
    existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync,
    rmSync, renameSync, readdirSync, createReadStream, promises: {},
};
export default api;
