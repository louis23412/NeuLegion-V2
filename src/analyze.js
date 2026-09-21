// NeuLegion A/B analysis driver (ROADMAP P2-1).
//
// This is the *productionized* version of the ad-hoc A/B harness that lived in
// `test/browser/entries/walkforward.test.js` sections G/H/I. It turns "should
// feature X ship on?" into a mechanical, reproducible decision:
//
//   1. build a causal walk-forward split over a candle series;
//   2. for every VARIANT (the default-off baseline plus each feature), fit a
//      fresh online model per fold and evaluate the pooled out-of-sample return
//      stream with the locked analysis layer (`walkForwardEvaluate`);
//   3. decide each candidate with `promoteDecision` (DSR floor + fold-win +
//      positive-fold + a CLEAN lookahead audit), and cross-check with the
//      family-wise subsampling SPA / Romano-Wolf step-down (`walkForwardSearch`)
//      so the verdict cannot be bought with search luck;
//   4. write a run directory (`run.json` manifest, `report.json`, `run.log`).
//
// The core is PURE and model-agnostic: `evaluateAB` takes an injected
// `signalForVariant` function, so the A/B mathematics is testable without a DB
// (`test/browser/entries/analyze.test.js`). The `HiveMind`-backed model factory
// (`makeHiveMindModelFactory`) is created only by the CLI, via a dynamic import.
//
// Nothing here is on the training hot path; it only *drives* the locked modules.

import fs from 'fs';
import path from 'path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { CONFIG } from './legion/config.js';
import { mulberry32, hashString } from './legion/rng.js';
import { walkForwardEvaluate, promoteDecision, formatReport, walkForwardSearch, probToPosition, poolReports, costLadder, familyCorrelation, DEPENDENCE_GATE_READER } from './analysis/walkforward.js';
import { walkForwardSplit } from './analysis/splits.js';
import { makeCandleViewFor, worldFromCandles, DEFAULT_SHOCK } from './analysis/world.js';
import { SIGNAL_CANDIDATES, signalForCandidate } from './analysis/features.js';
import { CANDLE_MANIFEST } from './candles_audit.js';
import { makeRunId, createRunDirectory, writeJson, writeJsonAtomic, writeReport, appendLog, appendJsonl } from './observer/report.js';
import { configFingerprint } from './legion/sanitize.js';

// Feature-vector length used by the online model (a trailing return window plus
// the current bar's sign). Kept identical to the walk-forward test so a report
// from here is comparable to the suite's pinned numbers.
export const FEATURE_LEN = 6;

// ---------------------------------------------------------------------------
// Variants — the default-off features, enabled one at a time.
// ---------------------------------------------------------------------------
//
// Each variant is `{ id, label, note, configure(hm), afterFit(hm)? }`. The
// `configure`/`afterFit` bodies use the EXACT settings the walk-forward suite
// already proves are either inert or live, so a promotion here is comparable to
// the suite. `baseline` configures nothing (every feature at its default/off).
export const VARIANTS = Object.freeze([
    {
        id: 'baseline',
        label: 'baseline',
        note: 'all optional features at their default (off)',
        configure: null,
        afterFit: null,
    },
    {
        id: 'surprise',
        label: 'surprise-gate',
        note: 'surprise-gated memory writes (Titans arXiv 2501.00663), floor=0.3',
        configure: (hm) => { hm._surpriseGateEnabled = true; hm._surpriseConfig = { floor: 0.3, sharpness: 1 }; },
        afterFit: null,
    },
    {
        id: 'homeostasis',
        label: 'homeostasis',
        note: 'homeostatic per-member learning rates (arXiv 2609.13771), gain=0.5',
        configure: (hm) => { hm._homeostasisEnabled = true; hm._homeostasisConfig = { gain: 0.5, target: 1, minScale: 0.5, maxScale: 1.5 }; },
        afterFit: null,
    },
    {
        id: 'multiprobe',
        label: 'multi-probe',
        note: 'margin-ordered multi-probe LSH (Lv et al. VLDB 2007), maxFlips=2',
        configure: (hm) => { hm._multiProbeConfig = { maxFlips: 2, budget: 8 }; },
        afterFit: null,
    },
    {
        id: 'querymod',
        label: 'query-mod',
        note: 'dynamic query modification (arXiv 2605.23807) — centroid re-query',
        configure: (hm) => { hm._queryModConfig = { enabled: true }; },
        afterFit: null,
    },
    {
        id: 'pca-hash',
        label: 'pca-hash',
        note: 'data-aware PCA-aligned LSH hyperplanes (BinaryPC arXiv 2608.04405), above-mean rank',
        configure: (hm) => { hm._pcaHashConfig = { seed: 1, iters: 30, tol: 1e-6, minRows: 8, rankPolicy: 'above-mean' }; },
        afterFit: (hm) => { if (typeof hm._refreshLshHyperplanes === 'function') hm._refreshLshHyperplanes(); },
    },
    {
        id: 'sample-weights',
        label: 'sample-weights',
        note: 'uniqueness loss weighting (AFML ch. 4) — CONTROLLER-scoped; it is only evaluable on the controller-backed model (round 23, N0)',
        configure: null,
        afterFit: null,
        controllerScoped: true,
    },
]);

// The causal signal family (ROADMAP N1) as A/B candidates: the proven pure
// features from `analysis/features.js`, each carrying the `signal(view, test)`
// the driver evaluates. They share the ONE family-wise gate and the one baseline,
// so the multiple-testing correction covers the whole searched universe.
export const SIGNAL_VARIANTS = Object.freeze(
    SIGNAL_CANDIDATES.map((c) => ({ ...c, signal: signalForCandidate(c) })),
);

// Every candidate the A/B can resolve by id: the mechanism flags plus the signal
// family. `kind` (default 'mechanism') distinguishes them in the report.
export const ALL_VARIANTS = Object.freeze([...VARIANTS, ...SIGNAL_VARIANTS]);

// The probability -> position policy for the controller-backed model (round 23,
// N0). The controller's confidence is a small deviation around 50 (measured: test
// windows sit in ~46-58), so the mapping is documented rather than implicit:
// `probToPosition` maps 50 -> 0 and saturates at the extreme, and `deadZone`
// abstains when the confidence is within 5% of a coin flip, i.e. prob in
// [47.5, 52.5]. Measured cost/behaviour of the policy is recorded in the report.
export const CONTROLLER_POSITION_POLICY = Object.freeze({ deadZone: 0.05, scale: 1 });

// The controller cache/ensemble used by the A/B model (the same shape the
// multi-symbol suite replays: cache 120, ensemble 4, tier 1, forced-minimum
// dimensions so the evaluation stays CPU-bounded). `warmup` is the minimum amount
// of streamed history a fold must have before its predictions are trusted: the
// controller only trains when trades close, so a fold with a tiny `testStart`
// would otherwise "predict" from a controller that has seen almost nothing. A
// fold below the threshold abstains (position 0), which is a non-leaky decision
// (it only reads the past).
export const CONTROLLER_MODEL = Object.freeze({ cacheSize: 120, ensembleSize: 4, tier: 1, warmup: 40 });

let variantIndex = null;
// Look up a variant by id (throws on an unknown id so a typo cannot silently run
// the baseline).
export const resolveVariant = (id) => {
    if (!variantIndex) variantIndex = new Map(ALL_VARIANTS.map((v) => [v.id, v]));
    if (!variantIndex.has(id)) {
        throw new Error(`analyze: unknown variant "${id}" (known: ${[...variantIndex.keys()].join(', ')})`);
    }
    return variantIndex.get(id);
};

// Apply a variant's flags to a model instance. Returns true when something was
// applied, false for the baseline / a controller-scoped variant (so the caller
// can record a "skipped" note instead of pretending it ran).
export const applyVariant = (target, variant) => {
    if (!variant || typeof variant.configure !== 'function') return false;
    variant.configure(target);
    return true;
};

