// NeuLegion observer component: run directory, spool and report artifacts
// (ROADMAP P1-2).
//
// A run writes everything under `state/runs/<runId>/`:
//   run.json      — the run manifest (config fingerprint, code, start/resume)
//   snapshots.jsonl — one canonical per-batch snapshot per line (the spool)
//   report.json   — the final observer report (metrics, alerts, summary)
//   run.log       — the structured event journal
//
// Everything here is plain fs + JSON, no hot-path coupling. Retention keeps the
// newest `keep` run directories so repeated runs cannot fill the disk.

import fs from 'fs';
import path from 'path';

const pad = (n, w = 2) => String(n).padStart(w, '0');

export const makeRunId = ({ seed = null, startedAt = Date.now() } = {}) => {
    const d = new Date(startedAt);
    const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
    return `${stamp}-seed${seed == null ? 'none' : seed}`;
};

export const createRunDirectory = (stateFolder, runId) => {
    const dir = path.join(stateFolder, 'runs', runId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
};

// Keep only the newest `keep` run directories (lexicographic order on the
// timestamp-prefixed id is chronological).
export const pruneRunDirectories = (stateFolder, keep = 20) => {
    const runsRoot = path.join(stateFolder, 'runs');
    if (typeof fs.readdirSync !== 'function') return { removed: [] };
    if (!fs.existsSync(runsRoot)) return { removed: [] };
    const entries = fs.readdirSync(runsRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    const removed = [];
    const excess = entries.length - Math.max(0, keep);
    for (let i = 0; i < excess; i++) {
        const target = path.join(runsRoot, entries[i]);
        try {
            fs.rmSync(target, { recursive: true, force: true });
            removed.push(entries[i]);
        } catch { /* best effort */ }
    }
    return { removed };
};

export const writeJson = (dir, name, value) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
    return file;
};

// Crash-safe JSON write: serialise beside the target and rename it into place, so
// a process killed mid-write can never leave a torn (unparseable) artifact behind.
// The long-running `analyze` CLI checkpoints with this — an interrupted run must
// leave *readable* partial state, which a truncated `writeFileSync` would not.
// Falls back to a direct write when `renameSync` is unavailable (test shims).
export const writeJsonAtomic = (dir, name, value) => {
    const file = path.join(dir, name);
    const text = JSON.stringify(value, null, 2);
    try {
        if (typeof fs.renameSync === 'function') {
            const tmp = `${file}.tmp`;
            fs.writeFileSync(tmp, text);
            fs.renameSync(tmp, file);
            return file;
        }
    } catch { /* fall through to a direct write */ }
    fs.writeFileSync(file, text);
    return file;
};

// Append-only newline-delimited JSON (one self-contained record per line, so a
// truncated final line costs at most one record). Used for the `run.log` journal
// and the `analyze` fold stream (`folds.jsonl`).
export const appendJsonl = (dir, name, value) => {
    if (!dir || typeof fs.appendFileSync !== 'function') return false;
    try {
        fs.appendFileSync(path.join(dir, name), `${JSON.stringify(value)}\n`);
        return true;
    } catch {
        return false;
    }
};

export const readJson = (dir, name, fallback = null) => {
    try {
        return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
        return fallback;
    }
};

export const appendSnapshot = (dir, snapshot) => {
    if (!dir || typeof fs.appendFileSync !== 'function') return false;
    try {
        fs.appendFileSync(path.join(dir, 'snapshots.jsonl'), `${JSON.stringify(snapshot)}\n`);
        return true;
    } catch {
        return false;
    }
};

export const appendLog = (dir, level, message, data = null) => {
    if (!dir || typeof fs.appendFileSync !== 'function') return false;
    try {
        const line = JSON.stringify({ t: new Date().toISOString(), level, message, data });
        fs.appendFileSync(path.join(dir, 'run.log'), `${line}\n`);
        return true;
    } catch {
        return false;
    }
};

export const writeReport = (dir, report) => writeJson(dir, 'report.json', report);
