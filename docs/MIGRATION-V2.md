# NeuLegion V2 — the migration map

**Status: V2.0 + V2.1 (partial) + V2.2 (sleeves/risk) LANDED; V2.3/V2.4 not started.**
Authored alongside the first code change (`src/core/**`, `src/plugins/**`), and kept in
sync with [`ARCHITECTURE-v2.md`](ARCHITECTURE-v2.md) §4/§6 (the blueprint) and
[`PLAN-round31.md`](PLAN-round31.md) (the pivot this serves). This is the deliverable
V2.0 step 1 item 4 calls for: the machine-readable map, plus the strategy that keeps each
plugin's proof local.

## 1. What landed, and the acceptance evidence

| phase | content | evidence |
| --- | --- | --- |
| **V2.0 — contracts + registry (additive)** | `src/core/contracts/*` (10 contracts + kernel), `src/core/registry.js`, `src/core/primitives/*`, the import-law suite, the wrapper proof, the migration map | full browser suite **2741/0** (was 2585/0; +156 new checks, see §7), `golden` **23/0** (no fingerprint moved), `locks` **41/0**, `modules` **51/0**, and **zero edits to any pre-existing (legacy) locked module** (the import law asserts the legacy tree never imports `core/`; the V2 modules' own R31b/R31c bug/coherence passes are RUNBOOK §6 and moved no golden) |
| **V2.1 — port the already-pure layers (partial)** | the shared book arithmetic (the lab's port artefact) is in `core/primitives/`; the gate (`analysis/*`) is unchanged and now *addressable* through the `evaluator` contract when V2.2's scoring path is wired | the port is proved twice: exact vectors in `contracts.test.js` §D and the real-data re-derivation in the lab's `e73_port_verify.js` — which now reports **10/10 checks pass** — the three books and the chain fingerprint **plus** a 250-trial seeded differential fuzz of every ported primitive against the lab module it came from (R8 `6.18/10×/46.04`, R7 `1.07/8×/182.59`, OI `0.92/198×/15.22`; rows and returns bit-for-bit; `cleanBook` fingerprint-identical to `prototypes/port.js`) |
| **V2.2 — sleeves + risk (the EV)** | `plugins/sleeves/{carry-dispersion,toptrader-fade,oi-change}.js`, `plugins/risk/cap-band.js`, `plugins/books/{single,fixed-split}.js`, `plugins/index.js` (the composition root) | the repo now runs the lab's pinned specs; the gate (G2/G5) has **not** run in the repo yet — the plugins land `UNTESTED` |
| **V2.3 — model plugins** | not started | the legacy model is available as `plugins/learners/legacy-hivemind.js` so its 11 goldens are never lost |
| **V2.4 — lab v2** | not started | — |

**The port is verified against the lab's data (F-81).** `e73_port_verify.js` (registered in the lab's
`run_all`, **10/10 checks**) imports the repo modules read-only, rebuilds the lab's real 8-symbol /
6 557-period carry panel, drives each sleeve through its `signal()`/`returns()`, and requires the weight
rows (bit-for-bit), the returns and the stored metrics to match — R8 `6.18 / 10× / 46.04` (= `e30`),
R7 `1.07 / 8× / 182.59` (= `e32`), OI `0.92 / 198× / 15.22` (= `e50`) — with the repo `cleanBook`
fingerprint-identical to `prototypes/port.js`. The exercise also pinned lab row **L10-ct**: the lab's two
construction shells read two different arrays off the same `buildXsSeries` result, so the repo primitives
take the book grid as an explicit `n` (see `research/core-contracts.md` §4).

## 2. The import law (enforced, not aspirational)

```
core/contracts/**   imports nothing outside core/contracts      (base.js imports NOTHING)
core/primitives/**  imports core/contracts + core/primitives
core/registry.js    imports core/contracts + core/primitives
core/<other>        imports only core/**            (no plugin, no engine)
plugins/<any>       imports core/contracts + core/primitives + Node built-ins
                    (+ the ONE legacy bridge: learners/legacy-hivemind.js -> src/hivemind/hiveMind.js)
plugins/index.js    the composition root: may import plugins (and nothing else plugin-shaped)
lab/**              imports the repo read-only (never edited by the lab; the lab VERIFIES the port)
```

Nothing under `src/core/` may import a plugin or the legacy engine (the bridge is
one-directional), no plugin may import another plugin, and **the legacy tree
(`src/hivemind`, `src/analysis`, `src/legion`, `src/observer`, `src/controller`) must not
import `core/`** — that last clause is the mechanical proof of "zero edits to locked
modules" (on top of the unchanged goldens). Section §H of
`test/browser/entries/contracts.test.js` enforces all of it over every file under the two
roots, with a negative control (the contract kernel must have zero imports) and a positive
one (exactly one file may bridge to the engine).

## 3. The migration map (contract → legacy modules → first plugins)

| contract | what it replaces | first plugins | landed? |
| --- | --- | --- | --- |
| `source` | `candle_fetcher`, `funding_fetcher`, the manifests | `candles-1h`, `candles-15m`, `funding-8h`, `positioning` | contract only |
| `feature` | `indicatorProcessor` + `controller/features` + `analysis/features` | the 10 TA indicators (one `legacy-ta` plugin), momentum, accel, reversal, sigup, carry, oi-change | contract only |
| `label` | the controller's trade labelling + `analysis/labels` | `online-trade` (legacy), `triple-barrier`, `cusum` | contract only |
| `learner` | `HiveMind`/`HiveMindController` + `analysis/benchmark` | **`legacy-hivemind`** (the 11 goldens), `base-rate`, `ridge`, `mlp`, `ewma-vol` | **legacy adapter landed** |
| `memory` | `memory/*` | `episodic`, `adaptive`, `semantic`, `core`, `ringbuf`, `+surprise`, `+pca` | contract only |
| `retrieve` | the retrieval *policy* (`_retrieveTopRelevantProtos`) — audit A12 | `global-topk` (legacy), `per-bank`, `exploration`; injected RNG (A20) | contract only |
| `sleeve` | the sleeve layer (round-31 W2) | **`carry-dispersion`, `toptrader-fade`, `oi-change`** | **landed (UNTESTED)** |
| `book` | portfolio composition + constraints | **`single`, `fixed-split`** | **landed** |
| `risk` | nothing (new) | **`cap-band`** (the ported chain), `inverse-vol`, `vol-target`, OI schedule | **landed (`cap-band`)** |
| `evaluator` | `analysis/*` | `dsr`, `spa`, `pbo`, `mcs`, `dm`, `jackknife-deff`, `cost-ladder`, `decision` | contract only (the modules carry over unchanged; they are not retyped) |

## 4. The per-plugin golden strategy (the unlock, audit A14)

* **Every plugin ships its own proof.** A model plugin is pinned by a fingerprint; an
  analytic plugin by exact reference vectors; a stateful plugin by both factory and
  instance contract checks plus its own behaviour vectors.
* **The engine's fingerprint is the compose of the ACTIVE stack.** `stackSnapshot()`
  hashes (kind, id, capability, state) over the `defaultStack` plugins only, so a new
  non-default plugin moves no existing proof. Changing the default stack is a deliberate,
  documented re-freeze — the `OPTIMIZATION.md` procedure.
* **The registry holds code + ids only.** The proofs live in `test/lock-registry.js`
  (`CORE_REGISTRY`, `PLUGIN_REGISTRY`) and a test asserts the plugin register and
  `src/plugins/index.js#DEFAULT_STACK` do not drift in either direction.
* **V2.0's default stack is deliberately narrow:** only `learner:legacy-hivemind` is
  `defaultStack: true`, which is what makes "the default stack reproduces the legacy
  goldens" a meaningful statement (`golden.test.js` is the engine's own proof, and the
  adapter adds no arithmetic).