// ---------------------------------------------------------------------------
// Feature vector + model factory (the online model the A/B drives)
// ---------------------------------------------------------------------------

// A causal feature vector: a trailing window of past returns, the current bar's
// sign, and (with `leaky`) a slot filled from returns[t+1] — the accidental
// lookahead the audit must catch.
export function featureVector(returns, t, { len = FEATURE_LEN, leaky = false } = {}) {
    const f = new Array(len).fill(0);
    for (let k = 0; k < len - 2; k++) {
        const idx = t - 1 - k;
        f[k] = idx >= 0 ? (returns[idx] ?? 0) * 100 : 0;
    }
    f[len - 2] = Math.sign(returns[t] ?? 0);
    f[len - 1] = leaky ? (returns[t + 1] ?? 0) * 1000 : 0;
    return f;
}

// Everything the core needs from a model: fit(train, test, returns) then
// predict(test, returns) -> positions. This is the shape `signalForVariant`
// must return per variant.
//
// Contract (round 23): `fit(train, test, view)` and `predict(test, view)` read the
// model's data from the VIEW object (`view.returns` here), never from a closed-over
// array — that is what lets the audit perturb the model's actual input.
// `modelRetention` (round 24): 'keep' leaves every fit's state directory behind
// (the old behaviour, and what forensics needs); 'discard' closes the fit's
// database and deletes its directory the moment its prediction has been consumed,
// so a run cannot bloat storage. `runAnalysis` defaults to 'discard'.
export const makeHiveMindModelFactory = ({
    HiveMind, stateDir, seed = 1, len = FEATURE_LEN, leaky = false, modelRetention = 'keep',
}) => {
    let fitCounter = 0;
    return (variant) => {
        let hm = null;
        let predictSeed = 0;
        let dir = null;
        let reclaimed = false;
        const reclaim = () => {
            if (reclaimed || modelRetention !== 'discard' || !dir) return { closed: false, removed: false };
            reclaimed = true;
            let closed = false;
            try {
                const db = hm && hm._db;
                if (db && typeof db.close === 'function') { db.close(); closed = true; }
            } catch { /* a failed close must never fail the run */ }
            let removed = false;
            try {
                if (typeof fs.rmSync === 'function') { fs.rmSync(dir, { recursive: true, force: true }); removed = true; }
            } catch { /* a failed delete must never fail the run */ }
            return { closed, removed };
        };
        const variantSeed = (seed * 131 + (hashString(variant.id) % 100000)) >>> 0;
        return {
            fit(train, test, view) {
                const returns = view.returns;
                const testStart = Math.min(...test);
                const foldSeed = (variantSeed + testStart * 977) >>> 0;
                // A unique directory per fit so no fit resumes another's state.
                dir = path.join(stateDir, `${variant.id}-${fitCounter++}`);
                const bars = train.filter((t) => t + 1 < testStart);
                const labels = bars.map((t) => ((returns[t + 1] ?? 0) > 0 ? 1 : 0));
                withSeed(foldSeed, () => {
                    hm = new HiveMind(dir, 3, len, `AN-${variant.id}`, true);
                    if (variant.configure) variant.configure(hm);
                    for (let i = 0; i < bars.length; i++) hm.train(featureVector(returns, bars[i], { len, leaky }), labels[i]);
                    if (variant.afterFit) variant.afterFit(hm);
                });
                predictSeed = (foldSeed + 7777) >>> 0;
            },
            predict(test, view) {
                const returns = view.returns;
                return withSeed(predictSeed, () => test.map((t) => (hm.predict(featureVector(returns, t, { len, leaky })) - 0.5) * 2));
            },
            // Explicit, idempotent disposal. Called by `makeSignalForVariant` after
            // predict, so an in-memory model can still be re-predicted by tests.
            dispose: () => reclaim(),
            stats: () => ({ trained: hm ? 1 : 0, retention: modelRetention, reclaimed }),
        };
    };
};

// The controller-backed model factory (ROADMAP round 23, N0): the A/B's model is
// the SHIPPED one — a real `HiveMindController` fed the real candle series, with
// its 10-indicator feature vector, trade bookkeeping and closed-trade training —
// instead of a bare `HiveMind` on a 6-element return vector.
//
// Per fold it streams bars `0 .. testStart-1` (the whole available history, in
// order: a streaming model cannot skip bars, so the fold's purge exclusions are
// not honoured — documented) and then evaluates the test bars **prequentially**:
// the position at bar t is read from `getSignal(candles[0..t])`, so it only ever
// uses information available at t, and the realised return is t -> t+1. The audit
// (`analysis/world.js`) certifies exactly that property.
//
// Model flags: `variant.configure` is applied to the controller (so
// `_sampleWeightConfig` lands where the controller reads it) AND to the
// pre-created underlying `HiveMind` (where the mind-level flags —
// `_surpriseGateEnabled`, `_homeostasisEnabled`, `_multiProbeConfig`,
// `_pcaHashConfig`, `_queryModConfig` — are read). `variant.afterFit` runs on the
// mind (the pca-hash hyperplane refresh). Pre-creating `_hivemind` is what makes
// a mind-level flag reachable before the first `getSignal`.
export const makeControllerModelFactory = ({
    HiveMind, HiveMindController, stateDir, seed = 1,
    cacheSize = CONTROLLER_MODEL.cacheSize, ensembleSize = CONTROLLER_MODEL.ensembleSize,
    tier = CONTROLLER_MODEL.tier, warmup = CONTROLLER_MODEL.warmup,
    positionPolicy = CONTROLLER_POSITION_POLICY,
    modelRetention = 'keep',
    priceObj = {
        atrFactor: CONFIG.baseAtr, stopFactor: CONFIG.baseStop,
        minPriceMovement: CONFIG.minPriceMove, maxPriceMovement: CONFIG.maxPriceMove,
    },
} = {}) => {
    let fitCounter = 0;
    return (variant) => {
        let ctl = null;
        let mind = null;
        let predictSeed = 0;
        let warmErrors = 0;
        let folds = 0;
        let undertrained = false;
        let dir = null;
        let reclaimed = false;
        // 'discard' closes the fit's SQLite handle and removes its state directory.
        // Both files of a fit live under `dir` (the controller's `hivemind_controller-*.db`
        // and the mind's `hivemind_state-*.db`); the mind opens its connection per
        // save/load rather than holding one, so the controller handle is the only
        // one to close. Every step is best-effort: a failed close or delete must
        // never fail the run.
        const reclaim = () => {
            if (reclaimed || modelRetention !== 'discard' || !dir) return { closed: false, removed: false };
            reclaimed = true;
            let closed = false;
            for (const model of [ctl, mind]) {
                try {
                    const db = model && model._db;
                    if (db && typeof db.close === 'function') { db.close(); closed = true; }
                } catch { /* ignore */ }
            }
            let removed = false;
            try {
                if (typeof fs.rmSync === 'function') { fs.rmSync(dir, { recursive: true, force: true }); removed = true; }
            } catch { /* ignore */ }
            return { closed, removed };
        };
        const variantSeed = (seed * 131 + (hashString(variant.id) % 100000)) >>> 0;
        return {
            fit(train, test, view) {
                const candles = view.candles || [];
                const testStart = Math.min(...test);
                const foldSeed = (variantSeed + testStart * 977) >>> 0;
                dir = path.join(stateDir, `${variant.id}-${fitCounter++}`);
                folds++;
                // A fold with too little history abstains (documented; reads only
                // the past, so it cannot leak).
                undertrained = !(testStart >= warmup);
                withSeed(foldSeed, () => {
                    ctl = new HiveMindController(`AN-${variant.id}`, dir, cacheSize, ensembleSize, 'positive', tier, priceObj, true);
                    if (variant.configure) variant.configure(ctl);
                    // Pre-create the mind so mind-level flags are reachable.
                    mind = new HiveMind(dir, ensembleSize, ctl._inputSize, `AN-${variant.id}`, true);
                    ctl._hivemind = mind;
                    if (variant.configure) variant.configure(mind);
                    for (let i = 1; i <= testStart; i++) {
                        try { ctl.getSignal(candles.slice(0, i), 1); } catch { warmErrors++; }
                    }
                    if (variant.afterFit) variant.afterFit(mind);
                });
                predictSeed = (foldSeed + 7777) >>> 0;
            },
            predict(test, view) {
                if (undertrained) return test.map(() => 0);
                const candles = view.candles || [];
                return withSeed(predictSeed, () => test.map((t) => {
                    let prob = 50;
                    try {
                        const s = ctl.getSignal(candles.slice(0, t + 1), 1);
                        // `prob === -1` is the documented "untrained" sentinel: abstain.
                        if (s && Number.isFinite(s.prob) && s.prob >= 0) prob = s.prob;
                    } catch { /* a failed decision abstains, never throws */ }
                    return probToPosition(prob, positionPolicy);
                }));
            },
            dispose: () => reclaim(),
            stats: () => ({
                warmErrors, folds, undertrained,
                retention: modelRetention, reclaimed,
                trainingSteps: ctl && ctl._globalAccuracy ? ctl._globalAccuracy.trainingSteps : 0,
                quarantinedRows: ctl && ctl._globalAccuracy ? ctl._globalAccuracy.quarantinedRows : 0,
            }),
        };
    };
};

