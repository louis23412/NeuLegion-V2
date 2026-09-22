# NeuLegion — runbook (configuration & commands)

Everything needed to install, configure, run, and verify the frozen core design
(see [`DESIGN.md`](DESIGN.md)). This is a Node.js project and is **not** runnable
in the Perchance preview.

## 1. Requirements

- **Node.js ≥ 22** (the suite uses `node:test`, `worker_threads`, and ESM; the
  test script passes an explicit **glob** to the runner, because Node dropped
  directory arguments for `node --test` — see §7. Developed and verified against
  Node **v25.9.0**).
- A C/C++ toolchain for `better-sqlite3@^12` (or a prebuilt binary for your
  platform — `npm install` will use one when available).
- No network needed for tests; only the candle fetcher talks to the network.

## 2. Install

```bash
npm install        # or: npm ci   (reproducible, uses package-lock.json)
```

## 3. Commands

| Command | What it does |
| --- | --- |
| `npm run train` | run the system: `node ./src/mainController.js` (reads `src/candles.jsonl`; HTTP state view on `CONFIG.httpPort`, default 3000) |
| `npm test` | the full Node suite (`node --test "test/node/*.test.js"`) — the authoritative local gate |
| `npm run test:locks` | the lock registry only |
| `npm run test:candles` | the candle data/quality audit only |
| `npm run test:analysis` | the analysis / walk-forward supercharges only |
| `npm run fetch` | incremental update of `src/candles.jsonl` |
| `npm run fetch:full` | backfill from the earliest available bar |
| `npm run fetch:check` | report only (no network, no write) |
| `npm run fetch:all` | incremental update of **every** symbol in the manifest |
| `npm run fetch:all:full` | backfill every symbol |
| `npm run fetch:all:check` | audit every symbol (no network, no write) |

**Pre-run gates + evaluation (ROADMAP P0-3/P2):**

| Command | What it does |
| --- | --- |
| `npm run preflight` | read-only pre-run gate: node floor, candle sample, state dir writable, native SQLite round-trip, `CONFIG` sanity, a real worker smoke test, port availability, disk/memory headroom — exits non-zero on failure (proven by `preflight.test.js`) |
| `npm run dryrun` | run the real pipeline over a seeded synthetic stream into a temp state dir and self-check its invariants (batch timing, finite/shape checks, persistence round-trip, vault growth, observer alerts) — exits non-zero on any failure |

`NEULEGION_STATE` / `NEULEGION_FILE` (overrides), `NEULEGION_HTTP_PORT`
(`0` = ephemeral loopback), `NEULEGION_SEED` and `CONFIG.maxBatches` are the
enablers those commands and the node-only runner/worker tests will use.

Fetcher options (`--symbol`, `--interval`, `--source`, `--out`, `--mode`,
`--limit`, `--since`, …) are documented at the top of `src/fetch_candles.js`.
Binance's `api.binance.com` is geo-blocked in some networks; the fetcher defaults
to `data-api.binance.vision` and falls through Bybit / Coinbase.

## 4. Configuration

All tunables live in **`CONFIG`** at the top of `src/legion/config.js`.

### 4.1 The knobs that matter

| Key | Default | Meaning |
| --- | --- | --- |
| `forceMin` | `true` | use the compact dimensions (CPU-constrained). The full-size branch is audited by `dimensions.test.js` (185 checks) — flipping to `false` is a deliberate re-freeze between two tested branches. |
| `baseGroups` / `baseSections` / `baseLayers` | `2 / 2 / 2` | the group × section × layer slot grid |
| `basePop` + `group/section/layerPopBoost` | `64`, `+5% / +15% / +25%` | ensemble population per tier |
| `baseCache` + boosts | `500`, `+15% / +25% / +35%` | prototype cache size per tier |
| `maxTier`, `tierWeightMultiplier` | `4`, `0.35` | hierarchy depth and the per-tier signal weight decay |
| `baseAtr` / `baseStop` / `minPriceMove` / `maxPriceMove` | `2 / 1 / 0.0025 / 0.05` | ATR and stop/target sizing, with per-tier boosts |
| `broadcastRatio` / `injectionRatio` | `0.025 / 0.025` | how much of the ensemble is shared between controllers / seeded |
| `candleWickRepair` / `candleMaxWickFraction` | `true / 0.9` | read-time winsorize of physically-impossible wicks |
| `maxWorkers` | `25% of availableParallelism()` | worker-pool size |
| `httpPort` | `3000` | read-only HTTP state view |
| `stateFolder` | `../../state` | SQLite state directory |
| `file` | `src/candles.jsonl` | default candle stream (BTCUSDT 1h) |

