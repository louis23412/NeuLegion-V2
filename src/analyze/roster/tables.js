// src/analyze/roster/tables.js (round-99 split of src/analyze/roster.js).
// Variant tables + constants (the roster data).
// A/B roster — variant tables, register contract, guards, policies (round-83 split of src/analyze.js).
// Pure, no I/O. Imported by ./models.js, ./evaluate.js and ./cli.js; re-exported by the analyze.js shim.
import '../../legion/rng.js';
import { SIGNAL_CANDIDATES, REVERSAL_CANDIDATES, SIGUP_CANDIDATES, signalForCandidate } from '../../analysis/features.js';
import { applyGenomeToMind } from './evolved.js';
import { BENCHMARK_KINDS } from '../../analysis/benchmark.js';
import { DEFAULT_ROSTER_IDS } from '../../lineage.js';


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
        note: 'margin-ordered multi-probe LSH (Lv et al. VLDB 2007), maxFlips=2 — LIVE via _multiProbeConfig, which _retrieveTopRelevantProtos reads (C3, lab CYCLE-203); default-off',
        configure: (hm) => { hm._multiProbeConfig = { maxFlips: 2, budget: 8 }; },
        afterFit: null,
        // C6/#71 (BUGS.md #71): scored-live since C3 — same journey as pca-hash (R28/#53).
        appliesTo: 'model',
    },
    {
        id: 'querymod',
        label: 'query-mod',
        note: 'dynamic query modification (arXiv 2605.23807) — centroid re-query — LIVE via _queryModConfig, which _retrieveTopRelevantProtos reads (C3, lab CYCLE-203); default-off',
        configure: (hm) => { hm._queryModConfig = { enabled: true }; },
        afterFit: null,
        // C6/#71 (BUGS.md #71): scored-live since C3 — same journey as pca-hash (R28/#53).
        appliesTo: 'model',
    },
    {
        id: 'pca-hash',
        label: 'pca-hash',
        note: 'data-aware PCA-aligned LSH hyperplanes (BinaryPC arXiv 2608.04405), above-mean rank — LIVE via _refreshLshHyperplanes, which _retrieveTopRelevantProtos reads (R27-2); the round-28 P2 probe shows the retrieved prototype SET is INVARIANT to the basis at every tested pool/budget (80/200/600 prototypes, production + narrow width), though the returned list\'s duplicate multiplicity can differ at production width (lsh.test.js §K, RUN-ANALYSIS.md §14)',
        configure: (hm) => { hm._pcaHashConfig = { seed: 1, iters: 30, tol: 1e-6, minRows: 8, rankPolicy: 'above-mean' }; },
        afterFit: (hm) => { if (typeof hm._refreshLshHyperplanes === 'function') hm._refreshLshHyperplanes(); },
        appliesTo: 'model',
        // R28 (BUGS.md #53): the mechanism IS reachable (the round-26 run measured
        // 6/288 folds differing), and the round-28 P2 probe shows the basis can
        // change the scored reader's OUTPUT (the returned list's duplicate
        // multiplicity, at production width, with equal RNG draw counts — so the
        // change is attributable to the basis, not to stream desync) while the
        // retrieved prototype SET stays invariant at every tested budget. An inert
        // certificate here is therefore a statement about THIS run's prototype pool
        // / probe budget, never about reachability. The reason must say exactly
        // that, or a false structural claim ends up in the report
        // (`RUN-ANALYSIS.md` §13.2).
        inertReason: ({ totalFolds }) =>
            `the PCA-aligned hyperplane refresh ran on the scored mind but changed no emitted position on all ${totalFolds} folds at this run's prototype pool and probe budget — the mechanism is REACHABLE and reaches the scored reader (it changes the returned list's duplicate multiplicity at production width with equal RNG draw counts; 6/288 folds differed on the round-26 8x600 run; the retrieved prototype SET is invariant at every tested budget), so this is a measured behavioural inertness at this budget, not structural unreachability (BUGS.md #53; lsh.test.js §K)`,
    },
]);