// Run core code under a seeded Math.random (the core draws random init and LSH
// probing), exactly like golden/sanity/walk-forward do.
export function withSeed(seed, fn) {
    const real = Math.random;
    Math.random = mulberry32(seed >>> 0);
    try { return fn(); } finally { Math.random = real; }
}

// `signalForVariant(variant)` -> `signalForFold(train, test, view)`.
//
// A signal candidate (`variant.signal`, the causal family from
// `analysis/features.js`) is pure array math on the view. A model variant builds a
// fresh model per fold, fits it on the view, then predicts the test bars.
export const makeSignalForVariant = (factory) => (variant) => {
    if (typeof variant.signal === 'function') {
        return (train, test, view) => variant.signal(view, test);
    }
    return (train, test, view) => {
        const model = factory(variant);
        model.fit(train, test, view);
        try {
            return model.predict(test, view);
        } finally {
            // The fold function is the only production caller, and it uses each
            // fitted model exactly once — so this is the right place to release the
            // fit's state (`modelRetention: 'discard'`). Disposal is a no-op when
            // the factory keeps state, and is idempotent.
            if (typeof model.dispose === 'function') model.dispose();
        }
    };
};

// ---------------------------------------------------------------------------
// The A/B core (pure; injected signalForVariant)
// ---------------------------------------------------------------------------

// Evaluate the whole variant family over one causal split, or over several
// independent streams (round 23, N2: one walk-forward per symbol, pooled).
//
//   returns/folds  — a single stream, or
//   worlds         — [{ returns, folds, viewFor, label }] (multi-stream; pooled)
//   variants       — the candidate family; the one with id 'baseline' is the bench
//   signalForVariant — (variant) => signalForFold(train, test, view)
//   audit          — run the look-ahead audit on every report
//   model          — 'bare' | 'controller': labels the model and decides whether a
//                    `controllerScoped` variant can run at all
//   viewFor/probe/requireReachable/auditProbesPerFold — forwarded to the scoring
//                    view and the audit, so a candle-driven model is audited on the
//                    data it actually reads (analysis/world.js)
//
// Returns { baseline, baselineVariant, candidates[], search, variants }.
export function evaluateAB({
    returns = null, folds = null, viewFor = null, worlds = null,
    variants = ALL_VARIANTS, signalForVariant,
    costBps = 0, periodsPerYear = 252, audit = true, requireCausal = true, alpha = 0.05,
    probe = 1e3, requireReachable = false, auditProbesPerFold = 0, model = 'bare',
    auditReuseBase = false,
    // Round 25: extra `promoteDecision` options applied to every candidate (after
    // each variant's own `decision` overrides). The real driver passes the
    // dependence-aware hurdles here; the default `{}` keeps the round-23/24
    // decision path byte-identical.
    gateOptions = null,
    // Reporting hooks (round 24). `onEvent` receives every scored fold and every
    // audit pass (tagged with the variant/stream it belongs to); `onVariant`
    // receives each variant's completed report plus its decision, so a caller can
    // checkpoint after every variant. Both are optional and have no arithmetic
    // effect on the returned reports.
    onEvent = null, onVariant = null,
} = {}) {
    if (typeof signalForVariant !== 'function') {
        throw new Error('evaluateAB: signalForVariant(variant) => signalForFold is required');
    }
    if (!Array.isArray(variants) || variants.length < 2) {
        throw new Error('evaluateAB: at least a baseline and one candidate are required');
    }
    const streams = Array.isArray(worlds) && worlds.length
        ? worlds
        : [{ returns, folds, viewFor, label: 'main' }];
    if (!Array.isArray(streams[0].returns) || !Array.isArray(streams[0].folds) || !streams[0].folds.length) {
        throw new Error('evaluateAB: either `worlds` or (`returns` + `folds`) is required');
    }

    // The baseline is evaluated FIRST so a per-variant checkpoint can carry a
    // decision for every row it reports (a decision needs the baseline). The
    // returned `variants` keep the caller's order, and no number can move: every
    // fit is independent and seeded from (variant, fold) alone.
    const baselineIndex = Math.max(0, variants.findIndex((v) => v.id === 'baseline'));
    const evaluateOne = (vi) => {
        const variant = variants[vi];
        const startedAt = Date.now();
        // A controller-scoped variant (sample-weights) can only be evaluated on
        // the controller-backed model; on a bare HiveMind it is flagged so the
        // report is honest rather than pretending it ran.
        const skipped = !!variant.controllerScoped && model !== 'controller';
        const reports = streams.map((s, si) => walkForwardEvaluate({
            returns: s.returns, folds: s.folds, signalForFold: signalForVariant(variant),
            costBps, periodsPerYear, trials: variants.length, audit, requireCausal,
            viewFor: s.viewFor == null ? viewFor : s.viewFor,
            probe, requireReachable, auditProbesPerFold, auditReuseBase,
            onEvent: onEvent
                ? (e) => onEvent({
                    ...e,
                    variantId: variant.id, variantIndex: vi, variantTotal: variants.length,
                    stream: si, streamLabel: s.label == null ? null : s.label, streamsTotal: streams.length,
                })
                : null,
        }));
        const report = poolReports(reports, { periodsPerYear, trials: variants.length });
        // Per-variant wall time (round 25, observability): the cost model
        // (`10.7 s x mechanismVariants x folds x (1 + probesPerFold)`) can only be
        // checked, and the next run sized, if the run says how long each variant
        // actually took. Pure reporting — it has no arithmetic effect.
        return { variant, report, skipped, streams: reports.length, elapsedMs: Date.now() - startedAt };
    };

    const evaluated = new Array(variants.length);
    evaluated[baselineIndex] = evaluateOne(baselineIndex);
    const baseline = evaluated[baselineIndex].report;
    if (onVariant) onVariant({ role: 'baseline', index: baselineIndex, entry: evaluated[baselineIndex], decision: null });
    const decisionsByIndex = new Map();
    for (let vi = 0; vi < variants.length; vi++) {
        if (vi === baselineIndex) continue;
        evaluated[vi] = evaluateOne(vi);
        // Round 25: the driver's dependence-aware hurdles ride on `gateOptions`;
        // each variant's own `decision` overrides them, and with `gateOptions`
        // null/absent the round-23/24 decision path is unchanged.
        const decision = promoteDecision(baseline, evaluated[vi].report, {
            requireCleanAudit: audit,
            ...(variants[vi].decision || {}),
            ...(gateOptions || {}),
        });
        decisionsByIndex.set(vi, decision);
        if (onVariant) onVariant({ role: 'candidate', index: vi, entry: evaluated[vi], decision });
    }

    const candidates = evaluated
        .map((entry, vi) => ({ ...entry, decision: decisionsByIndex.get(vi) || null }))
        .filter((_, i) => i !== baselineIndex);
    const decisions = candidates.map((c) => c.decision);

    let search = null;
    try {
        search = walkForwardSearch({
            baseline,
            candidates: candidates.map((c) => c.report),
            labels: candidates.map((c) => c.variant.label),
            alpha,
        });
    } catch (err) {
        search = { error: err.message || String(err) };
    }

    return {
        baselineIndex,
        baselineVariant: variants[baselineIndex],
        baseline,
        variants: evaluated,
        candidates: candidates.map((c, i) => ({
            variant: c.variant,
            report: c.report,
            skipped: c.skipped,
            decision: decisions[i],
            search: search && Array.isArray(search.candidates) ? (search.candidates[i + 1] || null) : null,
        })),
        search,
        auditClean: audit ? !!(baseline.audit && baseline.audit.clean) : null,
        model,
        streams: streams.length,
        probe,
        auditProbesPerFold,
        requireReachable,
        reuseBase: auditReuseBase,
        costBps,
        positionPolicy: model === 'controller' ? CONTROLLER_POSITION_POLICY : null,
        streamLabels: streams.map((s) => s.label || null),
    };
}

