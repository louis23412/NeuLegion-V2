// src/analyze/cli/io.js (round-95 split of src/analyze/cli.js).
// Candle/funding I/O readers, symbol resolution, audit block.
import fs from 'fs';
import path from 'path';
import { CANDLE_MANIFEST } from '../../candles_audit.js';


// ---------------------------------------------------------------------------

// Read closes from a JSONL candle stream (optionally the last `maxBars`).
export function readCloses(file, { maxBars = null } = {}) {
    const text = fs.readFileSync(file, 'utf8');
    const closes = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
            const c = JSON.parse(line);
            if (Number.isFinite(c.close)) closes.push(c.close);
        } catch { /* skip a malformed line, exactly like the runner */ }
    }
    return maxBars && closes.length > maxBars ? closes.slice(-maxBars) : closes;
}

// Coerce an optional numeric field, treating null / '' / booleans / non-finite
// as absent. `Number(null)` and `Number('')` are both 0, so a naive `Number()`
// would silently turn a missing close into a price of 0 — which is exactly the
// kind of corrupt row this reader exists to keep out of the model.
const numOr = (v, fallback) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
    if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
    }
    return fallback;
};

// Read the full candle rows from a JSONL stream (round 23: the A/B's world needs
// OHLCV, not just closes). Malformed lines and rows without a finite close are
// skipped, exactly like the runner; `volume` defaults to 1 so a close-only stream
// still yields a usable world.
export function readCandles(file, { maxBars = null } = {}) {
    const text = fs.readFileSync(file, 'utf8');
    const out = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let c;
        try { c = JSON.parse(line); } catch { continue; }
        const close = numOr(c.close, NaN);
        if (!Number.isFinite(close)) continue;
        const open = numOr(c.open, close);
        const high = numOr(c.high, Math.max(open, close));
        const low = numOr(c.low, Math.min(open, close));
        const volume = numOr(c.volume, 1);
        out.push({ timestamp: c.timestamp, open, high, low, close, volume });
    }
    return maxBars && out.length > maxBars ? out.slice(-maxBars) : out;
}

// Map `--symbols=a,b` to manifest file paths (project-root relative).
export const resolveSymbolFiles = (symbols) => {
    const root = path.join(import.meta.dirname || '.', '..', '..', '..');
    return symbols.map((s) => {
        const entry = CANDLE_MANIFEST.find((e) => e.symbol === String(s).toUpperCase());
        if (!entry) throw new Error(`analyze: unknown symbol "${s}" (known: ${CANDLE_MANIFEST.map((e) => e.symbol).join(', ')})`);
        return path.join(root, entry.file);
    });
};

// ---------------------------------------------------------------------------
// Run-integrity helpers (round 24): artifact shaping, progress and checkpoints.
// ---------------------------------------------------------------------------

// How many probe passes `auditNoLookahead` will run for a fold of `testLen` bars:
// `stride = ceil(testLen / auditProbesPerFold)` then one pass per stride step. Used
// only to size the progress denominator, never to decide anything.
export const probesPerFold = (testLen, auditProbesPerFold) => {
    const stride = auditProbesPerFold > 0 ? Math.max(1, Math.ceil(testLen / auditProbesPerFold)) : 1;
    return Math.ceil(testLen / stride);
};

// The machine-readable audit block. `reachable`/`reachableFolds` are the
// behavioural half of the certificate (`probes`/`viewDiffers` are the structural
// half): the shock reached the model's input AND demonstrably moved a later
// position. Exposed in the report so a `clean` audit can be read for what it is.
export const auditBlock = (audit) => (audit
    ? {
        clean: !!audit.clean,
        vacuous: !!audit.vacuous,
        reachable: audit.reachable === true,
        reachableFolds: audit.reachableFolds == null ? null : audit.reachableFolds,
        viewDiffers: audit.viewDiffers == null ? null : audit.viewDiffers,
        probes: audit.probes || 0,
        baseReused: audit.baseReused == null ? null : audit.baseReused,
        violations: (audit.violations || []).length,
        violationExamples: (audit.violations || []).slice(0, 5),
        auditStreams: audit.streams == null ? null : audit.streams,
    }
    : null);