## 5. The one-view rule (audit A16)

`core/primitives/views.js` makes "the runtime produced the view and the evaluator consumed
the SAME view" a checkable statement (`viewIdentity`/`assertOneView`). This is `BUGS.md`
#33 generalised: the round-26 leak read clean because the audit perturbed a returns array
the model never read. The V2 runtime must call `assertOneView` between the scoring view and
the audit view; the primitive is proved now so the runtime cannot silently skip it.

## 6. Seams intentionally left for V2.3/V2.4

* `retrieve` still needs the shipped retrieval **split** from the banks (A12) and an
  injected RNG default (A20) — the contract declares both; no plugin exists yet.
* The **legion** decision (A15/A22) is still open: re-host as `core/runtime/legion` with
  the module-eval DB side effect removed, or replace with a thin run harness. Not touched
  in this change.
* The LSH upgrades (A24: wire `_getGlobalLSHCandidates` or PARK `multiprobe`/`querymod`/
  `binarypc`/`bitweight`) are untouched; nothing in the new layer depends on them.
* `analysis/*` modules are not yet wrapped as `evaluator` plugins — they are unchanged and
  invoked directly, which is the plan's whole point (do not retype the gate).

## 7. Test-ledger effect (the repo's standing discipline)

| suite | before | after |
| --- | ---: | ---: |
| browser suite (all entries, `bench` excluded) | 2585 checks / 0 failures | **2741 / 0** |
| new entry `contracts.test.js` | — | **151 / 0** (sections A–K) |
| new entry `legacy_hivemind.test.js` | — | **15 / 0** |
| `golden.test.js` | 23 / 0 | **23 / 0** (unmoved) |
| `locks.test.js` | 41 / 0 | **41 / 0** (unchanged count; `DOMAINS.core` added) |
| `modules.test.js` | 51 / 0 | **51 / 0** |

