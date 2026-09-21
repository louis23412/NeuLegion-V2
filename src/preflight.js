// NeuLegion preflight (`npm run preflight`) — the read-only gate that must pass
// before a long run starts (ROADMAP P0-3).
//
// It checks every precondition that a multi-hour run depends on, so a broken
// environment or config fails in seconds instead of hours in:
//   1. Node version floor (the test runner needs >= 22; the run itself too)
//   2. candle stream: exists, parseable, monotonic, OHLC-valid (sampled)
//   3. state directory: writable
//   4. native SQLite: openable, WAL, schema round-trip
//   5. config sanity: dimensions/ratios/timeouts/worker count
//   6. worker smoke: spawn the real worker.js once and get a well-formed signal
//   7. dashboard port availability (non-fatal; the server falls back)
//   8. disk / memory headroom
//
// Exit code 0 when every check passes, 1 otherwise.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { CONFIG } from './legion/config.js';
import { configFingerprint } from './legion/sanitize.js';

const ok = (name, detail = '') => ({ name, ok: true, detail });
const bad = (name, detail = '') => ({ name, ok: false, detail });
const skip = (name, detail = '') => ({ name, ok: true, skipped: true, detail });

const sampleCandles = (n = 40) => {
    const out = [];
    let price = 100;
    const base = Date.parse('2024-01-01T00:00:00Z');
    for (let i = 0; i < n; i++) {
        const open = price;
        price = price * (1 + Math.sin(i / 7) * 0.002);
        const close = price;
        out.push({
            timestamp: new Date(base + i * 3600000).toISOString(),
            open: Number(open.toFixed(4)),
            high: Number((Math.max(open, close) + 0.05).toFixed(4)),
            low: Number((Math.min(open, close) - 0.05).toFixed(4)),
            close: Number(close.toFixed(4)),
            volume: 1000 + i,
        });
    }
    return out;
};

const checkNode = () => {
    const major = Number(String(process.version).replace(/^v/, '').split('.')[0]);
    return Number.isFinite(major) && major >= 22
        ? ok('node version', process.version)
        : bad('node version', `${process.version} (need >= 22)`);
};

const checkCandles = () => {
    const file = CONFIG.file;
    if (!fs.existsSync(file)) return bad('candle stream exists', file);
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return bad('candle stream readable', file); }
    if (size === 0) return bad('candle stream non-empty', `${file} is empty`);

    // The sample is a byte window, not a line window: unless it reaches EOF it
    // ends in the middle of a line, and that truncated tail must not be counted
    // as malformed (a healthy checkout ends at an arbitrary byte offset, so it
    // always has one partial tail line). Trim back to the last complete newline
    // whenever the window stopped short of the end of the file.
    const sampleBytes = Math.min(size, 262144);
    const fd = fs.openSync(file, 'r');
    try {
        const buf = Buffer.alloc(sampleBytes);
        const read = fs.readSync(fd, buf, 0, sampleBytes, 0);
        let text = buf.toString('utf8', 0, read);
        if (read < size) {
            const lastNewline = text.lastIndexOf('\n');
            if (lastNewline === -1) return bad('candle stream parseable', `no complete JSON line in first ${read} bytes`);
            text = text.slice(0, lastNewline);
        }
        const head = text.split('\n').filter(Boolean);
        let parsed = 0;
        let malformed = 0;
        let monotonic = true;
        let prevTs = -Infinity;
        let ohlcValid = true;
        for (const line of head) {
            let c;
            try { c = JSON.parse(line); } catch { malformed++; continue; }
            parsed++;
            const ts = Date.parse(c.timestamp);
            if (Number.isFinite(ts)) { if (ts < prevTs) monotonic = false; prevTs = ts; } else monotonic = false;
            const nums = [c.open, c.high, c.low, c.close].map(Number);
            if (!nums.every(Number.isFinite)) ohlcValid = false;
            else if (nums[1] < Math.max(nums[0], nums[3]) || nums[2] > Math.min(nums[0], nums[3])) ohlcValid = false;
        }
        if (parsed === 0) return bad('candle stream parseable', `no JSON lines in first ${read} bytes`);
        if (malformed > 0) return bad('candle stream parseable', `${malformed} malformed line(s) in sample`);
        if (!monotonic) return bad('candle timestamps monotonic', 'sampled window regressed');
        if (!ohlcValid) return bad('candle OHLC valid', 'sampled window violated high/low bounds');
        return ok('candle stream sample', `${parsed} lines parsed, ${size} bytes`);
    } finally {
        fs.closeSync(fd);
    }
};