Memory-bank decay / consolidation / hierarchy thresholds are in the same object;
their defaults are the ones all tests run against.

### 4.2 Optional features (all **off by default**)

These are proven but opt-in (see [`DESIGN.md`](DESIGN.md) §4). Enable them by
assigning the flag on a live `HiveMind` before training, e.g.:

```js
hm._multiProbeConfig = { maxFlips: 2, budget: 8 };        // margin multi-probe
hm._multiProbeConfig = { adaptive: true, budgetCap: 64 }; // query-adaptive budget
hm._pcaHashConfig    = { seed: 4242, iters: 48, rankPolicy: 'above-mean' };
hm._queryModConfig   = { alpha: 1, topK: 16, rounds: 1, maxFlips: 2, probeBudget: 8 };
hm._surpriseGateEnabled = true;
hm._sampleWeightConfig  = { /* see training/sample_weights.js */ };
hm._homeostasisEnabled  = true;
```

None of them change the golden fingerprints while off; turning one on by default
in `CONFIG`/code is a deliberate decision gated on the walk-forward A/B
(backlog P0).

## 5. Running & data

```bash
npm install
npm run fetch:check    # confirm the shipped candle files are intact
npm run train          # run the controller/legion system
# then open http://localhost:3000 for the read-only state view
```

The shipped manifest is 8 Binance 1h symbols (~567k rows / ~63 MB) audited by
`candles.test.js`; the default stream is `src/candles.jsonl`. A scheduled
workflow source lives at `docs/ci/update-candles.yml` (copy it to
`.github/workflows/` — the workspace file API forbids a literal `.github` dir).

## 6. Tests — the authoritative gate

```bash
npm test               # full Node suite (real better-sqlite3 + worker_threads)
```

The glob expands to all 41 `test/node/*.test.js` mirrors (`helpers.js` is not a
test file and is excluded).