`test/node/contracts.test.js` and `test/node/legacy_hivemind.test.js` are the `npm test`
mirrors (the first also supplies the recursive listing that makes the import-law file set
complete; the second runs the adapter against real `better-sqlite3`). **Not runnable in
this environment:** the native node suites (13 of them) — run `npm test` locally
(`docs/round29-TESTING.md` §1). **Cleared 2026-09-28:** the operator's native `npm test`
is **130/130 blocks, 0 failures** (both V2 mirrors included). **Round 32** (the lab R2 port)
moved the browser suite 2741 → **2753** (`walkforward` 63 → 74, `analyze` 279 → 280; no golden moved, no node-block change). **Round 33** (the lab R1 port) moved it 2753 → **2768** (`walkforward` 74 → 83, `analyze` 280 → 286; the new exports joined the curated lock lists in the same change; no golden moved, no node-block change).

## 8. Next work units

1. **Wire the sleeve book into the scoring path** (round-31 W2+W3): a `--sleeve` run mode
   that builds the panel view from the existing data layer, calls the sleeve → book → risk
   chain, and scores it through the unchanged gate. Gate **G2** then has a number.
   **(Round 40: the scoring half landed** — driver-side `src/sleeve_score.js` scores
   every sleeve's own P&L through the pinned `single` + `cap-band` chain by the gate's
   own arithmetic with the A2/A18 readouts beside it, proved in `contracts` §K. The
   data-layer view builder + CLI flag are next.)
2. **The shipped-path fixes (W6)**: F-61 (`carryOnBarGrid` sub-8h), F-69 (`benchmark` ridge
   `ybar`), F-70 (`hitRate`), F-71 (features L10-bs/bu/bv), F-74 (`panelFor`), F-76
   (`holding` `costBps`), L10-cs (`clustersOf` paired test). Each needs its own entry +
   ledger update.
3. **`assertOneView` in the runtime** (audit A16) once a runtime exists.
4. **V2.3** only after W4b names a target.
