# NeuLegion — final core design (frozen)

**Status: frozen.** The systems listed here are the intended core design and
their scope is deliberately closed. New subsystems, index tiers, or retrieval
mechanisms are **not** added to it unless they are demonstrably essential and
pass the definition of done (§6). Research keeps a catalogue of deferred leads
(§5) — that catalogue is *not* a schedule.

This is a CPU-only Node.js design. The Perchance generator wrapper
(`index.html` / `main.pjs` at the workspace root) is unrelated scaffolding and
is ignored.

See [`../README.md`](../README.md) for the run/commands quickstart,
[`RUNBOOK.md`](RUNBOOK.md) for configuration + commands + expected test output,
[`COMPONENTS.md`](COMPONENTS.md) for the assembly rules, [`LOCKED.md`](LOCKED.md)
for the per-component proofs, and [`research/`](research/) for the grounding.

## 1. What the system is

An evolutionary "hivemind" of small transformer controllers that collectively
trade a candle stream. Each `HiveMind` is an ensemble of tiny transformers with
prototype memory (episodic / adaptive / semantic / core) and a random-hyperplane
LSH index. A `HiveMindController` wraps one per
(group, section, layer, tier, direction) slot, feeds it indicator data, and emits
a signal. Controllers share prototypes ("hivemind" broadcast) so knowledge
propagates across the ensemble, and a "legion" layer aggregates their signals by
hierarchy. Offline `analysis/` supercharges score the result honestly.

## 2. The pipeline (data → signal → evaluation)

```
candle JSONL ── candle_quality (read-time winsorize) ── indicatorProcessor ── feature vectors
                                                                                   │
                                          ┌────────────────────────────────────────┘
                                          ▼
   HiveMindController (one per group/section/layer/tier/direction slot)
     └─ HiveMind: ensemble of tiny transformers
          ├─ prototype memory banks (episodic / adaptive / semantic / core)
          ├─ LSH index over semantic-prototype projections
          └─ training (gradient accumulation / distillation) + evolution/trust scores
                                          │  getSignal() → signal
                                          ▼
   legion: hierarchy aggregation, hivemind broadcast/sharing, persistence,
           worker pool, read-only loopback monitor dashboard (served page + API + SSE)
                                          │  per-batch snapshot
                                          ▼
   observer/ (online, additive, watches the legion — never in the hot path):
     calibration · diversity · influence concentration · drift · memory/pipeline/data health
                                          │
                                          ▼
   analysis/ (offline, additive, never imported by the hot path):
     backtest · walk-forward · DSR/PSR/MinTRL · PBO/CSCV · RC/SPA · labels · uniqueness
```

The **observer** (`src/observer/`) and the **monitor dashboard**
(`src/dashboard.html`, served by the HTTP worker) are read-only consumers of the
same per-batch snapshot. Neither imports, nor is imported by, the locked hot
path; they cannot move a golden fingerprint. The dashboard replaced the raw
JSON-over-LAN broadcast (it binds loopback by default).

## 3. The locked core systems (the frozen set)

Every one of these is registered in `test/lock-registry.js` and must keep
`locks.test.js` green. Statuses: **bit-exact** = behaviour pinned by a golden
fingerprint (currently 11 fingerprint constants); **invariant** = a mathematical
property pinned by a dedicated test; **needs-local-run** = native dependency
(real `better-sqlite3` / `worker_threads`), proven only under `npm test`.