// Opt-in controller-scoped mechanism variants: resolvable by id, but deliberately
// NOT part of the default roster. `sample-weights` was removed from the default
// roster in round 27 (R27-3). The round-27 rationale — "on the shipped
// (`optimistic`) labeller every label is one bar long, so no two label spans
// overlap and every weight is 1" — rested on the PRE-#49 `heldBars == 1`
// diagnostic, i.e. on the bug (BUGS.md #58). With #49 fixed the recorded holding
// period is ~8 bars (`heldBars {mean 8.30, max 54}` on `optimistic`), so the
// labels DO overlap; what made the weights all-ones was the ring's ASSUMED SPAN
// HORIZON being configured to 1. R28 gives the ring a causal measured span (or an
// explicit `--sample-weight-horizon`), so the mechanism is now expressible on
// `optimistic` too. It stays resolvable (with a `configure` that enables the
// causal streaming window) so an explicit `--variants=sample-weights` run
// *measures* its effect rather than assuming it away, with the
// `sample-weights-scale-control` arm isolating the emitted-scale (effective-LR)
// change from the uniqueness dispersion (BUGS.md #54).
export const OPT_IN_VARIANTS = Object.freeze([
    {
        id: 'sample-weights',
        label: 'sample-weights',
        note: 'uniqueness loss weighting (AFML ch. 4) — causal streaming window with a MEASURED span and a mean-1 emitted stream (R28); inert only when the assumed spans do not overlap',
        // R28 (BUGS.md #58): the old reason ("the shipped labeller emits one-bar
        // labels, so no two spans overlap") rested on the PRE-#49 `heldBars == 1`
        // diagnostic — i.e. on the bug — and was a false certificate: the round-27
        // runs measure a realized holding period of ~8 bars. What actually makes
        // the weights all 1 is the ASSUMED SPAN HORIZON the ring was configured
        // with, which the mechanism now reports (`horizonBars`/`measureHorizon`).
        // The reason is therefore a function of the measured run context.
        inertReason: ({ modelBlock, baselineModelBlock }) => {
            const sw = modelBlock ? modelBlock.sampleWeights : null;
            const held = baselineModelBlock ? baselineModelBlock.heldBars : null;
            const measured = !!(sw && sw.measureHorizon);
            const cfg = sw && Number.isFinite(sw.horizonBars)
                ? `the causal ring assumed a ${measured ? 'MEASURED (causal EMA of drained holding periods)' : 'FIXED'} span horizon of ${sw.horizonBars} bar${sw.horizonBars === 1 ? '' : 's'}`
                : 'the causal ring assumed a span horizon of 1 bar';
            const w = sw
                ? ` and every emitted weight was exactly 1 over ${sw.count} label(s)`
                : ' and every emitted weight was exactly 1';
            const heldTxt = held && Number.isFinite(held.mean)
                ? `, although this run's REALIZED holding period is mean ${held.mean.toFixed(2)}${Number.isFinite(held.max) ? ` / max ${held.max}` : ''} bars`
                : '';
            // R28 (BUGS.md #58): the causal basis of the all-ones vector differs by
            // how the horizon was obtained. A FIXED horizon of 1 is a *configuration*
            // artefact (the ring was told the labels are one bar long while the run's
            // realized holding period is ~8). A MEASURED horizon that still yields
            // all-ones weights means no two assumed spans overlapped in practice —
            // a real property of this run's trade timing, not of the labeller's name.
            const tail = measured
                ? ` — so no two assumed spans overlapped in this run, even with a measured span horizon (BUGS.md #58)`
                : ` — so the all-ones vector is a property of the ASSUMED horizon, not of the labeller (BUGS.md #58)`;
            return `${cfg}${w}${heldTxt}${tail}`;
        },
        controllerScoped: true,
        appliesTo: 'controller',
        configure: (ctl) => {
            // R28 (BUGS.md #58 / P1c): the span horizon is, in priority order:
            //   1. an explicit `--sample-weight-horizon=<n>`;
            //   2. the run's label horizon when the labeller has a real vertical
            //      barrier (`triple` + label-horizon > 1) — there the label span IS
            //      that horizon;
            //   3. otherwise null = MEASURED (the causal EMA of the holding periods
            //      of the trades drained so far).
            const explicit = Number.isFinite(ctl._sampleWeightHorizon) && ctl._sampleWeightHorizon > 0
                ? Math.floor(ctl._sampleWeightHorizon)
                : null;
            const labelHorizon = Number.isFinite(ctl._labelHorizonBars) && ctl._labelHorizonBars > 1
                ? Math.floor(ctl._labelHorizonBars)
                : null;
            ctl._sampleWeightConfig = {
                mode: 'causal-window',
                windowBars: SAMPLE_WEIGHT_WINDOW_BARS,
                horizonBars: explicit != null ? explicit : labelHorizon,
                normalization: 'mean1',
                emittedNormalization: 'mean1',
            };
        },
        afterFit: null,
    },
    {
        // R28 (P3, arm C): the SCALE-CONTROL arm. It applies the same mechanism to
        // the same spans but emits a CONSTANT weight equal to the running mean of
        // the raw window weight, i.e. it reproduces the learning-rate change with
        // NO dispersion. `sample-weights` (arm A) vs baseline is the mechanism's
        // honest effect; this arm vs baseline is the pure learning-rate effect; the
        // difference between the two is the dispersion the uniqueness weighting
        // actually contributes. Without it, a harmful `sample-weights` verdict
        // cannot be attributed to dispersion rather than to the LR shift (the
        // round-27 Step-3 confound, BUGS.md #54).
        id: 'sample-weights-scale-control',
        label: 'sample-weights:scale-control',
        note: 'the SCALE-ONLY control for `sample-weights`: the same assumed spans, emitted as a constant equal to the running raw mean (no dispersion)',
        controllerScoped: true,
        appliesTo: 'controller',
        configure: (ctl) => {
            const explicit = Number.isFinite(ctl._sampleWeightHorizon) && ctl._sampleWeightHorizon > 0
                ? Math.floor(ctl._sampleWeightHorizon)
                : null;
            const labelHorizon = Number.isFinite(ctl._labelHorizonBars) && ctl._labelHorizonBars > 1
                ? Math.floor(ctl._labelHorizonBars)
                : null;
            ctl._sampleWeightConfig = {
                mode: 'causal-window',
                windowBars: SAMPLE_WEIGHT_WINDOW_BARS,
                horizonBars: explicit != null ? explicit : labelHorizon,
                normalization: 'mean1',
                emittedNormalization: 'scale',
            };
        },
        afterFit: null,
    },
    {
        // B3 (lab CYCLE-224/225): the EVOLVED-READOUT arm. Carries an optional
        // `genome` (`{ members: [{ w, b }] }`, see `./evolved.js`); `afterFit`
        // writes it into each member's linear readout AFTER training, so the
        // transformer body trains exactly as stock and only the readout is
        // evolved (Lamarckian seeding). With `genome: null` (the registered
        // default) `afterFit` is a no-op and the arm is bit-identical to the
        // baseline — a driver injects genomes per candidate on a CLONE
        // (`{...resolveVariant('evolved-readout'), genome}`), never on the
        // frozen table object, and evaluates each genome on a FRESH mind
        // (predict is stateful — lab CYCLE-225 — so genomes are never scored
        // sequentially on one live mind).
        id: 'evolved-readout',
        label: 'evolved:readout',
        note: 'B3 evolved per-member linear readout (lab CYCLE-224): null genome = stock bit-identical; a driver-supplied genome replaces outputWeights/outputBias post-training',
        appliesTo: 'model',
        genome: null,
        configure: null,
        afterFit(mind) {
            if (this.genome != null) applyGenomeToMind(mind, this.genome);
        },
    },
]);

