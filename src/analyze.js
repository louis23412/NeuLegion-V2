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
import { Worker } from 'node:worker_threads';
import { CONFIG } from './legion/config.js';
import { mulberry32, hashString } from './legion/rng.js';
import { runWorkerThread } from './legion/workers.js';
import { makeFoldExecutor, normaliseConcurrency } from './analysis/parallel.js';
import { walkForwardEvaluate, walkForwardEvaluateAsync, promoteDecision, formatReport, walkForwardSearch, probToPosition, confidenceToPosition, confidenceFromProb, restateReportAtCost, restateReportAtPolicy, verifyPolicyRoundTrip, poolReports, costLadder, familyCorrelation, DEPENDENCE_GATE_READER } from './analysis/walkforward.js';
import { turnoverSweep as runTurnoverSweep, formatTurnoverSweep } from './analysis/holding.js';
import { resampleCandles, designEffectOfStreams, selectStreams as runStreamSelection, formatStreamSelection } from './analysis/streams.js';
import { seedDistribution, formatSeedReplication } from './analysis/replication.js';
import { forecastComparison, formatForecast } from './analysis/forecast.js';
import { foldConcentration, confidencePersistence, nextRunPlan, decisionReport, formatDecision } from './analysis/decision.js';
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

// The causal streaming window's size for R27-3's `sample-weights` mechanism: how
// many recent observed entry spans the uniqueness ring retains. Only used by the
// opt-in `sample-weights` variant; the default (null config) path is untouched.
export const SAMPLE_WEIGHT_WINDOW_BARS = 64;

// ---------------------------------------------------------------------------
// Variants — the default-off features, enabled one at a time.
// ---------------------------------------------------------------------------
//
// Each variant is `{ id, label, note, configure(hm), afterFit(hm)?, appliesTo }`.
// The `configure`/`afterFit` bodies use the EXACT settings the walk-forward suite
// already proves are either inert or live, so a promotion here is comparable to
// the suite. `baseline` configures nothing (every feature at its default/off).
//
// `appliesTo` (round 27, R27-2) says which code path the mechanism can actually
// reach, so the report can honestly mark a candidate `not-applicable` instead of
// presenting it as a tested arm:
//   'model'      — acts on the HiveMind the model is built from (applies to both
//                  the controller and the bare model);
//   'controller' — needs the shipped controller (sample-weights, label policy);
//   'broadcast'  — acts ONLY on the memory broadcast/transfer payload
//                  (`broadcastMemory` -> `_getGlobalLSHCandidates`), whose result
//                  the scored path never reads back — so it cannot move a
//                  position and is always not-applicable here;
//   'agnostic'   — a pure signal, applicable to any model.
// `SIGNAL_VARIANTS` are 'agnostic'.
export const VARIANTS = Object.freeze([
    {
        id: 'baseline',
        label: 'baseline',
        note: 'all optional features at their default (off)',
        configure: null,
        afterFit: null,
        appliesTo: 'agnostic',
    },
    {
        id: 'surprise',
        label: 'surprise-gate',
        note: 'surprise-gated memory writes (Titans arXiv 2501.00663), floor=0.3',
        configure: (hm) => { hm._surpriseGateEnabled = true; hm._surpriseConfig = { floor: 0.3, sharpness: 1 }; },
        afterFit: null,
        appliesTo: 'model',
    },
    {
        id: 'homeostasis',
        label: 'homeostasis',
        note: 'homeostatic per-member learning rates (arXiv 2609.13771), gain=0.5',
        configure: (hm) => { hm._homeostasisEnabled = true; hm._homeostasisConfig = { gain: 0.5, target: 1, minScale: 0.5, maxScale: 1.5 }; },
        afterFit: null,
        appliesTo: 'model',
    },
    {
        id: 'multiprobe',
        label: 'multi-probe',
        note: 'margin-ordered multi-probe LSH (Lv et al. VLDB 2007), maxFlips=2 — BROADCAST path only (R27-2: cannot reach the scored model)',
        configure: (hm) => { hm._multiProbeConfig = { maxFlips: 2, budget: 8 }; },
        afterFit: null,
        appliesTo: 'broadcast',
    },
    {
        id: 'querymod',
        label: 'query-mod',
        note: 'dynamic query modification (arXiv 2605.23807) — centroid re-query — BROADCAST path only (R27-2: cannot reach the scored model)',
        configure: (hm) => { hm._queryModConfig = { enabled: true }; },
        afterFit: null,
        appliesTo: 'broadcast',
    },
    {
        id: 'pca-hash',
        label: 'pca-hash',
        note: 'data-aware PCA-aligned LSH hyperplanes (BinaryPC arXiv 2608.04405), above-mean rank — LIVE via _refreshLshHyperplanes, which _retrieveTopRelevantProtos reads (R27-2)',
        configure: (hm) => { hm._pcaHashConfig = { seed: 1, iters: 30, tol: 1e-6, minRows: 8, rankPolicy: 'above-mean' }; },
        afterFit: (hm) => { if (typeof hm._refreshLshHyperplanes === 'function') hm._refreshLshHyperplanes(); },
        appliesTo: 'model',
    },
]);

// Opt-in controller-scoped mechanism variants: resolvable by id, but deliberately
// NOT part of the default roster. `sample-weights` was removed from the default
// roster in round 27 (R27-3): on the shipped (`optimistic`) labeller every label
// is one bar long, so no two label spans overlap, every uniqueness weight is
// exactly 1, and the mechanism is a mathematical no-op — it cannot express an
// effect there. It stays resolvable (with a `configure` that enables the causal
// streaming window) so an explicit `--variants=sample-weights` run *measures*
// that inertness, and so the mechanism can be exercised under the now-reachable
// `triple` label, where labels DO overlap.
export const OPT_IN_VARIANTS = Object.freeze([
    {
        id: 'sample-weights',
        label: 'sample-weights',
        note: 'uniqueness loss weighting (AFML ch. 4) — causal streaming window; inert unless labels overlap (triple + label-horizon > 1)',
        // R27-3: on the shipped (`optimistic`) labeller every label is one bar long,
        // so no two spans overlap and every weight is exactly 1 — the mechanism DOES
        // reach the model path, it just cannot express an effect there. The liveness
        // certificate uses this variant-specific reason instead of the generic
        // "never reaches the model path", so the inert report is a true statement.
        inertReason: 'the shipped (optimistic) labeller emits one-bar labels, so no two label spans overlap and every uniqueness weight is exactly 1 — it cannot express an effect there (R27-3)',
        controllerScoped: true,
        appliesTo: 'controller',
        configure: (ctl) => {
            const horizon = Number.isFinite(ctl._labelHorizonBars) && ctl._labelHorizonBars > 1
                ? Math.floor(ctl._labelHorizonBars)
                : 1;
            ctl._sampleWeightConfig = {
                mode: 'causal-window',
                windowBars: SAMPLE_WEIGHT_WINDOW_BARS,
                horizonBars: horizon,
                normalization: 'mean1',
            };
        },
        afterFit: null,
    },
]);

// The causal signal family (ROADMAP N1) as A/B candidates: the proven pure
// features from `analysis/features.js`, each carrying the `signal(view, test)`
// the driver evaluates. They share the ONE family-wise gate and the one baseline,
// so the multiple-testing correction covers the whole searched universe.
export const SIGNAL_VARIANTS = Object.freeze(
    SIGNAL_CANDIDATES.map((c) => ({ ...c, signal: signalForCandidate(c), appliesTo: 'agnostic' })),
);

// Every candidate the A/B can resolve by id: the mechanism flags plus the signal
// family. `kind` (default 'mechanism') distinguishes them in the report. The
// opt-in variants are NOT here (so the default roster stays lean) but ARE in
// `RESOLVABLE_VARIANTS`.
export const ALL_VARIANTS = Object.freeze([...VARIANTS, ...SIGNAL_VARIANTS]);

// The trade-label policies as opt-in A/B candidates (round 26, R26-11 /
// BUGS.md #36). They are CONTROLLER-scoped: each sets the controller's
// `_labelPolicy` (the `triple` policy also needs a run-level `labelHorizonBars`).
// `optimistic` is the baseline's behaviour, so only `conservative` and `triple`
// are candidates. They are deliberately NOT in the default roster: a label change
// is a *training-set* change, so it is opt-in (`--variants=label-conservative,...`
// or `--label-policies`) and never silently on — the default trajectory and every
// golden fingerprint are untouched.
export const LABEL_VARIANTS = Object.freeze([
    {
        id: 'label-conservative',
        label: 'label:conservative',
        kind: 'label',
        controllerScoped: true,
        labelPolicy: 'conservative',
        note: 'stop-first tie-break on a both-barrier bar + a gapped stop filled at the worst traded price (BUGS.md #36)',
        configure: (ctl) => { ctl._labelPolicy = 'conservative'; },
        afterFit: null,
        appliesTo: 'controller',
    },
    {
        id: 'label-triple',
        label: 'label:triple',
        kind: 'label',
        controllerScoped: true,
        labelPolicy: 'triple',
        note: 'conservative + a time barrier at `labelHorizonBars` (the triple-barrier label, López de Prado 2018 ch. 3)',
        configure: (ctl) => { ctl._labelPolicy = 'triple'; },
        afterFit: null,
        appliesTo: 'controller',
    },
]);

// The full resolvable universe: the default A/B family plus the opt-in mechanism
// variants (`sample-weights`) and the opt-in label variants. `resolveVariant`
// searches this (so `--variants=label-triple` / `--variants=sample-weights` work),
// while the default roster stays the lean family (varianRoster below).
export const RESOLVABLE_VARIANTS = Object.freeze([...ALL_VARIANTS, ...OPT_IN_VARIANTS, ...LABEL_VARIANTS]);

// R27-2: can this variant's mechanism reach the code path the A/B scores? Returns
// a one-line reason when it cannot (so the report marks it `not-applicable`
// instead of presenting it as a tested arm), or null when it can.
export const notApplicableReason = (variant, model = 'controller') => {
    if (!variant) return null;
    if (variant.appliesTo === 'broadcast') {
        return `not-applicable: acts only on the memory broadcast path (broadcastMemory -> _getGlobalLSHCandidates), whose output the scored ${model} model never reads back`;
    }
    if (variant.appliesTo === 'controller' && model !== 'controller') {
        return `not-applicable: acts only on the controller-backed model, not the ${model} model`;
    }
    return null;
};

// R27-5: the forecast layer's grouping key. The controller family (the baseline,
// the mechanism flags, the label policies) journals a confidence derived from a
// probability — `confidenceFromProb(prob)` — so `(c+1)/2` recovers that
// probability and a proper score is meaningful. A signal variant journals a
// normalised z-score, which is NOT a probability, so it is scored only against
// the other signals. Grouping by this key (rather than raw `kind`) keeps a
// `label` candidate in the controller family where it belongs.
export const forecastKindOf = (variant) => (variant && variant.signal ? 'signal' : 'controller');

// R27-2: a human-readable taxonomy table for `--list-variants`. Columns:
// id | label | kind | appliesTo | applicable-here. `model` decides the last
// column; the default roster marks opt-in variants too.
export const listVariants = (model = 'controller') => {
    const kindOf = (v) => v.kind || (v.signal ? 'signal' : 'mechanism');
    return RESOLVABLE_VARIANTS.map((v) => {
        const reason = notApplicableReason(v, model);
        const inDefaultRoster = ALL_VARIANTS.includes(v);
        return {
            id: v.id,
            label: v.label,
            kind: kindOf(v),
            appliesTo: v.appliesTo || 'agnostic',
            controllerScoped: !!v.controllerScoped,
            inDefaultRoster,
            applicable: reason == null,
            reason: reason || null,
        };
    });
};

// R27-5: a fixed-width table for `--list-variants`, so an operator can see the
// full resolvable universe (id | kind | appliesTo | default? | applicable-here)
// and the one-line reason a variant cannot reach the scored model.
export const formatVariantList = (rows) => {
    const w = (s, n) => String(s == null ? '-' : s).padEnd(n);
    const header = `${w('id', 22)} ${w('kind', 10)} ${w('applies-to', 11)} ${w('default', 8)} applicable`;
    const lines = [header, '-'.repeat(header.length)];
    for (const r of rows) {
        lines.push(`${w(r.id, 22)} ${w(r.kind, 10)} ${w(r.appliesTo, 11)} ${w(r.inDefaultRoster ? 'yes' : (r.controllerScoped ? 'opt-in' : 'no'), 8)} ${r.applicable ? 'yes' : `no — ${r.reason}`}`);
    }
    return lines.join('\n');
};

// The confidence→position policy for the A/B (round 26, R26-3 / BUGS.md #34).
//
// ONE policy, applied to BOTH candidate families through
// `walkforward#confidenceToPosition`, in one documented signed-confidence space:
//   - the controller hands in `(prob − 50)/50`;
//   - a signal candidate hands in `clamp(z / saturation, −1, 1)` (its feature's
//     causal z-score normalised to the same [-1, 1] space).
// Before R26-3 the controller carried this dead zone and the signal family did
// not, so every turnover/participation comparison was confounded by the mapping.
// The controller's confidence is a small deviation around 50 (measured test
// windows sit in ~46-58), so a 5% dead zone abstains on prob in [47.5, 52.5].
// Measured behaviour is recorded in the report, and the raw confidence is
// journaled so the policy can be swept offline (`restateReportAtPolicy`).
export const POSITION_POLICY = Object.freeze({ deadZone: 0.05, scale: 1 });
// Back-compat name: before R26-3 this was the controller-only policy.
export const CONTROLLER_POSITION_POLICY = POSITION_POLICY;

