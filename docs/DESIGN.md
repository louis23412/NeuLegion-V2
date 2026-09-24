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
| Candle data integrity + quality | `candles_audit.js`, `candle_quality.js`, `candle_fetcher.js`, `funding_fetcher.js` | **invariant** | `candles.test.js` (192), `fetcher.test.js` (111) |
| Price precision | `price_precision.js` | **invariant** | `price_precision.test.js` (29), `multisymbol.test.js` (28) |
| Consolidation algorithms | `consolidation_logic.js`, `consolidation_worker.js` | **invariant** | `consolidation.test.js` (48), `consolidation_worker.test.js` (18) |
| Analysis supercharges | `analysis/*` (21 modules: including `world.js` — the audited candle view — `features.js` — the causal signal family — `dependence.js`/`decision.js` — the round-25/26 gate and report — `forecast.js`/`race.js`, and the round-29 `benchmark.js`/`carry.js`) | **invariant** | `analysis.test.js` (621), `walkforward.test.js` (63) |
| LSH support modules | `memory/multiprobe.js`, `memory/binarypc.js`, `memory/bitweight.js`, `memory/querymod.js` | **invariant** (default-off; golden no-op) | their own entries + `lsh.test.js` section J + `golden.test.js` |

Registry totals: **60 entries — 17 bit-exact, 43 invariant, 0 needs-local-run,
0 experimental.** The canonical check ledger is in [`RUNBOOK.md`](RUNBOOK.md).
The native `npm test` gate is green (**127/127 blocks across 43 files** at round
27, `docs/BUGS.md` #20/#21/#42/#52), so the three controller DB bags that were the
only `needs-local-run` entries are promoted.

## 4. Default-off features (proven, opt-in — not part of the default trajectory)

These are **shipped and proven but off by default**, so they cannot move a golden
fingerprint. Each becomes part of the default design only when the walk-forward
harness promotes it (backlog P0).

| Feature | Flag (default) | What it does | Grounded by |
| --- | --- | --- | --- |
| Surprise-gated memory writes | `_surpriseGateEnabled = false` | scale a semantic write by `floor + (1-floor)·surprise^sharpness` | Titans 2501.00663; `surprise.test.js` (32) |
| Sample-uniqueness loss weighting | `_sampleWeightConfig = null` | weight each training sample by label uniqueness (AFML ch. 4) | López de Prado 2018; `sample_weights.test.js` (57) |
| Homeostatic learning rates | `_homeostasisEnabled = false` | error-driven multiplier toward an activity set-point | 2609.13771; `homeostasis.test.js` (30) |
| Margin-ordered multi-probe | `_multiProbeConfig = null` | probe the lowest-margin hash bits first | Lv et al. 2007; `multiprobe.test.js` (77) |
| Data-aware (PCA-aligned) hash | `_pcaHashConfig = null` | replace random hyperplanes with principal components | BinaryPC 2608.04405; `binarypc.test.js` (39), `lsh.test.js` §I |
| Dynamic query modification | `_queryModConfig = null` | re-hash the centroid of found neighbours (query-side) | 2605.23807; `querymod.test.js` (51), `lsh.test.js` §J |

> **How to read "not promoted" for this table (round-26 run, `BUGS.md` #43/#44; round-27
> correction and runs, `RUN-ANALYSIS.md` §13).** The A/B's *mechanism* candidates are
> how each of these features is tested. The `20260922T204248-seed1` run showed that
> **three of the seven were inert on the shipped controller path** — `sample-weights`
> never set `_sampleWeightConfig` (#43), and `multi-probe`/`query-mod` set flags whose
> only reader (`knowledge/transfer.js → _getGlobalLSHCandidates`) is not reached during
> a fold's training (#44) — so those three candidates were byte-identical to the
> baseline in every fold, and their keep-off verdicts are **not evidence about the
> feature**. Round 27 resolved this per feature: `multi-probe`/`query-mod` are now
> `not-applicable` (structurally off the scored path) and out of `K`; `sample-weights`
> is out of the default roster and is **mathematically inert on the `optimistic`
> labeller** (one-bar labels do not overlap, every uniqueness weight is 1 — proven by
> the round-27 Step-1 certificate), while under the reachable `triple` label it is
> **live but harmful** (Step 3: paired ΔSharpe −0.2276, 0/36 windows) — though that
> Step-3 comparison is confounded by an effective-LR change (`BUGS.md` #54) and is
> being re-run before TODO #5 is closed; and `pca-hash` turned out to be
> **budget-dependent** rather than unconditionally live (#53). "Off by default, not yet
> promoted" therefore means, for these four: *not tested by a valid run* (multi-probe,
> query-mod), *tested and rejected* (sample-weights), and *reachable, live at some
> budgets, not shown to help* (pca-hash). See TODO #64 and `PLAN-round28.md`.

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

**Round-25b observation (from the `20260921T062511-seed1` real run).** The three
hurdles did not bind equally. On 8 signal candidates, `requireBreadth` passed **8 of
8** — and hit its 2^-C resolution floor (p = 2^-142 ≈ 1.8e-43) on three of them —
while `requireSharpeDiff` and `minDsrAdjusted` rejected all 8. A sign test against
a near-zero baseline is close to automatic, so as specified the breadth hurdle adds
little discrimination and the magnitude hurdles do the work; giving it a magnitude
floor is now a tracked question (`ROADMAP.md` round 26, R26-7). **Resolved in round
26 (R26-7):** the sign test is kept as a reported statistic, and the shipped
dependence gate is the magnitude floor (`requireSharpeDiff`) plus a
cluster-stability requirement (`requireClusterStability` — the pooled difference
must stay positive on every leave-one-cluster-out panel). **Correction (round 26b,
`BUGS.md` #39):** the breadth figures quoted here were produced by a
`pairedClusterSignTest` that compared all-but-window-c (the jackknife input), i.e. a
leave-one-out form, so the "8 of 8" and "2^-C floor" numbers are superseded by the
per-window sign test now shipped; the conclusion (breadth separated nothing against
a weak baseline) is unaffected. The same run is also the clearest
vindication of the clustered tests: **every** signal had a negative mean per-fold
Sharpe and a `foldWinFraction < 0.5`, yet a positive pooled Sharpe and a ~100%
fold-*window* win rate. At the fold level the fractions said "loses"; at the cluster
level the tests said "no significant magnitude". Only the clustered view is
answering the question the fold grid actually asks.

**Addendum (round 28, `BUGS.md` #57).** The rule above was recorded but not fully implemented:
`promoteDecision` still applies `minFoldWinFraction = 0.5` and `minPositiveFoldDelta` as
always-on reasons over all folds, and the round-27 runs show it binding (`label-conservative`
0.2014 raw vs **0.500** cluster sign test; `sig:momentum` 0.4931 vs 0.5278). Round 28 (P1e)
makes the code match this section — the raw fractions become reported statistics, the gate's
breadth statement is the error-controlled cluster tests (magnitude + stability, with the sign
test reported) — after proving verdict-neutrality on the four round-27 reports (every failing
candidate also fails the DSR floor and/or the paired test, so no verdict moves). The size
rationale and the new paired-vs-single-series sizing rule are recorded in `METHOD.md` §7/§8.

**Addendum 2 (round 28 operator runs, `BUGS.md` #60/#61; `RUN-ANALYSIS.md` §15).** Two
decision-procedure questions the three runs opened, both recorded and neither fixed:

1. **A third fold-level statistic is still gated.** The #57 fix made the two raw fold *fractions*
   reported statistics; `meanSharpeDelta` (the candidate's mean per-fold Sharpe against the
   baseline's) remains an always-on `gated: true` hurdle over the same 288 correlated folds and is
   the first line of every failing verdict in the three runs. It is verdict-neutral on all 21
   candidate rows, so nothing moves — but whether §6.1's decision intended a mean-fold reason is
   this section's question, not an arithmetic one (`BUGS.md` #60).
2. **A cross-family comparison must name its exposure.** The position policy is unified in
   *dimension* (every family emits a confidence on [−1, 1]) but not in *distribution*: the
   controller's `|confidence|` never exceeds 0.27 while a signal's saturates at 1 (fraction above
   0.2: 0.93 % vs 83 %), so the shipped `deadZone 0.05` leaves the baseline in the market on
   0.508 of bars and `sig-momentum` on 0.892, and the P5 sweep's promoting row compares an
   ~80 %-invested book with one that holds a position on 16 of 4 320 bars (`BUGS.md` #61). The
   choice — family-normalised thresholds, or cross-family statements quoted only at matched
   exposure — is a change to this section and is left to the next round.

**Addendum 3 (round 29, P2/P4; `PLAN-round29.md` D5/D8).** The two questions Addendum 2 left open
were both decided by the round-29 implementation, so this section now carries the round-29
decision-procedure changes (rationale in `METHOD.md` §10/§11):

- **Configuration-robust promotion.** `promotionAcrossCadences` replaces the single-cadence gate:
  a candidate passes at **more than half** a grid of `testSize` cadences and is **vetoed** if any
  cadence is outright broken (failed look-ahead audit or negative pooled net Sharpe) —
  `majorityFraction = 0.5`, `defaultCatastrophic` (`analysis/decision.js`). Every level field
  carries its cadence. The rule is *stricter* than the old gate and was proved **verdict-neutral on
  every retained run** before it landed; it also kills the §15.5(c) `sig-accel` promotion at matched
  exposure (adjDSR 0.9584 → 0.7925). The driver exposes it as an opt-in `--cadences=a,b,c` pass
  (fixed-position restatement, default off → `report.configurationRobust`, `analyze.js`).
- **Exposure matching is the answer to Addendum 2's item 2.** Cross-family comparisons are quoted
  only at a common **in-market share**: `exposureDeadZone` finds the scale-free threshold that
  realises a target share, `exposureMatchedPair` restates both families and drops any holding band,
  and `matchedWithinTolerance` reports an unreachable target. The target share is read from the
  restatement, never from the report (`BUGS.md` #63). Opt-in `--exposure-match` writes the matched
  comparison to `report.exposureMatched` (`analyze.js`); both passes are pure post-processing.
- **An independence purchase is dated by correlation + effective streams, and the DSR surface
  separately.** The DSR hurdle stays a **surface** in `(Sharpe, designEffect, moments, K)`, not a
  Sharpe band (`RUN-ANALYSIS.md` §1.8 MC1; §16.1 anchors). A new return series (the P4 carry sleeve)
  is evaluated on the bar-level correlation, the panel's effective streams, *and* its effect on the
  best arm's `dsrAdjusted` — all three, because the design effect is serial-dominated and can fail to
  move while the correlation purchase is real (`METHOD.md` §11).
- **Extra panel streams are shape-guarded, not trusted.** A cross-sectional panel may carry extra
  streams (the carry sleeve) beside the price streams: `analyze.js --carry-files` /
  `extraPanelStreams` attach them, and `poolReports` compares each extra stream against a
  **per-stream** length (not the concatenated `pooled.length` — `BUGS.md` #64) and excludes a
  **constant** stream (`panelMismatchReason: 'length' | 'degenerate'`, `BUGS.md` #66), with the
  price-only dependence retained beside the extended one (`dependenceWithoutExtras`) so the
  increment is visible.
- **New manifest, same discipline.** The funding series is a third data manifest
  (`FUNDING_MANIFEST` / `FUNDING_FILES` in `candles_audit.js`) alongside the 1h `CANDLE_MANIFEST`
  and the 15m `CANDLE_MANIFEST_15M`, audited by the same pure auditor (`analysis/carry.js`) before
  any run (`PLAN-round29.md` §8 step-0 hard gate).
- **P5 (continuous TTA) is deferred, not dropped** — its gate G-D stays **OPEN** (nothing
  measured); the design + cost wall are in `RUN-ANALYSIS.md` §16.6 and `TODO.md` 96, and the
  DoD item 4 is explicitly conditional on P5 being built.

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

The design is still frozen; the native gate is **green (127/127 blocks,
`BUGS.md` #20/#21/#42/#52)**. Round 22 delivered the full ROADMAP P0-P3 programme (run
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
hurdles. **⚠️ Superseded (round 26, `BUGS.md` #33):** attempt 3 predates the
window-fidelity fix, so its baseline/mechanism rows are not the shipped model's.
The current verdict is the same-design corrected re-run `20260922T204248-seed1`
(all 14 keep-off, **SPA p = 0.4731**, nothing promotes at 0/2/5/10 bps, baseline
**Sharpe -0.1147** with negative skill, `query-mod`/`multi-probe`/`sample-weights`
byte-identical to the baseline, `sig:momentum` 1.0848 / `sig:acceleration` 1.0194
failing only the dependence-adjusted DSR floor) — `RUN-ANALYSIS.md` §10. Three caveats are now attached to the *evaluation* itself and are round
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

**Round-26 forensic finding — the A/B's controller input was not the production
input (fixed by R26-0; `BUGS.md` #33-#37 all fixed).** The first run made *with* the round-25 blocks and the corrected
power maths (`20260921T062511-seed1`) settled the economic question on that window
(nothing promotes; the signal family's break-even is 0.09-3.47 bps against a
5-10 bps taker — but see the window-dependence caveat in `RUN-ANALYSIS.md` §10.5:
on the 600-bar design the momentum/acceleration break-even is **14.6 / 11.6 bps**,
so the cost verdict is a property of the sample, not of the strategy), and a
controller/A-B fidelity sweep then found a defect in the *driver*
that changes how its baseline row must be read (`BUGS.md` #33): `analyze.js`
streams `candles.slice(0, i)` into `getSignal` where production streams
`state.cache.slice(-cacheSize)` (`legion/workers.js`), so the controller's candle
table re-inserts its own trimmed history on every call and `_updateOpenTrades` —
which has no timestamp guard — closes trades against bars older than their entry.
Measured: 78/144 wins with the prefix vs 156/64 with the production window on the
same seed and data. The signal-family rows are unaffected (they never construct a
controller), so the "the ceiling is economic" verdict stands, but the baseline
comparison does not, and the fix is a precondition for any further measurement.
Round 26's shape is therefore: **correctness** (R26-0 the window fix, R26-1 a
repeatable controller sweep, R26-11 label-policy variants) before **throughput**
(R26-12 the checkpoint throttle, R26-4 parallel folds) before
**economics** (R26-3 the unified policy, R26-5 the holding/turnover sweep, R26-6
effective independence) before
**decision quality** (R26-2/R26-7/R26-8) and the **method** question (R26-9), with a
**family-search** half (R26-13 seed replication with common random numbers,
R26-14 forecast comparison + Model Confidence Set, R26-15 gated racing) that
decides *which* family the following round builds. The second sweep pass
(`RUN-ANALYSIS.md` §8.4) also withdrew round 25c's cost attribution — a
production-shaped window costs the same per call as the prefix — so nothing is
sized on the churn. No new mechanism, no training-arithmetic change, no golden
re-freeze is in scope.