| Layer | Files | Registry status | Proved by |
| --- | --- | --- | --- |
| HiveMind kernels + transformer + training + memory + persistence + knowledge + internal | `hivemind/kernels/*`, `transformer/*`, `training/*`, `memory/*`, `persistence/*`, `knowledge/transfer.js`, `internal/*` (22 bags) | 17 **bit-exact** + 5 **invariant** | `golden.test.js` (11 fingerprints) + `modules.test.js` + per-domain entries |
| HiveMindController | `hivemind/controller/*` (5 bags) | 5 **invariant** (candle, feature, database, accuracy, trade) | `core.test.js`, `features.test.js`, `multisymbol.test.js`, `golden.test.js` — all now on the native driver (`BUGS.md` #18) |
| Legion (mainController split) | `legion/*` (16 files) | structural (pinned by `legion.test.js` / `core.test.js`) | `legion.test.js` (57) |
| Indicator processor | `hivemind/indicatorProcessor.js` | **invariant** | `indicators.test.js` (75) |
| Candle data integrity + quality | `candles_audit.js`, `candle_quality.js`, `candle_fetcher.js` | **invariant** | `candles.test.js` (95), `fetcher.test.js` (101) |
| Price precision | `price_precision.js` | **invariant** | `price_precision.test.js` (29), `multisymbol.test.js` (28) |
| Consolidation algorithms | `consolidation_logic.js`, `consolidation_worker.js` | **invariant** | `consolidation.test.js` (48), `consolidation_worker.test.js` (18) |
| Analysis supercharges | `analysis/*` (10 modules: including `world.js` — the audited candle view — and `features.js` — the causal signal family) | **invariant** | `analysis.test.js` (390), `walkforward.test.js` (48) |
| LSH support modules | `memory/multiprobe.js`, `memory/binarypc.js`, `memory/bitweight.js`, `memory/querymod.js` | **invariant** (default-off; golden no-op) | their own entries + `lsh.test.js` section J + `golden.test.js` |

Registry totals: **53 entries — 17 bit-exact, 36 invariant, 0 needs-local-run,
0 experimental.** The canonical check ledger is in [`RUNBOOK.md`](RUNBOOK.md).
The native `npm test` gate is green at round 22 (**115/115 blocks across 39
files**, `docs/BUGS.md` #20/#21), so the three controller DB bags that were the
only `needs-local-run` entries are promoted.

## 4. Default-off features (proven, opt-in — not part of the default trajectory)

These are **shipped and proven but off by default**, so they cannot move a golden
fingerprint. Each becomes part of the default design only when the walk-forward
harness promotes it (backlog P0).

| Feature | Flag (default) | What it does | Grounded by |
| --- | --- | --- | --- |
| Surprise-gated memory writes | `_surpriseGateEnabled = false` | scale a semantic write by `floor + (1-floor)·surprise^sharpness` | Titans 2501.00663; `surprise.test.js` (32) |
| Sample-uniqueness loss weighting | `_sampleWeightConfig = null` | weight each training sample by label uniqueness (AFML ch. 4) | López de Prado 2018; `sample_weights.test.js` (36) |
| Homeostatic learning rates | `_homeostasisEnabled = false` | error-driven multiplier toward an activity set-point | 2609.13771; `homeostasis.test.js` (30) |
| Margin-ordered multi-probe | `_multiProbeConfig = null` | probe the lowest-margin hash bits first | Lv et al. 2007; `multiprobe.test.js` (77) |
| Data-aware (PCA-aligned) hash | `_pcaHashConfig = null` | replace random hyperplanes with principal components | BinaryPC 2608.04405; `binarypc.test.js` (39), `lsh.test.js` §I |
| Dynamic query modification | `_queryModConfig = null` | re-hash the centroid of found neighbours (query-side) | 2605.23807; `querymod.test.js` (51), `lsh.test.js` §J |

The low-rank ES layer (`legion/evolve.js`) is proven **invariant** but is an
additive module **nothing imports yet** — it stays out of the hot path until it
is needed and A/B'd.

## 5. Frozen scope: explicitly out of scope

Recorded as research leads in [`research/`](research/), **not** scheduled:

- **New ANN index tiers** — Locality-Sensitive Filtering on the sphere
  (2604.24323), HNSW / multi-graph indexes (2607.28999), learned partition trees
  (2607.09909). The LSH + multi-probe + PCA-aligned stack is the chosen index.
- **Temporal-co-occurrence retrieval** (PAM, 2602.11322) and heavier associative
  recall operators (holographic 2606.18492, Sinkhorn 2606.28300) — the bank
  retrieves by projection cosine and that is the design.
- **Learned routing** (NeuRoute 2608.15438) — captured in closed form by the
  query-adaptive probe budget instead of a learned head.
- **New hashing families / new memory write paths / any GPU or large-scale
  training path.**

Adding any of the above requires the definition of done in §6 and an explicit
reason it is essential to the intended design.

## 6. Definition of done for a core system

A change is only "core" (and only enters `test/lock-registry.js`) when **all** of:

1. it lives in `src/` and, if additive, is **default-off** (so the 11 golden
   fingerprints are unchanged);
2. a dedicated test entry proves the math/property (browser entry **and** a
   `test/node/` mirror that asserts `failed === 0`);
3. a citation exists in `docs/CITATIONS.md` and a bullet in the relevant
   `docs/research/*.md` note;
4. a `lock-registry.js` entry names its status, `proves`, and `citations`;
5. `src/README.md` and `docs/LOCKED.md` document it;
6. the full browser suite is green (and `npm test` locally for anything native).

### 6.1 Decision-procedure changes (added round 25)

A change to *how a verdict is decided* is not arithmetic and moves no golden, but it
is still a core change: it changes which claims the project makes, so it gets its own
rationale, its own proofs and its own size calibration.

The round-25 rule, recorded here because it is a decision-procedure change:

- **Fold consistency is a significance statement, not a fraction.** The round-23/24
  gate required `foldWinFraction >= 0.5` and `positiveFraction >= baseline`. On the
  attempt-3 power run those raw thresholds decided all three DSR-significant
  candidates, over 288 folds that are ~0.41-0.52 correlated *across streams*
  (`BUGS.md` #27). The round-25 gate instead asks (a) does the candidate's pooled
  Sharpe improvement exceed its own sampling error — a paired delete-one-cluster
  jackknife difference referenced to t(C−1), and (b) does it win the majority of
  fold *windows* significantly — the exact sign test over the same clusters. The
  unit of repetition is the fold window (one calendar window across all streams),
  because that is what actually repeats in a walk-forward. The raw fraction is still
  reported, as a statistic.
- **The cluster is the fold window, and the jackknife is the variance.** Deleting one
  window across all streams and re-estimating is the delete-block jackknife for
  serially dependent observations (Künsch 1989) applied to the cluster structure the
  walk-forward already has (Cameron & Miller 2015). It is deterministic (nothing to
  seed) and exact on the calibration tests, which is why it replaced the planned
  equicorrelation scaling.
- **A hurdle whose input does not exist is SKIPPED, never failed, and saying which is
  mandatory.** A single-stream report has no cross-stream panel; a diversifying panel
  has a design effect ≤ 1 and needs no correction. Conflating those states with a
  genuine failure would either make a one-symbol run un-promotable or hide a real
  failure, so `promoteDecision` returns a per-hurdle `gate` of
  `applied` | `skipped-no-panel` | `not-needed` | `off` and the report renders it.
- **An effective number of independent tests is a diagnostic, never a discount.**
  `familyCorrelation` measures how concentrated the searched family was (on the
  attempt-3 run `sig:momentum` and `sig:acceleration` correlate 0.863, so three
  "significant" candidates are ≈ 1.5 bets), but the deflated Sharpe keeps
  `trials = K`: correlated tests are still tests that were run (Harvey, Liu & Zhu
  2016), and substituting an effective test count does not control the family-wise
  error rate (arXiv 1612.04535).
- **Every verdict carries its cost sensitivity.** The attempt-3 verdict flips between
  `costBps: 0` (keep-off) and `costBps: 2` (`sig:acceleration` promotes with zero
  reasons), so the report now restates the whole decision at 0/2/5/10 bps of turnover
  by re-scoring the retained per-fold inputs — the exact scored arithmetic, no model
  and no re-run. A verdict that changes across the ladder is a verdict about the cost
  assumption.

## 7. Integration invariants (what keeps the pieces coherent)

- **Golden fingerprints (11).** `golden.test.js` pins the exact seeded
  trajectory. Any default-off flag being off is proven byte-identical, so the
  goldens are the contract that the optional layers do not leak into the hot
  path. Changing the hot math is a deliberate re-freeze, never a side effect.
- **Assembly.** `modules.test.js` proves every component bag is installed
  exactly once, as the exact function reference, and that the class bodies keep
  only the public API (`docs/COMPONENTS.md`).
- **Registry completeness.** `locks.test.js` fails if a component bag is
  unclassified, a status is invalid, a citation key is unknown, or a claimed
  fingerprint does not exist.
- **LSH recall.** The LSH support modules are all default-off and, when enabled,
  can only *add* candidates (`_queryModConfig` returns a superset pool), so
  enabling one is never a recall regression.

## 8. Where to go next

The open, prioritized work is in [`TODO.md`](TODO.md); the consolidated plan and
priority rationale is in [`ROADMAP.md`](ROADMAP.md).

The design is still frozen; the native gate is **green (115/115 blocks,
`BUGS.md` #20/#21)**. Round 22 delivered the full ROADMAP P0-P3 programme (run
integrity + determinism + the dry-run/preflight harness + the monitor dashboard +
the legion observer + the walk-forward A/B driver); the only hot-path-adjacent
golden change was the deliberate `hm:postReloadPrediction` re-freeze (`BUGS.md`
#19).

The next step is **not construction** — it is making the evaluation faithful
([`ROADMAP.md`](ROADMAP.md) round 23, N0-N3). That is now implemented: the A/B
driver evaluates the shipped `HiveMindController` (10 real indicator series, real
OHLCV, trade bookkeeping) through `makeControllerModelFactory`, its look-ahead
audit perturbs that model's actual candle input instead of a returns array the
model never reads (`analysis/world.js`, `BUGS.md` #22), the candidate family is a
real causal signal family (`analysis/features.js`, K = 15 on one family-wise
gate), and reports carry a power/MDE readout with optional cross-symbol pooling
(`--symbols=all`). **The verdict (N3) now exists**: the power run
`20260920T144633-seed1` (8 streams / 288 folds / 4,320 pooled bars, 11.98 h)
returned **all 14 candidates keep-off**, **SPA p = 0.5699** (Rejects = [none]),
baseline pooled Sharpe +0.4387 / DSR 0.5179, with no golden re-frozen — recorded
in [`OPTIMIZATION.md`](OPTIMIZATION.md) and analysed in
[`RUN-ANALYSIS.md`](RUN-ANALYSIS.md) §5. The three candidates with DSR ≈ 0.999
(`query-mod`, `sig:momentum`, `sig:acceleration`) fail only the fold-consistency
hurdles. Three caveats are now attached to the *evaluation* itself and are round
25's scope: the power readout ignores cross-stream correlation (honest MDE95
≈ ±0.98, not ±0.47 — `BUGS.md` #26), the verdict is not cost-robust (a 2 bps cost
assumption promotes `sig:acceleration` — `BUGS.md` #27), and the fold-consistency
hurdle is a fixed 0.5 fraction over 288 correlated folds rather than a
significance statement. Attempt 1 was interrupted and produced no report;
**attempt 2 (the default smoke) completed** and gave an honest, underpowered null
— all 14 candidates keep-off, MDE95 ±2.0 over 240 bars, 969 bars needed for Sharpe
±1.0. The forensics of all three attempts are in
[`RUN-ANALYSIS.md`](RUN-ANALYSIS.md) §1, §3 and §5. The arithmetic-free robustness
work that round 24 derived from them — per-variant `partial-report.json`
checkpoints (atomic writes), `modelRetention` per-fit state reclamation, a
liveness `progress.json` + greppable stdout heartbeat, a `folds.jsonl` fold
journal, and the machine-readable `audit` block
(`clean`/`reachable`/`reachableFolds`/`probes`) — is **implemented and pinned** in
`analyze.test.js` §O/§P/§Q (as-built API: `RUN-ANALYSIS.md` §2). Round 24b then
hardened it against the smoke run's findings: a volume-aware audit shock, an
assumption-free break-even cost (`grossPnl`/`breakEvenCostBps`), an
offline-readable journal (`probeIndex`/`reused`), a power/`underpowered` verdict
(`barsToDetect1`), and the `--reuse-base` optimization (4 → 3 passes/fold,
verdict-identical) — see [`BUGS.md`](BUGS.md) #25 and
`RUN-ANALYSIS.md` §3.5-§3.7. No further hot-path core mechanism should be built
before the *evaluation* is trustworthy (round 25) — and any promote it produces is
a deliberate, documented golden re-freeze.

**Round 25 is now implemented** (`RUN-ANALYSIS.md` §6, `ROADMAP.md` round 25). The
three caveats above are closed at the report level: the power readout carries the
honest cluster-jackknife SE/MDE beside the i.i.d. one (and `psrAdjusted`/`dsrAdjusted`
on the design-effect-adjusted sample), the fold-consistency hurdle is a paired
significance statement over fold-window clusters (with the exact sign test and a
per-hurdle `gate` record), and every verdict carries a cost ladder restated from the
retained per-fold inputs. The searched family's concentration is reported as a
diagnostic. Nothing on the hot path changed and no golden fingerprint moved — the
new module (`analysis/dependence.js`) imports nothing, and the driver's new
behaviour is behind `--gate=` (default `dependence`, `classic` for the round-23/24
rule) and `--cost-ladder=`. The remaining step is not construction, it is the next
**experiment**: a run sized by *independence* rather than bars (`RUN-ANALYSIS.md`
§6.4), whose report will carry the round-25 blocks natively.