const f4 = (x) => (Number.isFinite(x) ? x.toFixed(4) : String(x));

// The one-line audit verdict for the human summary. `reachable`/`reachableFolds`
// are what distinguish a *structural* certificate (the perturbation changed the
// object the model reads) from a *behavioural* one (it demonstrably moved a later
// position); the machine-readable report always carries the full audit object.
export const auditVerdict = (report) => {
    const a = report && report.audit;
    if (!a) return 'skipped';
    const parts = [
        a.clean ? 'clean' : 'LEAK',
        `probes=${a.probes || 0}`,
        `reachable=${a.reachable === true}`,
    ];
    if (a.reachableFolds != null) parts.push(`reachableFolds=${a.reachableFolds}`);
    if (a.vacuous) parts.push('VACUOUS');
    return parts.join(' ');
};

// Render the A/B verdict as a human-readable block. `extra` carries the round-25
// run-level blocks (`costLadder`, `familyCorrelation`, `gate`) that are computed
// after the evaluation: they are optional so `formatAnalysis(result)` still
// renders on its own (the tests, and any caller that only wants the raw A/B).
export function formatAnalysis(result, extra = {}) {
    const lines = [];
    const s = result.search;
    lines.push(`walk-forward A/B: ${result.candidates.length + 1} variants, ` +
        `${result.baseline.folds ? result.baseline.folds.length : 0} folds, ${result.baseline.pooledBars} pooled bars`);
    lines.push(`model: ${result.model || 'bare'} | streams=${result.streams || 1} | ` +
        `positionPolicy=${JSON.stringify(result.positionPolicy || CONTROLLER_POSITION_POLICY)} | ` +
        `probe=${f4(result.probe)} | auditProbesPerFold=${result.auditProbesPerFold || 0} | costBps=${result.costBps || 0} | reuseBase=${result.reuseBase === true}`);
    // Round 25: state the gate. A `keep-off` verdict means something different
    // under a dependence-aware gate than under the classic one, so the reader
    // must be told which one produced it.
    const g = extra.gate || null;
    if (g && g.mode) {
        lines.push(`gate:   ${g.mode}${g.alpha != null ? ` (alpha=${f4(g.alpha)})` : ''}` +
            (g.mode === 'dependence'
                ? ' — paired cluster Sharpe difference + exact sign test over fold windows + DSR floor on design-effect-adjusted bars'
                : ' — the round-23/24 hurdles only (no dependence correction)'));
    }
    lines.push(formatReport(result.baseline, { label: `baseline(${result.baselineVariant.label})` }));
    for (const c of result.candidates) {
        const verdict = c.decision.promote ? 'PROMOTE' : 'keep-off';
        const kind = c.variant.kind === 'signal' ? ' |signal' : '';
        const fw = c.search ? ` | StepM p=${f4(c.search.pValue)} rejected=${!!c.search.rejected}` : '';
        // Name any round-25 hurdle that was SKIPPED for lack of a panel, so a
        // green gate can never be read as "all hurdles passed".
        const skippedHurdles = c.decision.gate
            ? Object.entries(c.decision.gate).filter(([, v]) => v === 'skipped-no-panel').map(([k2]) => k2)
            : [];
        const gt = skippedHurdles.length ? ` | gate-skipped=${skippedHurdles.join(',')}` : '';
        // The paired cluster test belongs to the candidate-vs-baseline DECISION,
        // not to the report, so it is handed to the formatter here (round 25). A
        // single-stream run still renders it — as `paired: n/a (reason)` — so the
        // absence of a panel is stated rather than silently omitted.
        lines.push(formatReport(c.report, {
            label: `${c.variant.label} [${verdict}]${kind}${c.skipped ? ' (skipped: controller-scoped)' : ''}${fw}${gt}`,
            promotionTest: c.decision ? c.decision.promotionTest : null,
        }));
        if (!c.decision.promote) lines.push(`  reasons: ${c.decision.reasons.join('; ')}`);
    }
    if (s && Array.isArray(s.candidates)) {
        lines.push(`family-wise: SPA p=${f4(s.spaPValue)} best=${s.bestLabel} Rejects=[${s.rejectedLabels.length ? s.rejectedLabels.join(',') : 'none'}] K=${s.K} T=${s.T}`);
    } else if (s && s.error) {
        lines.push(`family-wise: unavailable (${s.error})`);
    }
    // Round 25: how concentrated the search was. DIAGNOSTIC ONLY — the deflated
    // Sharpe keeps trials=K on purpose (an effective number of independent tests
    // does not control the FWER: arXiv 1612.04535).
    const fc = extra.familyCorrelation;
    if (fc && fc.available) {
        const mp = fc.maxPair ? ` | maxPair=${familyPairLabel(fc.maxPair, result)} r=${f4(fc.maxPair.rho)}` : '';
        lines.push(`family: excessCorr=${f4(fc.meanPairwiseExcessCorr)} effectiveTrials=${f4(fc.effectiveTrials)} of ${fc.K}${mp}` +
            ' (diagnostic only; DSR keeps trials=K)');
    }
    // Round 25: the cost ladder. One line per level, naming the promoting
    // candidates, so a verdict that only holds at one cost assumption is obvious.
    const cl = extra.costLadder;
    if (cl && cl.available && Array.isArray(cl.rows)) {
        for (const row of cl.rows) {
            const promo = row.candidates.filter((c) => c.promote).map((c) => c.id);
            lines.push(`cost-ladder +${row.costBps}bps: baseline Sharpe=${f4(row.baseline.netSharpe)} DSR=${f4(row.baseline.dsr)}` +
                ` | promotes=[${promo.length ? promo.join(',') : 'none'}]`);
        }
    }
    // Run-level power honesty (round 24b): a null verdict from a run that could
    // not have detected a Sharpe of 1 is "underpowered", not "no edge". Name the
    // sample size that would settle it, so the next run can be sized.
    const pw = result.baseline && result.baseline.power;
    if (pw && Number.isFinite(pw.mdeSharpe)) {
        lines.push(`power:  MDE95 Sharpe=±${f4(pw.mdeSharpe)} over ${pw.bars} pooled bars` +
            (pw.underpowered
                ? ` — UNDERPOWERED: this run cannot rule out edges below that; ~${pw.barsToDetect1} pooled bars are needed to detect Sharpe ±1.0`
                : ''));
    }
    // Round 25: the honest (cluster-jackknife) power, when a panel exists.
    if (pw && Number.isFinite(pw.mdeSharpeDependent)) {
        lines.push(`power*: MDE95 Sharpe=±${f4(pw.mdeSharpeDependent)} under the cluster jackknife` +
            ` (i.i.d. variance understated by ${f4(pw.varianceInflation)}x; ${f4(pw.effectiveBars)} effective bars of ${pw.bars})` +
            (pw.underpoweredDependent ? ' — UNDERPOWERED' : ''));
    }
    lines.push(`audit: baseline ${auditVerdict(result.baseline)}`);
    return lines.join('\n');
}

