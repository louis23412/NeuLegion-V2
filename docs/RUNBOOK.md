# NeuLegion — runbook (configuration & commands)

Everything needed to install, configure, run, and verify the frozen core design
(see [`DESIGN.md`](DESIGN.md)). This is a Node.js project and is **not** runnable
in the Perchance preview.

> **Round 27 is implemented and run (R27-1…R27-9; R27-7a–d complete — `RUN-ANALYSIS.md` §13).** The
> changes are in the tree: per-candidate liveness
> certificates (with duplicate detection and a reduced-`K` DSR restatement),
> fail-closed input handling, the #49 holding-period / `triple`-vertical-barrier fix,
> and the runs that execute the never-completed label-policy and (re-scoped)
> sample-weighting experiments — all in
> [`PLAN-round27.md`](PLAN-round27.md) §6. It changed two A/B defaults
> (`requireReachable` → true, `--audit-probes` → 1); the sections below describe the
> **shipped** behaviour, the round-27 verdicts are summarised in §6.1, and the test
> totals are in §7.

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

### 5.1 The A/B verdict + the round-30 operator set

The `analyze` run set (and, from round 30, the P1/P3/P4 re-runs, the pruned verdict run, the G-F
seed replication, the G-G breadth run and the G-H momentum-upgrade run) is scripted. It defines the 15m/funding file lists and
**checks every file exists before running**, so the empty-list fallback that invalidated the
2026-09-24/25 3c/3d runs (`BUGS.md` #69) cannot recur:

```bash
bash scripts/round30-runs.sh            # prints the stage list
bash scripts/round30-runs.sh p3         # one stage per invocation
bash scripts/round30-runs.sh all        # the whole set (hours)
```

`round29-TESTING.md` §3 is the full command reference and the per-run readouts; `PLAN-round30.md`
§6.3 lists the immediate runs and §6.2 the gates (`G-F…G-K`). Every run writes `state/runs/<runId>/`.

## 6. Tests — the authoritative gate

```bash
npm test               # full Node suite (real better-sqlite3 + worker_threads)
```

The glob expands to all 43 `test/node/*.test.js` files (`helpers.js` is not a
test file and is excluded).

The Node suite mirrors the browser entries in two styles: **22 mirrors** import
the browser entry's `run()` and assert `failed === 0` **and**
`result.total ===` that entry's count in the ledger below (analysis, analyze,
binarypc, bitweight, candles, dimensions, evolve, golden, guards, homeostasis,
locks, lsh, modules, multiprobe, multisymbol, observer, price_precision, querymod,
sample_weights, surprise, walkforward, controller_invariants — the counts are
**exact** as of the round-29 ledger, not floors; every
number was re-measured in the harness before pinning), and **21 of the remaining files**
re-declare the same contracts directly with `node:test`
against the real driver (sanity, core, features, indicators, fetcher,
consolidation, consolidation_worker, legion — 8) or check the mirror layout and
invariants the browser harness cannot (the thirteen Node-only suites). The Node-only
suites are `mirrors.test.js` (every browser entry has a mirror, no orphans, no
stub mirror files, the ledger counts 31 entries / 43 mirrors, the `test` script
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
`analyze_cli.test.js` (R26-5 + R26-13 + R26-8 + R27-9: spawns the real `analyze` CLI to prove
`--turnover-sweep`/`--turnover-target`, `--crn`/`--seeds`, `--decision=0` and the
round-27 surface (`--list-variants`, `--reachable=0`, `--min-training-steps`,
`--audit-probes`) are documented and threaded into the run, that `--list-variants`
starts no run, and that the seed aggregate is written — the browser entry
imports `runAnalysis` directly, so the argument-parsing block is otherwise
untested). `bench` is the only
browser entry
without a mirror (it prints timings). So `npm test` reports **128 `test()`
blocks across 43 files** (44 with `helpers.js`) rather than 2585 checks; a green
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
| `sanity` | 60 | | `lsh` | 75 |
| `core` | 46 | | `surprise` | 32 |
| `indicators` | 75 | | `sample_weights` | 57 |
| `features` | 11 | | `homeostasis` | 30 |
| `consolidation` | 48 | | `evolve` | 36 |
| `consolidation_worker` | 18 | | `multiprobe` | 77 |
| `fetcher` | 111 | | `binarypc` | 39 |
| `golden` | 23 | | `bitweight` | 69 |
| `modules` | 51 | | `querymod` | 51 |
| `legion` | 57 | | `walkforward` | 63 |
| `candles` | 192 | | `dimensions` | 185 |
| `locks` | 41 | | `analysis` | 638 |
| `price_precision` | 29 | | `multisymbol` | 28 |
| `guards` | 65 | | `observer` | 76 |
| `analyze` | 279 | | `controller_invariants` | 23 |

**Total: 2585 checks.** (Round 30 changed two counts: `analyze` 269 → 279 — the pruned-roster pin,
the roster snapshot/registration and present-but-empty-list-flag checks, the cross-sectional
panel taxonomy checks, and the momentum-upgrade family check; `analysis` 621 → 638 — the
`SIGUP_CANDIDATES` momentum-upgrade section (§G-H, 636) plus the two §5 critical-mechanics property tests (`dsrAdjusted` is a re-run, not a shrink; promote ⇒ no failed gated hurdle); total 2558 → 2585. The `test/node/analyze.test.js`
mirror had been left at the stale 269 and is corrected to 279 here.) Every one passed in the
development sandbox's browser
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
wrap-style mirrors kept their number and only their operator changed. Round 24b changed two counts: `analyze` 129 → 143 (section R and the power-honesty line: the volume-shocked audit, the assumption-free break-even cost, `--reuse-base`, the offline-readable journal) and `walkforward` 48 → 49 (`barsToDetect`/`underpowered`); total 1980 → 1995.) Round 25 changed three counts: `analysis` 390 → 437 (section AD: the dependence primitives against exact hand-computed values — Pearson, the Kish design effect, the delete-one-cluster jackknife, the paired t(C-1) test against an independently derived closed form, the exact sign test, the Student-t CDF — plus the gate semantics, the cost ladder, the family-correlation diagnostic and a zero-skill size comparison of the classic vs dependence gates), `walkforward` 49 → 62 (section 9: `poolReports`' dependence block and honest `power*` line, byte-identical cost restatement, the ladder, the paired test, the new gate states, and the report's new render lines) and `analyze` 143 → 158 (section L2: `evaluateAB` threading `gateOptions` into every decision, the dependence-aware report, recorded timings; section N: the driver's `gate`/`gateAlpha`/`gateOptions`, `skipped-no-panel` on a single stream, the default cost ladder, the family diagnostic, per-variant `timings`, and the proof that `--gate=classic` promotes exactly the same set); total 1995 → 2070.) Round 26 (R26-0) changed two counts: `core` 20 → 26 (sections E/F/G: the `_updateOpenTrades` entry-timestamp guard, the production-window vs prefix re-insert contract, and the duplicate-open-trade degrade path) and `analyze` 158 → 160 (the controller factory's per-call *input* contract: every `getSignal` receives at most `cacheSize` candles, contiguous and advancing — the `BUGS.md` #33 regression guard); total 2070 → 2078. Round 26 (R26-12) changed the same two counts again: `core` 26 → 32 (section H: the `_saveInterval` default, the dump-count arithmetic at k=1/3/∞, and the proof that the emitted signal stream is identical at every interval — the throttle only changes *when* the ensemble state is written) and `analyze` 160 → 166 (the factory default/threading of `saveInterval`, the driver defaulting the A/B to `Infinity`, and the field recorded in `run.json`/`report.json`), and `modules` 50 → 51 (the controller's public API manifest now lists `flushState`); total 2078 → 2091. Round 26 (R26-2) changed the same two counts again: `core` 32 → 36 (section I: the label-lifecycle counters — the resolved-barrier split, the Brier components and their SQLite round-trip, and the non-enumerable dropped-candle diagnostic) and `analyze` 166 → 173 (the base-rate/skill diagnostics and the three-state status, the readiness gate replacing the dead `undertrained` guard, and the per-variant `model` block plus the `models:` summary line in `report.json`); total 2091 → 2102. Round 26 (R26-3) changed two counts: `analysis` 437 → 442 and `analyze` 173 → 177 (the one confidence→position pipeline: `confidenceToPosition`/`confidenceFromProb`, `restateReportAtPolicy`/`verifyPolicyRoundTrip`, the raw pre-policy confidence journaled in `folds.jsonl`, and the policy round-trip certificate in `report.json`); total 2102 → 2111. Round 26 (R26-11) changed the same two counts again: `core` 36 → 42 (section J: the trade-label policy — the `optimistic` default, the `conservative` stop-first tie-break and worst-price gapped stop, the `triple` time barrier, and the lifecycle-counter SQLite round-trip) and `analyze` 177 → 184 (the opt-in label variants: id resolution without a roster change, the controller-level policy override against the run default, `--label-policies` appending exactly two candidates, the controller-scoped exclusion on `--model=bare`, the recorded `labelPolicy`/`labelHorizonBars` in `run.json`/`report.json`, and the named error for an unknown policy); total 2111 → 2124. Round 26 (R26-4) changed two counts: `analysis` 442 → 453 (the order-preserving concurrent scheduler, the async fold twins byte-identical to the serial ones, and the executor reply contract) and `analyze` 184 → 191 (the `evaluateABAsync` driver byte-identical to `evaluateAB`, the worker-dispatcher contract, and `runAnalysis` recorded `concurrency`); total 2124 → 2142. Round 26 also **re-froze three controller fingerprints** in `golden.test.js` (`ctl:finalSignal`, `ctl:signalTrajectory`, `ctl:accuracyTotals`), deliberately: the controller block had been fed the whole growing candle prefix, which is the very input shape `#33` showed to be mislabelling; it is now fed the production window and the guard makes the two shapes agree (see `BUGS.md` #33 and `#36`-adjacent notes). Round 26 (R26-5) changed two counts: `analysis` 453 → 463 (section AF: the confidence→position layer with a holding rule — the byte-identical default path, the enter/exit hysteresis band, the minimum holding period, the frozen grid cross product, and the `turnoverSweep` enumeration/sort/participation/target logic) and `analyze` 191 → 198 (the opt-in turnover block: off-by-default nulls, the 8x1x6 grid and row count, the sorted rows, the rendered summary, the pure-post-processing proof against an identical sweep-off run, and the `run.json`/`report.json` persistence); total 2142 → 2159. A new node-only `analyze_cli.test.js` spawns the real CLI to prove `--turnover-sweep`/`--turnover-target` are documented and threaded into the run. Round 26 (R26-6) changed the same two counts: `analysis` 463 → 475 (section AG: the exact OHLCV resampler, the Kish design effect 1+(K-1)rbar, the single-stream/identical/hedging cases, and the greedy stream selection) and `analyze` 198 → 204 (the opt-in interval resampling and `--select-streams` basket measurement/keep-n, plus their `run.json`/`report.json` records); total 2159 → 2177. Round 26 (R26-13) changed the same two counts: `analysis` 475 → 491 (section AH: the interquartile mean, the stratified bootstrap CI — including the zero-width proof that it resamples within strata — the hand-computed seed/fold/residual variance split, the seed-distribution block and the CRN paired-variance criterion) and `analyze` 204 → 213 (CRN on by default with a variant-independent fold seed and `--crn=0` restoring the historical one, the per-fold net-Sharpe series on every row, and `replicateAnalysis`/`--seeds` aggregating the per-variant seed distribution); total 2177 → 2202. Round 26 (R26-14) changed the same two counts: `analysis` 491 → 523 (section AI: the forecast layer — exact Brier/logScore, the Murphy reliability/resolution/uncertainty partition and its identity, deterministic bootstrap means, the Diebold-Mariano degenerate and noisy cases, the Model Confidence Set dominance/elimination/monotonicity, and the whole-layer `forecastComparison`) and `analyze` 213 → 216 (the forecast block on by default, its summary line, and the proof that `forecast=false` nulls it while moving no scored number); total 2202 → 2229. A second node-only block in `analyze_cli.test.js` spawns the real CLI to prove `--seeds`/`--crn`/`--forecast` are documented, that the seed aggregate is written, and that CRN is recorded honestly. Round 26 (R26-7) changed one count: `analysis` 515 → 523 (section AJ: `clusterStability` against hand-computed stable/fragile/unavailable panels, plus the gate fixtures — a tiny edge fails the magnitude floor while a broad-but-thin edge fails stability and a real spread edge passes — and the rewritten gate reader) while `analyze` stayed 216, because the gate change lives in the dependence/walkforward layer rather than the driver — total 2229 → 2237. Round 26 (R26-8) changed two counts: `analysis` 523 → 547 (section AK: the decision-grade primitives — `foldConcentration` exact on a hand-built fold grid and against an independent leave-one-out Sharpe sweep, `confidencePersistence` exact on alternating/monotone/`[0,0,1,1,1]` series, `nextRunPlan` on a frozen power fixture, and the `decisionReport` composition + `formatDecision`) and `analyze` 216 → 220 (the decision block on by default, the featured candidate and pass-through blocks, the summary lines, and the proof that `decision=false` nulls it while moving no scored number) — total 2237 → 2265. A third node-only block in `analyze_cli.test.js` spawns the real CLI to prove `--decision=0` is documented, nulls the block and changes no scored number. Round 26 (R26-9) added three checks to `analysis` (section AL: the correlated-fold null — the exact sign test calibrated on independent fold windows, its measured size inflation under a common fold component, and the design-effect identity) while `analyze` stayed 220 — total 2265 → 2268; the decision itself is recorded in `docs/METHOD.md` §1. Round 26 (R26-10) added eight checks across two entries: section K in `guards.test.js` (the reader boundary-degradation matrix — empty, short, corrupt row, NaN, duplicate timestamp, shuffled order and `maxBars`) and the report-completeness contract in `analyze.test.js` — `guards` 58 → 65, `analyze` 220 → 221, total 2268 → 2276. Round 26 (R26-15) added nine checks to `analysis` (section AM: the successive-halving engine and its full-grid validation — `halvingRounds`/`halvingSchedule` exact, the race winner agreeing with the brute-force oracle, the budget-saving identity, a non-finite elimination, a minimise race, the unavailable guards and `formatRace`) while `analyze` stayed 221 — total 2276 → 2285; the engine is registered `LOCKED-invariant` but the `--race` driver stays GATED (see `docs/METHOD.md` §2). Round 26b (the final review) added one check to `analysis` (the paired-units sizing in `nextRunPlan` — R26-8 clause 6 / R26-13) and one to `analyze.test.js` (a real MULTI-STREAM run must populate the decision block's paired sizing, journal decay and leave-one-fold range — the integration shape a bare-number unit fixture cannot see), and corrected three defects found by that review (`BUGS.md` #38/#39/#40: the magnitude cheapest-flip read the paired difference as a scalar when a real report carries an object; the sign test was a leave-one-out form, not the per-window test it documents; the training label distribution read a field the model summary never produces) — `analysis` 559 → 562, `analyze` 221 → 222, total 2285 → 2289.) Round 27 changed seven counts: `core` 42 → 46 (R27-4b: the true, window-derived holding period, its `cacheSize − 1` cap, and the now-reachable `triple` vertical barrier), `sample_weights` 36 → 45 (R27-3: the pure causal-window uniqueness weight and its reference vectors), `controller_invariants` 0 → 16 (a NEW entry pair: controller determinism under a seed, the open-book invariants, the shipped-timestamp invariant, the off-state/liveness cases including the inert horizon-1 weight, and audit non-vacuity), `walkforward` 62 → 63 (R27-2: a broadcast-only flag is bit-identical through the model harness — the "not applicable to the scored model" claim, measured), `sanity` 59 → 60 (R27-4: `predict` returns NaN on an invalid vector and `train` returns the current step count plus a rejection counter — the stale `=== 0`/`=== undefined` assertions updated), `analysis` 562 → 566 (R27-5: the per-kind forecast grouping unit checks and the decision referent) and `analyze` 222 → 245 (R27-1: the liveness certificate and the active-K restatement; R27-2: the candidate taxonomy and `--list-variants`; R27-5: the per-kind forecast block, the `partial-report.json` config echo, the `underTrainedFolds` floor and the normalised stream label); total 2289 → 2347. The node-only block ledger rose 123 → 126 (the new `controller_invariants` mirror plus a fourth `analyze_cli` block for the R27-9 CLI surface). The native `npm test` that followed then exposed `BUGS.md` #52 — the `controller_invariants` mirror died at link time because its browser entry statically imported the sql.js shim, whose CDN `https:` module Node's default loader refuses (`ERR_UNSUPPORTED_ESM_URL_SCHEME`) — fixed by making that CDN import lazy and guarded by a new static-import-graph walk in `mirrors.test.js`, so the node-only block ledger is **127** (no browser check count moved; the `controller_invariants` entry still reports its 16). The first local run passed every block
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
now green (`npm test`, **127/127 blocks across 43 files, 0 failures** at round 27
— `docs/BUGS.md` #20/#21/#42/#52), so all
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
cost-robust (`BUGS.md` #27) — which is round 25. **Round 26 then found that attempt
3's baseline was not the shipped model (`BUGS.md` #33) and re-ran the identical
design with the corrections**: `20260922T204248-seed1` (7.90 h) is the **current
verdict** — all 14 keep-off, **SPA p = 0.4731**, nothing promoting at 0/2/5/10 bps,
baseline Sharpe **-0.1147** with negative skill, and three mechanism candidates
(`sample-weights`, `multi-probe`, `query-mod`) byte-identical to the baseline
(`BUGS.md` #43/#44). The local gate re-measured green at round 26b (**123/123
blocks across 42 files**, `BUGS.md` #42), so the promotion still stands. The
run-integrity code is
**delivered and pinned in `analyze.test.js` §O/§P/§Q/§R**. `npm run preflight` and
`npm run dryrun` remain the mandatory pre-run gates.

**Round 27 then made a candidate prove it ran and ran the two stalled experiments**
(`PLAN-round27.md`; forensics in `RUN-ANALYSIS.md` §13). Four runs, all complete, all
`costBps: 0`, `seed: 1`, `concurrency: 4` except the liveness run:

| run | id | verdict |
| --- | --- | --- |
| liveness validation (2 streams × 200 bars) | `20260923T105845-seed1` | taxonomy works; `sample-weights` inert with measured evidence; `surprise`/`homeostasis` live; **`pca-hash` inert on this run with the generic reason despite being live at 8×600** (`BUGS.md` #53) |
| label policy (8 × 600) | `20260923T111159-seed1` | `label:conservative` paired ΔSharpe **+0.2164** (p 0.0597, stability 1.0/36, break-even +2.24 bps) — the best arm so far; `label:triple` reachable (`resolvedTimeBarrier 16244`); neither clears the DSR floor |
| weighting under `triple` (8 × 600) | `20260923T133315-seed1` | `sample-weights` **live** (`ess/n 0.8248`) and **hurts** (−0.2276 paired, 0/36 windows) — confounded by a ≈2.6× effective-LR change (`BUGS.md` #54) |
| near-miss seeds (8 × 600, `--seeds=1,2,3`) | `20260923T150720-seed1` | `sig-accel` **promotes at 0 bps only** (adjusted DSR 0.9742, paired p 0.0493, stability 1.0, audit 288/288; fails at 2 bps); `sig-momentum` fails two knife-edge floors; the signals are exactly seed-free so `--seeds` is vacuous for them |

The follow-ups are `TODO.md` items 74–83 and [`PLAN-round28.md`](PLAN-round28.md).
No code changed between the round-27 implementation and this plan, so the gate
counts above still stood at that point (**2347** browser checks, **127/127** node
blocks).

**Round 28's coherence re-read of these four reports** (`RUN-ANALYSIS.md` §14;
`PLAN-round28.md`) added three reading defects (`BUGS.md` #56/#57/#58) and corrected
the round's sizing: the DSR floor is a **magnitude** gate (crossed at Sharpe ≈1.02–1.08,
so `label:conservative`'s 0.1017 is ≈10× short and `barsToDetectObserved` 93 576 is not
a budget), while the paired test needs **41** clusters for significance (89 for 80 % power —
the plan's `81` is the normal approximation; `RUN-ANALYSIS.md` §14.7a), reachable with `--test=10` on the existing 600 bars (54 clusters) — the exact
commands are in `PLAN-round28.md` §3. Also: the `sample-weights` inertness on
`optimistic` is a *span-configuration* artefact (the #49-fixed `heldBars` is mean 8.3),
so the mechanism is re-tested with a measured causal span and an emitted mean-1 stream;
and `sig-accel`'s lever is cost/turnover, tested offline first.

**Round 28 then implemented the plan** (`PLAN-round28.md` §1–§2, `BUGS.md`
#53–#58): every reading defect those four runs exposed is now a *measured*
certificate —

* `pca-hash` and `sample-weights` carry **measured** inert reasons (the aligned
  basis is REACHABLE and budget-dependent; the all-ones weight vector is a
  property of the ASSUMED span horizon while the run's realized holding period is
  ~8.3 bars), and the generic fallback may no longer assert a structural
  unreachability (`analyze.test.js` §M2/R28);
* the emitted sample-weight stream is **mean-1** by a causal EMA of the raw
  weights, the span horizon is a causal measurement of drained holding periods (or
  an explicit `--sample-weight-horizon`), and a **scale-control** arm
  (`sample-weights-scale-control`) isolates the learning-rate change from the
  uniqueness dispersion (`sample_weights.test.js` §E, `controller_invariants.test.js`
  §D);
* the sizing block no longer mixes a PAIRED difference with a SINGLE-SERIES
  standard error: `cheapestFlip`'s magnitude branch and `pairedUnitsNeeded` read the
  paired SE and the **one-sided** cluster-t the test runs (41 clusters on the
  round-27 Step-2 shape, not 55; factor 1.058, not 4.95), and `nextRunPlan.scales`
  names which fields are which;
* the gate matches `DESIGN.md` §6.1: the raw fold-win / positive-fold fractions are
  **reported statistics** (`gated:false`), not always-on reasons, and every evaluated
  hurdle is recorded with its value, threshold and **margin** so a knife-edge miss
  (the 0.00124 adjusted-DSR shortfall) is legible;
* `training.labelPolicy` now names the **referent** model's policy with the run flag
  beside it (`runLabelPolicy`), and the summary's `maxPair` resolves against the
  ACTIVE arms the correlation matrix was built from.

The shipped gate's `rawFoldHurdles:false` change is **verdict-neutral on all four
round-27 reports** (every candidate that failed a raw fraction also failed the DSR
floor and/or the paired test) and no golden fingerprint moved (`golden` 23/23), so
the gate counts are now **2402** browser checks / **127/127** node blocks:
`sample_weights` 45 → 57, `analysis` 566 → 586, `analyze` 245 → 255,
`controller_invariants` 16 → 23 (the four entries whose counts the round-28
additions moved), then `lsh` 69 → 75 for the P2 retrieval-liveness section K
(six checks: the retrieved prototype SET is invariant to the PCA-aligned basis at
production width with EQUAL RNG draw counts, the returned list's duplicate
multiplicity *is* attributable to the basis at an 80-prototype pool, the
600-prototype pool is unchanged, and the narrow 6-bit index desyncs — so the
certificate uses the set + equal-draw-count test). No other entry changed.

**The round-28 operator runs then landed** (`PLAN-round28.md` §3; readout in
`RUN-ANALYSIS.md` §15). Three runs, all complete, all `seed: 1`, `concurrency: 4`,
`costBps: 0`, `auditProbesPerFold: 1`, `--symbols=all --bars=600 --train=60`, no
promotions:

| run | id | verdict |
| --- | --- | --- |
| Step 1 — the corrected weighting experiment (8 × 600, `--test=15`) | `20260923T211549-seed1` | both confounds gone: arm A `sampleWeights {mean 1.0334, min 0.3212, max 5.0739, ess 46.34 < n 58.05, horizonBars 7, measureHorizon true}`; A moves the baseline −0.1147 → **+0.0521** (break-even +1.22 bps) but the paired test is not significant (Δ 0.1668, p 0.0759); scale-control C −0.0182; A − C unresolvable. The mechanism is **live and mildly positive**; at `deadZone 0` A's Δ is 0.2447 (**p 0.0051**) with break-even +3.98 bps. No promotion |
| Step 2 — the label policy at the affordable power (8 × 600, `--test=10`) | `20260924T045601-seed1` | 54 clusters achieved and the paired SE fell as hoped (0.13554 → 0.11214) but Δ collapsed to **0.0289** (p 0.3987), so `neededForObserved` is **2197**; the level moved −0.1147 → **+0.8978** on the **retrain cadence** (baseline-vs-baseline Δ **1.01244**, p 0.02008) with `--label-horizon` provably inert (both arms `resolvedTimeBarrier 0`, `heldBars max 73`). The level-clearing model has **negative** forecast skill (`brierSkill −0.0738`) |
| Step 3 — the signal family (8 × 600, `--test=15`, used to unblock P5) | `20260924T071546-seed1` | the round-27 `sig-accel` promotion does not survive the honest `K`: adjusted DSR **0.97420 at `K = 3`** (round 27's roster) → **0.86080 at `K = 12`** from the same journal; `sig-momentum` 0.94876 → 0.77356. All 11 differentiated arms live; `multiprobe`/`querymod` correctly `not-applicable` (gates `off`, no reasons). The P5 sweep now runs and `sig-accel` promotes at `{deadZone 0.02, enter 0.2, exit 0.05}` (Sharpe 1.19403, adjDSR 0.95844, break-even 21.89 bps) — but the restated baseline abstains there (16 of 4 320 bars), so it needs an exposure-matched A/B. No promotion |

The runs added three **reported-not-fixed** findings (`BUGS.md` #60 the third fold-level gated
hurdle; #61 the cross-family confidence-scale incomparability; #62 `--label-horizon` silently
setting the sample-weight span). No code changed, so the ledger above (2402 browser checks /
127/127 node blocks) still stands.

**Round 29 (implementation of `PLAN-round29.md`) then changed four counts**, with no golden
fingerprint moved (`golden` 23/23): `candles` 95 → **192** (the 15m basket manifest and the funding
basket manifest, plus the funding JSONL byte-round-trip serializer), `fetcher` 101 → **111** (the
funding fetch/normalise/serialize path), `analysis` 586 → **621** (the P4 carry-sleeve / extra-panel-
stream / cadence-restatement checks), and `analyze` 255 → **258** (the P1 benchmark runner and the
`--carry-files` / `extraPanelStreams` wiring). The three wrap-style node mirrors that assert an exact
count were updated to match (`test/node/{candles,analysis,analyze}.test.js`), so the ledger is now
**2558** browser checks / **127/127** node blocks. The three defects the measurements exposed
(`BUGS.md` #64 the extra-stream length compare, #65 the double-appended sleeve, #66 the epoch-ms /
ISO-string mismatch) are fixed and pinned in `analysis.test.js`. Readouts: `RUN-ANALYSIS.md` §16.

**The rounds 4–5 post-implementation audit then moved `analyze` 258 → 269** (+11 checks: 8 P2-wiring + the P4+P2 sleeve-chaining check + the 2 fold-dispatch-contract checks, for
the opt-in `--cadences` / `--exposure-match` driver passes), leaving every other entry unchanged, so
the ledger was **2558** browser checks / **127/127** node blocks at the round-29 freeze. **Round 30
moved `analyze` 269 → 279** (the pruned-roster pin, the roster snapshot/registration, the
present-but-empty-list-flag guard, the cross-sectional panel taxonomy and the momentum-upgrade
family) **and `analysis` 621 → 638** (the pre-registered `SIGUP_CANDIDATES` momentum upgrades,
gate G-H), so the current ledger is
**2585** browser checks / **128/128** node blocks (round 30 added one node block — the
`analyze_cli.test.js` `BUGS.md` #69 spawned-CLI refusal — to the 127 the round-29 freeze certified). The same post-implementation pass repaired three
stale counts in the `test/lock-registry.js` notes (`guards` 58→65, `observer` 75→76, `analyze`
245→269); round 30 added the three new `analyze.js` exports — and the five `features.js` upgrade
exports — to those notes' curated lists.

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
`progress.json` are diagnostics — note that the checkpoint is **not** a full report:
it lacks the `forecast` block and the config-echo fields (`trials`, `gateOptions`,
`saveInterval`, `labelPolicy`, `intervalBars`, `commonRandomNumbers`, …), so a
recovered interrupted run cannot be read for its gate semantics or the roster size
its DSRs were deflated by (`BUGS.md`, TODO #66).

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
and returned the N3 verdict: all 14 candidates keep-off, SPA p = 0.5699
(Rejects = [none]), baseline pooled Sharpe **+0.4387** / DSR 0.5179 / break-even
12.42 bps; `query-mod` (DSR 0.9992), `sig:momentum` (1.1059) and `sig:acceleration`
(1.0502) miss only the fold-consistency hurdles (`RUN-ANALYSIS.md` §5).
**But that run predates the round-26 window-fidelity fix (`BUGS.md` #33), so its
baseline/mechanism rows are not the shipped model's.** The **current verdict** is the
identical design re-run with the round-26 corrections, `20260922T204248-seed1`
(`RUN-ANALYSIS.md` §10, **7.90 h**): all 14 keep-off, **SPA p = 0.4731**, the cost
ladder promotes `[none]` at 0/2/5/10 bps, baseline a *trained* model with negative
skill (Sharpe **-0.1147**, `brierSkill -0.0751`), and `sig:momentum` (1.0848,
break-even 14.64 bps) / `sig:acceleration` (1.0194, 11.57 bps) failing only the
dependence-adjusted DSR floor. That run also showed three of the seven mechanism
candidates are byte-identical to the baseline (`BUGS.md` #43/#44 — see TODO #64
before trusting any mechanism row). Read the printed `breakEven=` per candidate next
to each `power:` line: an apparent edge whose break-even cost is below ~10-15 bps is
inside a realistic taker cost — but remember the break-even is **window-dependent**
(a 600-bar run and a 2,200-bar run disagree by ~30× on the momentum family), so name
the window before drawing a cost conclusion.

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
recompute the report end to end (`RUN-ANALYSIS.md` §5.3, and §10.6 for the round-26
run, which reproduced every per-fold and pooled metric exactly). Two conventions the
journal does *not* state and that cost time to re-derive: `signals` is the position
**as computed at bar `i`**, so the *traded* position at bar `i` is `signals[i-1]`
(the first bar is flat) and the realised net return is `signals[i-1] × returns[i]`;
`turnover` is the total variation of that lagged series. Also recompute the decision
at a couple of cost levels (`--cost-ladder`). Attempt 3 flipped at 2 bps
(`sig:acceleration` promoted with zero reasons) which is why cost-robustness is now a
required readout (`BUGS.md` #27); the round-26 gate's cost ladder promotes `[none]`
at every level (`RUN-ANALYSIS.md` §10.2).

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
  mirror loads.** The module graph a node mirror *statically* imports reached a
  browser-only CDN module. The sql.js shim
  (`test/browser/shims/better-sqlite3.js`) is the usual culprit: its CDN runtime
  is `https://cdn.jsdelivr.net/...`, which the browser harness bundles fine but
  Node's ESM loader rejects at link time. Since `BUGS.md` #52 the shim's CDN import
  is itself **lazy**, so importing the shim statically no longer leaks the scheme;
  an entry should still import it **lazily inside `run()`** (running
  `shim.__ensureSql()` there) and have the mirror pass `ensureSql: async () => {}`.
  `test/node/mirrors.test.js` walks every mirror's static graph and fails with the
  offending specifier, so this is caught before the run reaches the gate.
  Recorded as `BUGS.md` #15.3 (first occurrence) and #52 (recurrence).
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
- **A candidate reads `liveness: inert` — is the mechanism dead?** Not necessarily.
  The certificate is computed **per run** (it compares the candidate's per-fold
  *positions* with the baseline's on *that* run's data and scale), so a variant can be
  `live` at 8 × 600 and `inert` at 2 × 200 — `pca-hash` is the worked example
  (`RUN-ANALYSIS.md` §13.2, `BUGS.md` #53). Read `identicalFolds/totalFolds` and
  `maxAbsDiff`, and treat the reason text as a claim about the run, not the code, until
  the variant carries its own `inertReason` (as `sample-weights` does). If you need a
  structural answer, use `--list-variants`'s `appliesTo` column, not the liveness row.
- **`sample-weights` is `live` but its `model.sampleWeights.mean` is ≫ 1.** That is
  expected pre-#54 and it matters: the causal-window estimator is mean-1 over the
  *window*, but only the newest span is trained, so the emitted (trained) weights do
  not have mean 1 — Step 3 measured `mean 2.6112`, i.e. a ≈2.6× effective learning-rate
  change versus the baseline (`BUGS.md` #54). Do not read a weighted-vs-unweighted
  Sharpe difference as a pure weighting effect until the emission is renormalised.
- **`forceMin`** — `true` (default) is the CPU-constrained branch; `false` is the
  full-size branch, both tested by `dimensions.test.js`.