// The causal signal family (ROADMAP N1) as A/B candidates: the proven pure
// features from `analysis/features.js`, each carrying the `signal(view, test)`
// the driver evaluates. They share the ONE family-wise gate and the one baseline,
// so the multiple-testing correction covers the whole searched universe.
export const SIGNAL_VARIANTS = Object.freeze(
    SIGNAL_CANDIDATES.map((c) => ({ ...c, signal: signalForCandidate(c), appliesTo: 'agnostic' })),
);

// P3 (round 29 -> 30): the short-horizon reversal family as opt-in A/B
// candidates. Same contract as `SIGNAL_VARIANTS` (a pure `signal(view, test)` under
// the one family-wise gate), but resolved only by id so a default run's roster and
// `K` are unchanged. `sig:reversal-xs` reads the cross-section through
// `view.panel`, which the driver attaches per stream.
export const REVERSAL_VARIANTS = Object.freeze(
    REVERSAL_CANDIDATES.map((c) => ({ ...c, signal: signalForCandidate(c), appliesTo: 'agnostic' })),
);

// Round 30 (C-SIGUP / C-REGIME, gate G-H): the pre-registered momentum-upgrade
// candidates from `analysis/features.js#SIGUP_CANDIDATES` (vol-scaled, multi-horizon
// blended, network/lead-lag and regime-gated momentum). Same contract as
// `SIGNAL_VARIANTS` (a pure `signal(view, test)` under the one family-wise gate),
// but resolved only by id (`--variants=sig-vol-momentum,...`) so a default run's
// roster and `K` are unchanged. `sig-network-momentum` reads the cross-section
// through `view.panel`, so the driver reports it `not-applicable` on a
// single-stream run (`BUGS.md` #70).
export const SIGUP_VARIANTS = Object.freeze(
    SIGUP_CANDIDATES.map((c) => ({ ...c, signal: signalForCandidate(c), appliesTo: 'agnostic' })),
);