// "candidate-a~candidate-b" for a family-correlation max pair, using the driver's
// variant ids when they are available.
function familyPairLabel(pair, result) {
    const label = (i) => {
        const c = result && result.candidates ? result.candidates[i] : null;
        return c && c.variant ? c.variant.id : `#${i}`;
    };
    return `${label(pair.a)}~${label(pair.b)}`;
}

// ---------------------------------------------------------------------------
// CLI driver — reads a candle stream, runs the A/B, writes the run directory.
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
const resolveSymbolFiles = (symbols) => {
    const root = path.join(import.meta.dirname || '.', '..');
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

// One row of `report.variants` (the roster: what exists, and whether it ran).
const variantRosterRow = (entry) => ({
    id: entry.variant.id,
    label: entry.variant.label,
    kind: entry.variant.kind || 'mechanism',
    skipped: entry.skipped,
    streams: entry.streams,
});

// The baseline row. `audit` is the full machine-readable block; `auditClean` keeps
// the old boolean for anything that already reads it.
const baselineRow = (result) => {
    const base = result.baseline;
    return {
        id: result.baselineVariant.id,
        label: result.baselineVariant.label || result.baselineVariant.id,
        pooledMetrics: base.pooledMetrics,
        aggregate: base.aggregate,
        audit: auditBlock(base.audit),
        auditClean: base.audit ? !!base.audit.clean : null,
        power: base.power || null,
        // Round 25: the dependence panel (cluster jackknife SE, design effect,
        // effective bars, equicorrelation reading) — null on a single stream.
        dependence: base.dependence || null,
        pooledBars: base.pooledBars,
        foldLengths: base.foldLengths || null,
    };
};

// One candidate row: the decision, the pooled metrics, the audit block and (when
// the family-wise cross-check has run) the joint `search` statistics.
const candidateRow = (entry, decision, search) => ({
    id: entry.variant.id,
    label: entry.variant.label,
    kind: entry.variant.kind || 'mechanism',
    skipped: entry.skipped,
    promote: decision.promote,
    reasons: decision.reasons,
    foldWinFraction: decision.foldWinFraction,
    pooledMetrics: entry.report.pooledMetrics,
    aggregate: entry.report.aggregate,
    audit: auditBlock(entry.report.audit),
    auditClean: entry.report.audit ? !!entry.report.audit.clean : null,
    power: entry.report.power || null,
    // Round 25: the dependence panel, the paired cluster test behind the new
    // hurdles, and which hurdles were actually applied (vs skipped for lack of a
    // cross-stream panel) — so the report can never claim a gate it did not run.
    dependence: entry.report.dependence || null,
    promotionTest: decision.promotionTest || null,
    gate: decision.gate || null,
    elapsedMs: entry.elapsedMs ?? null,
    pooledBars: entry.report.pooledBars,
    search: search ? { pValue: search.pValue, rejected: search.rejected, statistic: search.statistic, kfwerPValue: search.kfwerPValue ?? null, fdp: search.fdp ?? null } : null,
});

const foldRecord = (event) => ({
    stage: event.t === 'fold' ? 'score' : event.stage,
    v: event.variantId,
    variantIndex: event.variantIndex,
    stream: event.stream,
    streamLabel: event.streamLabel,
    fold: event.foldIndex,
    foldTotal: event.foldTotal,
    testStart: event.testStart ?? null,
    testEnd: event.testEnd ?? null,
    test: event.test ?? null,
    probeAt: event.probeAt ?? null,
    // The index of the probe inside the fold's test array. Without it the journal
    // cannot be read offline (the reachability comparison is `k > probeIndex`).
    probeIndex: event.probeIndex ?? null,
    // True for an audit base pass that REUSED the scored signals instead of re-fitting.
    reused: event.reused ?? null,
    signals: event.signals ?? null,
    returns: event.returns ?? null,
    metrics: event.metrics ?? null,
});

const fmtClock = (ms) => {
    if (!Number.isFinite(ms) || ms < 0) return '--:--';
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const p2 = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${p2(m)}:${p2(sec)}` : `${p2(m)}:${p2(sec)}`;
};

// Run the A/B against real candle data. Loads the model lazily so importing this
// module for its pure core never touches the SQLite driver.
//
// Round 23: the default model is the SHIPPED `HiveMindController` on a real candle
// world (N0), the candidate family includes the causal signal family (N1), and one
// or more symbols can be evaluated and pooled (N2).
export async function runAnalysis({
    file = CONFIG.file, files = null, symbols = null, stateFolder = CONFIG.stateFolder,
    trainSize = 60, testSize = 15, maxBars = 300, variantIds = null, costBps = 0, seed = 1,
    audit = true, alpha = 0.05, model = 'controller', writeFiles = true,
    probe = DEFAULT_SHOCK.probe, auditProbesPerFold = 2,
    // Round 24 run-integrity options (all off the arithmetic path).
    modelRetention = 'discard',   // 'discard' reclaims each fit's state dir after use; 'keep' for forensics
    requireReachable = false,     // enforce the audit's behavioural non-vacuity (not just structural)
    reuseBase = false,            // reuse the scored pass as the audit base pass (one less refit/fold)
    foldLog = 'all',              // 'all' | 'score' | 'off': what folds.jsonl records
    progressMs = 5000,            // stdout + progress.json cadence; 0 = every event, -1 = silent
    // Round 25 decision options.
    gate = 'dependence',          // 'classic' (round-23/24 hurdles) | 'dependence' (adds the panel-aware ones)
    gateAlpha = null,             // alpha for the dependence hurdles (defaults to `alpha`)
    costLadderLevels = [0, 2, 5, 10], // bps-of-turnover levels the verdict is restated at ([] disables)
    log = () => {},               // stdout sink (injectable so tests stay quiet)
    HiveMind: injectedHiveMind = null, HiveMindController: injectedController = null,
} = {}) {
    const startedAt = Date.now();
    const useController = model !== 'bare';
    // Round 25: resolve the promotion gate and the cost-ladder levels ONCE, so the
    // manifest, every checkpoint and the final report state what was actually
    // used. `classic` is the round-23/24 gate; `dependence` adds the paired
    // cluster Sharpe-difference test, the exact sign test over fold windows, and
    // the design-effect-adjusted DSR floor (all skipped, not failed, on a
    // single-stream run that has no panel to estimate them from).
    const gateMode = gate === 'classic' ? 'classic' : 'dependence';
    const gateAlphaResolved = Number.isFinite(gateAlpha) ? gateAlpha : alpha;
    const gateOptions = gateMode === 'dependence'
        ? { requireSharpeDiff: true, requireBreadth: true, minDsrAdjusted: 0.95, alpha: gateAlphaResolved, periodsPerYear: 252 }
        : { alpha: gateAlphaResolved, periodsPerYear: 252 };
    const ladderLevels = Array.isArray(costLadderLevels)
        ? costLadderLevels.filter((x) => Number.isFinite(x) && x >= 0)
        : [];
    const HiveMind = injectedHiveMind || (await import('./hivemind/hiveMind.js')).default;
    const HiveMindController = useController
        ? (injectedController || (await import('./hivemind/hiveMindController.js')).default)
        : null;

    const inputs = files && files.length ? files : (symbols && symbols.length ? resolveSymbolFiles(symbols) : [file]);

    const worlds = [];
    for (const f of inputs) {
        const world = worldFromCandles(readCandles(f), { maxBars });
        if (world.closes.length < trainSize + testSize + 2) {
            throw new Error(`analyze: not enough candles in ${f} (${world.closes.length}) for train=${trainSize} + test=${testSize}`);
        }
        const folds = walkForwardSplit({ n: world.closes.length, trainSize, testSize });
        if (!folds.length) throw new Error(`analyze: the walk-forward split produced no folds for ${f}`);
        // A full-history split would create thousands of folds (and thousands of
        // model fits). Bound it so the CLI stays usable; pass --bars to widen.
        if (folds.length > 200) {
            throw new Error(`analyze: ${folds.length} folds from ${world.closes.length} candles is too many for one run; pass --bars=<n> (e.g. ${(trainSize + testSize) * 20})`);
        }
        worlds.push({
            label: f,
            file: f,
            candles: world.candles.length,
            returns: world.returns,
            folds,
            viewFor: makeCandleViewFor(world.candles),
        });
    }

    const variants = variantIds
        ? ['baseline', ...variantIds.filter((id) => id !== 'baseline')].map(resolveVariant)
        : [...VARIANTS.filter((v) => !v.controllerScoped || useController), ...SIGNAL_VARIANTS];

    const runId = makeRunId({ seed, startedAt });
    const runDir = writeFiles ? createRunDirectory(stateFolder, runId) : null;
    let modelRoot;
    if (runDir) {
        modelRoot = path.join(runDir, 'models');
    } else {
        // Ensure the parent exists before mkdtemp (node's mkdtempSync does not
        // create its parent; `state/` may never have been created in a fresh
        // checkout).
        fs.mkdirSync(stateFolder, { recursive: true });
        modelRoot = fs.mkdtempSync(path.join(stateFolder, 'analyze-models-'));
    }
    const foldsTotal = worlds.reduce((a, w) => a + w.folds.length, 0);
    const probePasses = worlds.reduce((a, w) => a + w.folds.reduce((b, f) => b + probesPerFold(f.test.length, auditProbesPerFold), 0), 0);
    // The event budget the progress line reports against: EVERY variant runs the
    // same per-variant pass set (one scored fold each, plus — when the audit runs
    // — one base pass and `probesPerFold` probes per fold), so the total scales
    // with the roster.
    const eventsTotal = (foldsTotal + (audit ? foldsTotal + probePasses : 0)) * variants.length;
    const totalCandles = worlds.reduce((a, w) => a + w.candles, 0);
    const modelPath = useController ? 'controller' : 'bare';

    if (runDir) {
        fs.mkdirSync(modelRoot, { recursive: true });
        writeJson(runDir, 'run.json', {
            runId, startedAt, seed,
            configFingerprint: configFingerprint(CONFIG),
            type: 'analyze',
            model: modelPath,
            files: inputs,
            candles: totalCandles,
            streams: worlds.length,
            trainSize, testSize, maxBars,
            folds: foldsTotal,
            variants: variants.map((v) => v.id),
            probe, auditProbesPerFold, requireReachable, reuseBase,
            costBps, modelRetention, foldLog,
            gate: gateMode, gateAlpha: gateAlphaResolved, costLadder: ladderLevels.slice(),
            positionPolicy: useController ? CONTROLLER_POSITION_POLICY : null,
            node: process.version,
        });
    }

    // ---- live state: counters, heartbeat file, stdout line, fold journal -----
    const counters = {
        score: 0, base: 0, probe: 0, events: 0, eventsTotal,
        variantsDone: 0, variantsTotal: variants.length,
    };
    const state = {
        phase: 'starting', variantId: null, variantIndex: -1, variantTotal: variants.length,
        stream: null, foldIndex: null, foldTotal: null, lastEventAt: startedAt,
    };
    let lastProgressAt = 0;
    let lastLineAt = 0;
    const progressText = () => ({
        runId, startedAt,
        updatedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        phase: state.phase,
        variant: { id: state.variantId, index: state.variantIndex, total: state.variantTotal },
        stream: { index: state.stream, total: worlds.length },
        fold: { index: state.foldIndex, total: state.foldTotal },
        counters,
        etaMs: counters.events > 0 && counters.eventsTotal > counters.events
            ? Math.round(((Date.now() - startedAt) / counters.events) * (counters.eventsTotal - counters.events))
            : null,
        retention: modelRetention,
        requireReachable,
        reuseBase,
        costBps,
        reader: 'liveness heartbeat: `updatedAt` advancing means the run is progressing; `counters.events/eventsTotal` is the pass budget; `etaMs` is a linear estimate from the passes completed so far.',
    });
    const flushProgress = (force = false) => {
        if (!runDir || progressMs < 0) return;
        const now = Date.now();
        if (!force && progressMs > 0 && now - lastProgressAt < progressMs) return;
        lastProgressAt = now;
        try { writeJsonAtomic(runDir, 'progress.json', progressText()); } catch { /* diagnostics only */ }
    };
    // One greppable stdout line for a human or agent watching a long run: always at
    // a variant boundary (`force`), otherwise at most once per `progressMs`. The
    // `last event` age is the frozen-run tell.
    const reportProgress = (force = false, note = '') => {
        if (progressMs < 0) return;
        const now = Date.now();
        if (!force && progressMs > 0 && now - lastLineAt < progressMs) return;
        lastLineAt = now;
        const elapsed = now - startedAt;
        const done = counters.events;
        const pct = counters.eventsTotal ? (100 * done / counters.eventsTotal).toFixed(1) : '0.0';
        const age = state.lastEventAt ? `${((now - state.lastEventAt) / 1000).toFixed(1)}s` : '-';
        log(`[analyze] ${fmtClock(elapsed)} elapsed | variant ${Math.max(1, state.variantIndex + 1)}/${state.variantTotal} ${state.variantId || '-'}` +
            ` | stream ${state.stream == null ? '-' : state.stream + 1}/${worlds.length}` +
            ` | ${state.phase} fold ${state.foldIndex == null ? '-' : state.foldIndex + 1}/${state.foldTotal || '-'}` +
            ` | events ${done}/${counters.eventsTotal} (${pct}%) | last event ${age}${note ? ' | ' + note : ''}`);
        if (force && runDir) appendLog(runDir, 'info', 'progress', { ...counters, phase: state.phase, variantId: state.variantId });
    };
    // Every scored fold and every audit pass lands here (from `evaluateAB`).
    const onEvent = (event) => {
        if (event.variantId !== state.variantId) {
            state.variantId = event.variantId;
            state.variantIndex = event.variantIndex;
            state.phase = 'score';
            state.foldIndex = null;
            state.foldTotal = null;
        }
        if (event.stream != null) state.stream = event.stream;
        if (event.t === 'fold') {
            counters.score++;
            state.phase = 'score';
            state.foldIndex = event.foldIndex;
            state.foldTotal = event.foldTotal;
        } else if (event.t === 'pass') {
            if (event.stage === 'base') counters.base++; else counters.probe++;
            state.phase = event.stage === 'base' ? 'audit-base' : 'audit-probe';
            // The audit iterates folds too: advance the fold cursor, otherwise the
            // progress line freezes on the last scored fold for the whole audit
            // (measured in the completed smoke run's stdout).
            if (Number.isFinite(event.foldIndex)) {
                state.foldIndex = event.foldIndex;
                state.foldTotal = event.foldTotal;
            }
        }
        counters.events++;
        state.lastEventAt = Date.now();
        if (runDir && foldLog !== 'off' && (foldLog === 'all' || event.t === 'fold')) {
            appendJsonl(runDir, 'folds.jsonl', foldRecord(event));
        }
        reportProgress();
        flushProgress();
    };

    // ---- checkpoints: `partial-report.json` after every variant --------------
    const roster = [];
    const variantTimings = [];
    let baselineBlock = null;
    const candidateRows = [];
    const partialReport = (status, extra = {}) => ({
        version: 1,
        schema: 'nl.analyze.v1',
        type: 'analyze-partial',
        status,
        runId, startedAt, updatedAt: new Date().toISOString(),
        model: modelPath,
        files: inputs, file: inputs[0], streams: worlds.length, candles: totalCandles, folds: foldsTotal,
        trainSize, testSize, maxBars, costBps, seed, probe, auditProbesPerFold, alpha,
        requireReachable, modelRetention, reuseBase, foldLog,
        gate: gateMode, gateAlpha: gateAlphaResolved, costLadder: ladderLevels.slice(),
        positionPolicy: useController ? CONTROLLER_POSITION_POLICY : null,
        power: baselineBlock ? baselineBlock.power : null,
        variantsTotal: variants.length,
        variants: roster,
        timings: variantTimings,
        baseline: baselineBlock,
        candidates: candidateRows,
        familywise: null,
        progress: { ...counters, phase: state.phase, elapsedMs: Date.now() - startedAt },
        artifacts: runDir ? { report: 'report.json', folds: 'folds.jsonl', log: 'run.log', progress: 'progress.json' } : null,
        reader: 'live checkpoint, rewritten after every variant. status: running|complete|failed. Row shapes match report.json. `timings` carries each finished variant\'s wall time (the measured cost model is 10.7 s per controller fit), so a running eval can be sized from the checkpoint alone. On status=failed, candidates[] holds every variant that finished and folds.jsonl holds every completed pass, so the science is not lost with the process.',
        ...extra,
    });
    const checkpoint = (status, extra) => {
        if (!runDir) return;
        try { writeJsonAtomic(runDir, 'partial-report.json', partialReport(status, extra)); } catch { /* never fail the run on a checkpoint */ }
    };
    const onVariant = (event) => {
        const entry = event.entry;
        roster.push(variantRosterRow(entry));
        if (event.role === 'baseline') {
            baselineBlock = baselineRow({ baseline: entry.report, baselineVariant: entry.variant });
        } else {
            candidateRows.push(candidateRow(entry, event.decision, null));
        }
        // Per-variant wall time (round 25, observability): the measured cost model
        // is 10.7 s per controller fit, so a run's duration is
        // `meanFit x mechanismVariants x folds x (1 + probesPerFold)`; recording
        // what each variant actually took is what lets the NEXT run be sized
        // instead of guessed at.
        variantTimings.push({
            id: entry.variant.id,
            kind: entry.variant.kind || 'mechanism',
            role: event.role,
            elapsedMs: entry.elapsedMs ?? null,
            folds: entry.report && entry.report.folds ? entry.report.folds.length : 0,
            streams: entry.streams,
            promote: event.decision ? event.decision.promote : null,
            reasons: event.decision ? event.decision.reasons.length : null,
            skipped: !!entry.skipped,
        });
        counters.variantsDone = roster.length;
        state.variantId = entry.variant.id;
        state.variantIndex = event.index;
        state.phase = 'variant-checkpoint';
        checkpoint('running');
        reportProgress(true, event.role === 'baseline'
            ? `baseline evaluated in ${fmtClock(entry.elapsedMs)}`
            : `${entry.variant.label} ${event.decision && event.decision.promote ? 'PROMOTE' : 'keep-off'}` +
              ` (${event.decision ? event.decision.reasons.length : 0} reasons)` +
              `${Number.isFinite(entry.elapsedMs) ? ` in ${fmtClock(entry.elapsedMs)}` : ''}`);
    };

    const factory = useController
        ? makeControllerModelFactory({ HiveMind, HiveMindController, stateDir: modelRoot, seed, modelRetention })
        : makeHiveMindModelFactory({ HiveMind, stateDir: modelRoot, seed, modelRetention });
    const signalForVariant = makeSignalForVariant(factory);

    state.phase = 'evaluating';
    checkpoint('running');
    reportProgress(true, `starting ${variants.length} variants x ${foldsTotal} folds x ${worlds.length} stream(s)`);

    const t0 = performance.now();
    let result = null;
    let evaluationError = null;
    try {
        result = evaluateAB({
            worlds, variants, signalForVariant, costBps, audit, alpha,
            probe, auditProbesPerFold, model: modelPath, requireReachable, auditReuseBase: reuseBase,
            gateOptions,
            onEvent, onVariant,
        });
    } catch (err) {
        evaluationError = err;
    }
    const durationMs = performance.now() - t0;

    if (evaluationError) {
        // A crash still leaves the science: every finished variant is in the
        // checkpoint, every completed pass is in folds.jsonl, and the reason is
        // recorded in both the checkpoint and the journal.
        const message = String((evaluationError && evaluationError.message) || evaluationError);
        state.phase = 'failed';
        if (runDir) {
            appendLog(runDir, 'error', 'analyze failed', { message, variantsDone: roster.length, ...counters });
        }
        checkpoint('failed', {
            durationMs,
            timings: variantTimings,
            error: { message, stack: String((evaluationError && evaluationError.stack) || '') },
        });
        flushProgress(true);
        reportProgress(true, `FAILED after ${roster.length}/${variants.length} variants: ${message}`);
        throw evaluationError;
    }

    const familywise = result.search && Array.isArray(result.search.candidates)
        ? { spaPValue: result.search.spaPValue, best: result.search.bestLabel, rejected: result.search.rejectedLabels, K: result.search.K, T: result.search.T }
        : (result.search || null);
    // Round 25: cost ladder + family correlation diagnostic. Both are pure
    // post-processing of the finished reports (no model), so they cannot change
    // the scored numbers — only the amount of the verdict that is stated.
    const ladderCandidates = result.candidates.map((c) => ({ ...c.report, id: c.variant.id }));
    const ladder = ladderLevels.length
        ? costLadder({
            baseline: result.baseline,
            candidates: ladderCandidates,
            levels: ladderLevels,
            periodsPerYear: 252,
            trials: variants.length,
            decisionOptions: { requireCleanAudit: audit, ...gateOptions },
        })
        : null;
    const familyCorr = familyCorrelation({
        baseline: result.baseline,
        candidates: result.candidates.map((c) => c.report),
        periodsPerYear: 252,
    });

    const report = {
        version: 1,
        schema: 'nl.analyze.v1',
        type: 'analyze',
        status: 'complete',
        runId,
        startedAt,
        finishedAt: Date.now(),
        durationMs,
        model: modelPath,
        files: inputs,
        streams: worlds.length,
        file: inputs[0],
        candles: totalCandles,
        folds: foldsTotal,
        trainSize,
        testSize,
        maxBars,
        costBps,
        seed,
        probe,
        auditProbesPerFold,
        alpha,
        requireReachable,
        reuseBase,
        modelRetention,
        foldLog,
        gate: gateMode,
        gateAlpha: gateAlphaResolved,
        gateOptions: { ...gateOptions },
        positionPolicy: useController ? CONTROLLER_POSITION_POLICY : null,
        power: result.baseline.power || null,
        variants: result.variants.map(variantRosterRow),
        timings: variantTimings,
        baseline: baselineRow(result),
        candidates: result.candidates.map((c) => candidateRow(c, c.decision, c.search)),
        familywise,
        // Round 25: the cost ladder (the whole verdict restated at 0/2/5/10 bps of
        // turnover) and the family-correlation diagnostic. Both are pure
        // post-processing of the finished reports — no model, no re-run — so they
        // cannot move a scored number, only the amount of the verdict that is
        // stated. A verdict that flips across the ladder is a verdict about the
        // cost assumption, not about the strategy.
        costLadder: ladder,
        familyCorrelation: familyCorr,
        progress: { ...counters, phase: 'complete', elapsedMs: durationMs },
        artifacts: runDir
            ? { folds: 'folds.jsonl', log: 'run.log', progress: 'progress.json', partial: 'partial-report.json' }
            : null,
        reader: `canonical verdict. Per candidate: \`promote\` + \`reasons\` + \`pooledMetrics\` (incl. \`grossPnl\` and \`breakEvenCostBps\` = the per-unit-turnover cost in bps at which the gross edge is exactly consumed, so a high-turnover signal can be compared to a low-turnover mechanism on one axis) + \`audit\` (clean/reachable/reachableFolds/probes/viewDiffers/baseReused) + \`search\` (family-wise) + round-25 blocks: \`dependence\` (delete-one-cluster jackknife SE over fold-window clusters, design effect, effective bars, equicorrelation reading; null on a single stream), \`promotionTest\` (paired cluster Sharpe-difference t(C-1) + exact sign test over fold windows) and \`gate\` (which hurdles were APPLIED vs SKIPPED-no-panel). The run-level \`power\` block carries the pooled Sharpe SE/MDE, an \`underpowered\` flag (MDE95 above 1.0: a null verdict that could not detect Sharpe 1 is uninformative) and \`barsToDetect1\`; \`power.seDependent\`/\`mdeSharpeDependent\` are the same numbers under the cluster jackknife. \`timings\` records each variant's wall time (the measured cost model is 10.7 s per controller fit). \`costLadder\` restates the entire verdict at each cost level in bps of turnover; \`familyCorrelation\` reports how correlated the candidates' excess returns were (a diagnostic only — the deflated Sharpe deliberately keeps trials=K). \`folds.jsonl\` holds one line per fold-pass (source: stage=score|base|probe, probeIndex for the probe bar, the pass's bar indices, emitted positions, realised returns and metrics), so the pooled metrics AND the audit can be recomputed offline; \`run.log\` is the event journal; \`progress.json\` is the liveness heartbeat.`,
        summary: formatAnalysis(result, { gate: { mode: gateMode, alpha: gateAlphaResolved }, costLadder: ladder, familyCorrelation: familyCorr }),
    };

    state.phase = 'complete';
    if (runDir) {
        writeReport(runDir, report);
        checkpoint('complete', {
            durationMs,
            familywise: report.familywise,
            gate: report.gate,
            costLadder: report.costLadder,
            familyCorrelation: report.familyCorrelation,
            timings: report.timings,
            summary: report.summary,
            finishedAt: report.finishedAt,
            progress: report.progress,
        });
        appendLog(runDir, 'info', 'analyze complete', {
            candidates: report.candidates.length, variants: roster.length,
            durationMs, folds: foldsTotal, ...counters,
        });
        // An empty `models/` is noise once every fit has been reclaimed.
        if (modelRetention === 'discard') {
            try {
                const empty = typeof fs.readdirSync === 'function'
                    && typeof fs.existsSync === 'function'
                    && fs.existsSync(modelRoot)
                    && fs.readdirSync(modelRoot).length === 0;
                if (empty) fs.rmSync(modelRoot, { recursive: true, force: true });
            } catch { /* ignore */ }
        }
    }
    flushProgress(true);
    reportProgress(true, 'complete');

    return { runDir, report, result, durationMs };
}

