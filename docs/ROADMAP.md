# NeuLegion — roadmap & next-step plan

This is the consolidated, prioritized plan (the "what next, and why"). It is the
single place to see the intended order of work; [`TODO.md`](TODO.md) keeps the
full history and research backlog, and [`DESIGN.md`](DESIGN.md) §5/§6 is the
scope freeze that bounds it.

## Status snapshot (this revision)

- **Core design frozen** ([`DESIGN.md`](DESIGN.md)); no new hot-path subsystem is
  scheduled. Everything below the hot path (harness, dashboard, observer) is
  additive and default-off / read-only by construction.
- **Golden lock bit-exact on the native driver**: 23/23 golden checks, 9 of 11
  fingerprints literal, `hm:predictions` **and** `hm:postReloadPrediction`
  compared at 6 significant digits ([`BUGS.md`](BUGS.md) #17, #19).
  `engine_portability.test.js` guards it.
- **Local gate: green.** `npm test` is **115/115 `test()` blocks across 39
  files, 0 failures, ~5.9 min** on the native driver ([`BUGS.md`](BUGS.md) #21).
  The run exposed exactly one real defect in the new P0-P3 tooling — `preflight`
  counted the sampled candle window's truncated tail line as malformed, so it
  failed on a *healthy* checkout ([`BUGS.md`](BUGS.md) #20) — now fixed, with the
  test hardened to report the real failing check.
- **Registry**: 53 entries — **17 bit-exact, 36 invariant, 0 needs-local-run, 0
  experimental** ([`LOCKED.md`](LOCKED.md)).
- **Browser suite**: 1995 checks across the 28 pass/fail entries (30 entries
  including the non-pass/fail `bench`); 115 `test()` blocks across 39 node files,
  all verified green in the browser harness for this revision (round 23 raised
  `walkforward` 31→48, `analysis` 354→390, `analyze` 47→98, round 24 raised
  `analyze` 98→143, and made every
  wrap-style mirror assert its count **exactly**).
- **No known live defect in the *math*.** The open work is now *run integrity*
  (fault isolation, reproducibility, a real end-to-end harness), *observability*
  (a monitor dashboard + a dedicated legion observer) and *evaluation* (the
  walk-forward A/B), in that order.
- **N3 (the A/B verdict) is DELIVERED — nothing promotes.** The power run
  (`20260920T144633-seed1`, 8 streams / 288 folds / 4,320 pooled bars, 11.98 h)
  completed with a full report: **all 14 candidates `keep-off`**, family-wise
  **SPA p = 0.5699** (best `sig:momentum`, Rejects = [none], K = 15, T = 4,032),
  baseline pooled Sharpe **+0.4387** / DSR 0.5179. Three candidates
  (`query-mod`, `sig:momentum`, `sig:acceleration`) have DSR ≈ 0.999 edges that
  fail only the per-fold consistency hurdle; no golden was re-frozen. The run also
  exposed two *report-honesty* defects — the power readout ignores cross-stream
  correlation (`BUGS.md` #26) and the verdict is not cost-robust (`BUGS.md` #27) —
  so **round 25 is the promotion-gate / report-honesty round**, not a construction
  round. Forensics: [`RUN-ANALYSIS.md`](RUN-ANALYSIS.md) §5.

## Round 24 — make a verdict run survivable, then get it

Round 23's N3 attempt died inside its second candidate and took every result with
it ([`RUN-ANALYSIS.md`](RUN-ANALYSIS.md) §1: 1,862 of ~17,280 fits, no
`report.json`, an uncheckpointed final `-wal`). Round 24 is deliberately small and
arithmetic-free — it is the shortest path to a citable verdict.

- **P0-1 · Report checkpointing.** `evaluateAB({ onVariant })`; `runAnalysis`
  writes `partial-report.json` + a per-variant `run.log` line after each variant,
  so an interruption keeps the candidates it finished (`BUGS.md` #24.1).
- **P0-2 · Reclaim model state.** `modelRetention: 'discard' | 'keep'` on both
  model factories (`--keep-models` to opt out); each fit's state dir is closed and
  removed once its prediction is consumed. Removes the measured 0.708 MiB/fit
  (~11.9 GiB per full run) (`BUGS.md` #24.2).
- **P0-3 · Report the audit's teeth.** Record `{ clean, reachable, probes,
  viewDiffers, vacuous }` per candidate; today only `clean` survives into the
  report. Evidence: the probe passes moved the model's end state in only 31/288
  folds (`RUN-ANALYSIS.md` §1.4).
- **P0-4 · Run it.** Smoke run (`npm run analyze`, defaults) — **done**; its
  verdict and forensics are in `RUN-ANALYSIS.md` §3 → then the power run
  (`npm run analyze -- --symbols=all --bars=600 --audit-probes=1 --reuse-base`);
  hand back `run.json` + `report.json` + `run.log` + `folds.jsonl`.
- **P1 · Determinism smoke test** (two identical small runs ⇒ identical metrics
  and decisions) and a decision on `requireReachable`; the browser harness is
  *not* the right oracle for repeated controller fits (`RUN-ANALYSIS.md` §1.7).
- **P2 · Record the N3 verdict** in `OPTIMIZATION.md` (which is still the single
  decision record), re-freezing goldens only for whatever promotes.

> **Status: the run-integrity CODE (P0-1/P0-2/P0-3/P1) is DELIVERED and proven in
> `analyze.test.js` §O/§P/§Q** (as-built API: `RUN-ANALYSIS.md` §2). As-built:
> `modelRetention` (factory default `keep`, CLI default `discard`, `--keep-models`
> opts out) with an idempotent `dispose()`; `partial-report.json` rewritten
> after every variant (atomic) and a `status:'failed'` post-mortem on a crash;
> `progress.json` liveness heartbeat + a greppable stdout progress line;
> `folds.jsonl` fold journal (`--fold-log=all|score|off`); a machine-readable
> `audit` block (`clean`/`vacuous`/`reachable`/`reachableFolds`/`probes`/
> `viewDiffers`) with `--reachable`; `--progress-ms`; `--help`
> (`ANALYZE_USAGE`).
>
> **Status 2 — round 24b (premium hardening) is DELIVERED, and P0-4's smoke half
> is DONE.** The default smoke run completed (2,342,845 ms, 960 passes,
> `report.json` present, 15/15 variants) and gave an honest **underpowered null**:
> all 14 candidates keep-off, SPA p = 1.0000, baseline pooled Sharpe -0.31,
> MDE95 ±2.0 (`RUN-ANALYSIS.md` §3). Forensics found five defects, all fixed: a
> volume-blind audit shock (the pre-fix run had `sig:volume` reachable 0/16;
> the post-fix run confirms 16/16), a journal without `probeIndex`, an
> audit-frozen liveness cursor, always-zero/unfalsifiable
> transaction costs, and a null verdict with no underpowered flag (`BUGS.md`
> #25). Round 24b adds `grossPnl`/`breakEvenCostBps`, `power.underpowered`/
> `barsToDetect1`, an offline-readable journal, and the `--reuse-base`
> optimization (4 → 3 passes/fold, ~12 h → ~6 h, verdict-identical).
>
> **Status 3 — round 24 is CLOSED: P0-4's power half is DONE and the N3 verdict is
> RECORDED.** `20260920T144633-seed1` completed in 43,129,704 ms (11.98 h,
> 12,960 passes, 15/15 variants, 288 folds / 4,320 pooled bars) with
> **all 14 candidates `keep-off`**, **SPA p = 0.5699** (Rejects = [none]), baseline
> pooled Sharpe **+0.4387** / DSR 0.5179 / break-even 12.42 bps. Nothing promoted,
> so **no golden was re-frozen**. The only misses are the per-fold consistency
> hurdles: `query-mod` (DSR 0.9992, break-even 33.7 bps), `sig:momentum` (Sharpe
> 1.1059, break-even 15.0) and `sig:acceleration` (Sharpe 1.0502, fold-win 0.4896).
> The run's own report overstates its power (8 correlated streams ⇒ honest MDE95
> ≈ ±0.98, not ±0.47 — `BUGS.md` #26) and its verdict is not cost-robust (a 2 bps
> cost assumption promotes `sig:acceleration` — `BUGS.md` #27). Verdict record:
> [`OPTIMIZATION.md`](OPTIMIZATION.md); forensics and the offline-verified journal
> analysis: [`RUN-ANALYSIS.md`](RUN-ANALYSIS.md) §5; the measured cost model
> (**10.7 s/controller fit**; `run time ≈ 10.7 s × mechanismVariants × folds ×
> (1 + auditProbesPerFold)`) is `RUN-ANALYSIS.md` §4. **Round 25 is now the
> promotion-gate / report-honesty round** (items 31-36).

Acceptance for round 24: one completed `npm run analyze` whose `report.json` is
attached to the chat, a filled `OPTIMIZATION.md` verdict block, and a run that
leaves no unreclaimed state behind.

## Round 25 — make the verdict trustworthy, then make it decisive

The attempt-3 power run settled the *arithmetic* question (`RUN-ANALYSIS.md` §5:
nothing promotes, no golden moves) and exposed the next class of problem: **the
report's claims about itself are not robust.** Two of them are wrong in a
decision-relevant direction (`BUGS.md` #26/#27), and the binding constraint on
every real candidate is a fixed 0.5 threshold on 288 correlated folds. Round 25 is
therefore the *promotion-gate / report-honesty* round; it changes no hot-path
arithmetic and re-freezes no golden.

- **R25-1 · Power must see the design effect (`BUGS.md` #26).** Add the mean
  pairwise cross-stream correlation of the per-stream per-fold Sharpe series, an
  `effectiveStreams` estimate, a correlation-corrected `se`/`mdeSharpe`, and make
  `underpowered` read the corrected value (raw and corrected both recorded). The
  attempt-3 run printed ±0.4735 with `underpowered: false`; the corrected figure is
  ≈ ±0.98. Report it in `formatAnalysis`.
- **R25-2 · The verdict must carry its cost sensitivity (`BUGS.md` #27).** Emit a
  `costLadder` block — pooled metrics and the full `promoteDecision` recomputed at
  a small set of bps levels (`--cost-ladder=0,2,5,10`, default on) — and state the
  scored cost in the summary header. It is O(T) per level (seconds). The ladder for
  this run is reproduced in `RUN-ANALYSIS.md` §5.6(a) and *is* reproducible from
  any uploaded journal, but it must live **in the artifact**. Evidence it matters:
  at 2 bps `sig:acceleration` promotes with zero reasons.
- **R25-3 · The fold-consistency hurdle must be a significance statement, not a
  fraction.** `foldWinFraction >= 0.5` and `positiveFraction >= baseline` decide
  all three real candidates, on folds that are ~0.47-correlated across streams.
  Replace the raw thresholds with a paired test against the baseline (sign test /
  stream-block bootstrap with the effective-n correction) and require a stated
  alpha; keep the fraction as the reported statistic. Document the choice in
  `DESIGN.md` §6 (it is a decision-procedure change, so it needs its own rationale
  and tests, not a hot-path re-freeze).
- **R25-4 · Report the family's correlation.** Attach the excess-vs-baseline
  cross-candidate correlation (`sig:momentum ~ sig:acceleration` = 0.863) and an
  effective-trials estimate, so "K = 15" and "three significant candidates" are not
  read as 15 or 3 independent things.
- **R25-5 · Explain `query-mod`.** DSR 0.9992, MDD 0.0081, turnover *below* the
  baseline, break-even 33.7 bps, median fold Sharpe exactly 0. The question is
  whether the dead zone is making it abstain on most folds (a smooth, low-frequency
  filter) — that is a *feature* the fold-consistency hurdle currently punishes.
- **R25-6 · Buy independence, not bars.** The corrected MDE says the decisive
  experiment needs ~4× the effective independent data. `barsToDetect1` ≈ 969 bars
  is i.i.d.; with a design effect of 2.1 the target is ≈ 4,300 pooled bars of
  *uncorrelated* streams. Cost it with the measured model
  (`RUN-ANALYSIS.md` §4): run time ≈ 10.7 s × mechanismVariants × folds ×
  (1 + auditProbesPerFold), so doubling folds doubles the wall clock (≈ 24 h).
  Decide between more diverse symbols (other asset classes), longer per-symbol
  history, and a lower-frequency bar.
- **R25-7 · Observability polish.** Put each variant's own elapsed ms and its
  `kind` (`mechanism|signal`) in the checkpoint log line (the attempt-3 `run.log`
  reads as if 8 variants took 0.66 s — `RUN-ANALYSIS.md` §5.4); serialise
  `minTrackRecordLength` `Infinity` explicitly instead of `null`.

Acceptance for round 25: a re-run of the power command whose `report.json`
carries the corrected power, the cost ladder and the family correlation; a
documented gate decision (fold hurdle as a test, or a written justification for
keeping the fraction); and the whole suite green with the recorded counts updated
(this is arithmetic-free for the model, so no golden fingerprint may move).

### Round 25 — status: ✅ **delivered** (implementation; one re-run still to do)

All seven items are implemented, registered and test-guarded. The gate is green in
the browser harness: **2070 checks, 0 failures** across all 29 pass/fail entries
(`walkforward` 49 → 62, `analysis` 390 → 437, `analyze` 143 → 158; `locks` 41 and
`modules` 50 unchanged). No golden fingerprint moved (nothing here is imported by
the hot path). Full detail in `RUN-ANALYSIS.md` §6.

- **R25-1 ✅** `analysis/dependence.js` (new, LOCKED-invariant) + `dependenceSummary`
  in `analysis/walkforward.js`. Shipped the delete-one-cluster jackknife over
  fold-window clusters rather than the originally-planned equicorrelation scaling:
  Monte Carlo showed the jackknife recovers the exact design effect
  (`seCluster/seIid` = 0.988/1.653/2.124/2.512 at ρ = 0/0.25/0.5/0.75 vs the
  predicted 1/1.658/2.121/2.500), while the scaling is only an approximation. The
  i.i.d. numbers are kept beside the honest ones (`seDependent` etc.).
  `psrAdjusted`/`dsrAdjusted` ride on `effectiveBars`.
- **R25-2 ✅** `costLadder` + `restateReportAtCost` (byte-identical to the scored
  pass at cost 0), emitted by default (`--cost-ladder=` overrides), stated in the
  summary. A test pins the point of the ladder: an AR(1) momentum edge promotes at
  0-20 bps and stops at 40 bps.
- **R25-3 ✅** `pairedPromotionTest` (paired cluster Sharpe t(C−1) + exact sign test)
  and the `requireSharpeDiff`/`requireBreadth`/`minDsrAdjusted` hurdles, each
  recording `applied` | `skipped-no-panel` | `not-needed` | `off`. The raw fraction
  is still reported as a statistic. Rationale recorded in `DESIGN.md` §6 and §8.
- **R25-4 ✅** `familyCorrelation` (excess-vs-baseline correlation matrix, strongest
  pair, Kish effective trials) — DIAGNOSTIC ONLY: `trials = K` is retained because
  an effective number of independent tests does not control the FWER
  (arXiv 1612.04535; Harvey, Liu & Zhu 2016).
- **R25-5 ✅ (the measurement half)** `nonZeroFraction`/`meanAbsPosition`
  participation in every pooled report. Whether the dead zone is the cause of
  `querymod`'s smoothness needs the next run's participation numbers to settle
  (`RUN-ANALYSIS.md` §6.4).
- **R25-6 ✅ (the arithmetic half)** The sizing equation is now printed in the report
  and the cost model is verified per variant (`timings`), so the "~4× effective
  independent data" conclusion is checkable rather than asserted. The experiment
  itself is the next run.
- **R25-7 ✅** Per-variant elapsed ms + `kind` in the checkpoint log line and
  `timings`; `minTrackRecordLengthStatus` (finite | beyond-horizon | unavailable)
  so a JSON `null` is not ambiguous; `run.json` and both checkpoints record the gate
  and the ladder levels.

Two defects found while building it (both fixed, both in `BUGS.md`): #28
(`studentTPValue` swallowed its own infinite cases → a degenerate-but-dominant
candidate read as `not significant`) and #29 (a diversifying panel's
"adjustment not needed" was reported as "no panel").

## What changed in this revision (round 21)

The user asked for the plan to be re-evaluated against six directives: harden the
controllers so small faults cannot corrupt a run or its data; build a test harness
that can exercise the runners/workers *before* a full run; replace the raw
JSON-over-LAN broadcast with a lightweight monitor dashboard; keep the product
cutting edge; add a dedicated analysis layer that watches the legion; and add
anything that was missed. Concretely:

1. **A new P0 "run integrity" phase now precedes the A/B.** A trustworthy runner
   is a prerequisite for trusting any long run *or* its evaluation report, and a
   fault-isolated pipeline is exactly the "small issues must not corrupt a run"
   requirement. The decisive A/B moves to **P2** (it is still the ultimate gate;
   it is simply no longer allowed to run on a pipeline whose failure modes are
   untested).
2. **The runner/worker dry-run harness is promoted from an add-on to P0-3**, with
   an explicit list of node-only tests and the small safe enablers they need
   (`NEULEGION_*` overrides, an ephemeral port, a bounded/resolving stream loop).
3. **The HTTP state view becomes a served, self-contained monitor dashboard**
   (P1-1) bound to loopback with an SSE live-update channel — the raw
   JSON-over-LAN broadcast and its CORS allow-list are removed.
4. **A dedicated outer analysis layer** (`src/observer/`, P1-2) watches the
   legion's *internal* health (calibration, diversity, influence concentration,
   drift, memory/pipeline health) and feeds both the dashboard and the run report.
   It is distinct from `analysis/*`, which scores *returns*.
5. **An "added beyond the list" section** captures the unasked-for work the audit
   surfaced: seeded runs + run manifest, graceful shutdown / atomic checkpoint,
   worker watchdogs + a failure budget, a `preflight` command, a structured run
   journal, a snapshot spool, a state/config schema guard, and resource telemetry.

## What changed in this revision (round 22) — P0–P3 delivered

Round 22 executes the plan below end-to-end:

- **P0-1 fault isolation** — `sanitize.js` (finite/JSON coercion, signal/consensus
  sanitising, the controller-failure budget, the config fingerprint,
  `assertControllerArgs`) + `rng.js` (seeded randomness); `batch.js` isolates a
  failed controller instead of `process.exit(1)` and stops only on a budget
  breach; `workers.js` gains a settle-once watchdog with typed errors; corrupt
  DB rows are quarantined. Proven by `guards.test.js` (58), `worker_pool.test.js`
  (fault injection) and `runner_smoke.test.js` (budget breach).
- **P0-2 determinism & durability** — `NEULEGION_*` env overrides,
  `state/main/state_meta.json` fingerprint guard, a structured `runStream`
  summary with `maxBatches`/malformed-line counting, and a run directory
  (`run.json` manifest, `snapshots.jsonl` spool, `run.log`) with SIGINT/SIGTERM
  checkpointing. Proven by `config_env.test.js`, `report_lifecycle.test.js` and
  `shutdown.test.js`.
- **P0-3 harness** — `npm run preflight` (`src/preflight.js`) and
  `npm run dryrun` (`src/dryrun.js`), proven by `preflight.test.js` and
  `dryrun.test.js`.
- **P1-1 dashboard** — `src/dashboard.js` + a rewritten `http_server_worker.js`
  serve the self-contained page and a read-only GET API (SSE live updates,
  loopback bind, ephemeral fallback). Proven by `http_view.test.js`.
- **P1-2 observer** — `src/observer/{legion_metrics,alerts,collector,report}.js`
  (calibration, diversity, concentration, drift; a pure alert engine; the run
  directory/spool). Proven by `observer.test.js` (76) with exact reference vectors.
- **P2-1 A/B driver** — `src/analyze.js` + `npm run analyze`: the default-off
  variant family over a causal walk-forward, decided by `promoteDecision` (DSR
  floor + clean look-ahead audit) and cross-checked by the family-wise
  SPA / Romano-Wolf step-down. Proven by `analyze.test.js` (83 after round 23,
  which added the controller-backed factory, the signal-candidate dispatch, the
  pooled cross-symbol evaluation and `readCandles`).
- **P2-3** — `hm:postReloadPrediction` is now hashed **rounded** (6 significant
  digits) like `hm:predictions`, so no fingerprint depends on last-ulp engine
  behaviour; the remaining ten hashes are literal/structural.
- **P3** — the A/B family runs the whole feature universe (K includes every
  default-off feature) through the family-wise gate; `legion/evolve.js` stays a
  registered-but-unimported candidate (deliberate deferral, below); the reload
  bit-idempotency gap stays documented (P3-4).

The acceptance rule held: every change above is guard/exception-path or additive
tooling, and **`golden.test.js` is still 23/23** — the only golden edit was the
intentional `hm:postReloadPrediction` re-freeze (P2-3), recorded here. The native
gate confirmed the whole programme on the real drivers at **115/115** ([`BUGS.md`](BUGS.md)
#21).

---

## Round 23 — make the evidence real, then use the unused data (N0/N1/N2/N3 **delivered** — nothing promotes)

**Status (this revision).** Round 23 is **complete**: the code half is green in the
browser harness and **N3's verdict is now recorded** from the attempt-3 power run
(`20260920T144633-seed1`, 8 streams / 288 folds / 4,320 pooled bars, 11.98 h):
**all 14 candidates `keep-off`**, SPA p = 0.5699 (Rejects = [none]), baseline pooled
Sharpe +0.4387 / DSR 0.5179. Nothing promotes, so no golden was re-frozen. Three
candidates carry DSR ≈ 0.999 aggregate edges that fail only the fold-consistency
hurdle (`RUN-ANALYSIS.md` §5.2); the run's power readout is optimistic because the
8 streams are correlated (`BUGS.md` #26) and the verdict is not cost-robust
(`BUGS.md` #27) — both are round-25 work. History: **attempt 1** (2026-09-20,
seed 1) was interrupted and produced no report (forensics:
[`RUN-ANALYSIS.md`](RUN-ANALYSIS.md) §1; robustness plan: round 24); **attempt 2**
(the smoke) was an honest underpowered null (`§3`); **attempt 3** is the verdict
(`§5`).

- **N0 delivered.** `analyze.js#makeControllerModelFactory` evaluates the shipped
  `HiveMindController` (real OHLCV, 10 indicator series, trade bookkeeping,
  closed-trade training), prequentially per fold, with an explicit documented
  `prob -> position` policy (`CONTROLLER_POSITION_POLICY`); the `-1` untrained
  sentinel and a throwing controller both abstain. The audit prerequisite landed:
  `auditNoLookahead` takes a `viewFor(returns, perturb)` hook
  (`analysis/world.js`) so the perturbation reaches a candle-driven model's actual
  input, plus a structural `vacuous` flag (`BUGS.md` #22). `sample-weights` is no
  longer skipped on the controller path. Default (no `viewFor`) path is
  byte-identical; `walkforward.test.js` section K is the regression guard.
- **N1 delivered.** `src/analysis/features.js` — 8 causal features as candidates
  on the same family-wise gate, so K = 15 (7 mechanism flags + 8 signals); exact
  reference vectors + a causality invariance check in `analysis.test.js` §AC.
- **N2 delivered.** Sharpe SE / MDE readout in every report; `poolReports`
  (one walk-forward per symbol pooled with the single-stream `poolFolds`
  arithmetic); `readCandles`; CLI `--symbols=a,b|all`, `--files`, `--model`,
  `--probe`, `--audit-probes`, `--variants`. The *default* bar budget is still 300
  (the old `folds > 200` guard remains the bound, with a message naming
  `--bars`); a full `--symbols=all` run is a deliberate local decision, not a
  default.
- **N3 delivered — nothing promotes.** `npm run analyze -- --symbols=all
  --bars=600 --audit-probes=1 --reuse-base` completed as
  `20260920T144633-seed1`; the verdict is recorded in `OPTIMIZATION.md` and the
  forensics (including the exact offline verification of the journal) in
  `RUN-ANALYSIS.md` §5. All 14 candidates keep-off, SPA p = 0.5699.
- **Hygiene delivered.** The 20 wrap-style mirrors now assert **exact** counts;
  every count was re-measured in the harness before pinning. `bench.test.js`
  stays timing-only by design (no node mirror, so `npm test` never runs it; an
  absolute ms ceiling there would pin hardware).

**The finding that motivated it.** Round 22 delivered the A/B *driver*, but the
A/B did not yet evaluate the shipped model. `analyze.js` ran every variant on a
**bare `HiveMind`** fed a synthetic 6-element vector (`FEATURE_LEN = 6`: five
trailing log-returns plus the current bar's sign), over a default 300-bar window
(`train=60, test=15`). The production path is a `HiveMindController` fed **10 real
indicator series** (`rsi`, `macdDiff`, `atr`, `ema100`, `stochasticDiff`,
`bollingerPercentB`, `obv`, `adx`, `cci`, `williamsR`), robustly normalized over
the cache window, with trade bookkeeping and closed-trade training. Consequences:

1. A promote/reject from `npm run analyze` today is a statement about a *toy*
   model, not about the shipped legion — so the "decisive evaluation" is not yet
   decisive.
2. `sample-weights` is **skipped outright** (`controllerScoped: true`): it is a
   controller-level feature, so the bare factory cannot evaluate it at all.
3. P3-1's stated intent — "a genuinely larger real feature family
   (fractionally-differenced momentum, volatility regime, volume/turnover) each as
   a walk-forward candidate" — was satisfied by treating the six *mechanism flags*
   as the candidate family (K=7 with baseline). The named causal signals were
   never added as candidates (`fractionalDiff` exists, but only as a labelling
   helper in `analysis/labels.js`).
4. The default 300 bars / ~12 folds give little power, so "no feature promotes" is
   not yet an informative null.

**Round 23 therefore closes the fidelity gap, re-runs the gate, and decides.**

### Research findings (measured against the shipped code, this revision)

These were established empirically before writing the plan below; they change it.

1. **A controller-backed walk-forward already works, and the model is live.** A
   probe that replays 300 real ADAUSDT bars through
   `new HiveMindController(id, dir, 120, 4, 'positive', 1, PRICE, true)` over
   `walkForwardSplit({n:300, trainSize:60, testSize:15})` produced **16 folds /
   2376 `getSignal` calls**, the controller **trained** (`lastTrainingStep` rose
   28 -> 250 monotonically, 2203 steps total) and `prob` was a real, non-sentinel
   value on **every** test bar (never the `-1` "untrained" sentinel). So N0 is a
   factory swap, not a research project.
2. **The look-ahead audit is VACUOUS for a candle-driven model — this is the real
   blocker.** `auditNoLookahead` perturbs `returns[t+1..]` and re-runs
   `signalForFold`, and its documented contract is *"signalForFold must read
   `view.returns`"*. A **propagated** look-ahead (position at `t` = sign of the
   `t -> t+1` move) that reads a **pre-loaded candle array** — which is exactly
   what a controller-backed factory naturally does — is reported **clean (0
   violations in 30 probes)**, while the same leak expressed over `view.returns`
   is caught (15 violations). Since `promoteDecision` gates on a clean audit, a
   controller-path candidate could carry a blatant leak and still be promoted.
   **N0 must therefore also make the audit perturb the model's actual input**
   (see `BUGS.md` #22). This is the finding that makes N0 a prerequisite for
   everything else: without it, the faithful-looking evaluation would be the least
   trustworthy artefact in the repo.
3. **Cost.** On the browser harness's sql.js shim, one `getSignal` call costs
   **~43 ms**, so the 2376-call probe took **103 s**, ~90% of it in the streaming
   "fit" phase (91.4 s vs 10.9 s to read the test window). Extrapolation: the
   current default A/B (7 variants x 2376 calls) is ~12 min on the shim / a few
   minutes native; a 2000-bar budget is ~2x that per variant; **pooling all 8
   symbols is an overnight job serially**, so N2's cross-symbol evaluation must
   reuse the existing worker pool (or at least parallelise per symbol).
4. **The controller's confidence is small in magnitude but informative in sign.**
   Test-window `prob` values clustered around 50 (e.g. 46.5-49.6, 52.6-56.8), so
   the production mapping `(prob/100 - 0.5) * 2` yields positions of only
   ~+/-0.05-0.08. The A/B must decide deliberately between the raw scaling, a
   sign/dead-zone policy (`probToPosition` already takes `direction`, `deadZone`,
   `scale`) and a per-fold rescale — otherwise a real directional edge is measured
   as a near-zero position and washes out.
5. **Nit, found while probing.** `auditNoLookahead` compares positions with
   `alt[j] !== base[j]`, so a `NaN` position (e.g. a signal that reads one bar past
   the series end) is reported as a "position changed" *leak* on every probe. NaN
   positions should be a distinct, explicit reason — a false "leak" diagnostic is
   exactly the kind of thing that erodes trust in the gate.

### N0 · The A/B must evaluate the shipped model path (fidelity) — ✅ delivered

- **A controller-backed model factory.** `analyze.js` gains
  `makeControllerModelFactory({ HiveMindController, priceObj, ... })`: per fold it
  builds a real `HiveMindController` in a temp dir, streams the train-window
  candles (real OHLCV, so `indicatorProcessor` and the trade bookkeeping run),
  then reads `signal.prob` on the test window -> position, the production mapping.
  `evaluateAB` already takes an injected `signalForVariant`, so this is a factory
  swap, not a core rewrite.
- **Fix the audit contract (prerequisite, `BUGS.md` #22).** Extend the
  `signalForFold` view so the audit can perturb *the model's actual input*: pass
  the candle series (derived causally from the same bars the audit perturbs) as
  `view.candles`, or add an optional `perturbView(t, probe)` hook. The default
  must reproduce today's returns-only behaviour **byte-identically**, so every
  existing test, report and golden is unchanged. Then prove non-vacuity: the
  candle-driven leak from finding 2 must be *caught*, and the honest baseline must
  stay clean.
- **Prequential evaluation.** The controller is online (it trains as trades
  close), so the test window is evaluated prequentially — position at `t` from
  information `<= t`, realised at `t+1` — which is what production does and what
  the (now enforced) audit certifies. This is a deliberate, documented choice.
- **Controller-scoped variants stop being skipped.** With a controller-backed
  factory, `sample-weights` (`_sampleWeightConfig`) is evaluated like any other
  candidate; the `skipped` row disappears.
- **A fidelity self-check.** Every report states which model path produced the
  numbers (`model: 'bare-hivemind' | 'controller'`), the feature width and the
  indicator set, so a proxy result can never be misread as a shipped-model result.
- **Guard**: a test that the controller-backed factory yields a finite position
  series on real candles, that `auditNoLookahead` **catches** a deliberately leaky
  candle-driven feature, and that the honest one stays clean. `analyze.test.js`'s
  pure injected-core sections stay; add a section, do not replace.

### N1 · A real, causal, auditable signal family (deliver P3-1 honestly) — ✅ delivered

- **New `src/analysis/features.js`** — pure, point-in-time-safe functions of a
  candle window: fractionally-differenced momentum (`fractionalDiff` is already
  proven in `labels.js`), realized-volatility regime (short/long realized-variance
  ratio), volume/turnover imbalance, multi-horizon momentum sign agreement,
  range/close location, and the existing indicator set as a baseline candidate.
- **Each signal is a candidate** on the family-wise path, so SPA / Romano-Wolf
  runs over a *real* K ≥ 10 family instead of the six mechanism flags.
- **Proven causal + exact**: every signal passes `auditNoLookahead` (a `t+1` probe
  must be rejected), with a dedicated entry of exact reference vectors on a
  hand-computed series and a node mirror — the `analysis/` convention.

### N2 · Power and the unused dataset — ✅ delivered (pooling + power + all 8 symbols; default budget unchanged)

- **Raise the default budget** (e.g. `--bars=2000`, `train=250, test=50`) and turn
  the `folds > 200` guard into a documented bounded-chunk-and-pool policy; the
  manifest already records folds/bars/pooled length.
- **Use the 8 audited symbols.** Only `src/candles.jsonl` (BTCUSDT) is streamed
  while ~487k audited rows in `src/data/*_1h.jsonl` are never used. Two options
  that need no new design: **(a) pool** the per-symbol out-of-sample streams as
  extra folds, or **(b) cross-sectional holdout** (fit on 7 symbols, evaluate on
  the 8th, rotate). Either multiplies power immediately.
- **A power readout** in the report (pooled length, folds, minimum detectable
  effect or a bootstrap CI on the DSR) so a null verdict is interpretable.

### N3 · Run it and record the decision — ✅ **delivered: complete run, nothing promotes**

- Run `npm run analyze` + the family-wise cross-check over the shipped data; write
  a decision record (extend [`OPTIMIZATION.md`](OPTIMIZATION.md)) with the exact
  command, the run dir, per-candidate promote/reject, the family-wise verdict and
  the fidelity/power metadata.
- **Attempt 3 (2026-09-20, seed 1) — THE VERDICT.** `20260920T144633-seed1`
  (`--symbols=all --bars=600 --audit-probes=1 --reuse-base`, model `controller`)
  completed in 43,129,704 ms (11.98 h), 12,960 passes, 15/15 variants, 288 folds /
  4,320 pooled bars: **all 14 candidates `keep-off`**, **SPA p = 0.5699**
  (Rejects = [none], best `sig:momentum`, K = 15, T = 4,032), baseline pooled
  Sharpe **+0.4387** / PSR 0.9643 / DSR 0.5179 / break-even 12.42 bps / MDD 0.0242.
  `query-mod` (DSR 0.9992), `sig:momentum` (1.1059) and `sig:acceleration`
  (1.0502) miss only on fold-consistency. Nothing promoted ⇒ no golden re-frozen.
  Two report-honesty defects surfaced (`BUGS.md` #26/#27) ⇒ **round 25**.
  Forensics, the exact offline journal verification and the supplemental
  cost/per-symbol/correlation analyses: [`RUN-ANALYSIS.md`](RUN-ANALYSIS.md) §5.
- **Attempts 1-2 (history).** Attempt 1 (2026-09-20, seed 1) was interrupted
  inside the second candidate — 1,862 fits, no `report.json`/`run.log`; attempt 2
  (the default smoke) was a complete but **underpowered** null (MDE95 ±2.0). Their
  forensics drove round 24/24b: report checkpointing, model-state reclamation, the
  audit teeth, the offline journal, and `--reuse-base`.
- **The exact commands that were run** (both are `node`, so they need the local
  `better-sqlite3` build):
  - `npm run analyze` — controller-backed, `src/candles.jsonl` (BTCUSDT), 300
    bars, the default 15-variant family, probe 0.05, 2 audit probes per fold.
    16 folds / 2376 `getSignal` calls on that window (measured), so expect
    minutes; the summary block and `report.json` both carry the verdict.
  - `npm run analyze -- --symbols=all --bars=600` — the pooled cross-symbol run
    (8 symbols pooled into one report via `poolReports`); this is the run that
    actually buys power, and it is ~8x the work of the first, so it is a
    deliberate choice rather than the default.
  - Optional: `--model=bare` reproduces the round-22 proxy for comparison,
    `--variants=surprise,sig-momentum` narrows the family, `--audit-probes=0`
    skips the (now non-vacuous) audit for a fast smoke run.
- Anything that promotes is an intentional hot-path change → a documented golden
  re-freeze + `OPTIMIZATION.md` entry. Anything rejected is recorded as an honest
  negative, not deleted.
- **Read the power line first.** The report carries Lo (2002) SE / 95 % MDE, so a
  null is only citable with its MDE attached; if the MDE exceeds any plausible
  effect, the honest next move is more data/folds, not more candidates.
- **Only after this** is the deferred `legion/evolve.js` decision, multi-symbol
  portfolio mode, or any new index/retrieval tier worth reopening.

### Hygiene bundle (small; fold in opportunistically) — ✅ delivered

- **Exact-count ledger floors** (P3-3): the 20 wrap-style mirrors now assert
  `assert.equal(result.total, N)` instead of `total >= N`, and every pinned N was
  re-measured in the browser harness first (the three that moved:
  `analysis` 354→390, `analyze` 47→98, `walkforward` 31→48; total 1845→1949). A
  mirror can no longer pass while quietly losing checks.
- **A performance ceiling** (P3-3): deliberately **not** added to
  `bench.test.js`. It has no node mirror, so `npm test` never executes it, and an
  absolute ms ceiling would pin the machine rather than the code. What `bench`
  does assert is the hardware-independent part — the per-operation `Math`
  primitive counters (`countersPerTrain` / `countersPerPredict`), which a
  complexity regression would move regardless of CPU speed. The two dominating
  suites (`dimensions` ~353 s, `lsh` ~177 s) remain the place a regression would
  hide, and their exact-count mirrors are the gate.

### Alternatives considered (and why they are not first)

- **Build multi-symbol/portfolio mode now.** The biggest *capability* unlock (8
  symbols audited, the controller proven per-symbol by `multisymbol.test.js`), but
  it needs a real design decision (one legion fed interleaved streams? one per
  symbol with a portfolio consensus? shared memory across symbols?) and a
  `DESIGN.md` §6 gate. N2's pooled/cross-symbol evaluation supplies the evidence
  for free and de-risks that design, so it comes first.
- **Hand-flip the six mechanism flags on.** The entire point of the gate is that a
  promote is *earned*; flipping without a controller-backed A/B would recreate
  exactly the "uncitable verdict" the round-22 work set out to remove.
- **New index/retrieval tiers or learned routing.** Explicitly out of scope
  ([`DESIGN.md`](DESIGN.md) §5).
- **Do only the hygiene items.** Cheap and real, but they do not answer the
  project's central question ("does any of this machinery help?"), so they are
  folded in rather than front-loaded.

**Acceptance for round 23**: one `npm run analyze` report that states it evaluated
the *controller-backed* model over a *real* causal candidate family (K = 15) with
a stated power, where every candidate has an explicit promote/reject and at least
one pooled/cross-symbol stream is included — plus the green gate. **Status:** the
report capability and the gate are done and green in the harness; the report
itself is the N3 local run.

**Process constraints (non-negotiable, `DESIGN.md` §6).** The audit change is
default-off / byte-identical by default, so `golden.test.js` stays 23/23 and the
`analysis.test.js` / `walkforward.test.js` pins stay green. `analysis/world.js`
and `analysis/features.js` are new additive modules proved **inside the existing
`analysis.test.js` (§AC/§AC-causality) and `walkforward.test.js` (section K)**
rather than as new entries — a deliberate choice: adding two entries would have
required a third and fourth node mirror **and** re-syncing both ledger counts
(`test/node/mirrors.test.js` asserts exactly 30 browser entries / 39 mirrors), for
no extra coverage, since both are pure modules with no worker/DB dependency. Both
got a `lock-registry.js` entry (status, `proves`, `citations`, note), which is the
part that can silently drift; their citations reuse existing keys (`leakage2605`/`honesteval2608` for
`world.js`; `leprado2018afml`/`finval2609` for `features.js`), so no new
`docs/CITATIONS.md` key was needed. Every count in the docs was re-synced in the
same commit (RUNBOOK §6 table + `src/README.md` / root `README.md`,
`docs/LOCKED.md`), and `npm test` is the user-run confirmation.

---

## How work is prioritized

A mechanism only enters the locked *hot* core when it is (a) demonstrably
essential, (b) default-off so the goldens hold, and (c) proven by a dedicated
entry **and** grounded by a citation ([`DESIGN.md`](DESIGN.md) §6). Everything
scheduled below is either **enabling tooling** (harness, CLI, dashboard — no hot
math) or **fault handling on an error path** (guards and try/catch that cannot
change a clean trajectory). The six default-off features already clear (b) and
(c) and are inert; **the missing work is the decision**, which is why P2 stays
dominated by *measurement*. The new principle this revision adds is a hard rule:

> **No long run is started until `npm run preflight` passes and
> `npm run dryrun` reports all invariants green.** Investigate, then run.

---

## P0 — Run integrity: make a full run safe, testable and reproducible

> **Status: delivered in round 22** (see the round-22 section above; the plan is
> kept as the archived record). Everything below is implemented and proven on the
> native driver ([`BUGS.md`](BUGS.md) #21).

This phase is the user's directives 1 and 2, and it is fully executable now
(no dependency on the A/B). All of it is guard/exception-path or tooling, so the
11 golden fingerprints must remain byte-identical — that is the acceptance test.

### P0-1 · Fault-isolated pipeline (controllers must not corrupt a run or its data)

The audit found that the shipped pipeline's failure behaviour is "abort
everything". The named suspects (each to be **confirmed by a test**, then fixed):

- **`legion/batch.js` calls `process.exit(1)` when any worker rejects.** One
  controller, one corrupt memory row, or one transient SQLite error therefore
  kills a multi-hour run *and* exits before the next checkpoint. This is the
  single worst offender. Fix: per-controller isolation — a failed controller
  keeps its previous `lastSignal`, the failure is counted and surfaced, the batch
  continues; a configurable **failure budget** (`CONFIG.maxControllerFailures`,
  default e.g. 10%/batch of the pool, plus a hard consecutive-batch cap) aborts
  with a clear diagnosis only when the pool is genuinely broken.
- **No worker timeout.** `runWorker` / `runConsolidationWorker` await a promise
  that only settles on `message`/`error`/`exit`; a hung worker stalls
  `Promise.all` forever. Add a watchdog (`CONFIG.workerTimeoutMs`) that
  terminates + rejects (routed through the same isolation path).
- **`HiveMindController`'s constructor calls `process.exit(1)` on a mkdir
  failure**; inside a worker this surfaces as exit-code 1, which the pool treats
  as a fatal reject. Return a structured error signal instead.
- **Unvalidated constructor/config inputs**: `priceObj`
  (`atrFactor`/`stopFactor`/`minPriceMovement`/`maxPriceMovement`), `ensembleSize`,
  `cacheSize`, `tier`, `type` are used without range/finiteness checks, so a bad
  config yields silent `NaN` targets rather than a clear failure. Fail fast at
  construction (the isolation layer then degrades gracefully).
- **Non-finite values at the DB boundary.** `getSignal`'s `prediction` can become
  `NaN`, the legion consensus prices divide by a possibly-zero `entryPrice`, and
  `saveLegionState` can `JSON.stringify(undefined)`. A `NaN`/`undefined` bound to
  a `NOT NULL REAL` column throws (or silently NULLs a nullable one). Add one
  `sanitizeSignal()` / `assertFiniteOrNull()` chokepoint at every SQLite write.
- **Corrupt-row tolerance.** `_updateOpenTrades` / `_processClosedTrades`
  `JSON.parse` a stored `features` cell; corruption throws inside the worker.
  Catch, quarantine (count + skip) the row, and continue.
- **Boundary validation in `getSignal`** (ratios `bcR`/`injR`, `processCount`,
  array shape) so bad *arguments* are rejected, not propagated.
- **Controller test-coverage audit** (the user's directive 1, specifically):
  today the controller is covered by `core.test.js` (20), `features.test.js`
  (11), `golden.test.js` (23) and `multisymbol.test.js` (28) — all happy-path /
  invariant. The missing categories are: a **"getSignal never throws" property
  test** (fuzz malformed candles/configs); **corrupt-DB-row** tests; a
  **malformed-config** test that asserts a clear error, not a `NaN` trajectory;
  and the **fault-injection** test (P0-3) that proves one bad controller cannot
  abort a batch. These become part of the controller's proof, not a separate bag.

**Done when**: a new `test/node/fault_isolation.test.js` proves a poisoned
controller is isolated while the batch completes and persists; the golden suite
is unchanged; the DB-boundary sanitizer is proven to reject `NaN`/`undefined`.

### P0-2 · Determinism & durability (a run must be reproducible and crash-safe)

- **Seeded runs.** Add an opt-in run seed (`NEULEGION_SEED` / `CONFIG.seed`)
  that wraps the engine's `Math.random` (the docs already note this is the single
  randomness source), so a run is bit-reproducible. Default off → goldens and all
  existing tests unchanged. This is what makes an A/B verdict citable.
- **Run manifest + config/structure fingerprint.** Write `state/main/run.json`
  (code version, `CONFIG` fingerprint, `structureDims`, start time, resume
  counter) and refuse to silently resume when the persisted structure/config
  fingerprint does not match the live `CONFIG` — today a config edit can be
  silently applied on top of an incompatible state.
- **Atomic checkpoint + graceful shutdown.** Handle `SIGINT`/`SIGTERM`: stop the
  stream, run the final `saveLegionState()`, checkpoint WAL, exit 0. Today
  Ctrl-C between `processBatch()` and `saveLegionState()` loses the batch's
  legion-state write.
- **Crash-recovery test.** Kill a seeded dry-run at a random batch, reopen, and
  assert the resume counter, structure and vault counters are consistent and the
  run continues from the checkpoint (no duplicate/partial row).

**Done when**: two seeded dry-runs of the same length produce byte-identical
report artifacts; a SIGTERM mid-run leaves a resumable, consistent state.

### P0-3 · Legion test harness: dry-run, preflight, runner/worker tests

The user's directive 2: "write tests that can test runners / workers, so we can
test all issues before a full run is started." The shipped path
`mainController.js → legion/runner.js#processCandles → batch.js → worker.js →
HiveMindController.getSignal` is **not exercised by any test today**
(`legion.test.js` checks structure and drives `state` directly; it never streams a
file). `processCandles` also never resolves (`await new Promise(() => {})`) and
binds a fixed port — both need to become testable.

Small, safe enablers (the prerequisite):

- `NEULEGION_STATE` — state-dir override. `legion/database.js` opens its DBs at
  *module-eval* time from `CONFIG.stateFolder`, which no caller can override
  (the consolidation worker already takes such an override — mirror it).
- `NEULEGION_FILE` — candle-stream override (synthetic streams for tests).
- `NEULEGION_HTTP_PORT` (accept `0` for an ephemeral loopback port) and a way to
  disable the HTTP worker entirely in tests.
- `CONFIG.maxBatches` + an `onBatch` hook, so the stream loop can run N batches
  and **resolve** with a summary; `processCandles()` stays the CLI entry
  (`keepAlive: true`). This is a behaviour-preserving extraction.

Deliverables:

- **`npm run dryrun`** (`src/dryrun.js`): runs the *real* pipeline over a seeded
  synthetic stream (configurable length/batches) into a temp state dir and prints
  a structured report — batches, per-batch wall time, every signal
  finite/shape-checked, persistence + resume round-trip, vault growth, worker-pool
  stats, observer alerts — exiting non-zero on any invariant failure.
- **`npm run preflight`** (`src/preflight.js`): read-only checks *before* a run —
  candle-file integrity (reuse `candles_audit`), state dir writable, DBs openable
  + schema version, `CONFIG` sanity (dimensions, worker count, ratios in range),
  a worker-spawn smoke test, HTTP port availability, and a disk/memory headroom
  estimate. Prints PASS/FAIL, exits non-zero on failure.
- **Node-only tests** (real drivers; added to the `mirrors.test.js` `NODE_ONLY`
  set and the node-mirror ledger):
  - `test/node/runner_smoke.test.js` — a short synthetic JSONL through
    `runner.js` into a temp state dir; asserts a well-formed signal, persistence,
    the resume counter, and that the read-only view answers.
  - `test/node/worker_pool.test.js` — `runWorker` + `runConsolidationWorker` on a
    tiny config: signal shape, duration, terminate; **fault injection** (a
    controller whose `getSignal` throws is isolated and the batch completes).
  - `test/node/http_view.test.js` — spawn the HTTP worker on an ephemeral
    loopback port; assert `/`, `/api/state`, `/api/events` and a 404 contract.
  - `test/node/dryrun.test.js` — the dry-run on a tiny config returns a green
    report; a deliberately poisoned stream returns non-zero.
  - `test/node/shutdown.test.js` — SIGTERM mid-run flushes the final checkpoint.

---

## P1 — Observe the legion: dashboard + a dedicated outer analyzer

> **Status: delivered in round 22** (archived plan; `dashboard.js`,
> `http_server_worker.js`, `src/observer/*` — proven by `http_view.test.js` and
> `observer.test.js` (76)).

The user's directives 3 and 5. Both are **read-only / additive and never import
the hot path** ([`DESIGN.md`](DESIGN.md) §2), so they cannot move a fingerprint.
They share one snapshot stream, which is what lets the run report, the live
dashboard and the offline evaluation all agree.

### P1-1 · Monitor dashboard (replaces the raw JSON-over-LAN broadcast)

Today `http_server_worker.js` serves the raw state JSON and gates it behind a
CORS allow-list for `http://<lan-ip>:3001` — i.e. the only consumer is some
external page on the LAN. Replace it with a **self-contained, served dashboard**:

- **Serve** `GET /` as a single self-contained HTML page (`src/dashboard.html`;
  inline CSS + a small vanilla-JS renderer, no framework, no build step, no
  external requests) read once at worker start-up.
- **API**: `GET /api/state` (the current `getCleanLegionState` + `consensus` +
  `lastCandles` + `overview`), `GET /api/events` (Server-Sent Events pushed on
  every batch, so the page live-updates without polling), `GET /api/report` (the
  latest run/dry-run report). GET-only, read-only — the existing contract.
- **Bind `127.0.0.1` by default** (`CONFIG.httpHost`), not the LAN IP: no CORS
  allow-list is needed and nothing is exposed to the network. `NEULEGION_HTTP_PORT=0`
  picks an ephemeral port for tests.
- **Panels**: status / uptime / candle counter and batch timing; consensus
  direction+confidence and a last-candles sparkline; a sortable/filterable
  per-controller table (score, influence, speed, tier, polarity); an influence
  distribution readout (Gini/HHI + effective voters); memory-vault totals and
  growth; worker-pool/error stats; and the observer's alerts.
- **Test**: `test/node/http_view.test.js` + a snapshot test of the HTML/JSON
  contract (the worker still receives state via `postMessage`, so the hot path is
  unchanged).

### P1-2 · Analysis outer layer — a dedicated legion observer

`analysis/*` scores **returns** offline. The user asked for a layer that *watches
the legion itself*. New additive `src/observer/`:

| module | role |
| --- | --- |
| `observer/collector.js` | subscribe to the per-batch snapshot (via the runner's `onBatch` hook, and/or tee it to a spool) and maintain rolling windows |
| `observer/metrics.js` | **pure**, exact-reference-vector diagnostics of legion internal health |
| `observer/alerts.js` | threshold/hysteresis rule engine over the metrics (config-driven; **alerts only, never mutates the run**) |
| `observer/report.js` | compose the run report (per-batch series + alerts + final metrics) to `state/runs/<id>/report.json` |

`metrics.js` computes, at minimum:

- **Consensus calibration** — Brier score + a reliability curve of the consensus
  direction/confidence against the realized next-bar outcome (Murphy
  decomposition), and a rolling hit-rate-vs-chance sequential test (SPRT) so a
  drift to chance is detected early.
- **Ensemble diversity** — entropy / agreement (Cohen κ) / effective number of
  voters, to catch the "echo chamber" collapse the design's broadcast can cause.
- **Influence concentration** — Gini / HHI over the influence list; alerts when
  one controller dominates the consensus.
- **Drift & staleness** — CUSUM/EWMA on per-controller score and on the consensus
  Brier (ties into the recorded `#isStagnating` finding); regime-change flag.
- **Memory health** — vault size/growth rate, core:volatile ratio, purge rate,
  broadcast/injection ratios.
- **Pipeline health** — worker errors/timeouts per batch, sanitizer trips,
  quarantined rows, DB-write latency.
- **Data health** — candle repairs, gaps, out-of-band moves.

Grounding (added to [`CITATIONS.md`](CITATIONS.md)): calibration (Brier 1950;
Murphy 1973), sequential testing (Wald 1945), CUSUM (Page 1954), diversity/κ
(Cohen 1960; Kuncheva & Whitaker 2003), concentration (Gini 1912; Hirschman
1945). `metrics.js` is additive and pure → an entry + node mirror with exact
reference vectors, `LOCKED-invariant`; the collector/wiring are structural.

**Done when**: a dry-run and a real run both emit a `report.json`; the dashboard
shows the same metrics live; the pure metrics have exact reference vectors and a
node mirror.

---

## P2 — The decisive evaluation (the A/B, now run on a trustworthy runner)

> **Status: the *driver* was delivered in round 22 and its *fidelity* in round 23**
> (archived plan; `analyze.js` + `npm run analyze`, proven by `analyze.test.js`,
> 158 checks after N0/N1/N2, the round-24 run-integrity sections and the round-25
> dependence-aware gate). It now evaluates the shipped `HiveMindController`
> through a non-vacuous audit (`analysis/world.js`, `BUGS.md` #22) over a real
> 15-candidate causal family. **The N3 verdict run is DONE**
> (`20260920T144633-seed1`: nothing promotes, SPA p = 0.5699 —
> [`RUN-ANALYSIS.md`](RUN-ANALYSIS.md) §5, [`OPTIMIZATION.md`](OPTIMIZATION.md)).

This is the original P0, deliberately deferred behind P0/P1 so its verdict is
reproducible and its report is evidenced. The plan itself is unchanged.

**P2-1 · Runnable walk-forward A/B driver + decision report.**
The walk-forward harness (`analysis/walkforward.js`) and the promotion gate
already exist and are proven; the six default-off features (`surprise.js`,
`sample_weights.js`, `homeostasis.js`, `multiprobe.js`, `binarypc.js`,
`querymod.js`) are proven and inert. What has never been run is the actual A/B.

- **Deliverable**: `src/analyze.js`, a runnable CLI (`npm run analyze`) that
  loads the shipped candles (seeded, via P0-2), builds a candidate family —
  `{baseline(off), surprise, sample-weights, homeostasis, multiprobe, pca-hash,
  querymod}` plus the injected oracle control used by the tests — runs
  `walkForwardEvaluate` + `familywiseSearch` on the pooled out-of-sample returns,
  and prints `formatReport` + `promoteDecision` per candidate. It consumes the
  observer's per-candidate series where available and writes its report to
  `state/runs/<id>/`.
- **Must be**: deterministic under a fixed seed **and** causal — it must pass
  `auditNoLookahead` (a `t+1` feature is rejected) before it reports anything.
- **Done when**: every candidate has an explicit promote/reject, and any
  *promote* carries an intentional golden re-freeze recorded in
  [`OPTIMIZATION.md`](OPTIMIZATION.md). **Start from** the proven section-H family
  so the baseline reproduces a known verdict before the four extra candidates are
  added.
- **Grounding**: `financial-validation.md`, `lsh-ann.md`, `continual-learning.md`,
  `memory-retrieval.md`, `ensemble-evolution.md`.

**P2-2 · The analysis battery behind the same CLI.** Expose the whole
honest-evaluation battery (PSR/DSR/MinTRL, PBO/CSCV, RC/SPA/StepM, k-FWER/FDP,
purged/walk-forward CV) for a candidate's return series from the same CLI. Today
these modules are library-only and test-only.

**P2-3 · Close the last raw-float fingerprint.** `hm:postReloadPrediction` is the
one remaining fingerprint over an unrounded float64 (the reloaded prediction) —
it did not move under the drift (#17), but it is the same *class* of observable as
the one that did. Round it like `hm:predictions` (or justify leaving it), so no
fingerprint depends on last-ulp engine behaviour.

---

## P3 — Coverage, remaining hardening, candidate systems

> **Status: partially delivered in round 22.** P3-1 is marked done but see the
> round-23 note: the *mechanism flags* became the family, not the named causal
> signals (N1 below re-opens it honestly). P3-2 is a formal deferral. **P3-3 is
> partly open** (hygiene bundle) and **P3-4 is open** by deliberate tradeoff.

- **P3-1 · Grow the feature universe K** on the family-wise path
  ([`TODO.md`](TODO.md) item 11): fractional-diff momentum, volatility regime,
  volume/turnover; run the SPA/Romano–Wolf gate plus the k-FWER/FDP relaxations
  over it. Grounding: `arxiv-sweep-2026-09i.json`.
- **P3-2 · Decide the low-rank ES.** `legion/evolve.js` is proven but **nothing
  imports it**. Wire it behind a flag and A/B it (member-level monotone-fitness
  demonstration + a flag-gated trajectory check), or formally defer it.
- **P3-3 · Remaining untested surfaces**: the fetcher CLIs
  (`fetch_candles.js`, `update_candles_basket.js` — the `candle_fetcher.js`
  library is tested), memory-vault capacity/prune at scale
  (`memoryVaultCapacity`, `maxVaultCandidates`), and exact-count ledger
  assertions (today the floors are `>=`, so an entry emitting *extra* checks would
  not be flagged).
- **P3-4 · SQLite reload bit-idempotency** (Known/latent): persist
  `_priorityIndices`/derived caches (Cause 2) *then* consider float64 blobs
  (Cause 1); only then tighten the golden reload guard to `Object.is()`. Blocking
  but a deliberate tradeoff; revisit with a storage-budget decision.

**Candidate systems** (need a proven need + `DESIGN.md` §6 before building):

- **Multi-symbol / portfolio mode.** The manifest ships 8 audited symbols
  (~567k rows) and `multisymbol.test.js` proves the controller handles all eight,
  but `CONFIG.file` trains on `src/candles.jsonl` (BTCUSDT) only. A portfolio
  mode needs a design decision, a walk-forward A/B vs the single-symbol baseline,
  and the definition of done.
- **Scheduled data refresh in-repo.** `docs/ci/update-candles.yml` is a workflow
  *source* that cannot be committed to `.github/` via the workspace API; it needs
  a real home if the dataset must stay fresh.
- **Performance guard.** `bench.test.js` prints timings but asserts nothing; a
  coarse pass/fail ceiling on a reference config would catch an accidental
  complexity regression (important for the low-end-device target).

---

## Added beyond the requested list

These came out of the audit and are folded into the phases above; recorded here
so they are not lost:

1. **Reproducible runs** — run-level seed wrapper + `run.json` manifest
   (code/config fingerprint) (P0-2). Without this an A/B verdict is not citable.
2. **Durable run lifecycle** — graceful `SIGINT`/`SIGTERM` shutdown, atomic
   checkpoint, crash-recovery test (P0-2).
3. **Bounded work** — worker watchdog/timeout, a failure budget, and
   backpressure/queue-depth limits on the pool (P0-1/P0-3).
4. **`npm run preflight`** — a single read-only gate that checks *every*
   precondition before a long run (P0-3). The user's "test all issues before a
   full run" made concrete.
5. **Structured run journal** — a leveled logger + `state/runs/<id>/run.log`
   replacing interleaved `console.log` spam; the same events feed the dashboard
   and the observer (P1).
6. **Snapshot spool** — tee each batch snapshot to `state/runs/<id>/snapshots.jsonl`
   so a finished run is post-mortem-analyzable offline and the observer/A-B can
   replay it (P1).
7. **Data quarantine** — malformed candles and corrupt DB rows are counted and
   skipped (quarantined), never silently dropped, and surfaced in the report
   (P0-1).
8. **Resource telemetry** — heap/RSS, batch latency, queue depth and vault growth
   shown on the dashboard and asserted in the dry-run (P1).
9. **Retention policy** — cap `state/runs/` so repeated runs cannot fill the disk
   (P1).
10. **A golden-safety rule** — every P0 hardening change must be provably
    exception/guard-path only; `golden.test.js` stays 23/23 with the same 11
    hashes, or the change is an intentional, documented re-freeze.

---

## Deferred (research leads — a catalogue, **not** a schedule; [`DESIGN.md`](DESIGN.md) §5)

New ANN index tiers (Locality-Sensitive Filtering 2604.24323, HNSW/graph
2607.28999, learned partition trees 2607.09909), temporal-co-occurrence retrieval
(2602.11322), heavier associative recall (holographic 2606.18492, Sinkhorn
2606.28300), learned routing (2608.15438 — captured in closed form by the
query-adaptive budget). None are in scope unless the definition of done in
`DESIGN.md` §6 is met and the A/B justifies them.

---

## Coherency audit — this revision

| Check | Result |
| --- | --- |
| Registry total & status split (53 = 17 + 36 + 0 + 0) | ✅ verified programmatically against `lock-registry.js` |
| Ledger sum (1995) vs `RUNBOOK.md` §6 table | ✅ exact match |
| Manifest ↔ registry coverage (22 hivemind + 5 controller bags) | ✅ via `locks.test.js` |
| Browser entries ↔ node mirrors ↔ `KNOWN_TESTS` (30/39/29) | ✅ via `mirrors.test.js` |
| Golden fingerprint count (11) across all docs | ✅ consistent |
| Syntax + relative-import resolution (169 JS files, 368 relative imports) | ✅ 0 errors (re-measured this revision) |
| Counts in prose (115 blocks, 39 mirrors, 1995 checks) | ✅ synced |
| Exact check count in every wrap-style mirror | ✅ 20 mirrors now `assert.equal(result.total, N)` (was `>=`) |
| Runner/worker/HTTP path in tests | ✅ **P0-3** delivered (`runner_smoke`, `http_view`, `dryrun`) |
| Controller fault-isolation / malformed-input coverage | ✅ **P0-1** delivered (`guards`, `worker_pool`) |
| `process.exit(1)` on a worker reject aborts the whole run | ✅ removed (**P0-1**); proven by `runner_smoke` |
| Worker timeout / hung-worker protection | ✅ **P0-1** (`runWorkerThread` watchdog, `worker_pool.test.js`) |
| Analysis modules runnable from a CLI | ✅ **P2-1/P2-2** (`npm run analyze`) |
| Raw JSON-over-LAN broadcast (no dashboard) | ✅ **P1-1** (served dashboard + SSE, `http_view.test.js`) |
| No dedicated legion observer | ✅ **P1-2** (`src/observer/*`, `observer.test.js`) |
| `hm:postReloadPrediction` raw-float surface | ✅ **P2-3** rounded; `5f703135` re-freeze recorded |
| `legion/evolve.js` imported by nothing | ⚠️ orphan → **P3-2** (formal deferral) |
| Native gate green (real `better-sqlite3` + `worker_threads`) | ✅ **115/115**, `BUGS.md` #21 |
| A/B evaluates the **shipped** (controller) model path | ✅ **N0 delivered** — `makeControllerModelFactory` drives the real `HiveMindController` prequentially; `sample-weights` is evaluated, not skipped |
| The look-ahead audit is **non-vacuous** for a candle-driven model | ✅ **N0 delivered** — `viewFor` + a structural `vacuous` flag; the candle leak is now caught (`BUGS.md` #22) |
| A real causal feature family is the candidate set | ✅ **N1 delivered** — 8 causal candidates in `analysis/features.js`, K = 15 on one family-wise gate |
| The 8-symbol audited dataset is used | ✅ **N2 delivered** — `--symbols=all` + `readCandles` + `poolReports` (the *default* run is still BTCUSDT) |
| Exact-count ledger floors | ✅ delivered — the 20 wrap mirrors assert exact counts (1845 → 1995 checks across rounds 23-24) |
| Performance ceiling asserted | ✅ resolved as N/A — `bench` has no mirror so `npm test` never runs it; its `Math`-primitive counters are the hardware-independent regression signal |
| The round-23 verdict itself | ✅ **N3 delivered** — `20260920T144633-seed1`, nothing promotes, SPA p = 0.5699 |
| The report's own power claim | ⚠️ **round 25** — cross-stream correlation ⇒ honest MDE95 ≈ ±0.98, not ±0.47 (`BUGS.md` #26) |
| The verdict's cost-robustness | ⚠️ **round 25** — the gate flips at 2 bps (`BUGS.md` #27) |
| The fold-consistency hurdle | ⚠️ **round 25** — a raw 0.5 threshold on 288 correlated folds decides all three real candidates |

## Open risks

- **The verdict is recorded but not decisive (N3 + `BUGS.md` #26).** Attempt 3
  settles the family-wise question at this T (nothing rejects) and the golden set is
  unchanged, but the 8 streams are ~0.47-correlated, so the honest MDE95 is ≈ ±0.98:
  the run can rule out Sharpe ≳ 1, not Sharpe 0.5. A decisive experiment needs more
  *independent* data (diverse symbols / longer history) rather than more correlated
  crypto majors.
- **The promotion gate is the binding constraint, not the data (`BUGS.md` #27).**
  All three DSR-significant candidates fail only `foldWinFraction >= 0.5` /
  positive-fold-vs-baseline, and the result flips with the unstated cost
  assumption. Until the gate is cost-robust and the fold hurdle is a significance
  statement, a "keep-off" here means "this gate did not pass it", not "no edge".
- **Cross-candidate correlation shrinks the search dimension.** The excess per-fold
  Sharpe of `sig:momentum` and `sig:acceleration` correlates 0.863, so K = 15
  overstates the independent search; the family-wise test is conservative in a way
  that nothing currently reports.
- **Controller-backed evaluation is slower than the proxy.** Measured on the real
  driver: **10.7 s per controller fit**, and the fit count is
  `mechanismVariants × folds × (1 + auditProbesPerFold)` — 4,032 fits for the
  attempt-3 power run (11.98 h). Signal candidates are free; mechanism candidates
  are ~1.7 h each at this scale.
- **Low statistical power (round 23).** The default 300 bars / ~12 folds cannot
  distinguish a real effect from noise, so "nothing promotes" is expected either
  way. N2 (more bars, pooled/cross-symbol streams) is what makes a null
  interpretable.
- **Promotion changes the hot path.** Any feature promoted by N3 changes the
  default trajectory and therefore the goldens; the re-freeze must be deliberate
  and documented, and the N3 report is the evidence.
- **Testability of the legion DB.** Without the P0-3 override, the shipped
  orchestration stays untested; the override is the prerequisite (now delivered).
- **Hardening must not move a fingerprint.** The P0-1 guards are error-path only;
  if any guard turns out to run on the clean path, it is a deliberate re-freeze,
  not a "cleanup".
- **Ledger churn.** Ledger counts are (30 browser entries / 39 mirrors / 1995
  checks) and `mirrors.test.js` asserts the two layout constants exactly; every
  count in the docs must be re-synced in the same commit. Round 23 avoided adding
  entries by proving the new `analysis/world.js` and `analysis/features.js` inside
  the existing `analysis.test.js`/`walkforward.test.js`, so the ledger counts only
  had to change where the entries themselves grew — and the 20 wrap-style mirrors
  were switched from `total >= N` to `result.total === N` in the same pass.
- **Latent numerics** (SQLite reload, MAD/variance proxy, percentile 0→1,
  trigger-happy stagnation, MACD alignment) are pinned/documented, not fixed;
  touching any is a golden re-freeze plus a benchmark.