// The identity policy (no dead zone, unit scale). Used as `makeSignalForVariant`'s
// default so a direct call is byte-identical to the pre-R26-3 behaviour; the A/B
// passes the unified `POSITION_POLICY` explicitly.
export const IDENTITY_POSITION_POLICY = Object.freeze({ deadZone: 0, scale: 1 });

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
// the baseline). Searches the resolvable universe, which includes the opt-in
// label variants.
export const resolveVariant = (id) => {
    if (!variantIndex) variantIndex = new Map(RESOLVABLE_VARIANTS.map((v) => [v.id, v]));
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
    // Round 26 (R26-13): common random numbers. When true the per-fold seed is
    // VARIANT-INDEPENDENT (`seed + testStart*977`), so every variant is fitted and
    // predicted on the same random draws and the variance of the *difference*
    // between variants falls (Glasserman & Yao 1992) — the quantity a promotion
    // decision uses. When false the historical per-variant seed is restored.
    commonRandomNumbers = true,
}) => {
    let fitCounter = 0;
    return (variant) => {
        let hm = null;
        let predictSeed = 0;
        let lastConfidence = [];
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
                const foldSeed = ((commonRandomNumbers ? seed : variantSeed) + testStart * 977) >>> 0;
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
                // `(prob - 0.5) * 2` is already a signed confidence in [-1, 1], so the
                // bare model needs no policy (confidence === position).
                const confidences = withSeed(predictSeed, () => test.map((t) => (hm.predict(featureVector(returns, t, { len, leaky })) - 0.5) * 2));
                lastConfidence = confidences;
                return confidences;
            },
            rawConfidence: () => lastConfidence,
            // Explicit, idempotent disposal. Called by `makeSignalForVariant` after
            // predict, so an in-memory model can still be re-predicted by tests.
            dispose: () => reclaim(),
            stats: () => ({ trained: hm ? 1 : 0, retention: modelRetention, reclaimed }),
        };
    };
};

// Label-lifecycle + skill diagnostics for one controller's `_globalAccuracy`
// (round 26, R26-2 / `BUGS.md` #37). Pure, side-effect-free, module-private.
//
// A model's raw accuracy is unreadable without its reference point: at the
// shipped factors the stop is half as far as the take-profit, so the label base
// rate is ≈27 % TP and "always predict stop" reads as 73 % accurate. So the
// diagnostics are *referenced* to the base rate with proper scores:
//
//   baseRate       fraction of scored trades resolved at the take-profit
//   brier          mean Brier score of the entry confidence (lower is better)
//   brierBaseline  the base-rate forecast's Brier score, p̄(1−p̄)
//   brierSkill     1 − brier/brierBaseline. Proper (Gneiting & Raftery 2007), so
//                  hedging to the base rate cannot earn skill; > 0 is a real edge
//   accuracy       directional hit rate, wins/total
//   chanceAccuracy the base-rate forecast's accuracy, max(baseRate, 1−baseRate)
//   accuracySkill  accuracy − chanceAccuracy (Heidke-style chance correction)
//   status         'not-trained' | 'base-rate' | 'skilful' (three states, not two)
//
// `raw` carries the un-derived counters so a cross-fold accumulator can pool the
// sample and recompute the rates over it, instead of averaging per-fold rates.
const labelDiagnostics = (ga = {}) => {
    const num = (v) => (Number.isFinite(v) ? v : 0);
    const trainingSteps = num(ga.trainingSteps);
    const takeProfit = num(ga.resolvedTakeProfit);
    const stopLoss = num(ga.resolvedStopLoss);
    const resolvedTotal = takeProfit + stopLoss;
    const baseRate = resolvedTotal > 0 ? takeProfit / resolvedTotal : null;
    const brierCount = num(ga.brierCount);
    const brier = brierCount > 0 ? num(ga.brierSum) / brierCount : null;
    const brierBaseline = baseRate == null ? null : baseRate * (1 - baseRate);
    const brierSkill = (brier != null && brierBaseline != null && brierBaseline > 0)
        ? 1 - brier / brierBaseline
        : null;
    const scored = num(ga.total);
    const accuracy = scored > 0 ? num(ga.wins) / scored : null;
    const chanceAccuracy = baseRate == null ? null : Math.max(baseRate, 1 - baseRate);
    const accuracySkill = (accuracy != null && chanceAccuracy != null) ? accuracy - chanceAccuracy : null;
    const status = trainingSteps > 0
        ? ((brierSkill != null && brierSkill > 0) ? 'skilful' : 'base-rate')
        : 'not-trained';
    // Label lifecycle (round 26, R26-11): the time-barrier count and the
    // entry-to-close holding distribution, so the label policy is measurable.
    const heldCount = num(ga.heldBarsCount);
    const heldSum = num(ga.heldBarsSum);
    const heldMax = num(ga.heldBarsMax);
    return {
        trainingSteps,
        quarantinedRows: num(ga.quarantinedRows),
        droppedCandles: num(ga.droppedCandles),
        openTradeWriteErrors: num(ga.openTradeWriteErrors),
        resolved: { takeProfit, stopLoss, total: resolvedTotal },
        resolvedTimeBarrier: num(ga.resolvedTimeBarrier),
        heldBars: { count: heldCount, sum: heldSum, max: heldMax, mean: heldCount > 0 ? heldSum / heldCount : null },
        baseRate, brier, brierBaseline, brierSkill,
        accuracy, chanceAccuracy, accuracySkill,
        status,
        raw: {
            trainingSteps,
            quarantinedRows: num(ga.quarantinedRows),
            droppedCandles: num(ga.droppedCandles),
            openTradeWriteErrors: num(ga.openTradeWriteErrors),
            takeProfit, stopLoss,
            brierSum: num(ga.brierSum), brierCount,
            wins: num(ga.wins), scored,
            resolvedTimeBarrier: num(ga.resolvedTimeBarrier),
            heldBarsSum: heldSum, heldBarsCount: heldCount, heldBarsMax: heldMax,
        },
    };
};

// Cross-fold accumulator for a variant's model diagnostics (round 26, R26-2;
// renamed/re-scoped in round 27, R27-5). `trainingStepsList` retains each fold's
// training-step count so the report can print a real min/median/max distribution
// rather than a single pooled scalar.
const emptyModelAccumulator = (minTrainingSteps = 1) => ({
    folds: 0, notTrainedFolds: 0, shallowHistoryFolds: 0, underTrainedFolds: 0, warmErrors: 0,
    minTrainingSteps: Number.isFinite(minTrainingSteps) ? minTrainingSteps : 1,
    trainingStepsList: [],
    heldBarsCap: null,
    sampleWeightsRaw: { count: 0, min: Infinity, max: -Infinity, sum: 0, essSum: 0, nSum: 0 },
    raw: {
        trainingSteps: 0, quarantinedRows: 0, droppedCandles: 0, openTradeWriteErrors: 0,
        takeProfit: 0, stopLoss: 0, brierSum: 0, brierCount: 0, wins: 0, scored: 0,
        resolvedTimeBarrier: 0, heldBarsSum: 0, heldBarsCount: 0, heldBarsMax: 0,
    },
});

const mergeModelStats = (acc, s) => {
    if (!acc || !s) return acc;
    acc.folds += 1;
    acc.warmErrors += Number.isFinite(s.warmErrors) ? s.warmErrors : 0;
    // R27-5: `s.undertrained` is `testStart < warmup` — the OLD always-zero
    // certificate. It is now reported under its true name (`shallowHistoryFolds`),
    // and `underTrainedFolds` is a statistic that CAN fire: a fold whose model
    // trained, but on fewer than `minTrainingSteps` rows.
    if (s.undertrained) acc.shallowHistoryFolds += 1;
    const ts = Number.isFinite(s.trainingSteps) ? s.trainingSteps : null;
    if (ts == null) {
        acc.notTrainedFolds += 1;
    } else {
        acc.trainingStepsList.push(ts);
        if (!(ts > 0)) acc.notTrainedFolds += 1;
        else if (ts < acc.minTrainingSteps) acc.underTrainedFolds += 1;
    }
    if (Number.isFinite(s.heldBarsCap)) acc.heldBarsCap = s.heldBarsCap;
    const sw = s.sampleWeightsRaw;
    if (sw && Number.isFinite(sw.count) && sw.count > 0) {
        acc.sampleWeightsRaw.count += sw.count;
        acc.sampleWeightsRaw.sum += sw.sum;
        acc.sampleWeightsRaw.essSum += sw.essSum;
        acc.sampleWeightsRaw.nSum += sw.nSum;
        if (Number.isFinite(sw.min)) acc.sampleWeightsRaw.min = Math.min(acc.sampleWeightsRaw.min, sw.min);
        if (Number.isFinite(sw.max)) acc.sampleWeightsRaw.max = Math.max(acc.sampleWeightsRaw.max, sw.max);
    }
    const raw = s.raw || {};
    for (const key of Object.keys(acc.raw)) {
        const v = raw[key];
        if (!Number.isFinite(v)) continue;
        // Every counter pools additively except the holding maximum.
        if (key === 'heldBarsMax') acc.raw[key] = Math.max(acc.raw[key], v);
        else acc.raw[key] += v;
    }
    return acc;
};