const checkStateDir = () => {
    try {
        fs.mkdirSync(CONFIG.stateFolder, { recursive: true });
        const probe = path.join(CONFIG.stateFolder, `.preflight-${process.pid}`);
        fs.writeFileSync(probe, 'ok');
        fs.rmSync(probe);
        return ok('state directory writable', CONFIG.stateFolder);
    } catch (err) {
        return bad('state directory writable', `${CONFIG.stateFolder}: ${err.message}`);
    }
};

const checkSqlite = async () => {
    try {
        const { default: Database } = await import('better-sqlite3');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neulegion-preflight-'));
        const db = new Database(path.join(dir, 'probe.db'));
        db.pragma('journal_mode = WAL');
        db.exec('CREATE TABLE IF NOT EXISTS t (k TEXT PRIMARY KEY, v INTEGER NOT NULL)');
        db.prepare('INSERT OR REPLACE INTO t (k, v) VALUES (?, ?)').run('a', 1);
        const row = db.prepare('SELECT v FROM t WHERE k = ?').get('a');
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
        return row && row.v === 1 ? ok('sqlite native', 'open + WAL + round-trip') : bad('sqlite native', 'round-trip returned the wrong value');
    } catch (err) {
        return bad('sqlite native', err.message);
    }
};

const checkConfig = () => {
    const problems = [];
    for (const k of ['baseGroups', 'baseSections', 'baseLayers', 'basePairs', 'elderPairs', 'basePop', 'baseCache']) {
        if (!Number.isFinite(CONFIG[k]) || CONFIG[k] <= 0) problems.push(`${k}=${CONFIG[k]}`);
    }
    if (!Number.isFinite(CONFIG.maxTier) || CONFIG.maxTier < 1) problems.push(`maxTier=${CONFIG.maxTier}`);
    for (const k of ['broadcastRatio', 'injectionRatio']) {
        if (!Number.isFinite(CONFIG[k]) || CONFIG[k] < 0 || CONFIG[k] > 1) problems.push(`${k}=${CONFIG[k]}`);
    }
    if (!Number.isFinite(CONFIG.maxWorkers) || CONFIG.maxWorkers < 1) problems.push(`maxWorkers=${CONFIG.maxWorkers}`);
    if (CONFIG.workerTimeoutMs != null && (!Number.isFinite(CONFIG.workerTimeoutMs) || CONFIG.workerTimeoutMs < 0)) problems.push(`workerTimeoutMs=${CONFIG.workerTimeoutMs}`);
    return problems.length ? bad('config sanity', problems.join(', ')) : ok('config sanity', `fingerprint ${configFingerprint(CONFIG)}`);
};