// Round 30 (PLAN-round30.md section 2): the PRE-REGISTERED default A/B roster.
// The searched universe (`RESOLVABLE_VARIANTS`) is unchanged — every dropped
// branch is still resolvable by id for reproducibility — but the default roster
// is pruned to the arms the acceptance batch showed can plausibly clear the gate.
// That shrinks `K` (the deflated-Sharpe search size), the cheapest honest lever
// available; `DROPPED.md` records the measurement that killed each drop and
// `src/lineage.js#DEFAULT_ROSTER_IDS` is the register's code contract. The roster
// is pinned by `rosterSnapshot()` in analyze.test.js so a silent re-add fails.
export const ALL_VARIANTS = Object.freeze(
    [...VARIANTS, ...SIGNAL_VARIANTS].filter((v) => DEFAULT_ROSTER_IDS.includes(v.id)),
);

// P1 (round 29 → 30): the model-class benchmark forecasters. Each is an opt-in
// A/B candidate whose `fit/predict` is a base-rate / ridge / MLP forecaster over
// the SAME causal `featureVector` the bare path uses, run on the SAME walk-forward
// folds — so a promotion (or a failure) here is a statement about the model class,
// not about different inputs. They are deliberately NOT in the default roster: a
// benchmark run changes K and the family, so it is opt-in
// (`--variants=bench-base-rate,bench-linear,bench-mlp`). `kind:'benchmark'` marks
// them; `forecastKindOf` puts them in the probability-calibrated group beside the
// controller so the Model Confidence Set compares them.
export const BENCHMARK_VARIANTS = Object.freeze(
    BENCHMARK_KINDS.filter((k) => k !== 'tsfm').map((k) => ({
        id: `bench-${k}`,
        label: `bench:${k}`,
        kind: 'benchmark',
        benchmark: k,
        appliesTo: 'agnostic',
        note: k === 'base-rate'
            ? 'the training fold\'s outcome frequency, for every bar (the reference a skilful forecaster must beat)'
            : (k === 'linear'
                ? 'ridge regression on the same causal feature vector (DLinear-class; the model-class literature\'s default winner on TS)'
                : 'one-hidden-layer tanh MLP on the same causal feature vector (a generic nonlinear approximator, not a from-scratch transformer)'),
    })),
);

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
// variants (`sample-weights`), the opt-in label variants, the P1 benchmark
// forecasters, the P3 short-horizon reversal family and the round-30 momentum
// upgrades. `resolveVariant` searches
// this (so `--variants=label-triple` / `--variants=sample-weights` /
// `--variants=sig-reversal` / `--variants=sig-vol-momentum` work), while the
// default roster stays the lean family (variantRoster below).
export const RESOLVABLE_VARIANTS = Object.freeze([...VARIANTS, ...SIGNAL_VARIANTS, ...OPT_IN_VARIANTS, ...LABEL_VARIANTS, ...BENCHMARK_VARIANTS, ...REVERSAL_VARIANTS, ...SIGUP_VARIANTS]);

// Round 30: the default roster as a content-hashed snapshot. The pin lives in
// analyze.test.js, so a future edit that silently re-adds a dropped branch (or
// reorders the roster) fails a test instead of moving every deflated Sharpe. The
// hash is the stable FNV-1a of the id list (the same primitive `legion/rng.js`
// uses for worker sub-seeds), so it is portable across the browser and node runs.
