import fs from 'fs';
import os from 'os';
import path from 'path';

export function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function withSeed(seed, fn) {
    const original = Math.random;
    Math.random = mulberry32(seed);
    try { return fn(); } finally { Math.random = original; }
}

let dirCounter = 0;
export function tempStateDir(label = 'nl') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-${process.pid}-${dirCounter++}-`));
    return dir;
}

// Per-label temp state dir. The browser entries treat `stateDir(label)` as a
// PURE function of the label (`state/<suite>-<label>`), so a suite may save and
// then reload from `stateDir('I')` and expect the SAME directory. A mirror that
// mapped each CALL to a fresh temp dir would hand the reload an empty database
// (measured: `protos=0/144` after a dumpState/reload round-trip), so the label
// -> dir mapping is memoised here to match the browser semantics exactly.
const labelDirs = new Map();
export function labelledStateDir(label = 'nl') {
    if (!labelDirs.has(label)) labelDirs.set(label, tempStateDir(label));
    return labelDirs.get(label);
}

export function makeCandles(n, { start = 100, seed = 1, trend = 0, vol = 1 } = {}) {
    const rnd = mulberry32(seed);
    const candles = [];
    let price = start;
    const baseTs = Date.parse('2024-01-01T00:00:00Z');
    for (let i = 0; i < n; i++) {
        const open = price;
        price = Math.max(0.5, price + trend * price + (rnd() - 0.5) * 2 * vol);
        const close = price;
        const high = Math.max(open, close) + rnd() * vol;
        const low = Math.min(open, close) - rnd() * vol;
        candles.push({
            timestamp: new Date(baseTs + i * 60000).toISOString(),
            open: Number(open.toFixed(4)),
            high: Number(high.toFixed(4)),
            low: Number(low.toFixed(4)),
            close: Number(close.toFixed(4)),
            volume: Math.round(1000 + rnd() * 5000),
        });
    }
    return candles;
}

// Mixed structured input rows so prototypes actually form and get pruned.
export function makeInputs(inputSize, steps, seed = 7) {
    const rnd = mulberry32(seed);
    const rows = [];
    for (let s = 0; s < steps; s++) {
        const row = new Array(inputSize);
        for (let i = 0; i < inputSize; i++) {
            const base = Math.sin((s + i * 3) * 0.17) * 0.5 + 0.5;
            const noise = (rnd() - 0.5) * 0.4;
            const spike = (s % 37 === 0 && i % 5 === 0) ? (rnd() - 0.5) * 6 : 0;
            row[i] = base + noise + spike;
        }
        rows.push(row);
    }
    return rows;
}

export const PRICE = { atrFactor: 2, stopFactor: 1, minPriceMovement: 0.0025, maxPriceMovement: 0.05 };