The Node suite mirrors the browser entries in two styles: **22 mirrors** import
the browser entry's `run()` and assert `failed === 0` **and**
`result.total ===` that entry's count in the ledger below (analysis, analyze,
binarypc, bitweight, candles, dimensions, evolve, golden, homeostasis, locks,
lsh, modules, multiprobe, multisymbol, price_precision, querymod, sample_weights,
surprise, walkforward — the counts are **exact** as of round 23, not floors; every
number was re-measured in the harness before pinning), and **19 mirrors**
re-declare the same contracts directly with `node:test`
against the real driver (sanity, core, features, indicators, fetcher,
consolidation, consolidation_worker, legion) or check the mirror layout and
invariants the browser harness cannot (the thirteen Node-only suites). The Node-only
suites are `mirrors.test.js` (every browser entry has a mirror, no orphans, no
stub mirror files, the ledger counts 30 entries / 42 mirrors, the `test` script
passes a glob rather than a directory, and `engines.node` pins the required Node
floor — `BUGS.md` #14); `engine_portability.test.js` (a single golden pass under
a simulated last-ulp transcendental drift still satisfies all 23 checks —
`BUGS.md` #17); `worker_pool.test.js` (worker fault injection: `{error}` payload,
`error` event, non-zero exit, malformed message, spawn failure, watchdog
timeout, settle-once); `runner_smoke.test.js` (a good stream completes, a
malformed line is counted and skipped, a broken pool breaches the failure
budget); `dryrun.test.js` (the `runner → batch → worker → controller → observer`
dry run self-check); `preflight.test.js` (the environment gate); `http_view.test.js`
(dashboard routes + the EADDRINUSE fallback); `report_lifecycle.test.js`
(run-dir/manifest/spool/report + retention pruning on a real fs); and
`shutdown.test.js` (SIGINT checkpoints + writes the report); and
`config_env.test.js` (the config env overrides land before the DBs open); and
`parallel_folds.test.js` (R26-4: a real `runAnalysis` serial vs 2-way parallel gives
a byte-identical `folds.jsonl` and verdict — real `worker_threads`); and
`analyze_cli.test.js` (R26-5 + R26-13: spawns the real `analyze` CLI to prove
`--turnover-sweep`/`--turnover-target` and `--crn`/`--seeds` are documented and
threaded into the run, and that the seed aggregate is written — the browser entry
imports `runAnalysis` directly, so the argument-parsing block is otherwise
untested). `bench` is the only
browser entry
without a mirror (it prints timings). So `npm test` reports **123 `test()`
blocks across 42 files** (43 with `helpers.js`) rather than 2289 checks; a green
run — plus `failed === 0` and the ledger count from every wrap-style mirror — is
the gate. Measured **~5.9 min** at round 22 (`BUGS.md` #21): the `dimensions`
sweep of both `forceMin` branches dominates (~353 s), then `lsh` (~177 s) and
`walkforward` (~83 s); the runner parallelises the rest. Re-measured in the
round-23 harness run: `dimensions` 364 s, `lsh` 282 s, `multisymbol` 17 s,
`candles` 3 s, and `walkforward`/`analysis`/`analyze`/`golden`/`locks` each well
under a minute.

The counts below are each **browser entry's** own check count — the ledger the
wrap-style mirrors assert against. **Expected totals (all must be 0 failures):**

| entry | checks | | entry | checks |
| --- | ---: | --- | --- | ---: |
| `sanity` | 59 | | `lsh` | 69 |
| `core` | 42 | | `surprise` | 32 |
| `indicators` | 75 | | `sample_weights` | 36 |
| `features` | 11 | | `homeostasis` | 30 |
| `consolidation` | 48 | | `evolve` | 36 |
| `consolidation_worker` | 18 | | `multiprobe` | 77 |
| `fetcher` | 101 | | `binarypc` | 39 |
| `golden` | 23 | | `bitweight` | 69 |
| `modules` | 51 | | `querymod` | 51 |
| `legion` | 57 | | `walkforward` | 62 |
| `candles` | 95 | | `dimensions` | 185 |
| `locks` | 41 | | `analysis` | 562 |
| `price_precision` | 29 | | `multisymbol` | 28 |
| `guards` | 65 | | `observer` | 76 |
| `analyze` | 222 | | | |

**Total: 2289 checks.** Every one passed in the development sandbox's browser
harness (esbuild-wasm + sql.js shims) at the freeze; `npm test` is the local
confirmation on the real native drivers. (Round 23 changed three counts:
`walkforward` 31 → 48 from the `viewFor`/vacuity section K, `analysis` 354 → 390
from section AC (the signal family + pooling + the audited world), `analyze`
47 → 98 from the controller factory / signal dispatch / pooling / `readCandles`
sections plus section N (the whole `runAnalysis` CLI path with injected fakes).
Round 24 changed one count: `analyze` 98 → 129 from sections O (per-fit state
reclamation: `modelRetention` discard/keep, identical positions, idempotent
disposal), P (the reporting event stream: per-fold/per-pass events, the audit
reachability counter, `probesPerFold`/`auditVerdict`) and Q (run checkpointing:
`run.json`/`report.json`/`partial-report.json`/`progress.json`/`folds.jsonl`/`run.log`,
the roster-scaled event budget, `--fold-log=off`, `--keep-models`, and the
failed-run post-mortem); total 1949 → 1980. The counts of only one entry changed, so the other 19
wrap-style mirrors kept their number and only their operator changed. Round 24b changed two counts: `analyze` 129 → 143 (section R and the power-honesty line: the volume-shocked audit, the assumption-free break-even cost, `--reuse-base`, the offline-readable journal) and `walkforward` 48 → 49 (`barsToDetect`/`underpowered`); total 1980 → 1995.) Round 25 changed three counts: `analysis` 390 → 437 (section AD: the dependence primitives against exact hand-computed values — Pearson, the Kish design effect, the delete-one-cluster jackknife, the paired t(C-1) test against an independently derived closed form, the exact sign test, the Student-t CDF — plus the gate semantics, the cost ladder, the family-correlation diagnostic and a zero-skill size comparison of the classic vs dependence gates), `walkforward` 49 → 62 (section 9: `poolReports`' dependence block and honest `power*` line, byte-identical cost restatement, the ladder, the paired test, the new gate states, and the report's new render lines) and `analyze` 143 → 158 (section L2: `evaluateAB` threading `gateOptions` into every decision, the dependence-aware report, recorded timings; section N: the driver's `gate`/`gateAlpha`/`gateOptions`, `skipped-no-panel` on a single stream, the default cost ladder, the family diagnostic, per-variant `timings`, and the proof that `--gate=classic` promotes exactly the same set); total 1995 → 2070.) Round 26 (R26-0) changed two counts: `core` 20 → 26 (sections E/F/G: the `_updateOpenTrades` entry-timestamp guard, the production-window vs prefix re-insert contract, and the duplicate-open-trade degrade path) and `analyze` 158 → 160 (the controller factory's per-call *input* contract: every `getSignal` receives at most `cacheSize` candles, contiguous and advancing — the `BUGS.md` #33 regression guard); total 2070 → 2078. Round 26 (R26-12) changed the same two counts again: `core` 26 → 32 (section H: the `_saveInterval` default, the dump-count arithmetic at k=1/3/∞, and the proof that the emitted signal stream is identical at every interval — the throttle only changes *when* the ensemble state is written) and `analyze` 160 → 166 (the factory default/threading of `saveInterval`, the driver defaulting the A/B to `Infinity`, and the field recorded in `run.json`/`report.json`), and `modules` 50 → 51 (the controller's public API manifest now lists `flushState`); total 2078 → 2091. Round 26 (R26-2) changed the same two counts again: `core` 32 → 36 (section I: the label-lifecycle counters — the resolved-barrier split, the Brier components and their SQLite round-trip, and the non-enumerable dropped-candle diagnostic) and `analyze` 166 → 173 (the base-rate/skill diagnostics and the three-state status, the readiness gate replacing the dead `undertrained` guard, and the per-variant `model` block plus the `models:` summary line in `report.json`); total 2091 → 2102. Round 26 (R26-3) changed two counts: `analysis` 437 → 442 and `analyze` 173 → 177 (the one confidence→position pipeline: `confidenceToPosition`/`confidenceFromProb`, `restateReportAtPolicy`/`verifyPolicyRoundTrip`, the raw pre-policy confidence journaled in `folds.jsonl`, and the policy round-trip certificate in `report.json`); total 2102 → 2111. Round 26 (R26-11) changed the same two counts again: `core` 36 → 42 (section J: the trade-label policy — the `optimistic` default, the `conservative` stop-first tie-break and worst-price gapped stop, the `triple` time barrier, and the lifecycle-counter SQLite round-trip) and `analyze` 177 → 184 (the opt-in label variants: id resolution without a roster change, the controller-level policy override against the run default, `--label-policies` appending exactly two candidates, the controller-scoped exclusion on `--model=bare`, the recorded `labelPolicy`/`labelHorizonBars` in `run.json`/`report.json`, and the named error for an unknown policy); total 2111 → 2124. Round 26 (R26-4) changed two counts: `analysis` 442 → 453 (the order-preserving concurrent scheduler, the async fold twins byte-identical to the serial ones, and the executor reply contract) and `analyze` 184 → 191 (the `evaluateABAsync` driver byte-identical to `evaluateAB`, the worker-dispatcher contract, and `runAnalysis` recorded `concurrency`); total 2124 → 2142. Round 26 also **re-froze three controller fingerprints** in `golden.test.js` (`ctl:finalSignal`, `ctl:signalTrajectory`, `ctl:accuracyTotals`), deliberately: the controller block had been fed the whole growing candle prefix, which is the very input shape `#33` showed to be mislabelling; it is now fed the production window and the guard makes the two shapes agree (see `BUGS.md` #33 and `#36`-adjacent notes). Round 26 (R26-5) changed two counts: `analysis` 453 → 463 (section AF: the confidence→position layer with a holding rule — the byte-identical default path, the enter/exit hysteresis band, the minimum holding period, the frozen grid cross product, and the `turnoverSweep` enumeration/sort/participation/target logic) and `analyze` 191 → 198 (the opt-in turnover block: off-by-default nulls, the 8x1x6 grid and row count, the sorted rows, the rendered summary, the pure-post-processing proof against an identical sweep-off run, and the `run.json`/`report.json` persistence); total 2142 → 2159. A new node-only `analyze_cli.test.js` spawns the real CLI to prove `--turnover-sweep`/`--turnover-target` are documented and threaded into the run. Round 26 (R26-6) changed the same two counts: `analysis` 463 → 475 (section AG: the exact OHLCV resampler, the Kish design effect 1+(K-1)rbar, the single-stream/identical/hedging cases, and the greedy stream selection) and `analyze` 198 → 204 (the opt-in interval resampling and `--select-streams` basket measurement/keep-n, plus their `run.json`/`report.json` records); total 2159 → 2177. Round 26 (R26-13) changed the same two counts: `analysis` 475 → 491 (section AH: the interquartile mean, the stratified bootstrap CI — including the zero-width proof that it resamples within strata — the hand-computed seed/fold/residual variance split, the seed-distribution block and the CRN paired-variance criterion) and `analyze` 204 → 213 (CRN on by default with a variant-independent fold seed and `--crn=0` restoring the historical one, the per-fold net-Sharpe series on every row, and `replicateAnalysis`/`--seeds` aggregating the per-variant seed distribution); total 2177 → 2202. Round 26 (R26-14) changed the same two counts: `analysis` 491 → 523 (section AI: the forecast layer — exact Brier/logScore, the Murphy reliability/resolution/uncertainty partition and its identity, deterministic bootstrap means, the Diebold-Mariano degenerate and noisy cases, the Model Confidence Set dominance/elimination/monotonicity, and the whole-layer `forecastComparison`) and `analyze` 213 → 216 (the forecast block on by default, its summary line, and the proof that `forecast=false` nulls it while moving no scored number); total 2202 → 2229. A second node-only block in `analyze_cli.test.js` spawns the real CLI to prove `--seeds`/`--crn`/`--forecast` are documented, that the seed aggregate is written, and that CRN is recorded honestly. Round 26 (R26-7) changed one count: `analysis` 515 → 523 (section AJ: `clusterStability` against hand-computed stable/fragile/unavailable panels, plus the gate fixtures — a tiny edge fails the magnitude floor while a broad-but-thin edge fails stability and a real spread edge passes — and the rewritten gate reader) while `analyze` stayed 216, because the gate change lives in the dependence/walkforward layer rather than the driver — total 2229 → 2237. Round 26 (R26-8) changed two counts: `analysis` 523 → 547 (section AK: the decision-grade primitives — `foldConcentration` exact on a hand-built fold grid and against an independent leave-one-out Sharpe sweep, `confidencePersistence` exact on alternating/monotone/`[0,0,1,1,1]` series, `nextRunPlan` on a frozen power fixture, and the `decisionReport` composition + `formatDecision`) and `analyze` 216 → 220 (the decision block on by default, the featured candidate and pass-through blocks, the summary lines, and the proof that `decision=false` nulls it while moving no scored number) — total 2237 → 2265. A third node-only block in `analyze_cli.test.js` spawns the real CLI to prove `--decision=0` is documented, nulls the block and changes no scored number. Round 26 (R26-9) added three checks to `analysis` (section AL: the correlated-fold null — the exact sign test calibrated on independent fold windows, its measured size inflation under a common fold component, and the design-effect identity) while `analyze` stayed 220 — total 2265 → 2268; the decision itself is recorded in `docs/METHOD.md` §1. Round 26 (R26-10) added eight checks across two entries: section K in `guards.test.js` (the reader boundary-degradation matrix — empty, short, corrupt row, NaN, duplicate timestamp, shuffled order and `maxBars`) and the report-completeness contract in `analyze.test.js` — `guards` 58 → 65, `analyze` 220 → 221, total 2268 → 2276. Round 26 (R26-15) added nine checks to `analysis` (section AM: the successive-halving engine and its full-grid validation — `halvingRounds`/`halvingSchedule` exact, the race winner agreeing with the brute-force oracle, the budget-saving identity, a non-finite elimination, a minimise race, the unavailable guards and `formatRace`) while `analyze` stayed 221 — total 2276 → 2285; the engine is registered `LOCKED-invariant` but the `--race` driver stays GATED (see `docs/METHOD.md` §2). Round 26b (the final review) added one check to `analysis` (the paired-units sizing in `nextRunPlan` — R26-8 clause 6 / R26-13) and one to `analyze.test.js` (a real MULTI-STREAM run must populate the decision block's paired sizing, journal decay and leave-one-fold range — the integration shape a bare-number unit fixture cannot see), and corrected three defects found by that review (`BUGS.md` #38/#39/#40: the magnitude cheapest-flip read the paired difference as a scalar when a real report carries an object; the sign test was a leave-one-out form, not the per-window test it documents; the training label distribution read a field the model summary never produces) — `analysis` 559 → 562, `analyze` 221 → 222, total 2285 → 2289. The first local run passed every block
that executed on native SQLite (`BUGS.md` #15 records the run and the three
mirror-harness defects it exposed — none in `src/`). `golden` (23) was
subsequently given a node mirror, so the bit-exactness lock — and therefore every
`BIT_EXACT` status in `test/lock-registry.js` — is now verified on the native
driver and not only on the sql.js shim (`BUGS.md` #16). The second local run then
showed 22/23 checks bit-identical on the native driver and only `hm:predictions`
differing; that one fingerprint hashed raw unrounded float64 `predict()` output,
so it was engine-sensitive rather than driver-sensitive, and is now compared at 6
significant digits (the raw values are still returned in the failure detail).
`engine_portability.test.js` pins the invariant under a simulated 1-ulp `Math.exp`
drift, and the other ten hashes are still literal (`BUGS.md` #17).

**The gate is now green**: the round-22 local run reported **115 tests, 115 pass,
0 fail** (~5.9 min) on the real driver — see `docs/BUGS.md` #21 (and #20 for the
one `preflight` defect that run exposed and fixed). The round-21 run (89/89) was
the one that promoted the three controller DB bags (§6.1).

The browser suite (no Node needed) is `test/browser/entries/*.test.js` bundled by
`test/browser/harness.js`; see `../README.md` for how to run an entry headlessly.
`golden.test.js` is the one to run after **any** edit under `src/hivemind/`: a
changed fingerprint is either an intentional re-freeze (update the constants in
the same commit and say why in the registry note) or a bug.

### 6.1 What local green promotes

Three controller bags were `NEEDS-LOCAL-RUN` (native `better-sqlite3`):
`controllerDatabase`, `controllerAccuracy`, `controllerTrade`. The local gate is
now green (`npm test`, **115/115 blocks, 0 failures** at round 22 — `docs/BUGS.md`
#20/#21), so all
three are **promoted to `LOCKED-invariant`** in `test/lock-registry.js` and
recorded in `docs/LOCKED.md`. The registry now has **0 `NEEDS-LOCAL-RUN`**
entries; no local-run blocker remains. The **run integrity / observability /
evaluation programme (ROADMAP P0-P3) is now implemented** — see the round-22
section of `ROADMAP.md` and `BUGS.md` #19. **Round 23 (N0/N1/N2) is now
implemented too** (`ROADMAP.md`): the A/B drives the *shipped* controller path
(`makeControllerModelFactory`), the audit perturbs that model's actual candle
input (`viewFor`, `analysis/world.js` — `BUGS.md` #22), the candidate family is
K = 15 (7 mechanism flags + 8 causal signals from `analysis/features.js`), every
report carries a power/MDE readout, and `--symbols=all` pools all 8 audited
symbols. **N3, the verdict, is now DELIVERED**: the power run
(`20260920T144633-seed1`, 8 streams / 288 folds / 4,320 pooled bars, 11.98 h) gave
**all 14 candidates keep-off**, **SPA p = 0.5699**, baseline pooled Sharpe +0.4387,
with no golden re-frozen (`OPTIMIZATION.md`, `RUN-ANALYSIS.md` §5). What that run
also showed is that the report's *own* claims needed work — the power readout
ignores cross-stream correlation (`BUGS.md` #26) and the verdict is not
cost-robust (`BUGS.md` #27) — which is round 25. The run-integrity code is
**delivered and pinned in `analyze.test.js` §O/§P/§Q/§R**. `npm run preflight` and
`npm run dryrun` remain the mandatory pre-run gates.

### What to attach from an `analyze` run

An `analyze` run directory is `state/runs/<runId>/`. Round 24 (`BUGS.md` #24) made
the run crash-safe, self-describing and reclaiming, so the artifact set is now:

```
state/runs/<runId>/run.json              # the manifest (config, streams, folds, roster, modelRetention, requireReachable, foldLog)
state/runs/<runId>/report.json           # CANONICAL verdict: pooled metrics, decisions, audit block, power, SPA (status:'complete')
state/runs/<runId>/partial-report.json   # live checkpoint, rewritten after every variant (status: running|complete|failed)
state/runs/<runId>/progress.json         # liveness heartbeat (updatedAt / elapsedMs / phase / counters / etaMs)
state/runs/<runId>/folds.jsonl           # one line per scored fold + audit pass (bar indices, positions, returns, metrics)
state/runs/<runId>/run.log               # the structured event journal
```

`models/` (one SQLite state dir per fit) is **reclaimed by default** — the CLI runs
`modelRetention: 'discard'`, so every fit dir is closed and deleted once its
prediction is consumed and an empty `models/` is removed at the end. It is measured
at **0.708 MiB per fit** (~11.9 GiB for a full 15-variant, 8-symbol run), so it must
never be attached or archived; `--keep-models` retains it for forensics. Attach
`run.json` + `report.json` + `run.log` (add `folds.jsonl` to let an offline reader
recompute the pooled metrics and the audit); `partial-report.json` and
`progress.json` are diagnostics.

**Watch a run — tell frozen from progressing.** With the default `--progress-ms=5000`
the CLI prints one greppable line per 5 s (and at every variant boundary):

```
[analyze] mm:ss elapsed | variant i/N <id> | stream s/S | phase fold i/N | events d/T (p%) | last event Xs
```

`last event` is the age of the last completed pass: if it keeps climbing while
`events d/T` and the fold index stand still, the run is frozen (not merely slow).
The same state lives in `progress.json` (`updatedAt` advancing = alive;
`counters.events/eventsTotal` = the pass budget; `etaMs` = a linear estimate).
`--progress-ms=0` prints every pass, `-1` is silent. `--fold-log=all|score|off`
controls `folds.jsonl`. Round-24 flags: `--cost-bps=<n>`, `--reuse-base`, `--keep-models`, `--reachable`,
`--fold-log=all|score|off`, `--progress-ms=<n>`, `--help` (`ANALYZE_USAGE`).

**The verdict loop and the power run.** Both halves are done. The smoke run
(39.0 min, 960 passes) returned an **underpowered null** (`RUN-ANALYSIS.md` §3).
The power run —
`npm run analyze -- --symbols=all --bars=600 --audit-probes=1 --reuse-base` —
completed as `20260920T144633-seed1` in **11.98 h** (288 folds, 4,320 pooled bars)
and returned the **N3 verdict**: all 14 candidates keep-off, SPA p = 0.5699
(Rejects = [none]), baseline pooled Sharpe **+0.4387** / DSR 0.5179 / break-even
12.42 bps; `query-mod` (DSR 0.9992), `sig:momentum` (1.1059) and `sig:acceleration`
(1.0502) miss only the fold-consistency hurdles (`RUN-ANALYSIS.md` §5). Read the
printed `breakEven=` per candidate next to each `power:` line: an apparent edge
whose break-even cost is below ~10-15 bps is inside a realistic taker cost.

**Sizing a run (measured; CORRECTED in round 25b).** The cost is **not** a fixed
per-fit number. The fit warms an online controller by replaying all history
(`for (i = 1..testStart) getSignal(candles.slice(0, i))`), so the driver is the
number of warm-up calls, not the fit count:

```
time ≈ 0.035 s × Σ_f(testStart_f) × streams × passes × mechanismVariants
Σ_f(testStart_f) = F·trainSize + testSize·F(F−1)/2        (F = folds per stream)
```

i.e. **O(n²) per stream** — per-fold cost grows with the fold index (10.7 s at 36
folds/stream, 42.6 s at 142). Measured: 8 streams × 600 bars × 7 mechanisms = 11.98 h;
8 streams × 2,200 bars × **1** mechanism = 26.9 h. So a *signal* candidate is free,
a *mechanism* candidate multiplies the run by ~its share of the roster,
`--audit-probes=1` is not optional at scale, and **for a fixed pooled-bar budget,
many short streams are far cheaper than a few long ones**
(`time ∝ pooledBars × folds-per-stream`). See `RUN-ANALYSIS.md` §4 and
`OPTIMIZATION.md` "Round 25b".

**Sanity-checking a verdict before believing it.** `folds.jsonl` is enough to
recompute the report end to end (`RUN-ANALYSIS.md` §5.3). Also recompute the
decision at a couple of cost levels: at 0 bps this run says "keep-off", at 2 bps
`sig:acceleration` promotes with zero reasons — so a verdict read off a single
cost level is a verdict about that cost level (`BUGS.md` #27).

**Determinism smoke test.** Two identical small runs (`npm run analyze -- --bars=200
--test=20`) must produce an identical `report.summary` and identical per-candidate
pooled metrics/decisions; `analyze.test.js` §Q pins this in the harness, so a
disagreement on a real run is a real-driver bug, not noise.

## 7. Troubleshooting

- **`npm test` dies with `Error: Cannot find module '.../test/node'` and reports
  `tests 1 / fail 1` without running anything.** The test script's positional
  argument is the runner interface, and that interface changed: Node ≤ 21
  accepted a *directory* (`node --test test/node/`) and searched it recursively,
  while Node ≥ 22 resolves the argument as a **glob(7) pattern** and tries to
  load a bare directory as a module. The shipped script therefore uses
  `node --test "test/node/*.test.js"` (quoted, so the shell does not expand it
  first). If you see this signature, your `package.json` predates the fix — pull
  the current one. Minimum supported Node is 22; Node 20 (EOL) can no longer run
   `npm test` at all. Recorded as `BUGS.md` #14.
- **`ERR_UNSUPPORTED_ESM_URL_SCHEME ... Received protocol 'https:'` while a
  mirror loads.** An entry gained a *static* import of the sql.js shim
  (`test/browser/shims/better-sqlite3.js`), whose first import is
  `https://cdn.jsdelivr.net/...`. The browser harness bundles that fine;
  Node's ESM loader rejects the scheme. Import the shim (and run
  `shim.__ensureSql()`) **lazily inside `run()`**, and have the mirror pass
  `ensureSql: async () => {}`. Recorded as `BUGS.md` #15.3.
- **`ERR_MODULE_NOT_FOUND: .../test/src/...`.** A mirror's relative import depth
  is one level short: from `test/node/` it is `../../src/...` (the browser
  entries under `test/browser/entries/` use `../../../src/...`). Recorded as
  `BUGS.md` #15.1.
- **A mirror reports `protos=0/<n>` (or a failed save/load round-trip).** The
  injected `stateDir` is not pure in its label — an entry saves and reloads
  through the *same* label and expects the same directory. Use
  `labelledStateDir` from `test/node/helpers.js`. Recorded as `BUGS.md` #15.2.
- **`better-sqlite3` fails to build** — install a C++ toolchain, or pin a
  prebuilt-supported Node version; the browser suite needs none of this.
- **Fetcher 403/timeout** — a geo-block; the fetcher already falls through
  `data-api.binance.vision` → Bybit → Coinbase. Use `npm run fetch:check` to work
  offline.
- **A changed golden fingerprint** — expected only for an intentional hot-math
  change; re-freeze deliberately (see [`OPTIMIZATION.md`](OPTIMIZATION.md)).
- **`forceMin`** — `true` (default) is the CPU-constrained branch; `false` is the
  full-size branch, both tested by `dimensions.test.js`.
