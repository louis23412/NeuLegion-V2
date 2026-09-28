# NeuLegion — architecture audit & V2 blueprint

**Status: PARTIALLY IMPLEMENTED — V2.0/V2.1/V2.2 landed.** Authored 2026-09-28 from an end-to-end read of the shipped project
(`src/NeuLegion-master/NeuLegion-master`), its documentation set (`DESIGN.md`, `COMPONENTS.md`,
`CITATIONS.md`, `src/README.md`, `research/*`), the lab (`src/NeuLegion-lab`, F-01…F-81, 66 cycles,
19 leads) and `PLAN-round31.md`. **Implemented since:** the V2.0 contract/registry layer, the V2.1
primitive port and the V2.2 sleeves/risk/books plugins (`MIGRATION-V2.md` — full browser suite
**2753/0** (2741 at the V2 landing + the 12-check round-32 R2/R3 ports), `golden` 23/0 unmoved, zero edits to any pre-existing (legacy) locked module — the V2
modules' own bug/coherence passes are RUNBOOK §6 R31b/R31c, and they too moved no golden; the port is verified
bit-for-bit on the lab's real data by `e73_port_verify.js`, lab F-81). **Not started:** V2.3 (model plugins) and
V2.4 (lab v2). This document answers three questions the
operator asked together:

1. **Which parts of the system are "old" designs vs cutting-edge proven ones?** (§2)
2. **Which components / core features can be made modular — the *whole* system, not just memory?** (§3)
3. **Should we start a from-the-ground-up NeuLegionV2 + Lab v2?** (§4–§6)

---

## 0. Verdict in one page

**The proposal: partial accept.** Accept the *goal* (a genuinely modular V2, a lab that shares its
vocabulary, research separated from architecture). **Deny the blank-slate rewrite of the two things
that are already world-class:** the measurement harness and the evidence base. The V2 should be
built **contract-first and extraction-based** ("carve, don't rewrite"):

- **V2 = a new architecture** — the interface/registry layer, the pure engine, and the layered repo
  layout. That part is greenfield.
- **The harness, the data layer, the signal/label math, the memory-support math and the observer
  carry over behind the new contracts** — module by module, proven byte-identical at each step.
- **Only the model core is genuinely rebuilt** — because it is the part the project's own evidence
  says is inert *and* the part whose whole-engine lock is the modularity blocker. Even it ships as a
  `legacy-hivemind` plugin so its 11 golden fingerprints are never lost. **Framing note (`A5′`,
  §4.5): this is a *research* deliverable, not the revenue path — the product is the sleeve book +
  the gate.**
- **Lab v2 = the same contracts + a runner.** Its 81 findings, 19 leads, THEORY joints and the
  `e52` port artefact **port as data**, because they are the reason to trust any number.

The audit's central finding, and the reason for that shape: **the project's oldest, least-proven
part is the product (a 1988-era associative memory + a 2017-era tiny transformer fed 1970s
indicators), and its newest, most rigorously proven part is the measurement layer.** A rewrite that
throws away the measurement layer and keeps the model would be exactly backwards.

---

## 1. Method & scope

- **Old vs cutting-edge** is judged by design lineage (the published technique the code implements)
  and by **measured status in *this* project** (the lab's ledger, the lock registry, the A/B runs).
  A component is "cutting-edge proved" only if it is both recent *and* validated here or by a
  peer-reviewed/long-replicated result; "proven-modern" = a settled technique used correctly;
  "old" = a pre-deep-learning lineage that the evidence says is not carrying the result.
- **Modularity** is judged on four axes, not on "is it in its own file":
  **separable** (no hidden globals), **injectable** (takes its inputs, does not read `this`),
  **substitutable** (can be swapped without editing the engine), **isolation-testable** (has a test
  that runs it alone). File-splitting gives separability at best.
- **Citations** are the project's own (`docs/CITATIONS.md`); the raw sweeps are in
  `docs/research/raw/`.

---

## 2. Component inventory — old vs cutting-edge

`V` = design vintage · `verdict` ∈ {**old**, **proven-modern**, **cutting-edge-proved**,
**cutting-edge-untested**, **missing**}.

### 2.1 The product layer (what the project ships as "the bot")

| subsystem | what is actually shipped | V | verdict | measured here | call |
| --- | --- | --- | --- | --- | --- |
| **Indicator processor** `hivemind/indicatorProcessor.js` | 10 classic TA series: RSI, MACD-diff, ATR, EMA100, stochastic-diff, Bollinger %B, OBV, ADX, CCI, Williams %R | 1960s–80s TA | **old** | feeds the inert vector (NL-BENCH) | replaceable `Feature` plugin |
| **Controller features** `controller/features.js` | percentile/MAD-normalised indicator windows + quality-sorted prototype interleave | TA + robust scaling | **old** | features, not architecture, are the constraint (G-A) | replaceable `Feature` plugin |
| **HiveMind transformer** `transformer/*`, `kernels/*` | MHA + gated FFN (SiLU) + RMSNorm(2) + RoPE, mean-pool, linear head; tiny (`hidden` ~ tens) | 2017–2021 (Vaswani / Shazeer / Zhang–Sennrich / Su) | **proven-modern, mis-sized** | no class beats the base rate | keep as `legacy-hivemind` plugin |
| **Training** `training/gradients.js`, `distillation.js` | manual backprop, grad accumulation, apply→distill→rollback, EMA/decay LR, Hinton distillation | 2015–2018 | **old** | the learner is a passenger | fold into the learner plugin |
| **Memory banks** `memory/{banks,protos,replay,consolidation}.js` | prototype memory (mean+var+size+importance+access), capacity trim/prune, generative replay, semantic merge/split | Kanerva 1988 / Hopfield 2000s / kNN-LM | **old core** | surprise/homeostasis/pca-hash ≈ baseline (NL-MECH) | rebuild as `MemoryBank` plugins |
| **LSH index** `memory/lsh.js` | data-independent random-hyperplane SimHash, multi-set/multi-table, bit masks | Charikar 2002 | **old** | recall contract exact; prefix-4 probe collapses at prod width | keep behind the bank contract |
| **Ensemble/evolution** `ensemble/{hiveState,scores}.js` | performance/agreement/trust scores, Dirichlet sampling, adaptive per-member LR, specialization broadcast | 1990s–2016 ensemble heuristics, ad-hoc | **proven-modern, ad-hoc** | 4 mechanisms ≈ baseline | rebuild as `Ensemble` plugins |
| **Labels** `analysis/labels.js` (opt-in) | triple-barrier, CUSUM events, fractional differentiation | López de Prado 2018 | **proven-modern** | policy effect did not replicate | `Labeler` plugin |
| **Risk / portfolio** | *nothing* — a fixed ±1 `clampPosition` + a dead zone; no book, no vol target, no sleeve combination | — | **missing** | J5; the project cannot hold its only positive result | **new `RiskPolicy` + `Sleeve` layers** |

### 2.2 The research leads bolted onto the product (default-off)

These are the genuinely new (2007–2026) techniques the project has already implemented — but all are
default-off, and the measured ones are inert or off the scored path.

| subsystem | technique | V | verdict | measured here | call |
| --- | --- | --- | --- | --- | --- |
| `memory/surprise.js` | Titans surprise-gated writes (2501.00663) | 2025 | **cutting-edge-untested** | ≈ baseline (net +0.098→−0.028) | `MemoryBank` plugin |
| `memory/multiprobe.js` | margin-ordered multi-probe LSH (Lv 2007) + query-adaptive budget (NeuRoute 2608.15438, adaptive-bucket 2604.04603) | 2007 + 2026 | **cutting-edge-proved** (as math) | self-recall 0.03→0.30 at σ=0.25; **off the scored path** | index plugin, not a score arm |
| `memory/binarypc.js` + `bitweight.js` | BinaryPC data-aware hashing (2608.04405), Andoni–Indyk–Laarhoven optimality (1501.01062), bit-reliability / weighted Hamming (2009.08591) | 2015–2026 | **cutting-edge-proved** (as math) | pca-hash behaviourally inert | index plugin |
| `memory/querymod.js` | dynamic query modification (2605.23807) | 2026 | **cutting-edge-untested** | off the scored path | index plugin |
| `ensemble/homeostasis.js` | homeostatic plasticity (Turrigiano; 2609.13771) | 2026 | **cutting-edge-untested** | negative (−0.163) | ensemble plugin |
| `legion/evolve.js` | low-rank evolution strategies (EGGROLL 2609.10980) | 2026 | **cutting-edge-untested** | proven invariant, **nothing imports it** | learner plugin |

### 2.3 The measurement & systems layer (the actual asset)

| subsystem | what is shipped | V | verdict | measured here | call |
| --- | --- | --- | --- | --- | --- |
| **Honest gate** `analysis/*` (21 modules) | purged CV, no-lookahead audit (`world.js`), DSR/PSR/MinTRL, PBO/CSCV, White RC + Hansen SPA + Romano–Wolf step-down, blocked/subsampling bootstraps, Politis–White block length, lugsail-aware LRV, cluster jackknife + paired cluster-t + exact sign test, Kish design effect / effective streams, Diebold–Mariano + Model Confidence Set, stratified bootstrap + CRN, cost ladder + break-even, decision report | 1989–2026 | **cutting-edge-proved** — the most modern, best-validated part of the project | independently re-validated by the lab (F-62, e54–e69), incl. a 2026 production study (MinervaScore 2608.23808) | **port wholesale**, do not retype |
| **Data integrity** `candles_audit.js`, `candle_quality.js`, `fetch_candles.js`, `funding_fetcher.js`, manifests | pure auditor, winsorizer, byte-exact JSONL round-trips, offset budget | 2024–2026 discipline | **proven-modern** | manifests audited clean | **port wholesale** |
| **Observer** `observer/*` | Brier + Murphy reliability/resolution, CUSUM drift, Cohen's κ, Gini/HHI concentration, EWMA series, alerts | 1950–2000 | **proven-modern** | additive; wired via `state.onBatchSnapshot` | **port** (already a real observer seam) |
| **Legion** `legion/*` | SQLite vault, hierarchical aggregation, worker pool, HTTP/SSE monitor, sanitize/rng determinism guards | systems engineering | **solid, over-engineered** | works; DB opens at module-eval | **re-host** behind the engine, lighter |
| **A/B driver** `analyze.js` (200 KB) | variant registry, injected `signalForVariant`/model factory, fold journal, async twins, parallel folds | 2026 harness | **proven-modern** | the one real plugin seam | **generalize into the V2 registry** |

### 2.4 The one-sentence reading

**The model stack is a 1988–2021 design wearing six 2025–26 research patches, measured inert on its
target; the measurement stack is a 2026 front-runner, independently validated.** That asymmetry is
the whole case for the V2 shape: keep the modern part, rebuild the old part, and stop pretending the
old part is the product.

---

## 3. Modularity audit — the whole system

### 3.1 What is already genuinely modular (real seams to build on)

| seam | why it is real | reuse in V2 |
| --- | --- | --- |
| `analyze.js` `VARIANTS` + `signalForVariant` injection | a candidate is one `{id, note, configure(hm), afterFit(hm), appliesTo}` object; the engine is injected, not imported | **the registry pattern** |
| `analysis/features.js` (`SIGNAL_CANDIDATES`/`REVERSAL_*`/`SIGUP_*`) | pure, causal, selected by id, no engine import | `Feature` plugins as-is |
| `analysis/labels.js` | pure labeler, test-only today | `Labeler` plugins as-is |
| `analysis/*` (gate) | all pure; none import the hot path | `Evaluator` plugins as-is |
| `memory/{surprise,multiprobe,binarypc,bitweight,querymod}.js` | pure functions + a `resolveXConfig` + a `golden no-op` default | **the model for every plugin**: config-resolved, default-off, own test |
| `lineage.js#DEFAULT_ROSTER_IDS` + `rosterSnapshot()` | a pre-registered, content-hashed roster with a regression pin | the roster contract |
| `observer` via `state.onBatchSnapshot` | the engine calls a hook *only if something registered one* | the engine's event seam |
| `legion/sanitize.js` + `legion/rng.js` | exception-path guards + a seeded PRNG injected at the boundary | the engine's determinism seam |

### 3.2 What only *looks* modular (file-split ≠ interface-split)

`COMPONENTS.md` is explicit: the 22 HiveMind bags and 5 controller bags are **prototype mixins** —
every method runs with a `HiveMind` instance as `this` and reads/writes the same `_`-prefixed state.
The split is **behavioural/navigational**, explicitly *not* composed objects ("passing a state bag
around would rewrite every field access"). So:

- swapping a memory bank means editing the bag **and** `component-manifest.js` **and**
  `lock-registry.js` (138 KB) **and** re-freezing the whole-engine goldens;
- `_updateHiveState` (`ensemble/hiveState.js`) is the god function: per-member forward → retrieval →
  memory write/decay → ensemble readout all funnel through it, so a memory plugin cannot be tested
  without the ensemble, and vice versa;
- `persistence/{save,load}.js` + `dimensions.js` pin the exact bank layout and SQLite schema, so a
  bank swap is also a schema change;
- `legion/database.js` opens its DBs at **module-eval time**, so importing the legion has a side
  effect; the legion's mutable state lives in a shared holder (`legion/state.js`).

### 3.3 The #1 modularity blocker: the lock model

`DESIGN.md` §3: the 17 HiveMind bags are **bit-exact** against 11 golden fingerprints. `COMPONENTS.md`
rule 4: *"Don't touch the hot math."* The consequence is that **the very experiment the design exists
for — try a different memory/ensemble — is economically forbidden**: it is a whole-engine re-freeze.
The lock registry is a strength (it is why defects were caught) but as a *modularity* mechanism it is
monolithic. The V2 lock must be **per-plugin golden; engine = compose**, so adding/removing a
non-default plugin moves no existing fingerprint.

### 3.4 Modularity scorecard

`S` separable (no hidden global) · `I` injectable (inputs, not `this`) · `X` substitutable (swap with
no engine edit) · `T` isolation-testable.

| subsystem | S | I | X | T | verdict |
| --- | :-: | :-: | :-: | :-: | --- |
| `analysis/*` gate | ✅ | ✅ | ✅ | ✅ | **already a plugin library** |
| `analysis/features.js` signals | ✅ | ✅ | ✅ | ✅ | **already plugins** |
| `analysis/labels.js` | ✅ | ✅ | ✅ | ✅ | **already a plugin** |
| `analysis/carry.js` + `benchmark.js` | ✅ | ✅ | ✅ | ✅ | **already plugins** |
| `memory/{surprise,multiprobe,binarypc,bitweight,querymod}` | ✅ | ✅ | ✅* | ✅ | pure math; *not yet *swappable*, because nothing selects them |
| `observer/*` | ✅ | ✅ | ✅ | ✅ | real observer seam |
| `candles_audit` / `candle_quality` / fetchers | ✅ | ✅ | ✅ | ✅ | port as-is |
| `hivemind/kernels/*` | ✅ | ❌ (`this`) | ❌ | ✅ | file-split only |
| `transformer/*` | ✅ | ❌ | ❌ | 〜 | file-split only |
| `memory/{banks,protos,replay,consolidation,lsh}` | ✅ | ❌ | ❌ | ❌ | **the coupled core** |
| `ensemble/*` | ✅ | ❌ | ❌ | 〜 | coupled via `_updateHiveState` |
| `controller/*` | ✅ | ❌ | ❌ | ✅ | coupled via `this._` |
| `legion/*` | ❌ (module-eval DB, global state) | ❌ | ❌ | 〜 | over-coupled, re-host |
| `analyze.js` | ✅ (pure core) | ✅ | 〜 (one `VARIANTS` list) | ✅ | generalize the registry |

**Reading.** Everything that *measures* or *derives a series* is already plugin-shaped. Everything
that *is the model* (banks, transformer, ensemble, controller) is file-split but interface-coupled,
and the lock model freezes it whole. So the modularization work is concentrated exactly where the V2
rewrite is: the model core — and that is also the part the evidence says is inert.

---

## 4. The V2 architecture (contract-first)

### 4.1 Repo layout

```
neulegion/
  core/
    contracts/           # pure interfaces + capability tags, ZERO deps
      source.js   DataSource   { id, load(), view() }
      feature.js  Feature      { id, capability, causal, compute(view) -> series|panel }
      label.js    Labeler      { id, label(events, view) -> {t1, label, ret} }
      learner.js  Learner      { id, capability, fit(view, labels), predict(view) -> confidence }
      memory.js   MemoryBank   { id, write(e), decay(), merge(a,b), consolidate(), stats() }
      retrieve.js Retriever    { id, read(banks, query, k, rng) }        // A12, A20
      sleeve.js   Sleeve       { id, capability, signal(view) -> weightSeries }  // A11
      book.js     Book         { id, compose(sleeves) -> weights }              // A11
      risk.js     RiskPolicy   { id, weights(signals, book) -> weights, position(...) }
      evaluator.js Evaluator   { id, score(returns) -> metrics }
    primitives/          # pure, contract-free math shared by plugins (A13)
    registry.js          # register*/resolve(id)/activeRoster()/rosterSnapshot()
    engine/              # the thin composer over the active stack (events, determinism)
    runtime/legion/      # the legion as a runtime/scheduler (A15, A22) — DB side effect removed
    data/                # ← carries over candles_audit, candle_quality, *_fetcher
    measurement/         # ← carries over analysis/*  (the gate, wholesale)
    observability/       # ← carries over observer/*
  plugins/
    sources/  features/  labels/  learners/  memory/  sleeves/  risk/  evaluators/
  lab/
    runner/              # imports core/contracts (+ data); records experiments
    experiments/         # e01…e80 ported
    findings/            # F-01…F-80, THEORY, leads/  (ported evidence)
```

**Import law (enforced by a test):** `core/contracts` imports nothing · `core/*` may import
`core/contracts` · `plugins/*` import only `core/contracts` · `lab/*` imports both. A plugin never
imports another plugin. This is the whole modularity guarantee, and it is mechanically checkable.

### 4.2 What each contract absorbs

| contract | replaces | first plugins (carried over) |
| --- | --- | --- |
| `DataSource` | `candle_fetcher`, `funding_fetcher`, manifests | `candles-1h`, `candles-15m`, `funding-8h`, `positioning` (new) |
| `Feature` | `indicatorProcessor` + `controller/features` + `analysis/features` | the 10 TA indicators (as one "legacy" plugin), momentum, accel, reversal, sigup, carry, oi-change |
| `Labeler` | `controller/trades` labelling + `analysis/labels` | `online-trade` (legacy), `triple-barrier`, `cusum` |
| `Learner` | `HiveMind`/`HiveMindController` + `benchmark.js` | `legacy-hivemind` (the 11 goldens), `base-rate`, `ridge`, `mlp`, `ewma-vol`, `es-lowrank` |
| `MemoryBank` | `memory/*` | `episodic`, `adaptive`, `semantic`, `core`, `ringbuf`, `+surprise`, `+pca` |
| `Retriever` *(added §4.5/A12)* | the retrieval **policy** over banks (today `_retrieveTopRelevantProtos`) | `global-topk` (legacy), `per-bank`, `exploration`; takes an injected RNG (A20) |
| `Sleeve` *(added §4.5/A11)* | the sleeve layer (W2) | `carry-flat`, `carry-dispersion`, `toptrader-fade`, `oi-change` |
| `Book` *(added §4.5/A11)* | portfolio composition + constraints | `single`, `joint-fixed-split`, `capped-band` |
| `RiskPolicy` | nothing (new) | `clip+band` (port.js), `inverse-vol`, `vol-target`, `OI-schedule`, position/turnover policy (A11) |
| `Evaluator` | `analysis/*` | `dsr`, `spa`, `pbo`, `mcs`, `dm`, `jackknife-deff`, `cost-ladder`, `decision` |

### 4.3 The registry (generalize the one thing that already works)

`analyze.js#VARIANTS` is already the right shape. V2 promotes it to `core/registry.js`:

```js
// sketch — the single source of truth for every swappable thing
registerPlugin(kind, impl);            // kind ∈ {source, feature, label, learner, memory, risk, evaluator}
resolve(kind, id);
activeRoster(kind);                    // the pre-registered, content-hashed set (lineage.js pattern)
capabilityOf(id);                      // the appliesTo taxonomy, first-class ('model'|'controller'|'agnostic'|...)
```

Rules: `capability` is mandatory (an arm that cannot act on the scored path is `not-applicable`, not a
quiet baseline — the R27-2 lesson); the roster is pinned by a hash (the `rosterSnapshot` lesson); every
plugin's id is registered in the lineage register.

### 4.4 The lock model (the actual unlock)

- every plugin ships **its own golden fingerprint**;
- the engine's fingerprint is the **compose of the active stack** (default stack = today's behaviour,
  byte-identical to the 11 legacy goldens);
- `locks.test.js` asserts the contract for every registered plugin and that the default stack
  reproduces the legacy goldens;
- **adding/removing a non-default plugin moves no existing fingerprint** → experimentation becomes
  cheap again.

### 4.5 Audit amendments (2026-09-28)

A six-cycle red-team audit (coherence, friction/pollution, testability, five viewpoints) is in
[`AUDIT-round31-v2.md`](AUDIT-round31-v2.md). The architecture is unchanged in shape; these are the
corrections folded into it.

| id | correction |
| --- | --- |
| **A11** | Add a **`Sleeve`** contract (`{id, capability, signal(view) → weightSeries}`) and a **`Book`** (composition + constraints); `RiskPolicy` operates on a book. The sleeves are the highest-EV work and had no contract. |
| **A12** | Split `MemoryBank` (per-bank, pure: `write/decay/merge/consolidate/stats`) from a **`Retriever`** (the policy over banks). The shipped retrieval is global — it mixes episodic+adaptive+semantic, ranks entries, applies an exploration rate and even draws `Math.random()` — so it cannot be a method of one bank. |
| **A13** | Add **`core/primitives/`** (pure math shared by plugins: the port.js `clipWeights`/`bandWeights`/`cleanBook`, `causalZScore`/`clampPosition`, label helpers). Full import law: **contracts ← 0 deps; primitives ← contracts; plugins ← contracts + primitives; lab ← all; no plugin imports another plugin; the lab never imports engine internals.** |
| **A14** | Two lock classes: **model plugins → per-plugin fingerprint** (compose), **analytic plugins → reference-vector tests** (the existing `analysis.test.js` style); plus **one engine compose fingerprint over the frozen default roster**. Changing the default roster is a deliberate, documented re-freeze. |
| **A15** | Decide the legion: keep as **`core/runtime/legion`** with the module-eval DB side effect removed, **or** replace it with a thin run harness. Add it to V2.1 explicitly rather than "re-host, lighter". |
| **A16** | **One-view rule**: the runtime produces the `view`; the evaluator consumes the *same* view. Pin it with a test (this is `BUGS.md` #33 generalised — the A/B once built its own candle window). |
| **A5′** | Framing: the **product is the sleeve book + the gate**; the **model rebuild (V2.3) is a research deliverable off the critical path**. Revenue the model rebuild's value as *removing the whole-engine lock* and *enabling a winnable target*, not as a path to G5. |
| **A17** | Retire or explicitly validate the noise mechanisms before they become plugins: sample weights (inert), homeostasis (negative), the broadcast (off-path), and the specialization/trust/adaptive-LR stack (audit P3/P4/P6). |
| **A20** | The **`Retriever` contract takes an injected RNG**; the default stream is seeded; two same-seed runs are byte-identical (audit P12 — the live read path currently draws `Math.random()`). |
| **A22** | The **legion survives as a V2 runtime/scheduler** (`core/runtime/legion`: many learner slots, the vault, the observer) — the operator's core concept is preserved, but it is not the alpha source. |
| **A24** | **Wire-or-drop the LSH upgrades**: route the scored read through `_getGlobalLSHCandidates`, or mark `multiprobe`/`querymod`/`binarypc`/`bitweight` PARK and stop investing. |

---

## 5. Decision on the operator's proposal

| # | proposal | verdict | why |
| --- | --- | --- | --- |
| 1 | *Start NeuLegionV2; build it from the ground up to be modular* | **accept the goal, deny "from the ground up" for the proven layers** | V2 = contract-first extraction. Greenfield: the contracts, the registry, the engine, the layout, and the **model core** (the inert + frozen part). Carried over behind contracts: the gate, the data layer, the signal/label math, the memory-support math, the observer. Retyping the gate would discard the project's single best asset and its 2,585-check proof. |
| 2 | *Build a Lab v2 from the ground up with the v2 design in mind* | **accept a Lab v2, deny re-deriving its evidence** | Lab v2 = `core/contracts` + a runner. F-01…F-81, THEORY J1–J6, 19 leads, 66 cycles and `prototypes/port.js` (the validated 5/5 artefact) **port as data**, because they are what makes a number trustworthy. The lab's *harness* is re-hosted on the contracts; the lab's *record* is not re-run. |
| 3 | *Lab and project work together, organized from the start; research/tests in the lab, project pure code/architecture* | **accept, with a tightened seam** | Project = `core/` + `plugins/` (the architecture, the default stack, the gate). Lab = `lab/` (falsification, experiments, findings). The **contract layer is the shared vocabulary** — the lab imports the contracts, never forks the engine. The import law plus a per-plugin golden is what keeps them together without re-coupling them. |

**Why not a full blank-slate rewrite (five reasons).**

1. **The asset is the measurement layer, not the model.** `analysis/*` (DSR/PBO/SPA/Romano–Wolf/
   jackknife/design-effect/MCS/DM/CRN/cost-ladder) is 1989–2026 and independently re-validated by the
   lab. Re-deriving it is the single highest-risk, lowest-value thing a rewrite could do.
2. **A blank slate erases the ability to prove *nothing else changed*.** The 60-entry lock registry
   and the goldens are what caught F-61/F-69/F-70/F-71/F-74/F-76 and the L10-* family. Without them,
   a V2 model that "works" is unfalsifiable — the exact failure mode the harness exists to prevent.
3. **The evidence says the model's *premise* is wrong, not its *code*.** A greenfield model faces the
   same binding constraint (effective streams 1.73 of 8, design effect 3.6–4.9) and the same
   directional target (`P(next bar up)`), so it would return the same null — minus 2,585 checks of
   proof. Rebuilding it only helps *after* the target/job changes (`PLAN-round31.md` W4b).
4. **Cost/risk.** 277 files, ~2.5 MB of `src/`, 128 test blocks, a 200 KB driver, a 138 KB registry.
   A full rewrite has no gate until it has re-derived its own harness — one to two orders of magnitude
   more work than the extraction, with a strictly worse evidence position.
5. **The extraction *is* a rewrite where it matters.** The model core is genuinely re-architected, not
   preserved: it becomes plugins with per-plugin goldens and an optional demo. The legacy engine
   survives only as one plugin, so its math is available but no longer load-bearing. Meanwhile the
   sleeves + risk layer — the only measured positive results — get built on the new contracts first,
   which is where the EV is.

---

## 6. Migration plan (strangler-fig) and how it folds into round 31

The V2 work is **not a detour from `PLAN-round31.md`; it is the vehicle for its W2–W4.** W1 (decision
soundness) and W6 (shipped-path defects) land regardless, because they are prerequisites for
believing any V2 number.

| phase | content | gate |
| --- | --- | --- |
| **V2.0 — contracts + registry (design + additive, default stack = legacy)** | `core/contracts/*`, `core/registry.js`, the import-law test, the per-plugin golden strategy, the migration map. No numerics move. | legacy suite **2585/0**, `golden` **23/0**, `locks` **41/0** with **zero** edits to legacy modules (proves the contracts are wrappers) |
| **V2.1 — port the already-pure layers** | measurement (`analysis/*`), features, labels, memory-support math, observer, data. Purely mechanical: each module keeps its existing test and is invoked through its contract. | every ported module byte-identical to its legacy output; the lab's e-suites still pass |
| **V2.2 — sleeves + risk layer** | `plugins/sleeves/*` + `plugins/risk/*` (port `port.js`: `clipWeights`/`bandWeights`/`cleanBook`, `SLEEVE_SPECS`, `MIN_TRAIN_PERIODS=2555`); the positioning manifest; a sleeve run mode. *(This is round-31 W2+W3.)* | G2: each book reproduces the lab's `e52` to display precision and clears the repo gate at its pre-registered K; G3: effective streams ≥ 2.5 of 9 |
| **V2.3 — rebuild the model core as plugins** | `MemoryBank`/`Learner`/`Ensemble` plugins; `legacy-hivemind` preserves all 11 fingerprints; the plugin tournament targets vol/regime/sizing (round-31 W4b), **never** direction. | `legacy-hivemind` reproduces the 11 goldens; G4: a plugin beats the zero-parameter reference OOS at matched exposure, else it stays default-off |
| **V2.4 — lab v2** | the lab runner imports the contracts; findings/leads/THEORY/cycles port as data; new experiments are written against plugins. | the lab's 65-cycle ledger is intact and the runner reproduces an `e52`-class check |

**Sequencing note.** V2.0–V2.1 are cheap and de-risking and should happen **in parallel** with round-31
W1/W6 (they touch different layers). V2.2 is round-31 W2/W3 and is the EV. V2.3 is round-31 W4 and
only pays once W4b's target is chosen.

---

## 7. Explicitly denied / anti-re-tread

- **Deny** a blank-slate rewrite of `analysis/*` (the gate) and of the data-integrity layer.
- **Deny** re-running or re-deriving the lab's 65-cycle evidence — port it as data.
- **Deny** any V2 experiment against `P(next bar up)` (`NL-BENCH`/G-A closed; F-35 closed) — the
  plugin tournament's targets are vol, regime and *sizing*, and a directional test needs a genuinely
  new feature family to be admissible.
- **Deny** a V2 that keeps the whole-engine lock (it would re-create the modularity blocker).
- **Deny** treating the model as the product: the default path is the zero-parameter sleeve book; the
  learner is default-off until it beats the reference at matched exposure.

## 8. Risks

| risk | mitigation |
| --- | --- |
| extraction silently changes numerics | byte-identical gate at every V2.x step; the legacy goldens are the contract |
| "contract-first" becomes ceremony with no EV | V2.0/V2.1 are bounded and run in parallel with W1/W6; V2.2 carries the EV |
| the registry becomes a second `lock-registry.js` | the registry is code + ids only; proofs live with the plugin; a test asserts the two do not drift |
| the model rebuild is a re-tread | V2.3's tournament is gated on W4b's target and on G4, and `legacy-hivemind` keeps the old math available |
| plane-of-work sprawl (V2 + round 31) | V2.0–V2.2 are *the round-31 workstreams*, not a parallel programme |

## 9. First work unit (when the operator gives the go)

**V2.0, step 1 — the contract layer, additive and default-off.**

1. Add `core/contracts/*.js` + `core/registry.js` (pure; no engine import; no numerics).
2. Add the **import-law test** (contracts have zero deps; plugins import only contracts; `lab/` may
   import both).
3. Add a **wrapper proof**: a tiny `legacy-hivemind` plugin whose `predict()` delegates to the shipped
   `HiveMind`, plus a test asserting the 11 goldens still reproduce **with the legacy engine
   untouched**.
4. Write the **migration map** (the §4.2 table, machine-readable) and the per-plugin golden strategy.

**Acceptance:** legacy suite 2585/0, `golden` 23/0, `locks` 41/0, zero edits to any legacy locked
module (the V2 modules are added, not edited), and the import-law test green. Then V2.1 ports the
pure layers.

---

*Companions:* [`PLAN-round31.md`](PLAN-round31.md) (the pivot this architecture serves),
[`COMPONENTS.md`](COMPONENTS.md) (the current assembly), [`DESIGN.md`](DESIGN.md) (the frozen scope
this re-scopes), [`CITATIONS.md`](CITATIONS.md) (the lineage verdicts), and the lab's
[`INDEX.md`](../../../NeuLegion-lab/INDEX.md) / [`FOLD-BACK.md`](../../../NeuLegion-lab/FOLD-BACK.md).
