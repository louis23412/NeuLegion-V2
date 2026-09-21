// NeuLegion legion component: finite-value / JSON sanitizers for every
// persistence and broadcast boundary.
//
// Why this exists: a single non-finite value (NaN / Infinity) or one corrupt
// TEXT cell must never abort a run or corrupt its data. `better-sqlite3` rejects
// a non-finite binding on a NOT NULL column (and `JSON.parse` throws on a
// corrupted row), so a bad datum that reached a DB write used to take the whole
// worker — and therefore the run — down. These helpers make every boundary
// value-safe.
//
// They are PURE and change nothing for values that are already valid: for a
// finite number `finiteOr(v, f)` returns `v` (as a Number), so the golden
// fingerprints are unaffected. Nothing here is on a hot arithmetic path — these
// run once per signal / per persisted row.

import { isValidNumber } from '../hivemind/utils.js';

// A usable finite number, or `fallback`. `Number(v)` is applied so a numeric
// string like "12.5" is normalised exactly the way the DB would have bound it.
export const finiteOr = (value, fallback = 0) => (isValidNumber(value) ? Number(value) : fallback);

// A usable finite number, or `null` (for a nullable column). Never returns NaN.
export const finiteOrNull = (value) => (isValidNumber(value) ? Number(value) : null);

// `JSON.parse` that never throws. A corrupt/truncated cell yields `fallback`.
export const safeParseJSON = (text, fallback = null) => {
    if (typeof text !== 'string' || text.length === 0) return fallback;
    try {
        const parsed = JSON.parse(text);
        return parsed === undefined ? fallback : parsed;
    } catch {
        return fallback;
    }
};

// The scalar numeric fields the controllers/legion persist, aggregate and
// broadcast. (The nested `memoryBroadcast` payload is intentionally left
// untouched: it is built by the locked hot path and is serialised with
// `JSON.stringify`, which turns a stray NaN into `null` rather than throwing.)
export const SIGNAL_NUMERIC_FIELDS = Object.freeze([
    'entryPrice', 'sellPrice', 'stopLoss', 'prob', 'score', 'tradeAcc', 'trueAcc',
]);

// Returns a shallow copy of `signal` whose scalar numeric fields are all finite.
// `prob === -1` is the documented "no prediction yet" sentinel, so a non-finite
// prob becomes -1 (not 0) to preserve that meaning.
export const sanitizeSignal = (signal) => {
    if (!signal || typeof signal !== 'object') return signal;
    const out = { ...signal };
    for (const key of SIGNAL_NUMERIC_FIELDS) {
        if (!(key in out)) continue;
        if (isValidNumber(out[key])) continue;
        out[key] = key === 'prob' ? -1 : 0;
    }
    return out;
};

// The consensus object the legion broadcasts and records as an open simulation.
export const CONSENSUS_NUMERIC_FIELDS = Object.freeze([
    'confidence', 'entryPrice', 'exitPrice', 'stopLoss', 'profitPct', 'stopLossPct',
]);

export const sanitizeConsensus = (consensus) => {
    if (!consensus || typeof consensus !== 'object') return consensus;
    const out = { ...consensus };
    for (const key of CONSENSUS_NUMERIC_FIELDS) {
        if (!(key in out)) continue;
        if (isValidNumber(out[key])) continue;
        out[key] = 0;
    }
    return out;
};

// Resolve the per-batch controller-failure budget from the pool size.
//
// `budget` semantics (CONFIG.controllerFailureBudget):
//   - a finite fraction in (0, 1]  -> at most ceil(budget * poolSize) failures
//   - a finite number > 1          -> that many failures (absolute)
//   - 0                            -> any failure breaches the budget (strict)
//   - null / negative / non-finite -> Infinity (never breach; isolation only)
export const resolveFailureBudget = (poolSize, budget) => {
    const pool = Number.isFinite(poolSize) && poolSize > 0 ? Math.floor(poolSize) : 0;
    if (budget == null) return Infinity;
    if (!Number.isFinite(budget) || budget < 0) return Infinity;
    if (budget === 0) return Math.max(1, 1); // one failure is already too many
    if (budget <= 1) return Math.max(1, Math.ceil(pool * budget));
    return Math.floor(budget);
};

// True when the number of controller failures in a batch is *over* budget.
export const failureBudgetExceeded = (failures, poolSize, budget) =>
    failures > resolveFailureBudget(poolSize, budget);

// Stable 32-bit FNV-1a hash of an arbitrary JSON value (keys sorted), so a
// config/structure fingerprint is independent of key order.
export const stableHash = (value) => {
    const json = stableStringify(value);
    let h = 2166136261 >>> 0;
    for (let i = 0; i < json.length; i++) {
        h ^= json.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
};

const stableStringify = (value) => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',') + '}';
};

// The config keys that change the persisted legion structure / trajectory. A
// change to any of these means an existing `state/` directory is no longer
// compatible with the live config, so resuming silently would mix two
// different models (ROADMAP P0-2).
export const STRUCTURE_CONFIG_KEYS = Object.freeze([
    'forceMin', 'baseGroups', 'baseSections', 'baseLayers', 'basePairs', 'elderPairs',
    'maxTier', 'tierWeightMultiplier', 'basePop', 'baseCache', 'baseProcessCount',
    'broadcastRatio', 'injectionRatio',
]);

// Fingerprint of the structure-affecting config (paths/ports/timings excluded).
export const configFingerprint = (config) => {
    const picked = {};
    for (const key of STRUCTURE_CONFIG_KEYS) picked[key] = config ? config[key] : undefined;
    return stableHash(picked);
};

// Describe a worker rejection as a compact, loggable record.
export const describeFailure = (controller, error) => {
    const id = controller
        ? `G${controller.group}S${controller.section}L${controller.layer}C${controller.id}`
        : 'unknown';
    const message = error && error.message ? error.message : String(error);
    const code = error && error.code ? error.code : 'WORKER_ERROR';
    return { id, code, message };
};

// Fail-fast validation of the arguments a HiveMindController (or worker slot) is
// constructed with. A malformed config used to produce silent NaN targets and
// predictions; now it throws a clear message that the worker catches and
// batch.js isolates, so one bad slot degrades gracefully instead of corrupting
// the run. Lives here (with the other boundary guards) so it can be unit-tested
// without importing the heavyweight controller module.
export const assertControllerArgs = ({ dp, cs, es, type, tier, priceObj } = {}) => {
    if (typeof dp !== 'string' || dp.length === 0) {
        throw new Error('HiveMindController: directory path must be a non-empty string');
    }
    if (!Number.isFinite(cs) || cs <= 0) {
        throw new Error(`HiveMindController: cacheSize must be a positive finite number (got ${cs})`);
    }
    if (!Number.isFinite(es) || es <= 0) {
        throw new Error(`HiveMindController: ensembleSize must be a positive finite number (got ${es})`);
    }
    if (type !== 'positive' && type !== 'negative') {
        throw new Error(`HiveMindController: type must be "positive" or "negative" (got ${type})`);
    }
    if (!Number.isFinite(tier) || tier < 1) {
        throw new Error(`HiveMindController: tier must be a finite number >= 1 (got ${tier})`);
    }
    if (!priceObj || typeof priceObj !== 'object') {
        throw new Error('HiveMindController: priceObj is required');
    }
    for (const key of ['atrFactor', 'stopFactor', 'minPriceMovement', 'maxPriceMovement']) {
        if (!isValidNumber(priceObj[key]) || priceObj[key] <= 0) {
            throw new Error(`HiveMindController: priceObj.${key} must be a positive finite number (got ${priceObj[key]})`);
        }
    }
};
