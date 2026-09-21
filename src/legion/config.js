// NeuLegion legion component: legion configuration
//
// Split out of the original monolithic src/mainController.js; the bodies are
// byte-identical apart from the shared mutable state being read/written as
// properties of the `state` holder (see ./state.js). src/mainController.js is
// now just the entry point that runs ./legion/runner.js.

import path from 'path';
import { performance } from 'node:perf_hooks';
import { availableParallelism } from 'node:os';

export const scriptStart = performance.now();

// Environment overrides (ROADMAP P0-2/P0-3). Read once, at module evaluation,
// BEFORE the legion databases open — `legion/database.js` derives its paths from
// `CONFIG.stateFolder` at import time, so an override must land here. Every
// override is optional and defaults to the historical behaviour, so the golden
// fingerprints and the existing tests are unaffected.
const envString = (name) => {
    const v = process.env ? process.env[name] : undefined;
    return typeof v === 'string' && v.length > 0 ? v : undefined;
};
const envNumber = (name) => {
    const v = envString(name);
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
};

export const CONFIG = {
    cutoff: null,
    baseProcessCount: 1,
    forceMin: true,

    // --- Run integrity (ROADMAP P0) -----------------------------------------
    // Per-batch controller-failure budget. A failure is *isolated* (the
    // controller keeps its previous signal and the batch continues); only a
    // breach of this budget stops the run, so one bad slot, one corrupt memory
    // row or one transient SQLite error can no longer kill a long run.
    //   finite fraction in (0, 1] -> at most ceil(budget * poolSize) failures
    //   finite number > 1         -> that many failures (absolute)
    //   0                         -> any failure breaches the budget (strict)
    //   null / negative           -> never breach (isolation only)
    controllerFailureBudget: 0.1,
    // A whole batch that throws is logged and the stream continues; only this
    // many consecutive failed batches stop the run. A budget breach from the
    // controller-failure path is fatal regardless (it is a broken pool).
    maxFailedBatches: 3,
    // Worker watchdog: a worker that neither posts nor errors is terminated and
    // counted as a failure after this many ms. 0 / null disables the watchdog.
    workerTimeoutMs: 120000,
    // Deterministic runs: a finite seed installs a seeded Math.random inside
    // every worker (derived per worker id), so a run is bit-reproducible.
    // null = native randomness (default).
    seed: envNumber('NEULEGION_SEED') ?? null,
    // Resume guard (ROADMAP P0-2): if the persisted state was written with a
    // different structure/config fingerprint, warn (default) or refuse
    // (`refuseOnConfigChange: true`) rather than silently mixing two models.
    refuseOnConfigChange: false,
    // CLI keeps the process alive after the stream stops so the dashboard stays
    // up (the historical behaviour).
    keepAliveAfterRun: true,
    // Stop after this many completed batches and resolve (dry-run / tests).
    // null = run to the end of the stream.
    maxBatches: envNumber('NEULEGION_MAX_BATCHES') ?? null,
    // The monitor dashboard binds loopback by default (it is local-only); set
    // httpEnabled false to run headless (tests). Port 0 picks an ephemeral port.
    httpHost: envString('NEULEGION_HTTP_HOST') || '127.0.0.1',
    httpEnabled: envString('NEULEGION_HTTP') !== '0',
    // Retention: keep at most this many run directories under `state/runs/`.
    maxRunDirectories: 20,

    // Candle quality: winsorize physically-impossible single-bar wicks (e.g. a
    // venue flash print) before they reach the indicator pipeline. The raw
    // JSONL stays byte-exact; see src/candle_quality.js and docs/BUGS.md.
    candleWickRepair: true,
    candleMaxWickFraction: 0.9,

    httpPort: 3000,
    maxWorkers: Math.max(1, Math.floor(availableParallelism() * 0.25)),
    file: path.join(import.meta.dirname, '..', 'candles.jsonl'),
    stateFolder : path.join(import.meta.dirname, '..', '..', 'state'),

    baseGroups : 2,
    baseSections : 2,
    baseLayers : 2,

    basePairs : 2,
    elderPairs : 2,

    maxTier: 4,
    tierWeightMultiplier: 0.35,

    basePop: 64,
    groupPopBoost: 0.05,
    sectionPopBoost: 0.15,
    layerPopBoost: 0.25,

    baseCache: 500,
    groupCacheBoost: 0.15,
    sectionCacheBoost: 0.25,
    layerCacheBoost: 0.35,

    baseAtr: 2,
    baseStop: 1,
    minPriceMove: 0.0025,
    maxPriceMove: 0.05,
    groupPriceBoost: 0.05,
    sectionPriceBoost: 0.10,
    layerPriceBoost: 0.15,

    broadcastRatio : 0.025,
    injectionRatio : 0.025,

    volatileMemoryDecayFactor: 0.999,
    coreMemoryDecayFactor: 0.9995,
    memoryDecayFloor: 1,
    volatileConsolidationThreshold: 0.02,
    coreConsolidationThreshold: 0.01,
    consolidationPromoteCount: 25,
    coreCapacityRatio: 0.333,
    maxVaultCandidates: 5000,
    memoryVaultCapacity: 5000000,
    volatileConsolidationLimit: 1000,
    coreConsolidationLimit: 750,

    coreHierarchyThreshold: 0.03,
    volatileHierarchyThreshold: 0.05,
    hierarchyTraversalDepth: 5,
    maxHierarchyProtos: 250,

    coreMinNeighbors: 6,
    coreMaxNeighbors: 24,
    volatileMinNeighbors: 4,
    volatileMaxNeighbors: 16,

    newMemorySize: 1.0,
    newMemoryAccessCount: 1.0,
    newMemoryImportance: 10.0,
    baseAccessBoost: 1.001,
    performanceBoostFactor: 1.002
};

// Path/port overrides are applied after the literal so the defaults stay
// readable. `legion/database.js` reads `CONFIG.stateFolder` at import time, and
// this module is its first import, so these land before any DB opens.
const stateOverride = envString('NEULEGION_STATE');
if (stateOverride) CONFIG.stateFolder = path.resolve(stateOverride);
const fileOverride = envString('NEULEGION_FILE');
if (fileOverride) CONFIG.file = path.resolve(fileOverride);
const portOverride = envNumber('NEULEGION_HTTP_PORT');
if (portOverride !== undefined) CONFIG.httpPort = portOverride;