const median = (sorted) => {
    if (!sorted.length) return null;
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// The per-variant `model` block: the pooled diagnostics, or null when the variant
// never fit a model (a pure signal candidate) so an absent model cannot be read
// as a healthy one.
const summarizeModelStats = (acc) => {
    if (!acc || acc.folds === 0) return null;
    const r = acc.raw;
    const d = labelDiagnostics({
        trainingSteps: r.trainingSteps,
        quarantinedRows: r.quarantinedRows,
        droppedCandles: r.droppedCandles,
        openTradeWriteErrors: r.openTradeWriteErrors,
        resolvedTakeProfit: r.takeProfit,
        resolvedStopLoss: r.stopLoss,
        brierSum: r.brierSum,
        brierCount: r.brierCount,
        wins: r.wins,
        total: r.scored,
        resolvedTimeBarrier: r.resolvedTimeBarrier,
        heldBarsSum: r.heldBarsSum,
        heldBarsCount: r.heldBarsCount,
        heldBarsMax: r.heldBarsMax,
    });
    const tsSorted = acc.trainingStepsList.slice().sort((a, b) => a - b);
    const sw = acc.sampleWeightsRaw;
    return {
        folds: acc.folds,
        trained: d.trainingSteps > 0,
        notTrainedFolds: acc.notTrainedFolds,
        // R27-5: `shallowHistoryFolds` is the (always-zero-at-default-split) count
        // of folds below the warm-up floor; `underTrainedFolds` is the count of
        // folds whose model trained on fewer than `minTrainingSteps` rows.
        shallowHistoryFolds: acc.shallowHistoryFolds,
        underTrainedFolds: acc.underTrainedFolds,
        minTrainingSteps: acc.minTrainingSteps,
        // The per-fold training-step distribution (min/median/max), so the floor
        // can be set from evidence. Named `trainingStepsDistribution` to avoid
        // colliding with the pooled `trainingSteps` scalar below.
        trainingStepsDistribution: tsSorted.length
            ? { min: tsSorted[0], median: median(tsSorted), max: tsSorted[tsSorted.length - 1] }
            : null,
        heldBarsCap: acc.heldBarsCap,
        sampleWeights: sw.count > 0
            ? {
                count: sw.count,
                min: sw.min,
                max: sw.max,
                mean: sw.sum / sw.count,
                ess: sw.essSum / sw.count,
                n: sw.nSum / sw.count,
                effectiveFraction: sw.nSum > 0 ? sw.essSum / sw.nSum : null,
            }
            : null,
        warmErrors: acc.warmErrors,
        ...d,
    };
};

// The controller-backed model factory (ROADMAP round 23, N0): the A/B's model is
// the SHIPPED one — a real `HiveMindController` fed the real candle series, with
// its 10-indicator feature vector, trade bookkeeping and closed-trade training —
// instead of a bare `HiveMind` on a 6-element return vector.
//
// Per fold it streams bars `0 .. testStart-1` **through the same window shape
// production uses** (`legion/workers.js` passes `state.cache.slice(-cacheSize)`,
// i.e. the last `cacheSize` candles; the controller trims its own candle table to
// `cacheSize`), so the per-call input is always
// `candles.slice(max(0, i - cacheSize), i)` — contiguous and advancing. Feeding the
// whole growing prefix instead (as the driver did before round 26) re-inserts the
// trimmed history on every call and hands `_updateOpenTrades` bars older than the
// trade's entry, which mislabels the training stream (`BUGS.md` #33). Purge
// exclusions are still not honoured — a streaming model cannot skip bars — which
// is documented. The test bars are evaluated **prequentially**: the position at bar
// t is read from `getSignal(candles.slice(max(0, t + 1 - cacheSize), t + 1))`, so it
// only ever uses information available at t, and the realised return is t -> t+1.
// The audit (`analysis/world.js`) certifies exactly that property.
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
    saveInterval = 1,
    labelPolicy = 'optimistic',
    labelHorizonBars = null,
    // Round 26 (R26-13): see `makeHiveMindModelFactory`.
    commonRandomNumbers = true,
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
        // The raw pre-policy signed confidence per test bar (round 26, R26-3), so the
        // driver can journal it and restate the report at another policy.
        let lastConfidence = [];
        let warmErrors = 0;
        let folds = 0;
        let undertrained = false;
        // Readiness (round 26, R26-2 / BUGS.md #35). The old gate was
        // `testStart >= warmup` (40) while the default split's first test bar is
        // >= trainSize (60), so it could never fire — a false certificate. The
        // model's own readiness signal is whether it trained at all; a fold whose
        // controller never trained abstains (its `prob` would be the -1 sentinel
        // anyway, but this makes the reason explicit and testable).
        let ready = false;
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
        // R26-12: with `modelRetention: 'keep'` and a non-finite save interval the
        // ensemble state is never written during the run, so a kept fit directory
        // would hold no state at all. Flush it once at disposal. Under `discard` the
        // directory is deleted immediately afterwards, so the write would be pure
        // waste and is skipped. Off the arithmetic path either way.
        const flushKeptState = () => {
            if (modelRetention !== 'keep' || Number.isFinite(saveInterval) || !ctl) return;
            try { if (typeof ctl.flushState === 'function') ctl.flushState(); } catch { /* best effort */ }
        };
        const variantSeed = (seed * 131 + (hashString(variant.id) % 100000)) >>> 0;
        return {
            fit(train, test, view) {
                const candles = view.candles || [];
                const testStart = Math.min(...test);
                const foldSeed = ((commonRandomNumbers ? seed : variantSeed) + testStart * 977) >>> 0;
                dir = path.join(stateDir, `${variant.id}-${fitCounter++}`);
                folds++;
                // A fold with too little history abstains (documented; reads only
                // the past, so it cannot leak).
                undertrained = !(testStart >= warmup);
                withSeed(foldSeed, () => {
                    ctl = new HiveMindController(`AN-${variant.id}`, dir, cacheSize, ensembleSize, 'positive', tier, priceObj, true);
                    // R26-12: the A/B never reads the checkpoint back, so it does
                    // not pay for it (default via runAnalysis is Infinity; the
                    // factory default of 1 keeps the direct-call behaviour and the
                    // golden fingerprints unchanged).
                    ctl._saveInterval = saveInterval;
                    // Round 26 (R26-11): the run-level label policy. Set BEFORE the
                    // variant's configure, so a label variant can override it. The
                    // default 'optimistic' is the shipped behaviour (bit-identical).
                    ctl._labelPolicy = labelPolicy;
                    ctl._labelHorizonBars = Number.isFinite(labelHorizonBars) ? labelHorizonBars : null;
                    if (variant.configure) variant.configure(ctl);
                    // Pre-create the mind so mind-level flags are reachable.
                    mind = new HiveMind(dir, ensembleSize, ctl._inputSize, `AN-${variant.id}`, true);
                    ctl._hivemind = mind;
                    if (variant.configure) variant.configure(mind);
                    for (let i = 1; i <= testStart; i++) {
                        try { ctl.getSignal(candles.slice(Math.max(0, i - cacheSize), i), 1); } catch { warmErrors++; }
                    }
                    if (variant.afterFit) variant.afterFit(mind);
                });
                // Readiness is decided once the fit is complete: a controller that
                // closed no trade never trained, and every test bar abstains.
                ready = !!(ctl && ctl._globalAccuracy && Number.isFinite(ctl._globalAccuracy.trainingSteps) && ctl._globalAccuracy.trainingSteps > 0);
                predictSeed = (foldSeed + 7777) >>> 0;
            },
            predict(test, view) {
                if (!ready) { lastConfidence = test.map(() => 0); return test.map(() => 0); }
                const candles = view.candles || [];
                return withSeed(predictSeed, () => {
                    // The raw signed confidence per bar, then ONE policy maps it to a
                    // position (round 26, R26-3). `confidenceToPosition(confidenceFromProb(p))`
                    // is byte-identical to the old `probToPosition(p, policy)`.
                    const confidences = test.map((t) => {
                        let prob = 50;
                        try {
                            const s = ctl.getSignal(candles.slice(Math.max(0, t + 1 - cacheSize), t + 1), 1);
                            // `prob === -1` is the documented "untrained" sentinel: abstain.
                            if (s && Number.isFinite(s.prob) && s.prob >= 0) prob = s.prob;
                        } catch { /* a failed decision abstains, never throws */ }
                        return confidenceFromProb(prob);
                    });
                    lastConfidence = confidences;
                    return confidences.map((c) => confidenceToPosition(c, positionPolicy));
                });
            },
            // The raw pre-policy confidence for the last `predict`, or [] before it.
            rawConfidence: () => lastConfidence,
            dispose: () => { flushKeptState(); return reclaim(); },
            // One fold's model diagnostics (round 26, R26-2): the readiness flag,
            // the label-lifecycle split, the base rate and the skill scores, plus
            // the `raw` counters a cross-fold accumulator pools.
            stats: () => ({
                warmErrors, folds, undertrained, ready,
                retention: modelRetention, reclaimed,
                // R27-4b/R27-3 diagnostics: the cache-bounded holding cap and the
                // causal-window sample-weight raw counters (null when the mechanism
                // is off, which is the default and every golden fingerprint).
                heldBarsCap: (Number.isFinite(cacheSize) && cacheSize > 1) ? cacheSize - 1 : null,
                sampleWeightsRaw: (ctl && ctl._sampleWeightStats)
                    ? { ...ctl._sampleWeightStats }
                    : null,
                ...labelDiagnostics(ctl ? ctl._globalAccuracy : {}),
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
export const makeSignalForVariant = (factory, { onStats = null, positionPolicy = IDENTITY_POSITION_POLICY } = {}) => (variant) => {
    if (typeof variant.signal === 'function') {
        // A signal candidate emits a signed confidence (its clamped causal z-score).
        // The SAME confidence->position policy maps it to a position (round 26,
        // R26-3); with the identity default this is byte-identical to the pre-R26-3
        // signal path. The raw confidence is cached for `confidenceForFold`.
        let lastConfidence = [];
        const fold = (train, test, view) => {
            lastConfidence = variant.signal(view, test);
            return lastConfidence.map((c) => confidenceToPosition(c, positionPolicy));
        };
        fold.confidenceForFold = () => lastConfidence;
        return fold;
    }
    let lastConfidence = [];
    const fold = (train, test, view) => {
        const model = factory(variant);
        model.fit(train, test, view);
        try {
            const positions = model.predict(test, view);
            lastConfidence = typeof model.rawConfidence === 'function' ? model.rawConfidence() : null;
            return positions;
        } finally {
            // Round 26 (R26-2): hand the caller this fold's model diagnostics
            // before the fit is released. Reporting only — an observer that throws
            // must never fail a fold.
            if (onStats && typeof model.stats === 'function') {
                try { onStats(variant, model.stats()); } catch { /* reporting is best-effort */ }
            }
            // The fold function is the only production caller, and it uses each
            // fitted model exactly once — so this is the right place to release the
            // fit's state (`modelRetention: 'discard'`). Disposal is a no-op when
            // the factory keeps state, and is idempotent.
            if (typeof model.dispose === 'function') model.dispose();
        }
    };
    fold.confidenceForFold = () => lastConfidence;
    return fold;
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
        // A controller-scoped variant (sample-weights, the label policies) can only
        // run on the controller-backed model; a 'broadcast'-path variant
        // (multi-probe, query-mod) cannot reach the scored model at all (R27-2).
        // Both are still EVALUATED here (so the claim "identical to the baseline"
        // is measured, not assumed); `finalizeAB` marks them inactive and excludes
        // them from K and the search.
        const skipped = !!variant.controllerScoped && model !== 'controller';
        const notApplicable = notApplicableReason(variant, model);
        const reports = streams.map((s, si) => {
            // One fold function per (variant, stream): it holds the raw-confidence
            // cache the journal reads (round 26, R26-3).
            const foldFor = signalForVariant(variant);
            return walkForwardEvaluate({
                returns: s.returns, folds: s.folds, signalForFold: foldFor,
                confidenceForFold: typeof foldFor.confidenceForFold === 'function' ? foldFor.confidenceForFold : null,
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
            });
        });
        const report = reports.length ? poolReports(reports, { periodsPerYear, trials: variants.length }) : null;
        // Per-variant wall time (round 25, observability): the cost law
        // (`~0.035 s x sum_f(testStart_f) x streams x passes x mechanismVariants`,
        // O(n^2) per stream — docs/RUN-ANALYSIS.md section 4) can only be checked,
        // and the next run sized, if the run says how long each variant actually
        // took. Pure reporting — it has no arithmetic effect.
        return { variant, report, skipped, notApplicable, streams: reports.length, elapsedMs: Date.now() - startedAt };
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
        // null/absent the round-23/24 decision path is unchanged. This decision is
        // PROVISIONAL (computed at the roster K) and feeds the live checkpoint;
        // `finalizeAB` recomputes the authoritative decision at the active K.
        const decision = evaluated[vi].report
            ? promoteDecision(baseline, evaluated[vi].report, {
                requireCleanAudit: audit,
                ...(variants[vi].decision || {}),
                ...(gateOptions || {}),
            })
            : null;
        decisionsByIndex.set(vi, decision);
        if (onVariant) onVariant({ role: 'candidate', index: vi, entry: evaluated[vi], decision });
    }

    return finalizeAB({
        variants, evaluated, baselineIndex, decisionsByIndex, alpha, audit, model,
        streamCount: streams.length, streamLabels: streams.map((s) => s.label || null),
        probe, auditProbesPerFold, requireReachable, auditReuseBase, costBps,
        gateOptions,
    });
}

// The shared tail of `evaluateAB` and `evaluateABAsync` (round 26, R26-4): the
// candidate projection, the family-wise search and the returned result object. It
// reads only already-computed reports, so the serial and concurrent drivers cannot
// drift and the concurrency change stays strictly off the arithmetic path.
//
// Round 27 (R27-1) adds the LIVENESS CERTIFICATE and the K RESTATEMENT. A
// candidate that never reached the model path (a mechanism bolted to a dead
// reader, a label policy with no horizon) used to be scored, counted in K, and
// handed a fabricated hurdle list - so an untested arm looked tested and inflated
// every DSR. Each candidate is now compared, fold by fold, against the baseline
// (and against earlier LIVE candidates, for duplicate detection); only `live`
// candidates enter the family-wise search and the trial count K, and every
// inactive candidate carries exactly one explanatory reason. K affects the DSR,
// and `restateReportAtCost` re-pools a retained report at a new K, so the active
// reports are restated at the active K (it is proven to be the identity at the
// report's own K - see `analysis.test.js`).
const finalizeAB = ({
    variants, evaluated, baselineIndex, decisionsByIndex, alpha, audit, model,
    streamCount, streamLabels, probe, auditProbesPerFold, requireReachable, auditReuseBase, costBps,
    gateOptions = null,
}) => {
    const baselineEntry = evaluated[baselineIndex];
    const baseline = baselineEntry.report;

    // --- R27-1: per-fold position series + the liveness comparison -------------
    const foldSignals = (r) => (r && Array.isArray(r.foldInputs)
        ? r.foldInputs.map((f) => (f && Array.isArray(f.signals)) ? f.signals : [])
        : null);
    const compare = (aSignals, bSignals) => {
        const totalFolds = Math.max(aSignals.length, bSignals.length);
        let identicalFolds = 0, maxAbsDiff = 0, firstDifferingFold = null;
        for (let fi = 0; fi < totalFolds; fi++) {
            const a = aSignals[fi] || [];
            const b = bSignals[fi] || [];
            const n = Math.max(a.length, b.length);
            let diff = 0;
            for (let i = 0; i < n; i++) {
                const d = Math.abs((Number.isFinite(a[i]) ? a[i] : 0) - (Number.isFinite(b[i]) ? b[i] : 0));
                if (d > diff) diff = d;
            }
            if (diff === 0) identicalFolds += 1;
            else {
                if (firstDifferingFold === null) firstDifferingFold = fi;
                if (diff > maxAbsDiff) maxAbsDiff = diff;
            }
        }
        return { identicalFolds, totalFolds, maxAbsDiff, firstDifferingFold };
    };

    const baseSignals = foldSignals(baseline);
    const liveIndices = [];
    const livenessByIndex = new Map();
    for (let vi = 0; vi < variants.length; vi++) {
        if (vi === baselineIndex) continue;
        const entry = evaluated[vi];
        const variant = entry.variant;
        let status = 'live';
        let reason = null;
        let cmp = null;
        const naReason = entry.notApplicable || notApplicableReason(variant, model);
        if (naReason) {
            status = 'not-applicable';
            reason = naReason;
        } else if (entry.skipped) {
            status = 'skipped';
            reason = `skipped: a controller-scoped variant on the ${model} model`;
        } else if (!baseSignals || !entry.report) {
            status = 'skipped';
            reason = 'skipped: the candidate was not evaluated';
        } else {
            const candSignals = foldSignals(entry.report);
            if (candSignals) {
                cmp = compare(candSignals, baseSignals);
                if (cmp.totalFolds > 0 && cmp.identicalFolds === cmp.totalFolds) {
                    status = 'inert';
                    // R27-3: a variant may state WHY it is inert more precisely than
                    // the generic reason (e.g. `sample-weights`: labels do not overlap,
                    // so the mechanism reaches the model path and multiplies by 1).
                    reason = variant.inertReason
                        ? `inert: identical to the baseline on all ${cmp.totalFolds} folds — ${variant.inertReason}`
                        : `inert: identical to the baseline on all ${cmp.totalFolds} folds (the mechanism never reaches the model path)`;
                } else {
                    const dup = liveIndices.find((xi) => {
                        const xs = foldSignals(evaluated[xi].report);
                        if (!xs) return false;
                        const c2 = compare(candSignals, xs);
                        return c2.totalFolds > 0 && c2.identicalFolds === c2.totalFolds;
                    });
                    if (dup != null) {
                        const dupId = evaluated[dup].variant.id;
                        status = `duplicate-of:${dupId}`;
                        reason = `duplicate-of:${dupId}: identical to the earlier live candidate ${evaluated[dup].variant.label || dupId}`;
                    }
                }
            }
        }
        const cert = { status, reason, ...(cmp || {}) };
        livenessByIndex.set(vi, cert);
        entry.liveness = cert;
        if (status === 'live') liveIndices.push(vi);
    }
    if (baselineEntry) baselineEntry.liveness = { status: 'baseline', reason: null };

    // --- R27-1: the active set + the K restatement -----------------------------
    const activeIndices = [baselineIndex, ...liveIndices];
    const trialsRoster = variants.length;
    const trialsActive = activeIndices.length;
    const restate = (report) => {
        if (!report || !Array.isArray(report.foldInputs) || !report.foldInputs.length) return report;
        const r = restateReportAtCost(report, costBps, { trials: trialsActive });
        if (!r) return report;
        // Swap only what K (and the cost) affect; keep the scored report's audit,
        // foldInputs, probed flag, foldSharpes and stream labels.
        return {
            ...report,
            trials: r.trials,
            pooledMetrics: r.pooledMetrics,
            power: r.power,
            aggregate: r.aggregate,
            dependence: r.dependence,
            folds: r.folds,
            pooledBars: r.pooledBars,
        };
    };
    const baselineRestated = restate(baseline);
    // R27-1: restate EVERY candidate report at the active K, not just the live
    // ones. An inactive candidate's DSR is not a family-wise statistic (it is
    // outside K and the search), but its row must still carry the same K the run
    // was deflated by, so a reader never sees two different `trials` values in one
    // report. Its pre-restatement (roster-K) report is kept in `reportRoster`.
    for (let vi = 0; vi < variants.length; vi++) {
        if (vi === baselineIndex || !evaluated[vi].report) continue;
        evaluated[vi].reportRestated = restate(evaluated[vi].report);
    }

    // --- R27-1: the final decisions over the ACTIVE set ------------------------
    const finalDecision = new Map();
    for (let vi = 0; vi < variants.length; vi++) {
        if (vi === baselineIndex) continue;
        const entry = evaluated[vi];
        if (entry.liveness.status === 'live' && entry.reportRestated) {
            finalDecision.set(vi, promoteDecision(baselineRestated, entry.reportRestated, {
                requireCleanAudit: audit,
                ...(variants[vi].decision || {}),
                ...(gateOptions || {}),
            }));
        } else {
            finalDecision.set(vi, {
                promote: false,
                reasons: [entry.liveness.reason || `${entry.liveness.status} candidate`],
                foldWinFraction: null,
                promotionTest: {
                    available: false,
                    reason: 'candidate is not active (inert / duplicate / not-applicable / skipped): it is excluded from K and the family-wise search',
                },
                gate: { minDsrAdjusted: 'off', requireSharpeDiff: 'off', requireBreadth: 'off', requireClusterStability: 'off' },
                inactive: true,
            });
        }
    }

    // --- R27-1: the family-wise search over the ACTIVE set ---------------------
    let search = null;
    try {
        if (!liveIndices.length) {
            // R27-1: a skipped search keeps the normal search shape (with an empty
            // candidate list and explicit nulls), so a reader that expects
            // `spaPValue`/`rejectedLabels`/`bestLabel` never crashes on it.
            search = {
                skipped: true,
                reason: 'no active candidates (every candidate was inert / duplicate / not-applicable / skipped)',
                K: 1, T: null, alpha: alpha ?? null,
                spaPValue: null, bestLabel: null, rejectedLabels: [],
                candidates: [],
            };
        } else {
            search = walkForwardSearch({
                baseline: baselineRestated,
                candidates: liveIndices.map((vi) => evaluated[vi].reportRestated),
                labels: liveIndices.map((vi) => evaluated[vi].variant.label),
                alpha,
            });
        }
    } catch (err) {
        search = { error: err.message || String(err) };
    }
    const searchRowFor = (vi) => {
        if (!search || !Array.isArray(search.candidates)) return null;
        const pos = activeIndices.indexOf(vi);
        return pos >= 0 ? (search.candidates[pos] || null) : null;
    };

    const counts = { inert: 0, duplicate: 0, notApplicable: 0, skipped: 0 };
    for (let vi = 0; vi < variants.length; vi++) {
        if (vi === baselineIndex) continue;
        const s = livenessByIndex.get(vi).status;
        if (s === 'inert') counts.inert += 1;
        else if (s.startsWith('duplicate-of:')) counts.duplicate += 1;
        else if (s === 'not-applicable') counts.notApplicable += 1;
        else if (s === 'skipped') counts.skipped += 1;
    }

    const candidates = [];
    for (let vi = 0; vi < variants.length; vi++) {
        if (vi === baselineIndex) continue;
        const entry = evaluated[vi];
        candidates.push({
            variant: entry.variant,
            report: entry.reportRestated || entry.report,
            // The report BEFORE the K restatement (same foldInputs/audit, the
            // roster K); kept so an offline reader can compare the two Ks.
            reportRoster: entry.report || null,
            skipped: entry.skipped,
            notApplicable: entry.notApplicable || null,
            liveness: entry.liveness || null,
            // R27-1: whether this candidate entered K and the family-wise search.
            // The report side filters on this (cost ladder, family correlation,
            // forecast comparison, decision feature), so it must live on the
            // result object, not only on the projected `candidateRow`.
            active: !!(entry.liveness && entry.liveness.status === 'live'),
            elapsedMs: entry.elapsedMs,
            streams: entry.streams,
            decision: finalDecision.get(vi) || null,
            search: searchRowFor(vi),
        });
    }

    return {
        baselineIndex,
        baselineVariant: variants[baselineIndex],
        baseline: baselineRestated,
        variants: evaluated,
        candidates,
        search,
        auditClean: audit ? !!(baseline && baseline.audit && baseline.audit.clean) : null,
        model,
        streams: streamCount,
        probe,
        auditProbesPerFold,
        requireReachable,
        reuseBase: auditReuseBase,
        costBps,
        positionPolicy: model === 'controller' ? CONTROLLER_POSITION_POLICY : null,
        streamLabels,
        // R27-1: the trial accounting. `trials` is the K every DSR was deflated by
        // (the ACTIVE roster); `trialsRoster` is what was requested.
        trials: trialsActive,
        trialsRoster,
        trialsInactive: trialsRoster - trialsActive,
        inactiveCounts: counts,
        liveness: { roster: trialsRoster, active: trialsActive, ...counts },
    };
}
// The concurrent twin of `evaluateAB` (round 26, R26-4). Same options, plus
// `foldExecutorFor(variant, streamIndex, stream)` — returning a fold executor for a
// unit (e.g. a worker dispatch), or null/undefined to run that variant in-process
// via `signalForVariant` — and `concurrency` (the in-flight width). The variant
// order, the emit order and every number are unchanged; only wall time moves. The
// result is assembled by the SAME `finalizeAB`, so the two drivers cannot drift.
export async function evaluateABAsync({
    returns = null, folds = null, viewFor = null, worlds = null,
    variants = ALL_VARIANTS, signalForVariant,
    foldExecutorFor = null,
    costBps = 0, periodsPerYear = 252, audit = true, requireCausal = true, alpha = 0.05,
    probe = 1e3, requireReachable = false, auditProbesPerFold = 0, model = 'bare',
    auditReuseBase = false, gateOptions = null,
    onEvent = null, onVariant = null, onModelStats = null, concurrency = 1,
} = {}) {
    if (typeof signalForVariant !== 'function') {
        throw new Error('evaluateABAsync: signalForVariant(variant) => signalForFold is required');
    }
    if (!Array.isArray(variants) || variants.length < 2) {
        throw new Error('evaluateABAsync: at least a baseline and one candidate are required');
    }
    const streams = Array.isArray(worlds) && worlds.length
        ? worlds
        : [{ returns, folds, viewFor, label: 'main' }];
    if (!Array.isArray(streams[0].returns) || !Array.isArray(streams[0].folds) || !streams[0].folds.length) {
        throw new Error('evaluateABAsync: either `worlds` or (`returns` + `folds`) is required');
    }

    const baselineIndex = Math.max(0, variants.findIndex((v) => v.id === 'baseline'));
    const evaluateOne = async (vi) => {
        const variant = variants[vi];
        const startedAt = Date.now();
        const skipped = !!variant.controllerScoped && model !== 'controller';
        const notApplicable = notApplicableReason(variant, model);
        const reports = [];
        for (let si = 0; si < streams.length; si++) {
            const s = streams[si];
            const rawExecutor = foldExecutorFor ? foldExecutorFor(variant, si, s) : null;
            // Surface the worker's model diagnostics to the same accumulator the
            // in-process `onStats` feeds, so the per-variant `model` block (R26-2) is
            // present in the parallel run too. Reporting only — no arithmetic.
            const executor = rawExecutor
                ? async (ctx) => {
                    const r = await rawExecutor(ctx);
                    if (onModelStats && r && r.stats) {
                        try { onModelStats(variant, r.stats); } catch { /* reporting is best-effort */ }
                    }
                    return { signals: r.signals, confidence: r.confidence };
                }
                : null;
            const foldFor = signalForVariant(variant);
            reports.push(await walkForwardEvaluateAsync({
                returns: s.returns, folds: s.folds,
                // The scored pass may run in a worker (`executor`), but the look-ahead
                // audit always runs HERE, in-process, because it re-fits the signal on
                // PERTURBED views — and a fold executor has no view channel. Nulling
                // `signalForFold` when an executor existed crashed `auditNoLookahead`
                // for every `concurrency > 1` run with `audit` on (the default).
                // `signalForVariant` is a cheap closure over the shared factory; when
                // an executor handles the scored pass only the audit calls it.
                signalForFold: foldFor,
                foldExecutor: executor || null,
                confidenceForFold: !executor && typeof foldFor.confidenceForFold === 'function' ? foldFor.confidenceForFold : null,
                costBps, periodsPerYear, trials: variants.length, audit, requireCausal,
                viewFor: s.viewFor == null ? viewFor : s.viewFor,
                probe, requireReachable, auditProbesPerFold, auditReuseBase,
                concurrency,
                onEvent: onEvent
                    ? (e) => onEvent({
                        ...e,
                        variantId: variant.id, variantIndex: vi, variantTotal: variants.length,
                        stream: si, streamLabel: s.label == null ? null : s.label, streamsTotal: streams.length,
                    })
                    : null,
            }));
        }
        const report = reports.length ? poolReports(reports, { periodsPerYear, trials: variants.length }) : null;
        return { variant, report, skipped, notApplicable, streams: reports.length, elapsedMs: Date.now() - startedAt };
    };

    const evaluated = new Array(variants.length);
    evaluated[baselineIndex] = await evaluateOne(baselineIndex);
    if (onVariant) onVariant({ role: 'baseline', index: baselineIndex, entry: evaluated[baselineIndex], decision: null });
    const decisionsByIndex = new Map();
    for (let vi = 0; vi < variants.length; vi++) {
        if (vi === baselineIndex) continue;
        evaluated[vi] = await evaluateOne(vi);
        // Provisional (roster-K) decision for the live checkpoint; `finalizeAB`
        // recomputes the authoritative decision at the active K.
        const decision = evaluated[vi].report
            ? promoteDecision(evaluated[baselineIndex].report, evaluated[vi].report, {
                requireCleanAudit: audit,
                ...(variants[vi].decision || {}),
                ...(gateOptions || {}),
            })
            : null;
        decisionsByIndex.set(vi, decision);
        if (onVariant) onVariant({ role: 'candidate', index: vi, entry: evaluated[vi], decision });
    }

    return finalizeAB({
        variants, evaluated, baselineIndex, decisionsByIndex, alpha, audit, model,
        streamCount: streams.length, streamLabels: streams.map((s) => s.label || null),
        probe, auditProbesPerFold, requireReachable, auditReuseBase, costBps,
        gateOptions,
    });
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
    const ib = extra.intervalBars != null ? extra.intervalBars : (result.intervalBars || 1);
    lines.push(`model: ${result.model || 'bare'} | streams=${result.streams || 1} | ` +
        `positionPolicy=${JSON.stringify(result.positionPolicy || CONTROLLER_POSITION_POLICY)} | ` +
        `probe=${f4(result.probe)} | auditProbesPerFold=${result.auditProbesPerFold || 0} | costBps=${result.costBps || 0} | reuseBase=${result.reuseBase === true}` +
        ` | intervalBars=${ib} | crn=${extra.commonRandomNumbers !== false}`);
    // Round 26 (R26-2): whether each model-backed variant actually trained, and
    // whether it beats its label base rate. Without this, a keep-off verdict is
    // ambiguous between "no edge" and "no model" (BUGS.md #35/#37).
    const ms = extra.model || null;
    if (ms && typeof ms.get === 'function' && typeof ms.size === 'number' && ms.size > 0) {
        const parts = [];
        for (const [id, acc] of ms) {
            const d = summarizeModelStats(acc);
            if (!d) continue;
            parts.push(`${id} ${d.status} steps=${d.trainingSteps}` +
                ` base=${d.baseRate == null ? 'n/a' : f4(d.baseRate)}` +
                ` skill=${d.brierSkill == null ? 'n/a' : f4(d.brierSkill)}` +
                ` warmErrors=${d.warmErrors}`);
        }
        if (parts.length) lines.push(`models: ${parts.join(' | ')}`);
    }
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
        const decision = c.decision || { promote: false, reasons: [], gate: null, promotionTest: null };
        const verdict = decision.promote ? 'PROMOTE' : 'keep-off';
        const kind = c.variant.kind === 'signal' ? ' |signal' : '';
        const fw = c.search ? ` | StepM p=${f4(c.search.pValue)} rejected=${!!c.search.rejected}` : '';
        // Name any round-25 hurdle that was SKIPPED for lack of a panel, so a
        // green gate can never be read as "all hurdles passed".
        const skippedHurdles = decision.gate
            ? Object.entries(decision.gate).filter(([, v]) => v === 'skipped-no-panel').map(([k2]) => k2)
            : [];
        const gt = skippedHurdles.length ? ` | gate-skipped=${skippedHurdles.join(',')}` : '';
        // R27-1: an inactive candidate (inert / duplicate / not-applicable / skipped)
        // names its status inline, and a candidate with no report (never evaluated)
        // is stated as such rather than crashing the formatter on a null report.
        const liveTag = c.active ? '' : ` [${(c.liveness && c.liveness.status) || (c.skipped ? 'skipped' : 'inactive')}]`;
        const label = `${c.variant.label} [${verdict}]${kind}${liveTag}${c.skipped ? ' (skipped: controller-scoped)' : ''}${fw}${gt}`;
        if (!c.report) {
            lines.push(`[${label}] not evaluated`);
            lines.push(`  reasons: ${(decision.reasons || []).join('; ')}`);
            continue;
        }
        // The paired cluster test belongs to the candidate-vs-baseline DECISION,
        // not to the report, so it is handed to the formatter here (round 25). A
        // single-stream run still renders it — as `paired: n/a (reason)` — so the
        // absence of a panel is stated rather than silently omitted.
        lines.push(formatReport(c.report, {
            label,
            promotionTest: decision.promotionTest,
        }));
        if (!decision.promote) lines.push(`  reasons: ${(decision.reasons || []).join('; ')}`);
    }
    if (s && s.skipped) {
        lines.push(`family-wise: skipped (${s.reason || 'no active candidates'})`);
    } else if (s && Array.isArray(s.candidates)) {
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
    // Round 26 (R26-5): the turnover attack. One line per candidate naming the
    // best break-even policy, so the reader sees whether any no-trade band (or
    // hysteresis / minimum holding) clears the target cost — and which.
    const ts = extra.turnoverSweep;
    if (ts) {
        const rendered = formatTurnoverSweep(ts);
        if (rendered) for (const line of rendered.split('\n')) lines.push(line);
    }
    // Round 26 (R26-6): the effective independence of the stream basket (Kish
    // design effect over the streams' own returns) and, when asked, the greedy
    // selection order. Design/diagnostic only.
    const ss = extra.streamSelection;
    if (ss) {
        const rendered = formatStreamSelection(ss);
        if (rendered) for (const line of rendered.split('\n')) lines.push(line);
        if (ss.keep != null && ss.keptDesignEffect && ss.keptDesignEffect.available) {
            lines.push(`streams kept=${ss.keep} -> ${ss.kept.join(',')} DE=${f4(ss.keptDesignEffect.designEffect)} ` +
                `effectiveBars=${f4(ss.keptDesignEffect.effectiveBars)}`);
        }
    }
    // Round 26 (R26-14): the forecast-comparison line — proper scores and the
    // Model Confidence Set. The MCS is the headline: which families cannot be
    // distinguished from the best, rather than a single sample-best winner.
    const fcBlock = extra.forecast;
    if (fcBlock) {
        const rendered = formatForecast(fcBlock);
        if (rendered) for (const line of rendered.split('\n')) lines.push(line);
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
    // Round 26 (R26-8): the decision-grade report — the verdict, the concentration
    // readout and the next-run sizing knobs stated in one place, so a reader does
    // not have to reconstruct them from the per-candidate lines above.
    if (extra.decision) {
        const renderedDecision = formatDecision(extra.decision);
        if (renderedDecision) for (const line of renderedDecision.split('\n')) lines.push(line);
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
const variantRosterRow = (entry, modelStats = null) => ({
    id: entry.variant.id,
    label: entry.variant.label,
    kind: entry.variant.kind || 'mechanism',
    appliesTo: entry.variant.appliesTo || 'agnostic',
    skipped: entry.skipped,
    notApplicable: entry.notApplicable || null,
    // R27-1: the liveness certificate (null before finalizeAB has run).
    liveness: entry.liveness || null,
    inDefaultRoster: ALL_VARIANTS.includes(entry.variant),
    streams: entry.streams,
    // Round 26 (R26-2): null for a pure signal candidate (it never fits a model),
    // so an absent model block is never mistaken for a healthy one.
    model: summarizeModelStats(modelStats && modelStats.get(entry.variant.id)),
});

// The baseline row. `audit` is the full machine-readable block; `auditClean` keeps
// the old boolean for anything that already reads it.
const baselineRow = (result, modelStats = null) => {
    const base = result.baseline;
    return {
        id: result.baselineVariant.id,
        label: result.baselineVariant.label || result.baselineVariant.id,
        // Round 26 (R26-2): did the model train, on what label base rate, and is
        // it any better than that base rate.
        model: summarizeModelStats(modelStats && modelStats.get(result.baselineVariant.id)),
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
        // Round 26 (R26-13): the per-fold net Sharpe series, so a multi-seed run can
        // build the (seed x fold) panel without re-reading folds.jsonl.
        foldSharpes: (base.folds || []).map((f) => (f && f.metrics ? f.metrics.netSharpe : NaN)),
    };
};

// One candidate row: the decision, the pooled metrics, the audit block and (when
// the family-wise cross-check has run) the joint `search` statistics. R27-1: a
// candidate that was NOT evaluated (not-applicable / skipped) has a null report,
// so every report-derived field is null rather than a crash; it still carries its
// liveness certificate and its single reason.
const candidateRow = (entry, decision, search, modelStats = null) => {
    const report = entry.report || null;
    const fallbackReason = entry.liveness && entry.liveness.reason
        ? [entry.liveness.reason]
        : (entry.notApplicable ? [entry.notApplicable] : []);
    return {
        id: entry.variant.id,
        label: entry.variant.label,
        kind: entry.variant.kind || 'mechanism',
        appliesTo: entry.variant.appliesTo || 'agnostic',
        skipped: entry.skipped,
        notApplicable: entry.notApplicable || null,
        // R27-1: the liveness certificate. `status` is one of
        // live | inert | skipped | not-applicable | duplicate-of:<id>.
        liveness: entry.liveness || null,
        active: !!(entry.liveness && entry.liveness.status === 'live'),
        // Round 26 (R26-2): the per-variant model diagnostics (null for a signal).
        model: summarizeModelStats(modelStats && modelStats.get(entry.variant.id)),
        promote: decision ? decision.promote : false,
        // R27-1: true for a candidate excluded from K / the search (inert,
        // duplicate, not-applicable or skipped). It carries exactly one reason in
        // `reasons` and a null promotion test; `active` is its complement.
        inactive: !!(decision && decision.inactive),
        reasons: decision ? decision.reasons : fallbackReason,
        foldWinFraction: decision ? decision.foldWinFraction : null,
        pooledMetrics: report ? report.pooledMetrics : null,
        aggregate: report ? report.aggregate : null,
        audit: auditBlock(report ? report.audit : null),
        auditClean: report && report.audit ? !!report.audit.clean : null,
        power: report ? (report.power || null) : null,
        // Round 25: the dependence panel, the paired cluster test behind the new
        // hurdles, and which hurdles were actually applied (vs skipped for lack of a
        // cross-stream panel) — so the report can never claim a gate it did not run.
        dependence: report ? (report.dependence || null) : null,
        promotionTest: decision ? (decision.promotionTest || null) : null,
        gate: decision ? (decision.gate || null) : null,
        elapsedMs: entry.elapsedMs ?? null,
        // How many streams actually contributed to this variant's pooled report.
        streams: entry.streams ?? null,
        // The number of searches this candidate's DSR was deflated by (K, the
        // ACTIVE roster after R27-1). It rides on the report, but it was not
        // surfaced in `report.json`, so a reader could not see the trial count the
        // verdict assumed.
        trials: report && Number.isFinite(report.trials) ? report.trials : null,
        pooledBars: report ? report.pooledBars : null,
        // Round 26 (R26-13): the per-fold net Sharpe series (seed x fold panel input).
        foldSharpes: report && Array.isArray(report.folds)
            ? report.folds.map((f) => (f && f.metrics ? f.metrics.netSharpe : NaN))
            : [],
        search: search ? { pValue: search.pValue, rejected: search.rejected, statistic: search.statistic, kfwerPValue: search.kfwerPValue ?? null, fdp: search.fdp ?? null } : null,
    };
};

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
    // The raw pre-policy confidence (round 26, R26-3). With the scored policy this
    // reproduces `signals` byte-for-byte (`analyze#verifyPolicyRoundTrip`), so a
    // dead-zone/scale/holding sweep is pure post-processing.
    confidence: event.confidence ?? null,
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

// A worker-backed fold dispatcher (round 26, R26-4). Each call runs one fold-pass
// in its own thread via the settle-once, watchdogged `runWorkerThread`, so a crash
// or hang in one fold rejects that fold only. `spawn` is injectable so a test can
// drive the dispatch without `worker_threads`.
export const makeNodeFoldDispatcher = ({ url, spawn = null, timeoutMs = null } = {}) => {
    const spawnWorker = spawn || ((u, workerData) => new Worker(u, { workerData }));
    return async (request) => runWorkerThread({
        url,
        label: `fold:${request.variantId}#${request.streamIndex}.${request.foldIndex}`,
        workerData: request,
        spawn: spawnWorker,
        accept: (m) => !!m && Array.isArray(m.positions),
        onSuccess: (m) => ({ positions: m.positions, confidence: m.confidence || null, stats: m.stats || null }),
        ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
    });
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
    // Round 27 (R27-9): `requireReachable` now defaults ON — a structurally
    // reachable but behaviourally unreachable audit must never certify a
    // promotion. `--reachable=0` opts out. The CLI also defaults
    // `--audit-probes` to 1 (below); this direct-call default stays 2 so the
    // historical behaviour is available to a direct caller.
    minTrainingSteps = 1,        // R27-5: folds training on fewer rows than this are `underTrainedFolds`
    // Round 24 run-integrity options (all off the arithmetic path).
    modelRetention = 'discard',   // 'discard' reclaims each fit's state dir after use; 'keep' for forensics
    requireReachable = true,      // enforce the audit's behavioural non-vacuity (not just structural)
    reuseBase = false,            // reuse the scored pass as the audit base pass (one less refit/fold)
    foldLog = 'all',              // 'all' | 'score' | 'off': what folds.jsonl records
    progressMs = 5000,            // stdout + progress.json cadence; 0 = every event, -1 = silent
    // Round 26 (R26-12): the A/B never reads a fit's persisted state back, so it
    // does not pay for the checkpoint. `1` restores a per-call full-state dump
    // (the historical behaviour); `Infinity` never dumps during the run. The
    // emitted signals/positions are identical either way (measured: ~25% of the
    // per-call cost was the dump).
    saveInterval = Infinity,
    // Round 26 (R26-11): the label policy applied to every controller. Default
    // `optimistic` is the shipped labeler (bit-identical); `conservative` and
    // `triple` are also available as opt-in *variants* (`--label-policies`).
    // `labelHorizonBars` is the triple barrier's time horizon; without it the
    // `triple` policy degrades to `conservative` (recorded, not silently ignored).
    labelPolicy = 'optimistic',
    labelHorizonBars = null,
    labelPolicies = false,        // append the opt-in label variants to the roster
    // Round 26 (R26-4): the fold loop's in-flight width. `1` (default) keeps the
    // serial driver byte-for-byte; `> 1` dispatches whole fold-passes to worker
    // threads through the settle-once dispatcher. The arithmetic and the emit order
    // are unchanged (only wall time moves). `spawnWorker` is injectable for tests.
    concurrency = 1,
    spawnWorker = null,
    // Round 26 (R26-6): buy effective independence, not bars. `intervalBars > 1`
    // resamples every stream by that factor (e.g. 4 => 4h bars from 1h data) — a
    // genuinely different horizon, not another copy of the same one. `streamSelect`
    // is null (off) | true (measure and report the greedy basket) | a positive
    // integer (keep only the first N streams of the greedy order). Both are design
    // choices; neither changes how an included stream is scored.
    intervalBars = 1,
    streamSelect = null,
    // Round 26 (R26-13): common random numbers. With CRN (the default) every
    // variant's fold seed depends only on the master seed and `testStart`, so the
    // variant comparison is PAIRED on the random draws and the variance of the
    // difference falls (Glasserman & Yao 1992). `false` restores the historical
    // per-variant seed (`seed*131 + hash(variant.id)`) for reproducing old runs.
    commonRandomNumbers = true,
    // Round 26 (R26-14): score the family as forecasters (proper scores, the
    // Diebold–Mariano test vs the baseline, and the family Model Confidence Set).
    // Pure post-processing of the journaled confidence — it cannot move a scored
    // number. `--forecast=0` disables the (small) extra work.
    forecast = true,
    // Round 26 (R26-8): the decision-grade report — a pure composition of the blocks
    // above into the six questions the next cycle asks (training / edge /
    // concentration / economics / family / nextRun), every field either a value or an
    // explicit { available:false, reason }. No new strategy statistic is computed; the
    // concentration readout restates the scored folds (leave-one-fold-out Sharpe
    // range) and `nextRun` reads the measured power. `--decision=0` disables it.
    decision = true,
    // Round 25 decision options.
    gate = 'dependence',          // 'classic' (round-23/24 hurdles) | 'dependence' (adds the panel-aware ones)
    gateAlpha = null,             // alpha for the dependence hurdles (defaults to `alpha`)
    costLadderLevels = [0, 2, 5, 10], // bps-of-turnover levels the verdict is restated at ([] disables)
    // Round 26 (R26-5): the turnover attack. A dead-zone x hysteresis x
    // minimum-holding grid restated as pure post-processing of the journaled
    // confidence (no model). Off by default — it is an extra diagnostic block,
    // like the cost ladder, and cannot move a scored number. `turnoverTarget` is
    // the bps of per-unit-turnover cost the attack is trying to clear (the
    // realistic crypto taker range is 5-10 bps).
    turnoverSweep = false,
    turnoverTarget = 5,
    log = () => {},               // stdout sink (injectable so tests stay quiet)
    HiveMind: injectedHiveMind = null, HiveMindController: injectedController = null,
} = {}) {
    const startedAt = Date.now();
    const useController = model !== 'bare';
    // Round 26 (R26-11): validate the label policy up front so a typo cannot
    // silently run the default labeler.
    if (!['optimistic', 'conservative', 'triple'].includes(labelPolicy)) {
        throw new Error(`analyze: unknown labelPolicy "${labelPolicy}" (optimistic | conservative | triple)`);
    }
    // Round 26 (R26-4): resolve the fold loop's in-flight width once, so the manifest,
    // the checkpoints and the report all state what was actually used.
    const width = normaliseConcurrency(concurrency);
    // Round 25: resolve the promotion gate and the cost-ladder levels ONCE, so the
    // manifest, every checkpoint and the final report state what was actually
    // used. `classic` is the round-23/24 gate; `dependence` adds the paired
    // cluster Sharpe-difference test, the exact sign test over fold windows, and
    // the design-effect-adjusted DSR floor (all skipped, not failed, on a
    // single-stream run that has no panel to estimate them from).
    const gateMode = gate === 'classic' ? 'classic' : 'dependence';
    const gateAlphaResolved = Number.isFinite(gateAlpha) ? gateAlpha : alpha;
    const gateOptions = gateMode === 'dependence'
        ? { requireSharpeDiff: true, requireClusterStability: true, minDsrAdjusted: 0.95, alpha: gateAlphaResolved, periodsPerYear: 252 }
        : { alpha: gateAlphaResolved, periodsPerYear: 252 };
    const ladderLevels = Array.isArray(costLadderLevels)
        ? costLadderLevels.filter((x) => Number.isFinite(x) && x >= 0)
        : [];
    // Round 26 (R26-5): resolve the turnover attack's target once, so the manifest
    // and the report state the same number the sweep was run against.
    const turnoverEnabled = turnoverSweep === true;
    const turnoverTargetBps = Number.isFinite(turnoverTarget) ? turnoverTarget : 5;
    // Round 26 (R26-6): resolve the interval factor and the stream-selection mode
    // once, so the manifest and the report agree.
    const intervalFactor = Number.isInteger(intervalBars) && intervalBars > 1 ? intervalBars : 1;
    const streamSelectKeep = Number.isFinite(streamSelect) && streamSelect > 0 ? Math.floor(streamSelect) : null;
    const streamSelectEnabled = streamSelect === true || streamSelectKeep != null;
    const crn = commonRandomNumbers !== false;
    const forecastEnabled = forecast !== false;
    const HiveMind = injectedHiveMind || (await import('./hivemind/hiveMind.js')).default;
    const HiveMindController = useController
        ? (injectedController || (await import('./hivemind/hiveMindController.js')).default)
        : null;

    const inputs = files && files.length ? files : (symbols && symbols.length ? resolveSymbolFiles(symbols) : [file]);
    // R27-5 journal/report hygiene: a stream's label is its SYMBOL (or the file
    // basename), never the operator's absolute path. The round-26 journal embedded
    // `/home/<operator>/.../candles.jsonl` because the world label was the path.
    const inputLabels = inputs.map((f) => {
        const entry = CANDLE_MANIFEST.find((e) => f === e.file || String(f).endsWith(e.file));
        if (entry) return entry.symbol;
        const base = path.basename(String(f)).replace(/\.jsonl$/i, '').replace(/^candles[_-]?/i, '');
        return base ? base.toUpperCase() : String(f);
    });

    let worlds = [];
    for (let ii = 0; ii < inputs.length; ii++) {
        const f = inputs[ii];
        // Round 26 (R26-6): optionally resample the raw 1h stream to a coarser bar
        // interval before the world is built, so a second horizon can be added to
        // the panel without a second dataset.
        const rawCandles = readCandles(f);
        const candles = intervalFactor > 1 ? resampleCandles(rawCandles, { factor: intervalFactor }) : rawCandles;
        const world = worldFromCandles(candles, { maxBars });
        if (world.closes.length < trainSize + testSize + 2) {
            throw new Error(`analyze: not enough candles in ${f} (${world.closes.length}) for train=${trainSize} + test=${testSize}` +
                (intervalFactor > 1 ? ` after resampling by ${intervalFactor}` : ''));
        }
        const folds = walkForwardSplit({ n: world.closes.length, trainSize, testSize });
        if (!folds.length) throw new Error(`analyze: the walk-forward split produced no folds for ${f}`);
        // A full-history split would create thousands of folds (and thousands of
        // model fits). Bound it so the CLI stays usable; pass --bars to widen.
        if (folds.length > 200) {
            throw new Error(`analyze: ${folds.length} folds from ${world.closes.length} candles is too many for one run; pass --bars=<n> (e.g. ${(trainSize + testSize) * 20})`);
        }
        worlds.push({
            label: inputLabels[ii],
            file: f,
            candles: world.candles.length,
            returns: world.returns,
            folds,
            viewFor: makeCandleViewFor(world.candles),
            // The raw candle series, for a worker-backed fold executor (R26-4): the
            // worker rebuilds the same view from it. Reporting uses the `candles`
            // count above, so this field is internal to the driver.
            candleData: world.candles,
        });
    }

    // Round 26 (R26-6): measure the basket's effective independence (Kish 1965
    // design effect over the streams' own returns) and, when asked, keep only the
    // most diversifying streams — greedy by marginal effective bars per raw bar
    // (Grinold 1989 breadth; the cost law is `time ~= pooledBars x folds-per-stream`,
    // so a redundant stream is pure cost). A DESIGN choice: it changes which streams
    // are pooled, never how an included stream is scored.
    const streamSeriesByLabel = {};
    for (const w of worlds) streamSeriesByLabel[w.label] = w.returns;
    const streamSelectionCandidates = (streamSelectEnabled && worlds.length >= 1)
        ? runStreamSelection({ seriesByLabel: streamSeriesByLabel, maxStreams: Infinity, foldLength: testSize, periodsPerYear: 252 })
        : null;
    if (streamSelectKeep != null && streamSelectionCandidates && streamSelectionCandidates.available && streamSelectionCandidates.order.length) {
        const keep = new Set(streamSelectionCandidates.order.slice(0, streamSelectKeep));
        worlds = worlds.filter((w) => keep.has(w.label));
        if (!worlds.length) throw new Error('analyze: --select-streams kept no streams');
    }
    // The kept basket's own design effect (the "after" half of the report). Null
    // when selection was off or there is a single stream.
    const streamSelection = streamSelectionCandidates
        ? {
            ...streamSelectionCandidates,
            keep: streamSelectKeep,
            kept: worlds.map((w) => w.label),
            keptDesignEffect: worlds.length >= 1
                ? designEffectOfStreams(
                    Object.fromEntries(worlds.map((w) => [w.label, w.returns])),
                    { foldLength: testSize, periodsPerYear: 252 },
                )
                : null,
        }
        : null;

    const variants = variantIds
        ? ['baseline', ...variantIds.filter((id) => id !== 'baseline')].map(resolveVariant)
        : [
            ...VARIANTS.filter((v) => !v.controllerScoped || useController),
            ...SIGNAL_VARIANTS,
            // Round 26 (R26-11): the opt-in label variants, appended only when asked
            // for (a label change is a training-set change; it must never be silent).
            ...(labelPolicies && useController ? LABEL_VARIANTS : []),
        ];

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
            probe, auditProbesPerFold, requireReachable, reuseBase, minTrainingSteps,
            costBps, modelRetention, foldLog,
            saveInterval: Number.isFinite(saveInterval) ? saveInterval : 'inf',
            labelPolicy,
            labelHorizonBars: Number.isFinite(labelHorizonBars) ? labelHorizonBars : null,
            labelPolicies: !!labelPolicies,
            concurrency: width,
            intervalBars: intervalFactor,
            streamSelect: streamSelectKeep != null ? streamSelectKeep : streamSelectEnabled,
            commonRandomNumbers: crn,
            forecast: forecastEnabled,
            decision: decision !== false,
            gate: gateMode, gateAlpha: gateAlphaResolved, costLadder: ladderLevels.slice(),
            turnoverSweep: turnoverEnabled,
            turnoverTarget: turnoverEnabled ? turnoverTargetBps : null,
            trials: variants.length,
            positionPolicy: useController ? POSITION_POLICY : null,
            node: process.version,
        });
    }

    // ---- live state: counters, heartbeat file, stdout line, fold journal -----
    const counters = {
        score: 0, base: 0, probe: 0, events: 0, eventsTotal,
        variantsDone: 0, variantsTotal: variants.length,
    };
    // Round 26 (R26-2): the per-variant model-diagnostics accumulator, filled by
    // every fold's `stats()` as the A/B runs. Populated before a variant's
    // `onVariant` fires (all its folds are done), so the report rows built there
    // carry complete diagnostics.
    const modelStats = new Map();
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
    const reportProgress = (force = false, note = '', extra = null) => {
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
        if (force && runDir) appendLog(runDir, 'info', 'progress', { ...counters, phase: state.phase, variantId: state.variantId, ...(extra || {}) });
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
        // R27-5: the config echo is in the FIRST checkpoint, so a kill-and-recover
        // reader never has to guess the run's design (gate, K, throttle, label,
        // concurrency, resampling, CRN, selection, sweep toggles).
        gate: gateMode, gateAlpha: gateAlphaResolved, gateOptions: { ...gateOptions },
        costLadder: ladderLevels.slice(),
        trials: variants.length,
        saveInterval: Number.isFinite(saveInterval) ? saveInterval : 'inf',
        labelPolicy,
        labelHorizonBars: Number.isFinite(labelHorizonBars) ? labelHorizonBars : null,
        concurrency: width,
        intervalBars: intervalFactor,
        commonRandomNumbers: crn,
        streamSelection: streamSelection ? { keep: streamSelectKeep, kept: streamSelection.kept } : null,
        turnoverSweep: turnoverEnabled,
        forecast: forecastEnabled,
        decision: decision !== false,
        minTrainingSteps,
        policyRoundTrip: null,
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
        reader: 'live checkpoint, rewritten after every variant. status: running|complete|failed. Row shapes match report.json. `timings` carries each finished variant\'s wall time, so a running eval can be sized from the checkpoint alone. The measured cost law is `time ~= k * streams * passes * modelVariants * sum_f(testStart_f)` with `k ~= 0.036 s` per history bar replayed, because a model fit warms up by replaying ALL history up to the fold (`analyze.js` fit) - the run is O(n^2) per stream, not linear in bars, so doubling a stream\'s history roughly quadruples its cost (`OPTIMIZATION.md`, `BUGS.md` #31). On status=failed, candidates[] holds every variant that finished and folds.jsonl holds every completed pass, so the science is not lost with the process.',
        ...extra,
    });
    const checkpoint = (status, extra) => {
        if (!runDir) return;
        try { writeJsonAtomic(runDir, 'partial-report.json', partialReport(status, extra)); } catch { /* never fail the run on a checkpoint */ }
    };
    const onVariant = (event) => {
        const entry = event.entry;
        roster.push(variantRosterRow(entry, modelStats));
        if (event.role === 'baseline') {
            baselineBlock = baselineRow({ baseline: entry.report, baselineVariant: entry.variant }, modelStats);
        } else {
            candidateRows.push(candidateRow(entry, event.decision, null, modelStats));
        }
        // Per-variant wall time (round 25, observability). The cost is NOT a fixed
        // per-fit number: `fit()` replays all history through `getSignal` to warm
        // the online controller, so cost/fold grows with the fold index and a run
        // is O(n^2) per stream. Measured: 0.035 s per warm-up call, i.e.
        // `0.035 * sum_f(testStart_f) * streams * passes * mechanismVariants`
        // (docs/RUN-ANALYSIS.md section 4, docs/OPTIMIZATION.md round 25b).
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
              `${Number.isFinite(entry.elapsedMs) ? ` in ${fmtClock(entry.elapsedMs)}` : ''}`,
            // R27-5: the variant checkpoint in run.log names the variant's KIND and
            // its wall time, so a long run's log is self-describing.
            {
                variantId: entry.variant.id,
                kind: entry.variant.kind || 'mechanism',
                role: event.role,
                elapsedMs: Number.isFinite(entry.elapsedMs) ? entry.elapsedMs : null,
                promote: event.decision ? !!event.decision.promote : null,
            });
    };

    const positionPolicy = useController ? POSITION_POLICY : IDENTITY_POSITION_POLICY;
    // Round 26 (R26-2): pool every fold's model diagnostics per variant. The
    // in-process path feeds this from `makeSignalForVariant`'s `onStats`; the
    // parallel path feeds it from the worker's reported `stats` (R26-4).
    const accumulateStats = (variant, s) => {
        const acc = modelStats.get(variant.id) || emptyModelAccumulator(minTrainingSteps);
        mergeModelStats(acc, s);
        modelStats.set(variant.id, acc);
    };
    const factory = useController
        ? makeControllerModelFactory({ HiveMind, HiveMindController, stateDir: modelRoot, seed, modelRetention, saveInterval, labelPolicy, labelHorizonBars, commonRandomNumbers: crn })
        : makeHiveMindModelFactory({ HiveMind, stateDir: modelRoot, seed, modelRetention, commonRandomNumbers: crn });
    const signalForVariant = makeSignalForVariant(factory, {
        // Round 26 (R26-3): ONE confidence->position policy for both families.
        positionPolicy,
        onStats: accumulateStats,
    });

    // Round 26 (R26-4): with `concurrency > 1` each fold-pass is dispatched to a
    // worker that reconstructs the same signal function from the same data, so the
    // positions/confidence/stats are bit-identical and only wall time moves.
    let foldExecutorFor = null;
    if (width > 1) {
        // Resolve the worker URL only when we must spawn it (a caller-supplied
        // `spawnWorker` — the tests — ignores it, and `import.meta.url` is not
        // resolvable in every environment the analysis layer is imported into).
        const workerUrl = spawnWorker ? null : new URL('./analysis/fold_worker.js', import.meta.url);
        const dispatcher = makeNodeFoldDispatcher({ url: workerUrl, spawn: spawnWorker });
        foldExecutorFor = (variant, si, s) => makeFoldExecutor({
            dispatch: (ctx) => dispatcher({
                variantId: variant.id, model: modelPath, streamIndex: si, foldIndex: ctx.index,
                seed, stateDir: modelRoot, modelRetention,
                cacheSize: CONTROLLER_MODEL.cacheSize, ensembleSize: CONTROLLER_MODEL.ensembleSize,
                tier: CONTROLLER_MODEL.tier, warmup: CONTROLLER_MODEL.warmup,
                positionPolicy, saveInterval, labelPolicy, labelHorizonBars,
                commonRandomNumbers: crn,
                len: FEATURE_LEN, leaky: false,
                returns: s.returns, candles: s.candleData || null,
                train: ctx.train, test: ctx.test,
            }),
        });
    }

    state.phase = 'evaluating';
    checkpoint('running');
    reportProgress(true, `starting ${variants.length} variants x ${foldsTotal} folds x ${worlds.length} stream(s)${width > 1 ? ` @ concurrency ${width}` : ''}`);

    const t0 = performance.now();
    let result = null;
    let evaluationError = null;
    try {
        result = width > 1
            ? await evaluateABAsync({
                worlds, variants, signalForVariant, foldExecutorFor, onModelStats: accumulateStats, concurrency: width,
                costBps, audit, alpha,
                probe, auditProbesPerFold, model: modelPath, requireReachable, auditReuseBase: reuseBase,
                gateOptions,
                onEvent, onVariant,
            })
            : evaluateAB({
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
        ? {
            spaPValue: result.search.spaPValue,
            best: result.search.bestLabel,
            rejected: result.search.rejectedLabels,
            K: result.search.K,
            T: result.search.T,
            ...(result.search.skipped ? { skipped: true, reason: result.search.reason } : {}),
        }
        : (result.search || null);
    // Round 25: cost ladder + family correlation diagnostic. Both are pure
    // post-processing of the finished reports (no model), so they cannot change
    // the scored numbers — only the amount of the verdict that is stated. R27-1:
    // they cover the ACTIVE candidates only (inactive ones are outside K and the
    // search, so restating a verdict over them would be meaningless).
    const activeCandidates = result.candidates.filter((c) => c.active && c.report && c.report.pooledMetrics);
    const ladderCandidates = activeCandidates.map((c) => ({ ...c.report, id: c.variant.id }));
    const ladder = ladderLevels.length
        ? costLadder({
            baseline: result.baseline,
            candidates: ladderCandidates,
            levels: ladderLevels,
            periodsPerYear: 252,
            trials: result.trials,
            decisionOptions: { requireCleanAudit: audit, ...gateOptions },
        })
        : null;
    const familyCorr = familyCorrelation({
        baseline: result.baseline,
        candidates: activeCandidates.map((c) => c.report),
        periodsPerYear: 252,
    });
    // Round 26 (R26-3): the journaled raw confidence + the scored policy must
    // reproduce the emitted positions byte-for-byte. That is the precondition for
    // treating a dead-zone/scale sweep as pure post-processing, so it is asserted on
    // every real run rather than assumed.
    const policyRoundTrip = verifyPolicyRoundTrip(result.baseline, useController ? POSITION_POLICY : IDENTITY_POSITION_POLICY);

    // Round 26 (R26-14): score the family as forecasters — proper scores (Brier +
    // reliability/resolution/uncertainty, log score), the Diebold–Mariano test of
    // each candidate's per-bar Brier loss against the baseline, and the Hansen–
    // Lunde–Nason Model Confidence Set over the whole family. Pure post-processing
    // of the journaled confidence, so it cannot move a scored number.
    const forecastBlock = forecastEnabled
        ? forecastComparison({
            baseline: result.baseline.foldInputs,
            baselineKind: forecastKindOf(result.baselineVariant),
            baselineId: result.baselineVariant.id,
            candidates: result.candidates
                .filter((c) => c.active && c.report && Array.isArray(c.report.foldInputs))
                .map((c) => ({ id: c.variant.id, kind: forecastKindOf(c.variant), foldInputs: c.report.foldInputs })),
            seed,
        })
        : null;

    // Round 26 (R26-5): the turnover attack. Which no-trade band (dead zone),
    // entry/exit hysteresis and minimum holding period lowers turnover enough to
    // reach a realistic taker cost, restated from the journaled confidence with no
    // model. Pure post-processing, so it cannot move a scored number — it only
    // adds a row per (candidate, policy) to the report.
    const turnover = turnoverEnabled
        ? runTurnoverSweep({
            baseline: result.baseline,
            candidates: ladderCandidates,
            costBps,
            periodsPerYear: 252,
            trials: result.trials,
            decisionOptions: { requireCleanAudit: audit, ...gateOptions },
            targetBps: turnoverTargetBps,
        })
        : null;

    const candidateReportRows = result.candidates.map((c) => candidateRow(c, c.decision, c.search, modelStats));
    // Round 26 (R26-8): the decision-grade report. A pure composition of the blocks
    // above into the six questions the next cycle asks; it computes no new strategy
    // statistic (the concentration readout restates the already-scored folds with the
    // same `strategyReturns` arithmetic, and `nextRun` reads the measured power). The
    // featured candidate is the promoted one if any, else the best by pooled Sharpe.
    let decisionBlock = null;
    if (decision) {
        const promotable = result.candidates
            .map((c, i) => ({ c, row: candidateReportRows[i] }))
            .filter((x) => x.c.active && x.c.report && x.c.report.pooledMetrics);
        const promoted = promotable.find((x) => x.row.promote);
        // Rank by pooled Sharpe, treating a non-finite one as the floor. Using
        // `x || -Infinity` here would misrank an exactly-zero Sharpe as -Infinity,
        // so a zero-Sharpe candidate would lose to a negative one.
        const poolSharpe = (x) => (Number.isFinite(x.c.report.pooledMetrics.netSharpe) ? x.c.report.pooledMetrics.netSharpe : -Infinity);
        const best = promoted || promotable.slice().sort((a, b) => poolSharpe(b) - poolSharpe(a))[0] || null;
        const featured = best ? best.c.report : null;
        const featuredRow = best ? best.row : null;
        const concentration = featured
            ? foldConcentration({ folds: featured.folds, foldInputs: featured.foldInputs, costBps, periodsPerYear: 252 })
            : null;
        const confidence = featured ? confidencePersistence({ foldInputs: featured.foldInputs }) : null;
        const nextRun = nextRunPlan({
            power: (featured && featured.power) || result.baseline.power || null,
            dependence: featuredRow ? featuredRow.dependence : null,
            candidate: featuredRow,
            levels: ladderLevels,
            periodsPerYear: 252,
            durationMs,
            folds: foldsTotal,
            streams: worlds.length,
        });
        // R27-5: the featured row can be a pure signal (no model of its own) while
        // the baseline is a trained controller. Rather than degrade the training
        // question to n/a, report the BASELINE's model diagnostics with an explicit
        // referent, so the answer's owner is never ambiguous.
        const featuredModel = featuredRow ? featuredRow.model : null;
        const baselineModelBlock = summarizeModelStats(modelStats.get(result.baselineVariant.id));
        const modelReferent = (!featuredModel && baselineModelBlock)
            ? { kind: 'baseline', reason: 'the featured row is a pure signal; the referent is the baseline controller' }
            : null;
        decisionBlock = decisionReport({
            model: featuredModel || (modelReferent ? baselineModelBlock : null),
            modelReferent,
            runMeta: {
                gate: gateMode,
                gateOptions,
                labelPolicy,
                labelHorizonBars,
                seed,
                trials: variants.length,
                saveInterval: Number.isFinite(saveInterval) ? saveInterval : 'inf',
            },
            baseline: result.baseline,
            candidate: featuredRow,
            concentration,
            confidence,
            nextRun,
            familyCorrelation: familyCorr,
            familywise,
            costLadder: ladder,
            forecast: forecastBlock,
            replication: null,
            positionPolicy: useController ? POSITION_POLICY : IDENTITY_POSITION_POLICY,
        });
    }

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
        // R26-12: the checkpoint throttle this run used. A number, or 'inf' for
        // "never dump during the run" (the A/B default). It is off the arithmetic
        // path: it changes only when the in-memory ensemble is written to disk.
        saveInterval: Number.isFinite(saveInterval) ? saveInterval : 'inf',
        // Round 26 (R26-11): the label policy this run used, and the triple barrier's
        // horizon (null when unused). A label policy is a training-set change, so
        // which one a run used is part of the result.
        labelPolicy,
        labelHorizonBars: Number.isFinite(labelHorizonBars) ? labelHorizonBars : null,
        // Round 26 (R26-4): the fold loop's in-flight width. Off the arithmetic path
        // — it changes only how many fold-passes ran at once.
        concurrency: width,
        gate: gateMode,
        gateAlpha: gateAlphaResolved,
        gateOptions: { ...gateOptions },
        // R27-1: `trials` is K, the ACTIVE roster every DSR was deflated by — not
        // the requested roster. `trialsRoster` is what was asked for, so the two
        // can never be confused.
        trials: result.trials,
        trialsRoster: result.trialsRoster,
        trialsInactive: result.trialsInactive,
        // R27-1: the liveness certificate per candidate (live/inert/duplicate/
        // not-applicable/skipped) and the mechanism counters behind it.
        liveness: result.liveness,
        inactiveCounts: result.inactiveCounts,
        // R27-5: the floor an `underTrainedFolds` count was measured against.
        minTrainingSteps,
        positionPolicy: useController ? POSITION_POLICY : null,
        // Round 26 (R26-3): the byte-for-byte policy round-trip certificate. A
        // policy sweep is only valid if the journaled confidence reproduces the
        // emitted positions at the scored policy.
        policyRoundTrip,
        power: result.baseline.power || null,
        variants: result.variants.map((entry) => variantRosterRow(entry, modelStats)),
        timings: variantTimings,
        baseline: baselineRow(result, modelStats),
        candidates: candidateReportRows,
        familywise,
        // Round 25: the cost ladder (the whole verdict restated at 0/2/5/10 bps of
        // turnover) and the family-correlation diagnostic. Both are pure
        // post-processing of the finished reports — no model, no re-run — so they
        // cannot move a scored number, only the amount of the verdict that is
        // stated. A verdict that flips across the ladder is a verdict about the
        // cost assumption, not about the strategy.
        costLadder: ladder,
        familyCorrelation: familyCorr,
        // Round 26 (R26-5): the turnover attack. Which dead-zone / entry-exit
        // hysteresis / minimum-holding policy lowers turnover enough to clear a
        // realistic taker cost. Null unless `--turnover-sweep`. A grid of pure
        // post-processing of the journaled confidence (no model), so it cannot
        // move a scored number.
        turnoverSweep: turnover,
        turnoverTargetBps: turnoverEnabled ? turnoverTargetBps : null,
        // Round 26 (R26-6): the bar interval the streams were resampled to, and the
        // measured effective-independence of the basket (Kish 1965 design effect
        // over the streams' returns). Design/diagnostic only — no scored number
        // depends on it.
        intervalBars: intervalFactor,
        streamSelection,
        // Round 26 (R26-13): whether the variant comparison was paired on the
        // random draws (common random numbers). Default true; `false` restores the
        // historical per-variant seed.
        commonRandomNumbers: crn,
        // Round 26 (R26-14): the forecast-comparison block (proper scores per
        // variant, DM vs baseline, and the family Model Confidence Set). Null when
        // disabled. Pure post-processing of the journaled confidence.
        forecast: forecastBlock,
        // Round 26 (R26-8): the decision-grade report. Six blocks (training / edge /
        // concentration / economics / family / nextRun), each answering one question
        // the next cycle asks, with every field a value or an explicit
        // { available:false, reason }. Null when `--decision=0`.
        decisionEnabled: decision !== false,
        decision: decisionBlock,
        progress: { ...counters, phase: 'complete', elapsedMs: durationMs },
        artifacts: runDir
            ? { folds: 'folds.jsonl', log: 'run.log', progress: 'progress.json', partial: 'partial-report.json' }
            : null,
        reader: `canonical verdict. Per candidate: \`promote\` + \`reasons\` + \`pooledMetrics\` (incl. \`grossPnl\` and \`breakEvenCostBps\` = the per-unit-turnover cost in bps at which the gross edge is exactly consumed, so a high-turnover signal can be compared to a low-turnover mechanism on one axis) + \`audit\` (clean/reachable/reachableFolds/probes/viewDiffers/baseReused) + \`search\` (family-wise) + round-25 blocks: \`dependence\` (delete-one-cluster jackknife SE over fold-window clusters, design effect, effective bars, equicorrelation reading; null on a single stream), \`promotionTest\` (paired cluster Sharpe-difference t(C-1) + exact sign test over fold windows) and \`gate\` (which hurdles were APPLIED vs SKIPPED-no-panel). The run-level \`power\` block carries the pooled Sharpe SE/MDE, an \`underpowered\` flag (MDE95 above 1.0: a null verdict that could not detect Sharpe 1 is uninformative) and \`barsToDetect1\`; \`power.seDependent\`/\`mdeSharpeDependent\` are the same numbers under the cluster jackknife. \`trials\` (top-level and per candidate) is K, the searched-roster size every DSR was deflated by. \`timings\` records each variant's wall time; the measured cost law is \`time ~= k * streams * passes * modelVariants * sum_f(testStart_f)\` with \`k ~= 0.036 s\` per history bar replayed (a model fit warms up by replaying all history up to the fold, so per-fold cost grows with the fold index - the run is O(n^2) per stream, not linear in bars). \`costLadder\` restates the entire verdict at each cost level in bps of turnover; \`familyCorrelation\` reports how correlated the candidates' excess returns were (a diagnostic only — the deflated Sharpe deliberately keeps trials=K); \`turnoverSweep\` (null unless \`--turnover-sweep\`) restates the journaled confidence under a dead-zone x entry/exit-hysteresis x minimum-holding grid and names the policy with the highest break-even cost, so the economic ceiling can be attacked offline (no model, no re-run); \`streamSelection\` (null unless \`--select-streams\`) measures the basket's Kish design effect over the streams' own returns and reports the greedy most-diversifying order — with \`keep\` set it also names the kept basket and its design effect — and \`intervalBars\` is the resampling factor every stream was built at (1 = the raw bars). \`commonRandomNumbers\` says whether the variant comparison was paired on the random draws (R26-13 common random numbers; default true). \`folds.jsonl\` holds one line per fold-pass (source: stage=score|base|probe, probeIndex for the probe bar, the pass's bar indices, emitted positions, realised returns and metrics), so the pooled metrics AND the audit can be recomputed offline; \`run.log\` is the event journal; \`progress.json\` is the liveness heartbeat.`,
        summary: formatAnalysis(result, { gate: { mode: gateMode, alpha: gateAlphaResolved }, costLadder: ladder, familyCorrelation: familyCorr, turnoverSweep: turnover, streamSelection, intervalBars: intervalFactor, commonRandomNumbers: crn, forecast: forecastBlock, decision: decisionBlock, model: modelStats }),
    };

    state.phase = 'complete';
    if (runDir) {
        writeReport(runDir, report);
        checkpoint('complete', {
            durationMs,
            familywise: report.familywise,
            gate: report.gate,
            // R27-1/R27-5: the trial accounting, the liveness certificate and the
            // policy round-trip certificate ride along in the final checkpoint too.
            trials: report.trials,
            trialsRoster: report.trialsRoster,
            trialsInactive: report.trialsInactive,
            inactiveCounts: report.inactiveCounts,
            liveness: report.liveness,
            policyRoundTrip: report.policyRoundTrip,
            costLadder: report.costLadder,
            familyCorrelation: report.familyCorrelation,
            timings: report.timings,
            summary: report.summary,
            decision: report.decision,
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

// Round 26 (R26-13): run the A/B under several master seeds and summarize the
// per-variant distribution (mean / IQM / stratified-bootstrap CI / variance
// decomposition) with common random numbers ON, so the variant differences are
// paired on the random draws. A single-seed point estimate is not a family
// decision (Bouthillier et al. 2019; Henderson et al. 2018). Only the first seed
// writes a run directory; the aggregate is written beside it as `replication.json`.
export async function replicateAnalysis({ seeds = [1, 2, 3], writeFiles = true, log = () => {}, ...options } = {}) {
    const list = (Array.isArray(seeds) ? seeds : []).filter((s) => Number.isFinite(s));
    if (!list.length) throw new Error('replicateAnalysis: at least one numeric seed is required');
    const runs = [];
    for (let i = 0; i < list.length; i++) {
        runs.push(await runAnalysis({ ...options, seed: list[i], writeFiles: writeFiles && i === 0, commonRandomNumbers: true, log }));
    }
    const first = runs[0].report;
    const ids = ['baseline', ...first.candidates.map((c) => c.id)];
    const seriesOf = (report, id) => {
        const row = id === 'baseline' ? report.baseline : report.candidates.find((c) => c.id === id);
        return row && Array.isArray(row.foldSharpes) ? row.foldSharpes : [];
    };
    const byVariant = {};
    for (const id of ids) {
        byVariant[id] = seedDistribution({ perSeed: runs.map((r) => ({ seed: r.report.seed, values: seriesOf(r.report, id) })) });
    }
    const replication = {
        seeds: list,
        variants: ids,
        byVariant,
        commonRandomNumbers: true,
        reader: 'per-variant seed distribution over the same fold grid: mean, IQM (Agarwal et al. 2021), stratified-bootstrap CI resampling within each seed stratum, and the seed/fold variance fractions. CRN on => the variant differences are paired on the random draws (Glasserman & Yao 1992); a single seed is not a ranking.',
    };
    if (writeFiles && runs[0].runDir) writeJson(runs[0].runDir, 'replication.json', replication);
    return { runs, replication, runDir: runs[0].runDir || null, durationMs: runs.reduce((a, r) => a + r.durationMs, 0) };
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
    '  --audit-probes=<n>       probe passes per fold (default 1; the audit is the',
    '                           dominant per-fold cost, and one probe per fold is ample)',
    '  --audit=0                skip the look-ahead audit (no promotion is defensible then)',
    '  --reachable=0            disable the behavioural non-vacuity requirement (default:',
    '                           ON — an audit that cannot differ cannot certify a promotion)',
    '  --min-training-steps=<n> floor below which a fold counts as under-trained',
    '                           (default 1; a fold with 0 steps is not-trained, not under-trained)',
    '  --list-variants          print the resolvable variant taxonomy (id/kind/applies-to/',
    '                           default?/applicable-here) and exit',
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
    '  --turnover-sweep         restate the journaled confidence under a no-trade band',
    '                           x entry/exit hysteresis x minimum-holding grid (pure',
    '                           post-processing, no model) and report which policy',
    '                           clears the target taker cost',
    '  --turnover-target=<bps>  break-even cost the turnover attack tries to clear',
    '                           (default 5 bps — the Binance USD-M futures taker fee)',
    '  --interval=<n>           resample every stream by n bars (e.g. 4 = 4h bars from',
    '                           1h data); a genuinely different horizon, not a copy',
    '  --select-streams[=<n>]   measure the basket\'s effective independence (Kish',
    '                           design effect over the streams\' returns) and report',
    '                           the greedy most-diversifying order; with =<n> keep only',
    '                           the first n streams of that order',
    '  --crn=0                  disable common random numbers (R26-13): use the',
    '                           historical per-variant fold seed instead of the paired',
    '                           variant-independent one (default: CRN on)',
    '  --forecast=0             skip the forecast-comparison block (R26-14): the',
    '                           proper scores, the Diebold-Mariano test vs baseline',
    '                           and the family Model Confidence Set (default: on;',
    '                           pure post-processing of the journaled confidence)',
    '  --decision=0             skip the decision-grade report block (R26-8): the',
    '                           six-question composition (training / edge /',
    '                           concentration / economics / family / nextRun); the',
    '                           concentration readout is a leave-one-fold-out Sharpe',
    '                           sweep, so this saves that pass (default: on)',
    '  --seeds=a,b,c            replicate the A/B under several master seeds with CRN and',
    '                           aggregate each variant\'s mean/IQM/stratified-bootstrap CI',
    '                           + seed/fold variance split (writes replication.json',
    '                           beside the first run dir)',
    '  --keep-models            keep each fit\'s SQLite state dir (forensics; large)',
    '  --fold-log=all|score|off what folds.jsonl records (default all)',
    '  --save-interval=<n>      full-state checkpoint every n getSignal calls',
    '                           (default Infinity: the A/B never reads it back;',
    '                           use 1 for the historical per-call dump)',
    '  --label-policy=optimistic|conservative|triple',
    '                           trade-label policy for every controller (default',
    '                           optimistic = the shipped labeler, bit-identical)',
    '  --label-horizon=<n>      time barrier in bars for --label-policy=triple',
    '                           (required for the triple barrier to expire a trade)',
    '  --label-policies         add the opt-in label variants (conservative, triple)',
    '                           to the candidate roster (a training-set change)',
    '  --concurrency=<n>        fold-passes in flight via worker threads (default 1 =',
    '                           serial; > 1 dispatches each fold to a worker — identical',
    '                           arithmetic and folds.jsonl, only wall time moves)',
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
        // R27-2/R27-5: the taxonomy is printable before a run, so the operator can
        // see which variants can reach the scored model (and why not) without
        // starting a multi-minute evaluation.
        if (has('list-variants')) {
            console.log(formatVariantList(listVariants(argOf('model') || 'controller')));
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
        const saveIntervalRaw = argOf('save-interval');
        // Default: no checkpointing during the run (the A/B never reads it back).
        // `--save-interval=1` restores the historical per-call full-state dump.
        const saveInterval = saveIntervalRaw == null
            ? Infinity
            : (/^(inf(inity)?)$/i.test(saveIntervalRaw.trim()) ? Infinity : Number(saveIntervalRaw));
        const options = {
            file: argOf('file') || CONFIG.file,
            files: list('files'),
            symbols: symbols && symbols.length === 1 && symbols[0] === 'all' ? CANDLE_MANIFEST.map((e) => e.symbol) : symbols,
            model: argOf('model') || 'controller',
            trainSize: num('train', 60),
            testSize: num('test', 15),
            maxBars: num('bars', 300),
            seed: num('seed', 1),
            probe: num('probe', DEFAULT_SHOCK.probe),
            auditProbesPerFold: num('audit-probes', 1),
            variantIds: list('variants'),
            audit: argOf('audit') !== '0',
            // R27-9: reachability is ON by default; `--reachable=0` opts out. The
            // historical `--reachable` flag still works (it is a no-op now).
            requireReachable: !/^(0|false)$/i.test(String(argOf('reachable'))),
            minTrainingSteps: num('min-training-steps', 1),
            costBps: num('cost-bps', 0),
            reuseBase: has('reuse-base'),
            gate: argOf('gate') || 'dependence',
            gateAlpha: argOf('gate-alpha') == null ? null : num('gate-alpha', null),
            ...(costLadderLevels === undefined ? {} : { costLadderLevels }),
            turnoverSweep: has('turnover-sweep'),
            turnoverTarget: num('turnover-target', 5),
            intervalBars: num('interval', 1),
            streamSelect: (() => {
                if (!has('select-streams')) return null;
                const raw = argOf('select-streams');
                const n = raw == null ? NaN : Number(raw);
                return Number.isFinite(n) && n > 0 ? n : true;
            })(),
            commonRandomNumbers: !/^(0|false)$/i.test(String(argOf('crn'))),
            forecast: !/^(0|false)$/i.test(String(argOf('forecast'))),
            decision: !/^(0|false)$/i.test(String(argOf('decision'))),
            modelRetention: has('keep-models') ? 'keep' : 'discard',
            foldLog,
            saveInterval,
            labelPolicy: argOf('label-policy') || 'optimistic',
            labelHorizonBars: num('label-horizon', null),
            labelPolicies: has('label-policies'),
            concurrency: num('concurrency', 1),
            progressMs: num('progress-ms', 5000),
            log: (line) => console.log(line),
        };
        const seedList = list('seeds');
        if (seedList) {
            // Round 26 (R26-13): replicate under several master seeds and print each
            // variant's distribution, not a single-seed point estimate.
            const seeds = seedList.map((s) => Number(s)).filter((s) => Number.isFinite(s));
            const { runs, replication, runDir, durationMs } = await replicateAnalysis({ ...options, seeds });
            for (const r of runs) console.log(r.report.summary);
            console.log('');
            for (const [id, dist] of Object.entries(replication.byVariant)) {
                console.log(formatSeedReplication({ label: `seeds ${id}`, dist }));
            }
            console.log(`\nreplicated ${seeds.length} seeds (${seeds.join(',')}) in ${durationMs.toFixed(0)}ms` +
                `${runDir ? ` — aggregate at ${path.join(runDir, 'replication.json')}` : ''}`);
        } else {
            const { runDir, report, durationMs } = await runAnalysis(options);
            console.log(report.summary);
            console.log(`\nanalyzed in ${durationMs.toFixed(0)}ms${runDir ? ` — report at ${path.join(runDir, 'report.json')}` : ''}`);
            if (runDir) {
                console.log('upload: run.json, report.json, run.log (optionally folds.jsonl) — ' +
                    'per-variant checkpoint: partial-report.json, live heartbeat: progress.json. Do not upload models/.');
            }
        }
    } catch (err) {
        console.error('analyze failed:', err && err.stack ? err.stack : err);
        process.exitCode = 1;
    }
}