export const ANALYZE_USAGE = [
    'npm run analyze [-- <flags>]        (this text: --help / -h)',
    '',
    '  --file=<path>            single candle JSONL stream (default CONFIG.file)',
    '  --files=<a,b>            explicit list of candle JSONL streams',
    '  --symbols=a,b|all        manifest symbols to pool (8 available)',
    '  --model=controller|bare  shipped controller (default) or the round-22 proxy',
    '  --train=<n> --test=<n>   walk-forward sizes (default 60 / 15)',
    '  --bars=<n>               bars per stream, most recent (default 300)',
    '  --seed=<n>               seed (default 1)',
    '  --probe=<x>              audit shock size (default 0.05)',
    '  --audit-probes=<n>       probe passes per fold (default 2; 1 halves the audit cost)',
    '  --audit=0                skip the look-ahead audit (no promotion is defensible then)',
    '  --reachable              require the audit to be BEHAVIOURALLY non-vacuous',
    '  --cost-bps=<n>           transaction cost in bps per unit turnover (default 0;',
    '                           the report always states the break-even cost per candidate)',
    '  --reuse-base             reuse the scored pass as the audit base pass (one fewer',
    '                           refit per fold; the verdict is unchanged)',
    '  --variants=a,b           narrow the candidate family (baseline is always first)',
    '  --gate=classic|dependence promotion gate (default dependence: adds the paired',
    '                           cluster Sharpe-difference t-test, the exact sign test over',
    '                           fold windows, and the DSR floor on design-effect-adjusted',
    '                           bars; all skipped on a single-stream run)',
    '  --gate-alpha=<a>         alpha for the dependence hurdles (default = --alpha)',
    '  --cost-ladder=0,2,5,10   cost levels (bps of turnover) the whole verdict is',
    '                           restated at (default 0,2,5,10; empty disables)',
    '  --keep-models            keep each fit\'s SQLite state dir (forensics; large)',
    '  --fold-log=all|score|off what folds.jsonl records (default all)',
    '  --progress-ms=<n>        heartbeat cadence ms (default 5000; 0 = every pass, -1 = silent)',
].join('\n');

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    const args = process.argv.slice(2);
    const argOf = (name) => {
        const hit = args.find((a) => a.startsWith(`--${name}=`));
        return hit ? hit.slice(name.length + 3) : null;
    };
    const num = (name, fallback) => {
        const v = argOf(name);
        return v == null ? fallback : Number(v);
    };
    const list = (name) => {
        const v = argOf(name);
        return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : null;
    };
    const has = (name) => args.includes(`--${name}`);
    try {
        if (has('help') || args.includes('-h')) {
            console.log(ANALYZE_USAGE);
            process.exit(0);
        }
        const foldLogRaw = argOf('fold-log') || 'all';
        const foldLog = ['all', 'score', 'off'].includes(foldLogRaw) ? foldLogRaw : 'all';
        const ladderRaw = argOf('cost-ladder');
        // `--cost-ladder=` (explicitly empty) disables the ladder; absent keeps the
        // default levels.
        const costLadderLevels = ladderRaw == null
            ? undefined
            : (ladderRaw.trim() === '' ? [] : ladderRaw.split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x >= 0));
        const symbols = list('symbols');
        const { runDir, report, durationMs } = await runAnalysis({
            file: argOf('file') || CONFIG.file,
            files: list('files'),
            symbols: symbols && symbols.length === 1 && symbols[0] === 'all' ? CANDLE_MANIFEST.map((e) => e.symbol) : symbols,
            model: argOf('model') || 'controller',
            trainSize: num('train', 60),
            testSize: num('test', 15),
            maxBars: num('bars', 300),
            seed: num('seed', 1),
            probe: num('probe', DEFAULT_SHOCK.probe),
            auditProbesPerFold: num('audit-probes', 2),
            variantIds: list('variants'),
            audit: argOf('audit') !== '0',
            requireReachable: has('reachable'),
            costBps: num('cost-bps', 0),
            reuseBase: has('reuse-base'),
            gate: argOf('gate') || 'dependence',
            gateAlpha: argOf('gate-alpha') == null ? null : num('gate-alpha', null),
            ...(costLadderLevels === undefined ? {} : { costLadderLevels }),
            modelRetention: has('keep-models') ? 'keep' : 'discard',
            foldLog,
            progressMs: num('progress-ms', 5000),
            log: (line) => console.log(line),
        });
        console.log(report.summary);
        console.log(`\nanalyzed in ${durationMs.toFixed(0)}ms${runDir ? ` — report at ${path.join(runDir, 'report.json')}` : ''}`);
        if (runDir) {
            console.log('upload: run.json, report.json, run.log (optionally folds.jsonl) — ' +
                'per-variant checkpoint: partial-report.json, live heartbeat: progress.json. Do not upload models/.');
        }
    } catch (err) {
        console.error('analyze failed:', err && err.stack ? err.stack : err);
        process.exitCode = 1;
    }
}