const checkWorkerSmoke = async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neulegion-worker-'));
    try {
        const signal = await new Promise((resolve, reject) => {
            const worker = new Worker(new URL('./worker.js', import.meta.url), {
                workerData: {
                    id: 'preflight',
                    directoryPath: dir,
                    cacheSize: 40,
                    pop: 2,
                    cache: sampleCandles(40),
                    type: 'positive',
                    tier: 1,
                    priceObj: { atrFactor: 2, stopFactor: 1, minPriceMovement: 0.0025, maxPriceMovement: 0.05 },
                    processCount: 1,
                    forceMin: CONFIG.forceMin,
                    bcR: CONFIG.broadcastRatio,
                    injR: CONFIG.injectionRatio,
                    sharedMem: [],
                    childMem: [],
                    seed: null,
                },
            });
            const timer = setTimeout(() => { worker.terminate(); reject(new Error('worker did not respond within 30s')); }, 30000);
            worker.on('message', (msg) => { clearTimeout(timer); worker.terminate(); msg && msg.error ? reject(new Error(msg.error)) : resolve(msg.signal); });
            worker.on('error', (e) => { clearTimeout(timer); reject(e); });
            worker.on('exit', (code) => { if (code !== 0) { clearTimeout(timer); reject(new Error(`worker exited with code ${code}`)); } });
        });
        if (!signal || typeof signal !== 'object') return bad('worker smoke', 'no signal object');
        const finite = ['entryPrice', 'sellPrice', 'stopLoss', 'prob', 'score'].every((k) => Number.isFinite(signal[k]));
        return finite ? ok('worker smoke', `signal ok (prob=${signal.prob})`) : bad('worker smoke', `signal had non-finite fields: ${JSON.stringify({ entryPrice: signal.entryPrice, sellPrice: signal.sellPrice, prob: signal.prob })}`);
    } catch (err) {
        return bad('worker smoke', err.message);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
};

const checkPort = async () => {
    const net = await import('node:net');
    return await new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', (err) => resolve(err.code === 'EADDRINUSE' ? skip('dashboard port', `${CONFIG.httpHost}:${CONFIG.httpPort} busy (server will fall back to an ephemeral port)`) : bad('dashboard port', err.message)));
        server.once('listening', () => {
            server.close(() => resolve(ok('dashboard port', `${CONFIG.httpHost}:${CONFIG.httpPort} free`)));
        });
        server.listen(CONFIG.httpPort, CONFIG.httpHost);
    });
};

const checkResources = () => {
    const checks = [];
    const freeMem = os.freemem();
    checks.push(freeMem > 256 * 1024 * 1024 ? ok('memory headroom', `${(freeMem / 1e9).toFixed(1)} GB free`) : bad('memory headroom', `only ${(freeMem / 1e6).toFixed(0)} MB free`));
    try {
        if (typeof fs.statfsSync === 'function') {
            const st = fs.statfsSync(CONFIG.stateFolder);
            const freeBytes = Number(st.bavail) * Number(st.bsize);
            checks.push(freeBytes > 200 * 1024 * 1024 ? ok('disk headroom', `${(freeBytes / 1e9).toFixed(1)} GB free`) : bad('disk headroom', `only ${(freeBytes / 1e6).toFixed(0)} MB free`));
        } else {
            checks.push(skip('disk headroom', 'fs.statfsSync unavailable'));
        }
    } catch (err) {
        checks.push(skip('disk headroom', err.message));
    }
    return checks;
};

export const runPreflight = async () => {
    const checks = [];
    checks.push(checkNode());
    checks.push(checkCandles());
    checks.push(checkStateDir());
    checks.push(await checkSqlite());
    checks.push(checkConfig());
    checks.push(await checkWorkerSmoke());
    checks.push(await checkPort());
    checks.push(...checkResources());
    return checks;
};

export const formatPreflight = (checks) => checks.map((c) => {
    const mark = c.skipped ? 'SKIP' : (c.ok ? 'PASS' : 'FAIL');
    return `[${mark}] ${c.name}${c.detail ? ` — ${c.detail}` : ''}`;
}).join('\n');

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    const checks = await runPreflight();
    console.log(formatPreflight(checks));
    const failed = checks.filter((c) => !c.ok);
    if (failed.length) {
        console.error(`\n${failed.length} preflight check(s) failed. Do not start a full run until these pass.`);
        process.exit(1);
    }
    console.log('\npreflight OK.');
}
