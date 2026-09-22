# NeuLegion — roadmap & next-step plan

This is the consolidated, prioritized plan (the "what next, and why"). It is the
single place to see the intended order of work; [`TODO.md`](TODO.md) keeps the
full history and research backlog, and [`DESIGN.md`](DESIGN.md) §5/§6 is the
scope freeze that bounds it.

## Status snapshot (this revision)

- **Round 26 is planned and starts from a correctness finding, not from new
  features.** The user asked for the round-26 draft to be re-checked for coherence
  and research grounding, and for a sweep + bug check of every controller before
  more compute is spent. The sweep's first pass found a **blocking** defect
  (`BUGS.md` #33): the
  A/B driver streams the whole growing candle prefix into the shipped controller
  where production streams a fixed `cacheSize` window, so the controller's trade
  bookkeeping sees bars older than each trade's entry and its training labels are
  corrupted (measured 78/144 wins vs 156/64 with the production window, same seed
  and data). Every `baseline` number in `RUN-ANALYSIS.md` §7 is therefore not the
  shipped model's; the signal-family rows and §7's economic verdict are unaffected.
  Round 26 is re-ordered to correctness → throughput → economics → decision quality
  → family search, with the sweep itself as a permanent procedure (R26-1) and sixteen
  contract tests (R26-10). **A second pass (round 26b, the user's re-run of the
  request) added two more measured defects (`BUGS.md` #36 the optimistic intrabar
  label tie-break / gapped stop fill / unlabelled trades, #37 the missing label base
  rate and skill score), corrected round 25c's cost claim (the re-insert churn is
  *not* the large per-call term — measured against a production-shaped control),
  found the real per-call cost breakdown (inference ≈ 54 %, full-state checkpoint
  ≈ 25 %, training ≈ 14 %), and added the round's family-search half (R26-11 label
  policy variants, R26-12 checkpoint throttle, R26-13 seed replication with common
  random numbers, R26-14 forecast comparison + Model Confidence Set, R26-15 gated
  racing).** See `RUN-ANALYSIS.md` §8 and `OPTIMIZATION.md` "Round 26b".
- **Core design frozen** ([`DESIGN.md`](DESIGN.md)); no new hot-path subsystem is
  scheduled. Everything below the hot path (harness, dashboard, observer) is
  additive and default-off / read-only by construction.
- **Golden lock bit-exact on the native driver**: 23/23 golden checks, 9 of 11
  fingerprints literal, `hm:predictions` **and** `hm:postReloadPrediction`
  compared at 6 significant digits ([`BUGS.md`](BUGS.md) #17, #19).
  `engine_portability.test.js` guards it.
- **Local gate: green.** `npm test` is **123/123 `test()` blocks across 42
  files, 0 failures, ~5.9 min** on the native driver (last re-run: round-26b, the
  R26-4 parallel fix; [`BUGS.md`](BUGS.md) #42).
  The run exposed exactly one real defect in the new P0-P3 tooling — `preflight`
  counted the sampled candle window's truncated tail line as malformed, so it
  failed on a *healthy* checkout ([`BUGS.md`](BUGS.md) #20) — now fixed, with the
  test hardened to report the real failing check.
- **Registry**: 60 entries — **17 bit-exact, 43 invariant, 0 needs-local-run, 0
  experimental** ([`LOCKED.md`](LOCKED.md)).
- **Browser suite**: 2289 checks across the 29 pass/fail entries (30 entries
  including the non-pass/fail `bench`); 123 `test()` blocks across 42 node files
  (R26-12 added `checkpoint_throttle.test.js`, R26-4 added
  `parallel_folds.test.js`, R26-5 added `analyze_cli.test.js`, R26-13 added a second
  block to it, all node-only suites),
  all verified green in the browser harness for this revision (round 23 raised
  `walkforward` 31→48, `analysis` 354→390, `analyze` 47→98, round 24 raised
  `analyze` 98→143, and made every
  wrap-style mirror assert its count **exactly**). The blocks are green on the
  native driver — **confirmed locally at round-26b** (**123/123 `test()` blocks
  across 42 files, 0 failures**, including the R26-12/R26-4/R26-5/R26-13 node-only
  suites and the R26-4 parallel fix of `BUGS.md` #42) — and the browser checks are
  verified in the harness for this revision.
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
> (1 + auditProbesPerFold)`) is `RUN-ANALYSIS.md` §4 (round 25b corrects the fit cost to be O(n²) per stream). **Round 25 is now the
> promotion-gate / report-honesty round** (items 31-37).

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
the browser harness: **2289 checks, 0 failures** across all 29 pass/fail entries
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

### Round 26 — status: 🔵 **in progress** (R26-0 + R26-1 + R26-12 + R26-2 + R26-3 + R26-11 + R26-4 + R26-5 + R26-6 + R26-13 + R26-14 + R26-7 + R26-8 + R26-9 + R26-10 landed; correctness first, then economics)

Evidence and numbers: `RUN-ANALYSIS.md` §7 and §8; defects: `BUGS.md` #33-#37.

The draft of this round was six items (parallelise, journal, turnover, diversity,
gate power, method). The user asked for it to be re-evaluated for coherence and
research grounding, and to add a controller sweep *before* spending more compute.
Doing that changed the plan, in one case decisively:

- **The old order was wrong.** It put throughput and economics first. The sweep
  found a defect (`BUGS.md` #33) that makes the A/B's `baseline` row not-the-model:
  the driver feeds the controller the whole growing candle prefix where production
  feeds a fixed window, so the controller's trade bookkeeping sees ancient bars and
  its training labels are systematically wrong (measured 78/144 wins vs 156/64 with
  the production window). Correctness is therefore a **precondition**, not a
  parallel workstream: nothing below can be measured until R26-0 lands.
- **Old R26-2 was under-specified.** It assumed "the pre-policy signal" is one
  quantity. It is not: the controller emits `prob` through `probToPosition`
  (dead-zone, scale), while the signal family emits `clampPosition(z)` with no dead
  zone, so the two families are mapped to positions incomparably (`BUGS.md` #34).
  The item becomes "**one** confidence→position pipeline + journal the raw value for
  both families", which is also what makes the turnover sweep meaningful.
- **Old R26-3 was measuring a confounded quantity.** "Signals trade 17-64× the
  baseline" is partly the policy asymmetry, so its 5-10 bps target has to be
  re-stated against a unified pipeline.
- **Old R26-4 said "other asset classes".** The basket is Binance-only, so a literal
  second asset class is not available from the existing pipeline. The operational
  goal is the *measured* one: maximise **effective** independent streams
  (`designEffect`, `effectiveBars`) per unit of compute, which a second bar interval
  and low-correlation symbol selection can also deliver.
- **Old R26-5 was vague** ("give `requireBreadth` a magnitude floor **or** replace
  it"). The plan now decides: the sign test becomes a *reported statistic*, and the
  hurdle becomes a two-part **magnitude + cluster-stability** requirement.
- **Missing entirely:** the sweep itself, the model-readiness diagnostics, the
  decision-grade report spec, and the test additions. All are now explicit items.
- **A second pass (round 26b)** then added the family-search half (R26-13/R26-14/
  R26-15), the label-policy variants (R26-11) and the checkpoint throttle (R26-12),
  and **withdrew round 25c's cost attribution** — see "Revision 2" below.

Research grounding is checked per item below; new references are added to
`docs/CITATIONS.md` and `docs/research/financial-validation.md` (the trading-cost /
turnover domain) in the same revision. No item is planned without either an existing
citation or a new, verified one.

#### Revision 2 (round 26b) — the second sweep pass, and what it changed

The user asked for the same request again: re-check the plan for sanity, coherence
and research grounding, sweep the controllers again so no bug can be causing a
faulty reading, add the tests, and optimise the analyse run so the models are
trained and read correctly and the report answers the next cycle's questions.
Six things changed. Two of them correct claims the plan was about to size compute
and expectations on; two are new measured defects; one is the plan's weakest
methodological point; one is housekeeping.

1. **The cost attribution was wrong, and the plan was about to inherit it.** The
   round-25c conclusion — "a large part of the A/B's per-call constant is the #33
   re-insert churn" — is **not supported**. Measured with the control (same
   controller, seed, candles, `cacheSize = 120`, one call per bar), a
   production-shaped *window* costs the **same** per call as the *prefix*: 56.6 vs
   55.4 ms/call at calls 150-200, and equal in every earlier block; the
   `8.8 → ~50 ms/call` "ramp" round 25c read as the churn's onset appears
   identically in window mode (early-run warm-up). Over 600 bars the whole
   difference is ≤ 8 % (51.2 vs 55.1 ms/call) while the prefix's re-insert volume
   reaches 480 candles/call. So R26-0 is a **correctness** fix; its speed benefit
   is unmeasured, no item may be sized on it, and the native constant must be
   re-measured after it lands. `OPTIMIZATION.md` "Round 25c" is replaced by
   "Round 26b".
2. **The per-call cost was measured, and the largest lever was not on the list.**
   One warm controller, 100 window-shaped bars, shim: `HiveMind.predict` **53.7 %**
   of per-call time, `dumpState()` **24.6 %**, `train` 14.2 %, `broadcastMemory`
   0.5 %, rest ~7 %. `dumpState()` re-opens the state DB, re-runs ~50 DDL + ~50
   `DELETE`, and re-inserts the **entire** ensemble state on every call — and the
   A/B never reads it back (the factory pre-creates the mind and discards the
   directory per fold). Roughly a quarter of every fold buys a checkpoint nobody
   loads. New item **R26-12** throttles it (`saveInterval`, default `1` ⇒
   byte-identical; the A/B sets "final only"), grounded in the classical
   checkpoint-interval problem.
3. **A second label defect, measured (#36).** `_updateOpenTrades` books a bar that
   spans *both* barriers as a **win** (take-profit tested first) even though at the
   shipped factors (`baseAtr: 2`, `baseStop: 1`) the stop is half as far and thus
   the likelier first touch; it fills a **gapped stop at the stop price**; and a
   trade that never triggers a barrier is **never closed or labelled** (so
   `open_trades` is unbounded and those bars never train). Exposure on the 7
   audited 1h symbols: ~0.028 % of bars have both barriers inside the entry-price
   range, ~1.0 % span ≥ 3·ATR. New item **R26-11** makes the labeler a **variant
   dimension** (optimistic / conservative / triple-barrier), default off.
4. **The label base rate is 27 % and nothing reports it (#37).** Over 600 bars with
   the window shape: **155 wins / 411 losses** (the prefix gives 322/248 — the base
   rate is itself a function of #33). A model that always predicts the stop would
   be reported as ~73 % "accurate" by the bare `tradeAcc`. R26-2/R26-8 gain the
   base rate, a **skill score**, the label-lifecycle counters and the calibration
   reading, so "trained" (#35) and "skilful" (#37) are both answerable.
5. **The weakest point: one seed is not a family ranking.** Every variant ordering
   so far is single-seed, and `variantSeed` mixes the variant id into the fold
   seed, so variant comparisons are *unpaired*. New item **R26-13** replicates
   across master seeds, uses **common random numbers** across variants, and reports
   a variance decomposition + a stratified-bootstrap interval; **R26-14** adds the
   family's *forecast* comparison (proper scores, Diebold–Mariano, Model Confidence
   Set), because "which family is best" is a predictive-accuracy question and the
   A/B currently only asks it about PnL; **R26-15** is the racing / successive
   halving search those two make affordable (gated). New citations in
   `CITATIONS.md` "Experimental design, replication & model comparison".
6. **Coherence fixes.** `RUN-ANALYSIS.md` §7.9 (cited twice) does not exist → §4;
   the status snapshot's browser-suite count was stale (1995 across 28 → **2070
   across 29**; 2078 once the R26-0 contract tests landed, 2091 after R26-12, 2102 after R26-2, 2111 after R26-3, 2124 after R26-11, 2142 after R26-4, 2159 after R26-5, 2177 after R26-6, 2202 after R26-13, 2229 after R26-14, 2237 after R26-7, 2265 after R26-8, 2268 after R26-9, 2276 after R26-10, 2285 after R26-15, 2289 after the round-26b review); the round-23 "coherency audit" table is now labelled historical
   with its ledger noted as the round-24b total; the sweep's standing output is
   named **§9** explicitly (§8 is the finding, §9 the matrix); and the acceptance /
   order-of-work below are updated for R26-11…R26-15.

Two candidate defects were **checked clean and recorded** rather than fixed: the
`wins`/`losses`/`realPoints` bookkeeping is a correct linear proper scoring rule,
and `insertTradeStmt`'s duplicate-timestamp PRIMARY KEY is unreachable through the
driver contract (a probe calling `getSignal` twice with an identical window threw
nothing, because the second call re-inserts no candle and therefore opens no
trade). Both are in `BUGS.md`'s "Checked clean by the sweep" subsection.

#### Grounding check — what each item rests on, and which claims are *not* literature claims

The user asked whether the plan is research-grounded. Checked item by item; the
non-literature items are labelled as such deliberately, because a scheduling change
or a correctness fix does not need (and should not be given) an invented citation.

| item | the claim it makes | basis | status |
| --- | --- | --- | --- |
| R26-0 | the A/B must exercise the shipped input shape | engineering (same principle as round 23's N0), *measured*: prefix 78/144 vs window 156/64 | verified by measurement |
| R26-1 | invariants detect reading faults; boundary inputs must degrade at the boundary | engineering; the stop-and-alarm discipline traces to Wald (1945)/Page (1954) | procedure, not a claim |
| R26-2 | accuracy is uninterpretable without a base rate; the score must be *proper*; a "never trained" flag is an alarm | Brier (1950); Murphy (1973); Gneiting & Raftery (2007); Wald (1945)/Page (1954) | grounded; base rate 27 % measured |
| R26-3 | both families must share one confidence→position map, and the policy must be restatable from a journal | Constantinides (1986); Davis & Norman (1990); Gârleanu & Pedersen (2013); Pardo (2008) | grounded; asymmetry verified by reading |
| R26-11 | the triple barrier (profit/loss/**time**) is the standard label; intrabar order is unobservable from OHLC | López de Prado (2018) ch. 3; arXiv 2504.02249; 2411.12753 | grounded; exposure measured (0.028 %/1.0 %) |
| R26-4 | the fold loop is embarrassingly parallel and its seeds are scheduling-independent | engineering — **no literature claim**; the cost law is measured | verified: per-fold seed is `(variantSeed + testStart·977)` |
| R26-12 | a full-state dump per call is far from the optimal checkpoint interval | Young (1974); Daly (2006) | grounded; 24.6 % of per-call time measured |
| R26-5 | proportional cost ⇒ a no-trade region and a hold/hysteresis policy | Constantinides (1986); Davis & Norman (1990); Gârleanu & Pedersen (2013); arXiv 2101.09936, 1709.06296, 2502.04284, 2509.04541, 1904.04912 | grounded; the 0.09-3.47 bps gap is measured |
| R26-6 | breadth means *independent* bets, and the design effect converts count to breadth | Grinold (1989); Kish (1965); Harvey, Liu & Zhu (2016) | grounded; ρ = 0.35-0.57 measured |
| R26-7 | the sign test is a robust *reported* comparison but says nothing about magnitude; stability is a promotion criterion | Demšar (2006); Ledoit & Wolf (2008); Cameron & Miller (2015); Künsch (1989); Pardo (2008) | grounded; 8/8 pass + magnitude-reject measured |
| R26-8 | the report must answer the next cycle's questions without recomputation | the already-cited honest-evaluation battery + the experimental-design refs | spec, no new statistic |
| R26-9 | replay vs snapshot is a statistical decision, not an optimisation | López de Prado (2018); Pardo (2008); Cawley & Talbot (2010); arXiv 2412.10545 | grounded |
| R26-13 | one seed is not a ranking; paired comparisons have lower variance | Bouthillier et al. (ICML 2019); Henderson et al. (arXiv 1709.06560); Agarwal et al. (arXiv 2108.13264); Glasserman & Yao (1992) | grounded; the current seed schedule is unpaired (verified in code) |
| R26-14 | "best family" is a predictive-accuracy question; return the MCS, not a winner | Diebold & Mariano (1995); Hansen, Lunde & Nason (2011); Gneiting & Raftery (2007) | grounded; the journal makes it free |
| R26-15 | allocate the search budget by racing, not a full grid | Jamieson & Talwalkar (arXiv 1502.07943); Li et al. (arXiv 1603.06560) | grounded (gated) |
| research leads | cross-sectional construction buys independence by construction | Moskowitz & Grinblatt (1999); Moskowitz, Ooi & Pedersen (2012); Asness, Moskowitz & Pedersen (2013) | grounded (gated) |

**Citation verification.** The arXiv identifiers added in this revision were
resolved through the arXiv API and confirmed (title/authors/venue) before being
cited, not inferred from memory. One candidate was **rejected** on that check: the
id first remembered for the seed-reproducibility paper resolves to a
knowledge-distillation paper, so Bouthillier et al. is cited by venue (ICML 2019)
instead. Non-arXiv classics (Glasserman & Yao; Diebold & Mariano; Hansen, Lunde &
Nason; Gneiting & Raftery; Young; Daly) are given by venue/year; their specifics are
stated no more precisely than the source supports.

**Coherence check on the plan itself.** (a) No item changes the shipped trajectory
or a golden fingerprint: R26-0's driver fix and its `_updateOpenTrades` guard are
production no-ops, R26-11's policies default off, R26-12 defaults to the current
interval, R26-13/14 are analysis-layer. (b) R26-13 *does* change A/B numbers, and
that is stated where it is introduced rather than discovered later. (c) The O(n²)
replay is not "optimised away" anywhere except through R26-9's statistical
decision. (d) Sequencing is acyclic: R26-12 and R26-4 (throughput) precede R26-13
and R26-15 (search), R26-3 precedes R26-5 and R26-14 (they read the journal), R26-0
precedes everything (nothing is measurable before it). (e) Every item names its
acceptance evidence.

#### The sweep — R26-1 · a fidelity + invariant audit of every controller (the user's direct request)

The audit that found #33 was ad hoc (read the caller, then measure the callee in the
browser harness). Round 26 turns it into a repeatable procedure with a permanent
output: a sweep matrix in `RUN-ANALYSIS.md` (component × invariant × status), the
defects it finds as `BUGS.md` entries, and a contract test per invariant.

**Inventory (every stateful component, classified):**

| class | components | why it is in the sweep |
| --- | --- | --- |
| online/stateful model | `HiveMindController` (+ `controller/{candles,trades,accuracy,features,database}.js`), `HiveMind` (+ `kernels/`, `memory/`, `ensemble/`) | its *inputs* and its *counters* are what a reading is built from |
| online/stateful pipeline | `legion/{runner,batch,workers,state}.js`, `consolidation_worker.js` | shapes every window/seed the model ever sees; owns the failure budget |
| online/stateful support | `observer/{collector,legion_metrics,alerts}.js`, `http_server_worker.js`, `dashboard.js` | derives the health numbers a run is judged by |
| pure | `analysis/*`, `indicatorProcessor`, `candle_quality`, `candles_audit`, `price_precision`, `consolidation_logic`, `legion/{sanitize,rng,structure,serialization,signals}.js` | already dense-tested; re-checked for contract drift only |

**Invariants checked for each (this is the checklist, in order):**

1. **Input-shape fidelity** — does every caller pass the callee the same *shape* of
   input production passes? (This is the invariant #33 violated. Check: width,
   increment size, ordering, whether a "read" call mutates, and whether the caller
   passes whole history vs a window.) For each caller/callee pair, state production's
   shape explicitly and assert the A/B/tests match it.
2. **Ordering/timestamp assumptions** — does anything assume the input is strictly
   ordered, and does it guard? (#33's `_updateOpenTrades` does not.)
3. **Read-vs-write** — does a nominally-read operation mutate state a later
   statistic depends on? (e.g. `predict` also trains, by design; document, and make
   the fold the unit of parallelism so it stays deterministic.)
4. **Counter provenance** — is every reported number the one the code path actually
   produced? (Cross-check `stats()`/`audit`/`timings` against an independent
   recomputation from `folds.jsonl`; #31 was this class, #35 is the gap.)
5. **Boundary degradation** — shuffled / out-of-order / duplicate-timestamp /
   corrupt row / `NaN` / short / empty inputs must degrade safely (abstain,
   quarantine, or throw *at the boundary*), never silently mislabel.
6. **Determinism under a seed** — same (variant, fold) ⇒ same positions, for the
   factory *and* any parallel execution.
7. **Resource bounds** — no unbounded growth (`open_trades`/`closed_trades`
   backlogs, `state.cache`, model dirs, `closed_trades` rows processed 1/call).
8. **Dead guards** — a guard whose condition can never fire is a false certificate
   (`undertrained` at `warmup = 40` vs `trainSize = 60`, #35).
9. **Label realism & lifecycle** — does the labelling rule resolve an unresolvable
   bar optimistically, fill a gapped stop at the stop price, and give *every*
   opened trade a label at a bounded horizon? Is the label base rate reported, and
   is the accuracy metric referenced to it? (#36/#37; R26-11.)
10. **Cost & persistence attribution** — is the per-call cost attributed to the
   stage that actually produces it, and is any of it a full-state dump that is
   never read back? (the round-25c correction; the measured breakdown in
   `OPTIMIZATION.md` "Round 26b"; R26-12.)

**Concrete suspects already identified (the sweep starts from these, verified ones
first):**

1. **`BUGS.md` #33 — the prefix/window defect.** Verified by measurement. Blocking.
2. **`_updateOpenTrades` has no timestamp guard** (verified by reading; the
   invariant it violates, and the reason #33 corrupted labels rather than merely
   slowing the run).
3. **`insertTradeStmt.run` is unguarded** against a duplicate-timestamp PRIMARY KEY
   (`open_trades.timestamp`), so a data glitch could throw out of `getSignal`
   instead of abstaining.
4. **`BUGS.md` #34 — the position-policy asymmetry** (verified by reading).
5. **`BUGS.md` #35 — the readiness counters are computed and discarded**, and the
   `undertrained` guard is dead (verified by reading).
6. **`openSimulations`/`pendingClosedTrades` are two full-table `SELECT`s per
   `getSignal`**, and open trades that never touch TP/SL are never pruned — so a
   long production run grows `open_trades` without bound, and per-call cost with it.
7. **The re-insert churn** (#33's cost half) — verified by measurement.
8. **Silent candle drops**: `_getRecentCandles` filters out any candle with a
   non-finite OHLCV, so a malformed bar is skipped rather than flagged; the count is
   not reported.
9. **A/B fold semantics vs production**: `fit()` "purge exclusions are not honoured"
   is documented, but with a window-shaped input the statement needs re-checking
   (the folded train set and the streamed window must be reconciled explicitly).
10. **Warm-up depth vs production**: production's first dispatch already carries a
   full `cacheSize` window (the runner waits for `maxCache`), while a fold's first
   `cacheSize` calls carry 1..120 bars, so an early fold's controller is colder than
   production's at the same bar. Decide deliberately (require
   `testStart >= cacheSize`, or replay from bar 0 with a full first window) rather
   than leaving it implicit; measure the effect on the `model` block's
   `trainingSteps`.

**Added by the second pass (round 26b):**

11. **`BUGS.md` #36 — the optimistic intrabar tie-break** (verified by reading;
    exposure measured at ~0.028 % of bars with both barriers in range, ~1.0 %
    spanning ≥ 3·ATR).
12. **`BUGS.md` #36 — the gapped stop fills at the stop price** (verified by
    reading; one-sided optimism on every loser's label).
13. **`BUGS.md` #36 — an untriggered trade is never closed or labelled**
    (verified by reading; `open_trades` has no cap and two full-table `SELECT`s run
    per call; measured 7-20 open rows warm on 600 bars, unbounded in principle).
14. **`dumpState()` on every call** — a full ensemble-state rewrite the A/B never
    reads back (measured 24.6 % of per-call time; `OPTIMIZATION.md` "Round 26b").
15. **The A/B exercises only the `positive` polarity**, while production selects
    over `positive` and `negative` (verified by reading; the factory hard-codes
    `'positive'`).
16. **A back-in-time / non-contiguous window mass-re-inserts** even under the R26-0
    fix (measured `recentCandles = 80` for a window older than the cached set),
    because the insert is followed by the same transaction's cleanup — pure churn,
    and the one path that can still reach the duplicate-PK insert. The invariant:
    the A/B's per-call input must be the **contiguous, advancing** production
    window, and a test must pin it.

Each gets either a `BUGS.md` entry (with the measured evidence) or a note that it
was checked and is clean. The sweep is *done* when every cell of the matrix is
resolved and every finding has a contract test.

#### Part A — Correctness (blocking; do first)

- **R26-0 · Restore the A/B's controller input to the production window.** Replace
  `candles.slice(0, i)` in `fit()` and `candles.slice(0, t + 1)` in `predict()` with
  `candles.slice(max(0, i - cacheSize), i)` and
  `candles.slice(max(0, t + 1 - cacheSize), t + 1)`, exactly matching
  `legion/workers.js`'s `state.cache.slice(-cacheSize)`. Harden
  `_updateOpenTrades` with a timestamp guard (ignore bars not strictly after the
  trade's entry) and wrap the open-trade insert so a duplicate timestamp cannot
  throw; both are production no-ops and must leave all 11 golden fingerprints
  bit-identical. Re-derive every `baseline` number in `RUN-ANALYSIS.md` §7 and
  re-measure the cost constant. *Grounding:* this is not a literature question — it
  is the same "the evaluation must exercise the shipped path" principle as round
  23's N0 (`DESIGN.md` §6, `BUGS.md` #22).
- **R26-1 · The sweep itself** (the procedure above). It runs *with* R26-0 and
  R26-3, and is what certifies that the re-derived numbers are not another artefact:
  no item below is declared "done" while a sweep invariant is unresolved.
  **Landed (round 26).** `RUN-ANALYSIS.md` §9 is the standing matrix: the component
  inventory (§9.1), the ten invariants (§9.2), the invariant × component-class status
  grid (§9.3), the sixteen suspects each resolved as *fixed*/*clean*/*documented*/
  *pending* (§9.4), and the R26-10 contract-test map where every pending cell has an
  owning item (§9.5). Reading-invalidating #33 and unfair-comparison #34/#35 are
  fixed and pinned; #36/#37 are fixed or opt-in; the documented items (the
  `positive`-polarity scope, the fold purge-exclusion limitation, the unbounded
  default `open_trades`, and the not-yet-landed contract tests) are recorded by name.
  No ledger count changes (documentation only).
- **R26-2 · Surface the model's readiness and training diagnostics.** The factory's
  `stats()` (`trainingSteps`, `folds`, `undertrained`, `warmErrors`,
  `quarantinedRows`) and the per-fold trade-label counts (`closed`/`open`,
  `wins`/`losses`) become: (a) a per-variant `model` block in `report.json`; (b) a
  `model:` line in the summary; (c) an explicit annotation when a fold's model never
  trained (`trainingSteps === 0`) or the warm-up threw (`warmErrors > 0`), which is
  what makes "no edge" distinguishable from "never trained" (`BUGS.md` #35). Replace
  the dead `undertrained` guard with the readiness signal (`trainingSteps > 0`).
  **Extend (round 26b):** the block also carries the **label base rate** (the
  fraction of trades whose take-profit triggered) and a **skill score** referenced
  to it (Brier skill score against the base-rate forecast, plus a chance-corrected
  accuracy), because at the shipped factors the base rate is ≈ 27 % TP and a model
  that always says "stop" reads as 73 % "accurate" (`BUGS.md` #37). A model is
  reported as *trained and skilful*, *trained and no better than the base rate*, or
  *not trained* — three states, not two.
  *Grounding:* the model-diagnostics half of `docs/research/observability.md`
  (Brier 1950; Murphy 1973 for the reliability/resolution split; Wald 1945 / Page
  1954 for the stop-and-alarm discipline a "never trained" flag is the analogue of)
  and the skill-score literature in `CITATIONS.md` "Experimental design…"
  (Gneiting & Raftery 2007 — the score must be *proper*, so hedging to the base
  rate cannot earn skill).

  **Landed (round 26).** `HiveMindController._globalAccuracy` now carries the
  resolved-barrier split (`resolvedTakeProfit`/`resolvedStopLoss`), the Brier
  components (`brierSum`/`brierCount`) and a `droppedCandles` count (the R26-1
  suspect-8 fix), all persisted through `_saveGlobalAccuracy`/`_loadGlobalAccuracy`
  and surfaced non-enumerably on the signal when nonzero (so the golden payload is
  untouched — verified: `golden` 23/23 unchanged). The factory's `stats()` reports
  the label base rate, a proper Brier skill score against the base-rate forecast,
  a chance-corrected accuracy and a three-state `status`
  (`not-trained` | `base-rate` | `skilful`), plus the raw counters; `predict()` is
  gated on readiness (`trainingSteps > 0`) instead of the never-firing
  `testStart >= warmup` guard (which is kept as a reported statistic). The A/B
  pools the per-fold stats into a per-variant `model` block in `report.json`
  (null for a pure signal candidate) and a `models:` summary line. Proved by
  `core.test.js` section I and the new `analyze.test.js` R26-2 checks
  (core 32 → 36, analyze 166 → 173; ledger 2091 → 2102).
- **R26-3 · One confidence→position pipeline, and journal the pre-policy value.**
  Define a single documented signed-confidence space and map both families through
  one `confidenceToPosition(confidence, policy)`; make the signal candidates emit
  their raw `z` and the controller its raw `prob` and apply the *same* policy to
  both. Journal the raw per-test-bar value (and the applied policy) into
  `folds.jsonl`, so a policy/holding sweep is pure post-processing:
  `restateReportAtPolicy(journal, policy)` must reproduce the emitted positions
  byte-for-byte at the scored policy. *Grounding:* the position-sizing/turnover
  literature below; the design principle is that the *measurement* of a policy must
  not require re-running the model (Pardo 2008's walk-forward discipline applied to
  the policy layer).

  **Landed (round 26).** `analysis/walkforward.js` gained the one pipeline —
  `confidenceFromProb(prob)` (the controller's `(prob−50)/50`), `confidenceToPosition(c,
  policy)` (dead zone + scale), and a `probToPosition` re-expressed through both
  (byte-identical on the whole controller domain, pinned) — plus
  `restateReportAtPolicy(report, policy)` and `verifyPolicyRoundTrip(report, policy)`.
  `analyze.js` has ONE `POSITION_POLICY = {deadZone:0.05, scale:1}` applied to BOTH
  families (the signals now carry the controller's dead zone, which is the point:
  BUGS.md #34), with `IDENTITY_POSITION_POLICY` as `makeSignalForVariant`'s default
  so a direct call stays byte-identical. The model factories expose
  `rawConfidence()`; `walkForwardEvaluate`/`purgedCVBacktest` journal the raw
  pre-policy confidence beside the emitted positions in `folds.jsonl`, and every
  real run records a `policyRoundTrip` certificate (`ok`, `mismatch`) in
  `report.json`. Proved by new `analysis.test.js` checks (the exact pipeline, the
  prob-domain equivalence, the round-trip detector, a restatement's participation
  change) and `analyze.test.js` checks (the journaled confidence, the certificate,
  the scored-policy reproduction, the wider dead zone). analysis 437 → 442,
  analyze 173 → 177; ledger 2102 → 2111.

- **R26-11 · Make the trade labeller a variant dimension, and report the label
  lifecycle.** Today the labeller is fixed and optimistic (`BUGS.md` #36): a bar
  crossing both barriers is booked as a win, a gapped stop fills at the stop price,
  and a trade that never triggers a barrier is never closed or labelled. Add
  `labelPolicy` as an **A/B variant dimension**, default `optimistic` (the current
  behaviour, so all 11 golden fingerprints are untouched):
  `optimistic` / `conservative` (stop-loss-first tie-break when a bar spans both
  barriers, and a stop fill at the bar's *worst* traded price when it gaps through
  the stop) / `triple` (conservative **plus a time barrier**: an untriggered trade
  is closed at `horizonBars` and labelled from that bar's return). Also surface the
  lifecycle: per-fold base rate, resolved/unresolved counts, and the entry-to-
  training age distribution (which is what makes `_processClosedTrades`' FIFO
  drain and its `processCount = 1` lag visible). **Partial:** the landed build
  reports the **entry-to-close holding period** (and the time-barrier
  resolution), not the entry-to-training age — see the note under *Landed*.
  *Grounding:* López de Prado (2018)
  ch. 3 — the triple barrier (profit, loss, **time**) is the standard label, and the
  two-barrier version is the special case that never expires a trade; the
  intrabar-order ambiguity is a property of OHLC data, not of the model, so the
  honest response is to measure both conventions rather than to assume one.
  *Semantics:* default off; the shipped trajectory and every golden are unchanged,
  and the A/B is what decides. This **is** a training-set change when enabled, so it
  is opt-in by construction and never silently on.
  **Landed (round 26).** `hivemind/controller/trades.js#_updateOpenTrades` is
  policy-aware: `optimistic` is the shipped rule and is byte-identical (pinned by the
  three `ctl:*` goldens); `conservative` resolves a both-barrier bar to the stop
  (stop-first tie-break) and fills a gapped stop at the bar's worst traded price
  (`isLong ? min(stopLoss, open) : max(stopLoss, open)`); `triple` adds the time
  barrier at `_labelHorizonBars` (exit at the horizon bar's close, outcome from its
  return). The holding period and time-barrier resolution are accumulated
  (`heldBarsSum`/`heldBarsCount`/`heldBarsMax`, `resolvedTimeBarrier`) and persisted
  with the accuracy bag. `analyze.js` exports `LABEL_VARIANTS` (`label-conservative`,
  `label-triple`; `kind:'label'`, `controllerScoped:true`) through
  `RESOLVABLE_VARIANTS` (so `--variants=label-triple` resolves) while the default
  family stays 15; `--label-policies` appends exactly the two, `--label-policy=` and
  `--label-horizon=` set the run-level policy (recorded in `run.json`/`report.json`,
  an unknown name throws). Proved by `core.test.js` section J (browser + native) and
  `analyze.test.js` (7 checks); core 36 → 42, analyze 177 → 184, ledger 2111 → 2124.
  **Documented gap (round 26b).** The lifecycle *age* metric is the
  **entry-to-close holding period** (`heldBarsSum`/`heldBarsCount`/`heldBarsMax`,
  persisted with the accuracy bag), which is what the trade labeller itself
  observes — **not** the entry-to-training age. The training-age version (the
  gap between a trade's entry bar and the bar at which `_processClosedTrades`
  actually consumes it under the `processCount = 1` FIFO drain) is **not yet
  measured**: it needs the current candle timestamp threaded into
  `_processClosedTrades`' hot path, which is a state-affecting change that must
  not be made blind. The holding period makes the label horizon measurable; the
  drain lag remains an open throughput-accounting item, tracked as `TODO.md`
  #62. No metric or verdict moves.

#### Part B — Throughput (the enabler)

- **R26-4 · Parallelise the fold loop.** Every fold-pass is an independent
  model fit with its own state directory, so the unit of parallelism is
  `(variant, stream, fold, pass, probeIndex)`; dispatch it through
  `legion/workers.js#runWorkerThread` (the existing settle-once, watchdogged
  dispatch) with a new analysis worker entry. Two things must be preserved exactly:
  (a) the per-fold seed is already `(variantSeed + testStart·977)` plus `+7777` for
  predict, so a worker that installs it with `installSeededRandom` reproduces the
  sequential arithmetic bit-for-bit; (b) `folds.jsonl` and the per-variant
  checkpoints must keep their sequential emit order, so results are buffered and
  flushed in fold order. `walkForwardEvaluate` is synchronous today, so this needs
  an async fold executor with a serial inner path retained for the tests.
  **Acceptance is a byte-identical `folds.jsonl`** between the serial and parallel
  paths on a small real run, plus an unchanged `report.json` modulo `timings`.
  *Grounding:* no literature claim — this is a scheduling change whose justification
  is the measured cost law (`OPTIMIZATION.md` "Round 25b" / "Round 26b").
  **Semantics-preserving; no golden fingerprint may move.**
  **Landed (round 26).** `analysis/parallel.js` holds the order-preserving
  bounded-concurrency scheduler (`scheduleUnits`, `normaliseConcurrency`,
  `makeFoldExecutor`); `analysis/backtest.js` gained `scoreFold` (shared by both
  paths) and `purgedCVBacktestAsync`; `analysis/walkforward.js` gained
  `walkForwardEvaluateAsync`; `analyze.js` gained `evaluateABAsync` (sharing
  `finalizeAB` with `evaluateAB`), `makeNodeFoldDispatcher`, a `concurrency` option
  and `--concurrency=<n>`; `analysis/fold_worker.js` is the one-fold-per-worker
  entry. The default `concurrency = 1` is byte-identical; `> 1` dispatches each
  scored fold to a worker that reconstructs the same seeded signal function, so
  `folds.jsonl` and the verdict are unchanged (the audit stays serial and reads the
  same scored signals). The worker reports its model diagnostics, so the per-variant
  `model` block survives. Proved in the browser (an injected inline executor
  reproduces the serial report; `analysis.test.js` 442 → 453, `analyze.test.js`
  184 → 191; ledger 2124 → 2142) and natively by the node-only
  `parallel_folds.test.js` (real worker threads, byte-identical `folds.jsonl`).
  **Follow-up fix (`BUGS.md` #42, round 26b).** The first native `npm test` run of
  the concurrent path exposed that `evaluateABAsync` nulled `signalForFold` whenever
  a worker executor was present, but the look-ahead audit re-fits perturbed views
  **in-process** — so any `concurrency > 1` run with the audit on (the default)
  crashed at the first fold. `evaluateABAsync` now always supplies the folded signal
  (only the audit calls it when an executor owns the scored pass), and
  `walkForwardEvaluateAsync` names the requirement instead of a bare `TypeError`; the
  browser concurrency check now runs the audit ON as well as off.

- **R26-12 · Throttle the state checkpoint (throughput; semantics-preserving).**
  `HiveMind.dumpState()` rewrites the **entire** ensemble state (weights, gradient
  accumulators, all memory prototypes and histories) to SQLite on **every call**
  that predicts or trains — measured at **24.6 %** of per-call time in the shim,
  the second-largest term after inference (`OPTIMIZATION.md` "Round 26b"). In the
  A/B the saved state is never read back at all: `makeControllerModelFactory`
  pre-creates the mind and discards the directory per fold. Add a
  `saveInterval` (in calls) to the controller/mind, default `1` (current behaviour,
  bit-exact), so:
  - the **A/B** sets "final only" (`saveInterval = Infinity`, with one guaranteed
    save at fold disposal), removing ~a quarter of every fold's compute for **zero**
    change to any emitted position or metric;
  - **production** keeps a bounded interval, because there the state *is* reloaded
    after a worker restart — the interval is a real tradeoff there, not a free win.

  *Grounding:* the classical checkpoint-interval problem — cost per unit time
  against expected lost work per failure — Young (1974) and Daly (2006); a full dump
  per operation is far from the optimal interval. *Acceptance:* a small real run's
  `folds.jsonl` is byte-identical at `saveInterval ∈ {1, ∞}` (only `timings`
  moves), and the 11 golden fingerprints are unmoved at the default.

  **Landed (round 26).** `HiveMindController` has `_saveInterval`/`_saveTicks`
  (default `1` ⇒ the historical per-call dump, bit-identical) plus a public
  `flushState()`; the gate is `interval > 0 && _saveTicks % interval === 0` with
  the interval floored, so `Infinity`/`0`/negative never dump during a run. The
  A/B (`runAnalysis`) defaults to `Infinity`, `makeControllerModelFactory` keeps
  the direct-call default `1`, the CLI gained `--save-interval=<n>|inf`, and the
  resolved value is recorded in `run.json`/`report.json` (a number, or `'inf'`).
  A kept fit (`--keep-models`) with a non-finite interval is flushed once at
  disposal so its state directory is not empty. Proven by `core.test.js` section H
  (identical signal stream at `k = 1/3/∞` and exact dump counts) and
  `analyze.test.js`; the byte-diff acceptance is node-only
  (`test/node/checkpoint_throttle.test.js`). **Not yet measured natively** — the
  24.6 % share is a shim number and the native saving must be re-measured with a
  local `npm run analyze`.

#### Part C — Economics (the actual ceiling)

- **R26-5 · Attack turnover.** With R26-3's journal this is a post-processing
  experiment: sweep `deadZone` × `scale`, then add a documented **holding /
  hysteresis** rule (enter at `|c| ≥ enter`, exit at `|c| ≤ exit < enter`, plus an
  optional minimum holding period), and report each policy's
  `turnover`/`grossPnl`/`breakEvenCostBps`/pooled Sharpe and its full
  `promoteDecision`. Target: a policy whose break-even clears **5-10 bps** — a real
  1h taker round-trip — at a Sharpe indistinguishable from the costless one. The
  last round's best is 3.47 bps (`sig:volume`), and the signal family is ~93 %
  invested with no dead zone, so the search space is large. *Grounding:* the
  no-trade-band result is classical — Constantinides (1986) shows a proportional
  cost produces an optimal **no-trade region**; Davis & Norman (1990) characterise
  it; Gârleanu & Pedersen (2013) give the modern dynamic formulation; arXiv
  2101.09936 gives small-cost asymptotics of the region. For the signal-processing
  side, arXiv 2502.04284 shows that with costs the optimal policy uses *past* signal
  values (alpha decay), which is exactly what a hysteresis/holding rule is; arXiv
  2509.04541 introduces **turnover regularization** for learned positions; arXiv
  1904.04912 (Deep Momentum Networks) demonstrates learned position sizing that
  keeps an edge after 2-3 bps. Measurement stays Frazzini et al. (2018) + the
  Binance fee schedule.
  **Landed (round 26).** `analysis/holding.js` holds the frozen
  `DEFAULT_TURNOVER_GRID` (8 dead zones × 1 scale × 6 holdings, including a
  no-hold policy, two enter/exit hysteresis bands and two with a minimum holding
  period) and `turnoverSweep`/`bestTurnoverPolicy`/`formatTurnoverSweep` — pure
  post-processing over `restateReportAtPolicy`, so it cannot move a scored number.
  `analysis/walkforward.js` gained `positionSeriesFromConfidence`, the one
  holding-aware confidence→position map: with no `enter`/`exit`/`minHold` it is
  byte-identical to `confidences.map(confidenceToPosition)`, so the default path
  and the R26-3 round-trip certificate are unchanged. `analyze.js` gained the
  opt-in `--turnover-sweep`/`--turnover-target=<bps>` (default off ⇒
  `turnoverSweep: null`), recorded in `run.json`/`report.json` and rendered in the
  summary. Proved in the browser (`analysis.test.js` 453 → 463, `analyze.test.js`
  191 → 198; ledger 2142 → 2159) and natively by the node-only
  `analyze_cli.test.js` (the spawned CLI documents and threads both flags).
- **R26-6 · Buy effective independence, not bars.** Keep the cost law in view
  (`time ∝ pooledBars × folds-per-stream`), and select the stream set by the
  **measured** design effect: add a second bar interval (e.g. 4h) and/or
  lower-correlation symbols, then choose the basket that maximises `effectiveBars`
  per unit of compute. Report per-stream and pooled `designEffect` before/after, and
  cost the next run from the corrected R26-0 constant. *Grounding:* Grinold (1989),
  *The Fundamental Law of Active Management* — information ratio scales with the
  square root of **breadth**, and breadth means *independent* bets, not raw sample
  count; Kish (1965) gives the design effect that converts one into the other
  (already cited); Harvey, Liu & Zhu (2016) for why the search count still matters.
  **Landed (round 26).** `analysis/streams.js` holds `resampleCandles` (exact OHLCV
  aggregation — a second bar interval is a genuinely different horizon, not a copy),
  `designEffectOfStreams` (Kish 1965 design effect over the streams' own returns or
  their per-fold Sharpe series, effectiveStreams/effectiveBars, with K=1 and the
  perfectly-hedging pair handled explicitly) and `selectStreams` (greedy forward
  selection by marginal effective bars per raw bar — Grinold 1989 breadth under the
  measured cost law). `analyze.js` gained the opt-in `--interval=<n>` (resample every
  stream) and `--select-streams[=<n>]` (measure the basket / keep the first n), both
  recorded in `run.json`/`report.json` and rendered in the summary. Both are DESIGN
  choices — they cannot change how an included stream is scored. Proved in the
  browser (`analysis.test.js` 463 → 475, `analyze.test.js` 198 → 204; ledger
  2159 → 2177). Registered `LOCKED-invariant` in `lock-registry.js` (`streams.js`).

#### Part D — Decision quality (the report as the next cycle's input)

- **R26-7 · Give the gate discriminating power.** The sign-test `requireBreadth`
  hurdle passed 8/8 and hit its 2⁻¹⁴² resolution floor on three candidates, so it
  separated nothing while the magnitude hurdles rejected everything. Replace it with
  a two-part hurdle, both already computable from the panel: (a) a **magnitude
  floor** on the paired cluster Sharpe difference (`requireSharpeDiff` already
  exists — breadth becomes a *reported* statistic, not a gate), and (b) a **cluster
  stability** requirement — the pooled edge must survive deleting any single
  fold-window cluster (a delete-one-cluster jackknife sign/magnitude check), which
  is the statistical form of "the edge is not carried by 20 of 1,136 folds".
  *Grounding:* Demšar (2006) for why the sign test is the robust *reported*
  comparison but is uninformative about magnitude; Ledoit & Wolf (2008) and Cameron
  & Miller (2015) for the paired cluster Sharpe test (already cited); Künsch (1989)
  for the delete-block jackknife; Pardo (2008) for stability as a promotion
  criterion.
  **Landed (round 26).** `analysis/dependence.js` adds `clusterStability({clustersA,
  clustersB, statistic, minFraction, minDelta})` — it recomputes the pooled paired
  statistic on each leave-one-cluster-out panel and requires the difference to stay
  positive for (at least) `minFraction` of the windows (default 1, i.e. every window),
  reporting `{available, nClusters, full, worstCluster, worstDelta, fractionPositive,
  leaveOneOut, minFraction, minDelta, stable}`. `analysis/walkforward.js`:
  `pairedPromotionTest` now also returns `stability`, `promoteDecision` gains
  `requireClusterStability`/`minStableFraction` (both default-off, so the classic
  gate path is bit-identical) with its own `gate.requireClusterStability` state and a
  named failure reason, and the shipped `DEPENDENCE_GATE_READER` is rewritten to
  **magnitude (`requireSharpeDiff`) + stability (`requireClusterStability`) +
  `dsrAdjusted`** — the exact sign test (`promotionTest.breadth`) is retained and
  **reported, no longer a gate**. `analyze.js`'s dependence `gateOptions` swap
  `requireBreadth:true` for `requireClusterStability:true`. Proved in the browser
  (`analysis.test.js` §AJ: hand-computed stable/fragile/unavailable panels, the
  tiny-edge-fails-magnitude vs broad-but-thin-fails-stability gate fixtures, and the
  reader strings; `analyze.test.js` asserts the driver's `gateOptions`)
  — `analysis.test.js` 515 -> 523, `analyze.test.js` stays 216, ledger 2229 ->
  2237.
- **R26-8 · A decision-grade report.** The report must answer, without re-computing
  anything, the six questions the next cycle asks. Spec (every field non-null or
  explicitly `n/a` with a reason):
  1. **Did the models train, and on what?** per-variant `model` block (R26-2);
     per-fold label counts; `warmErrors`; `quarantinedRows`; **the label base rate,
     the skill score and the entry-to-close holding-period distribution** (#37,
     R26-11; the spec's *entry-to-training age* is deferred — see the R26-11
     "Documented gap" note);
     and the per-stage cost breakdown (`timings` split into fit / predict / audit,
     plus the measured checkpoint share — `OPTIMIZATION.md` "Round 26b").
  2. **Is the edge real?** `dependence` + `promotionTest` + `gate` with the binding
     hurdle named, `familyCorrelation`, and the family-wise `search`.
  3. **Is it concentrated?** new `concentration` block: top-K folds' share of gross,
     positive/negative sums, the delete-one-cluster range of the pooled Sharpe, and
     the k-th fold's marginal contribution. (`sig:volume`'s best 20 of 1,136 folds
     carry 108 % of its gross — a reader must see that in the artifact.)
  4. **Does it pay?** `costLadder` + `breakEvenCostBps` + participation
     (`nonZeroFraction`, `meanAbsPos`) under the unified policy (R26-3), plus the
     raw-confidence autocorrelation / estimated half-life (the alpha-decay ranking
     input — see the research leads below).
  5. **Is it the best family, or just the best of these?** new `forecast` block per
     variant (Brier / reliability / resolution, Diebold–Mariano vs baseline) and the
     family-level `mcs` membership set (R26-14), plus the **seed distribution** —
     mean, IQM, stratified-bootstrap CI and the seed/stream/fold variance
     decomposition (R26-13). A single-seed point estimate is not a family decision.
  6. **What would change the verdict?** a machine-readable `nextRun` block: the
     honest `effectiveBars`/MDE95, `barsToDetect` at the measured design effect, the
     required break-even at 5/10 bps, the projected wall clock from the **re-measured**
     native cost constant, the seeds/folds a paired comparison would need for a given
     MDE (R26-13), and the single cheapest change that would flip the decision.
  *Grounding:* the honest-evaluation battery already cited (DSR/PBO/SPA/MinTRL,
  `docs/research/financial-validation.md`), the observability note, and the
  experimental-design references in `CITATIONS.md` "Experimental design, replication
  & model comparison"; this item adds no new *strategy* statistic, it makes the
  existing ones legible and closes the "PSR 0.97 looks publishable" gap by printing
  the adjusted number beside it — and by printing the seed distribution beside the
  point estimate.
  **Landed (round 26).** `analysis/decision.js` (pure, no new statistic):
  `foldConcentration` restates the scored folds — top-K share of gross PnL, signed
  fold sums, the pooled Sharpe on each leave-one-fold-out panel, and each fold's
  marginal contribution to it — rebuilding the strategy returns from the retained
  `foldInputs` with the scored `strategyReturns` arithmetic; `confidencePersistence`
  measures the lag-1 autocorrelation of the journaled raw pre-policy confidence
  within folds and its exponential half-life (the alpha-decay ranking input);
  `nextRunPlan` turns the finished run into sizing knobs (effective bars and MDE,
  i.i.d. and dependence-corrected; the bars a detection of Sharpe 1 / of the observed
  Sharpe needs at the measured design effect; the break-even against 0/2/5/10 bps;
  the measured per-fold wall time; and the single cheapest lever that would flip the
  verdict); `decisionReport` composes the six questions (training / edge /
  concentration / economics / family / nextRun) so every field is a value or an
  explicit `{available:false, reason}`; `formatDecision` renders the summary.
  `analyze.js` emits the block by default (`--decision=0` disables; recorded in
  `run.json`/`report.json` and the checkpoint), features the promoted candidate or
  the best by pooled Sharpe, and adds the `decision:`/`concentration:`/`nextRun:`
  summary lines. Proved in the browser (`analysis.test.js` §AK: exact top-K/signed
  sums, the leave-one-out range and marginals against an independent sweep, the
  exact lag-1 cases, the frozen `nextRunPlan` fixture, the composer and the
  formatter; `analyze.test.js`: the block is on by default, the featured candidate
  is real and the composed blocks are the run's own, `decision=false` nulls it and
  moves no scored number) and by a third node-only `analyze_cli.test.js` block (the
  spawned CLI documents `--decision=0` and nulls the block) — `analysis.test.js`
  523 -> 547, `analyze.test.js` 216 -> 220, ledger 2237 -> 2265. **Round 26b**
  completed clause 6's "the seeds/folds a paired comparison would need": `nextRunPlan`
  now carries a `pairedUnits` block (`pairedUnitsNeeded`, internal) that sizes the
  *paired* difference — `nClusters * (1.959964 * se / target)^2` clusters/seeds —
  for the observed difference and the dependence-corrected MDE, and the same review
  fixed the four shape/wiring defects recorded as `BUGS.md` #38/#39/#40/#41 (the
  magnitude cheapest-flip read the paired difference as a scalar; the sign test was a
  leave-one-out form; `training.labelDistribution` read a field the model summary
  never produces; the `family` seed fields read a `replication` shape the only
  producer never emits). The same review added one `analyze.test.js` integration check
  (a real multi-stream run populates the decision block's paired sizing, journal
  decay and leave-one-fold range). `analysis.test.js` 559 -> 562, `analyze.test.js`
  221 -> 222, ledger 2285 -> 2289.

#### Part E — Method (research; no code until decided)

- **R26-9 · Per-fold replay vs per-stream snapshot.** Keep the per-fold fresh-seed
  full replay (fold independence, O(n²)) or warm one controller per stream and
  snapshot it at fold boundaries (O(n), but the folds' trajectories correlate)? This
  changes the very fold-level statistics the cluster inference reads, so it is a
  statistical decision, not an optimisation: write the justification, re-derive the
  size/power under the correlated-fold null, and prove on a fixture that the
  snapshot's fold-level statistic still has the nominal properties (or document the
  bias). *Grounding:* López de Prado (2018) — purging/embargo and the independence
  assumptions of walk-forward evaluation; Pardo (2008) — walk-forward efficiency
  under refitting regimes; Cawley & Talbot (2010) — over-fitting in *model
  selection* and the selection bias of reusing one fitted model; arXiv 2412.10545 —
  retraining as a response to drift, which is the argument *for* replaying.
  **Decided (round 26).** The scored walk-forward **keeps the per-fold full
  replay**: the fold window is the unit the round-25 cluster inference reads, and a
  warm snapshot would correlate the folded outcomes, invalidating the gate's size.
  The decision, the re-derivation under the correlated-fold null (the equicorrelation
  design effect `1+(C-1)ρ` on the win-count variance), the measured fixture (an
  exact sign test over C = 40 windows rejects at ≈0.043 for independent folds but
  ≈0.31 / 0.36 at ρ = 0.25 / 0.5) and the conditions under which a snapshot could
  ever be added are recorded in **`docs/METHOD.md` §1**; the fixture is
  `analysis.test.js` §AL. No code ships for this item (by design), so the only
  ledger change is the three fixture checks: `analysis.test.js` 547 -> 550, ledger
  2265 -> 2268.

#### Part F — Tests added to `npm test` (R26-10)

Added to the existing entries (no new ledger counts unless stated); every one is a
contract test for a sweep invariant, not a happy-path assertion:

| # | test | file | asserts |
| --- | --- | --- | --- |
| 1 | **window contract** | `analyze.test.js` | on a ≥300-bar fold, every `getSignal` receives ≤ `cacheSize` bars and `recentCandles.length ≤ 1` per call (the #33 guard) |
| 2 | **no pre-entry close** | `core.test.js` | a trade is never closed by a candle at or before its entry timestamp, on a shuffled/over-wide window |
| 3 | **unified policy** | `walkforward.test.js` | the controller and a signal pass through the same mapping; the journal's raw value re-policed reproduces the emitted positions exactly |
| 4 | **readiness surfacing** | `analyze.test.js` | a real fold's report carries a non-null `model` block; a deliberately-broken warm-up sets `warmErrors > 0` and is annotated |
| 5 | **concentration readout** | `walkforward.test.js` | exact reference vectors for top-K share / delete-one-cluster range on a hand-built fold set |
| 6 | **breadth replacement** | `walkforward.test.js` + `analysis.test.js` | a candidate that wins every window with a negligible paired magnitude FAILS the new hurdle; a real edge passes |
| 7 | **parallel = serial** | `analyze.test.js` (or a node-only test) | a small run's `folds.jsonl` is byte-identical serial vs parallel |
| 8 | **sweep fixtures** | `guards.test.js` | the boundary degradation matrix (shuffled, duplicate timestamp, corrupt row, NaN, short, empty) per component |
| 9 | **dead-guard audit** | `guards.test.js` | `undertrained` fires on the readiness signal, not on `testStart >= 40` |
| 10 | **report completeness** | `analyze.test.js` | every field in the R26-8 spec exists and is non-null (or carries a reason) on a small run |
| 11 | **contiguous window** | `analyze.test.js` | every per-call input is the contiguous, advancing production window (no back-in-time / over-wide window) and `recentCandles.length === 1` after warm-up (suspect 16) |
| 12 | **label policy fixtures** | `core.test.js` | a bar spanning both barriers labels as TP under `optimistic` and SL under `conservative`; a gapped stop fills at the worst traded price under `conservative`; an untriggered trade closes at the horizon under `triple` and lands in `closed_trades` exactly once |
| 13 | **base rate + skill** | `analyze.test.js` | the `model` block's base rate matches an independent recount from `folds.jsonl`; the always-majority predictor's skill score is ≤ 0 and a perfect predictor's is 1 |
| 14 | **checkpoint equivalence** | `analyze.test.js` (or node-only) | a small run's `folds.jsonl` is byte-identical for `saveInterval = 1` and final-only; only `timings` moves |
| 15 | **paired seeds (CRN)** | `analysis.test.js` + `analyze.test.js` | with CRN a variant's fold seed depends only on the master seed and `testStart`; the paired difference's variance is below the unpaired one on a fixture |
| 16 | **forecast block / MCS** | `analysis.test.js` + `analyze.test.js` | Diebold–Mariano and the Model Confidence Set reproduce hand-computed reference vectors on a built journal; MCS membership is monotone in the confidence level |

Node mirrors are updated in the same commit (exact-count `assert.equal`), and
`RUNBOOK.md` §6 / `src/README.md` / `README.md` counts are re-synced. The only tests
that need a local `node` run are the ones touching the real worker pool (7) and any
new node-only file, which must be registered in `mirrors.test.js`'s ledgers.
**Landed (round 26).** All sixteen cells are in the browser suite (and wherever the
plan named a node mirror, in `npm test`; the real-worker cell 7 is the node-only
`parallel_folds.test.js`). The final two added under R26-10 are `guards.test.js`
section K (the reader boundary-degradation matrix: empty / short / corrupt row /
NaN / duplicate timestamp / shuffled order / `maxBars`) and the report-completeness
contract over the R26-8 `decision` block in `analyze.test.js`; the dead-guard audit
(cell 9) is pinned by `analyze.test.js`'s `undertrained`-vs-warm-up checks.
`guards.test.js` 58 -> 65, `analyze.test.js` 220 -> 221, ledger 2268 -> 2276.

#### Part G — Family search: how the round decides *which* model is best (round 26b)

The parts above make the reading correct (A), affordable (B), economically honest
(C), legible (D) and methodologically defensible (E). None of them answers the
question the project started from: **which family or variant is actually best.**
The A/B answers it with a single-seed ranking, which — per the replication
literature — is not a ranking at all. Three items fix that. None changes the
shipped trajectory; all are analysis-layer.

- **R26-13 · Replicate across seeds, pair the variants with common random numbers,
  and report the distribution.** Today `variantSeed = seed·131 +
  hash(variant.id) % 100000` and `foldSeed = variantSeed + testStart·977`, so *each
  variant sees different
  fold randomness* — the comparison is unpaired and its noise cannot be cancelled.
  Change the fold seed to be **variant-independent** (`foldSeed = masterSeed +
  testStart·977`), so every variant is fitted and predicted on the *same* random
  draws — common random numbers — which reduces the variance of the *difference*
  between variants (the quantity the decision actually uses) without hiding either
  variant's own level. Then run every variant under **≥ 3 master seeds** and report
  per variant: the mean, the interquartile mean, a **stratified-bootstrap**
  confidence interval over (seed × fold), and a variance decomposition
  (seed / stream / fold / residual) so the fraction of the spread that is seed
  noise is visible. *Grounding:* Bouthillier et al. (ICML 2019) and Henderson et al.
  (2018, arXiv 1709.06560) — seed-to-seed variation routinely exceeds the variation
  attributed to the compared factor, so a single-seed ordering is not a ranking;
  Agarwal et al. (2021, arXiv 2108.13264) — IQM + stratified bootstrap + performance
  profiles as the honest summary of a noisy per-run metric; Glasserman & Yao (1992)
  — common random numbers reduce the variance of the *difference*, which is exactly
  what "variant A beats variant B" is. *Semantics:* this changes which random seed
  each variant sees, so it changes A/B numbers — deliberately, and that is the
  point; the goldens (controller/HiveMind numerics) are untouched. *Acceptance:* the
  paired difference's variance is measurably smaller than the unpaired one on a
  fixture, and the report carries the distribution, not a point.
  **Landed (round 26).** `analysis/replication.js` (pure, seeded): `interquartileMean`
  (drops the best/worst quarter, falls back to the mean below four values),
  `stratifiedBootstrapCI` (resamples WITHIN each seed stratum — a zero-width CI on
  constant unequal strata proves the stratification), `varianceComponents` (exact
  between-seed / within-seed-fold / residual split), `seedDistribution` (mean + IQM
  + CI + split for one variant), `pairedVarianceRatio` (the CRN criterion) and
  `formatSeedReplication`. `analyze.js` now defaults `commonRandomNumbers: true` —
  the per-fold seed is variant-independent (`seed + testStart*977`), so the variant
  comparison is paired on the random draws and the variance of the difference falls
  (Glasserman & Yao 1992) — and `--crn=0` restores the historical per-variant seed
  for reproducing old runs. `replicateAnalysis` (CLI `--seeds=a,b,c`) runs the A/B
  once per master seed with CRN on and aggregates each variant's mean/IQM/stratified
  CI/seed-fold variance split into `replication.json` beside the first run dir; every
  baseline/candidate row now carries its per-fold net-Sharpe series and `crn=<bool>`
  is recorded in `run.json`/`report.json` and the summary. Registered
  `LOCKED-invariant` in `lock-registry.js` (`replication.js`). Proved in the browser
  (`analysis.test.js` 475 → 491, `analyze.test.js` 204 → 213; ledger 2177 → 2202) and
  by a second node-only block in `analyze_cli.test.js` (the spawned CLI documents
  `--crn`/`--seeds`, writes the aggregate, and records CRN honestly).

- **R26-14 · Decide between families as *forecasters*, not only as PnL streams.**
  Every candidate already emits a per-bar signed confidence and the journal (R26-3)
  can carry it, so the family can also be scored on the quantity the literature
  actually compares: predictive accuracy. For each variant compute proper scores on
  the journal's per-bar outcomes (Brier score + its reliability/resolution split,
  and the log score), then run a **Diebold–Mariano** test on the paired per-bar loss
  differentials (variant vs baseline, block-bootstrapped for serial dependence), and
  a **Model Confidence Set** at 90/95 % over the whole family. The MCS is the
  headline: it returns *the set of families that cannot be distinguished from the
  best*, which is the correct answer to "which family is best" when K models are
  compared on noisy dependent losses — and it is cheap, because it is pure
  post-processing of the journal. *Grounding:* Diebold & Mariano (1995);
  Hansen, Lunde & Nason (2011, *The Model Confidence Set*); Gneiting & Raftery
  (2007) for proper scoring; Brier (1950) / Murphy (1973) for the decomposition
  (already cited). *Semantics:* measurement only — no training change, no golden.
  *Acceptance:* the report carries a `forecast` block per variant and a family-level
  `mcs` membership set, computed offline from `folds.jsonl` and reproduced by a
  test on a hand-built journal.
  **Landed (round 26).** `analysis/forecast.js` (pure, seeded): `forecastPairs`
  (signed confidence -> probability + next-bar sign, dropping each fold's last bar),
  `brierScore`/`logScore`/`brierLosses`, `brierDecomposition` (Murphy 1973: the exact
  identity `BS_binned = REL - RES + UNC`), `bootstrapMeans` (one stationary-block
  resampling shared by the DM test and the MCS), `dieboldMariano` (the paired test on
  per-bar Brier-loss differentials, block-bootstrapped) and `modelConfidenceSet` (the
  Hansen-Lunde-Nason range-statistic MCS: eliminate the worst while the equal-accuracy
  null is rejected, returning the surviving set at 90/95%). `analyze.js` computes the
  `forecast` block by default from the journaled confidence (`--forecast=0`
  disables), and renders a `forecast:` summary line. Registered `LOCKED-invariant` in
  `lock-registry.js` (`forecast.js`). Proved in the browser (`analysis.test.js`
  491 -> 515, `analyze.test.js` 213 -> 216; ledger 2202 -> 2229) and by a fourth
  node-only `analyze_cli.test.js` block (the spawned CLI documents `--forecast=0`,
  nulls the block, and changes no scored number).

- **R26-15 · Search the family by racing, not by a full grid (GATED).** Once
  R26-12 makes a fold cheap and R26-13 makes a comparison paired, the expensive
  part of "find the best family" is no longer a fold but the *number of variants ×
  seeds*. Successive halving / Hyperband is the standard answer: give every arm a
  small budget (few folds, one seed), eliminate the arms that are statistically out
  of contention, and reallocate the freed budget to the survivors — which is exactly
  the shape of this A/B once the fold loop is parallel. Ship it as an opt-in
  `--race` driver that (a) needs R26-13's paired seeds, (b) needs R26-12's cheap
  folds, and (c) must be validated against the full grid on one small run before it
  is trusted (a racing budget may not change the *decided* set). *Grounding:*
  Jamieson & Talwalkar (2016, arXiv 1502.07943); Li et al. (2018, arXiv 1603.06560).
  *Gated on:* an economics win (R26-5) or a diversity win (R26-6) giving a reason to
  search a *larger* family — racing is a tool for spending the budget on the
  candidates that matter, not a substitute for having candidates worth testing.
  **Engine landed (round 26); driver gated.** `analysis/race.js` implements and
  validates the engine — `halvingRounds`/`halvingSchedule` (exact reference vectors),
  `successiveHalving({arms, evaluate, maxBudget, eta, maximize})` (evaluator-agnostic
  and deterministic; a non-finite evaluation is eliminated, never ranked; returns the
  full per-rung scored table plus both the evaluation count and the budget-weighted
  `spentBudget` vs `gridBudget`), and `formatRace`. It is registered
  `LOCKED-invariant`; the validation requirement is a test, not a promise
  (`analysis.test.js` §AM proves the race winner equals the brute-force full-grid
  oracle on a fixture and reports the budget saving). The `--race` **driver is not
  shipped**, because the gate is currently **closed**: `RUN-ANALYSIS.md` §7 measured
  neither an economics nor a diversity win (the family is cost-dead), so a larger
  search has no reason yet. The gate and the conditions under which the driver would
  be wired are recorded in `docs/METHOD.md` §2. `analysis.test.js` 550 -> 559, ledger
  2276 -> 2285.

#### Research leads that could change the *family* (gated — not this round)

These are the research-grounded directions that could change which *model family
or variant* is worth building, recorded now so the evidence from this round can
decide them rather than a guess. None is implemented in round 26; each is gated on
the round's own outcome (an economics win from R26-5, and/or a diversity win from
R26-6).

1. **Rank by signal half-life, not just net Sharpe (fits R26-5/R26-8).** arXiv
   2502.04284 shows the optimal multi-period policy under costs depends on how
   *slowly* the signal decays — a slow signal justifies holding; a fast one should
   be traded less or not at all. Concretely: measure each candidate's raw
   confidence autocorrelation / estimated half-life in bars, and add it to the
   report beside `breakEvenCostBps`, so candidates are ranked by
   `decay × gross edge per unit turnover` (Grinold's breadth argument applied to
   *time* rather than to streams). This is measurement-only and belongs in R26-8's
   `nextRun`/participation block; if it works it becomes a candidate-selection
   criterion, not a new mechanism.
2. **Cross-sectional variants buy independence by construction.** The current
   signal family is *time-series*: the same feature on 8 correlated majors, which
   is why its cross-stream correlation is 0.35-0.57 (`RUN-ANALYSIS.md` §7.1) and its
   design effect 3.2-4.6. A **cross-sectional** candidate (rank the basket by the
   feature, go long the top / short the bottom) makes the common factor cancel by
   construction, so its per-stream positions are far less correlated and the
   *effective* bar count is much higher for the same data. That is the cheapest
   possible answer to R26-6 and it is a genuinely different family, not another
   tunable. Grounding: the cross-sectional momentum literature — Moskowitz &
   Grinblatt (1999, *Do Industries Explain Momentum?*, JF 54(4)); Moskowitz, Ooi &
   Pedersen (2012, *Time Series Momentum*, JFE 104(2)); Asness, Moskowitz &
   Pedersen (2013, *Value and Momentum Everywhere*, JF 68(4)). Gate: only after
   R26-6 shows the diversity it claims, and only after the A/B can afford the extra
   candidates (R26-4).
3. **Turnover-regularised *training*, and learned position sizing.** arXiv
   2509.04541 (turnover regularization as a loss term) and arXiv 1904.04912 (Deep
   Momentum Networks learn trend and sizing jointly against Sharpe) are the
   hot-path halves of R26-5. They are **deferred by design**: they change the
   training arithmetic, so they need their own A/B, a `DESIGN.md` §6 gate and a
   golden decision — exactly the discipline that keeps the goldens meaningful. If
   R26-5's post-processing sweep finds a policy band that clears cost, the natural
   next question is whether the *model* can learn to sit inside it.
4. **A composite candidate instead of a single winner.** With a K = 9 family that
   is effectively ~3.6 independent ideas (`familyCorrelation`), combining weakly
   correlated candidates (equal-weight, or IC-weighted) is the textbook way to add
   breadth without adding a new data source (Grinold 1989; the "fundamental law"
   again). Recorded as a lead because it interacts with R26-7: a composite must
   clear the same gate, and its construction must not be fitted on the test folds.

#### Acceptance (round 26)

1. `BUGS.md` #33 fixed with the driver + hardening changes; the 11 golden
   fingerprints unmoved; `RUN-ANALYSIS.md` §7's baseline numbers re-derived and §9
   written with the corrected readings. The native cost constant is re-measured
   after the fix (no churn-based saving is claimed without it).
2. The sweep matrix complete (16 suspects × 10 invariants × every stateful
   component), every found defect either fixed with a contract test or recorded as
   a documented tradeoff — including the five "checked clean" cells.
3. `BUGS.md` #36/#37 closed as *measured, not fixed*: the three label policies are
   evaluated as A/B variants (default `optimistic`, goldens unmoved) and the report
   carries the base rate, the skill score and the label lifecycle.
4. The checkpoint throttle lands with a byte-identical `folds.jsonl` at
   `saveInterval ∈ {1, final-only}` and the measured per-call share recorded.
5. A policy sweep (offline, from the journal) in which some policy clears a 5-10 bps
   break-even at a Sharpe not distinguishable from its costless value.
6. The fold loop parallelised with a byte-identical `folds.jsonl`.
7. The seed replication done: ≥ 3 master seeds, common random numbers across
   variants, the paired variance below the unpaired one on a fixture, and the
   distribution (not a point estimate) in the report.
8. A report that carries every R26-8 field — including `model` (base rate, skill,
   lifecycle), `concentration`, `forecast` + `mcs`, the seed distribution and
   `nextRun`.
9. Whole suite green with the recorded counts updated (new tests land the ledger at
   a new total); `npm test` mirrors exact, and `RUNBOOK.md` §6 / the READMEs
   re-synced in the same commit.

#### Order of work, and what is deliberately NOT in this round

**Order:** R26-0 → R26-1 (sweep + fixes, now 16 suspects) → R26-2/R26-3/R26-11 →
R26-12 → re-derive §7's baseline → R26-4 → R26-5 → R26-6 → R26-13 → R26-7/R26-8/
R26-14 → R26-9 decision → R26-10 alongside each. R26-0/1 are prerequisites for
*trusting* anything; R26-12/R26-4 are the prerequisites for *affording* anything
(R26-12 first — it is the cheaper and smaller change); R26-13/R26-14 are the
prerequisites for *deciding* anything about the family; R26-15 is gated behind an
R26-5 or R26-6 result.

**Not in this round:** any change to the shipped labeler's default (R26-11's
policies are opt-in A/B variants), any change to the training arithmetic, any
golden re-freeze (nothing here should qualify), a portfolio/consensus layer, a
scheduled racing driver (R26-15 is gated), and any hot-path "optimisation" that is
not proven semantics-preserving. The O(n²) replay is *not* removed — R26-9 decides
whether it may be, on statistical grounds, and only then.

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
  DB rows are quarantined. Proven by `guards.test.js` (65), `worker_pool.test.js`
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
(`test/node/mirrors.test.js` asserts exactly 30 browser entries / 42 mirrors), for
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

## Coherency audit — round-23 revision (historical; kept for the record)

| Check | Result |
| --- | --- |
| Registry total & status split (53 = 17 + 36 + 0 + 0) | ✅ verified programmatically against `lock-registry.js` **at that revision** (current: 60 = 17 + 43 + 0 + 0) |
| Ledger sum (1995, the round-24b total) vs `RUNBOOK.md` §6 table | ✅ exact match **at that revision**; the current ledger is 2289 |
| Manifest ↔ registry coverage (22 hivemind + 5 controller bags) | ✅ via `locks.test.js` |
| Browser entries ↔ node mirrors ↔ `KNOWN_TESTS` (30/39/29) | ✅ via `mirrors.test.js` |
| Golden fingerprint count (11) across all docs | ✅ consistent |
| Syntax + relative-import resolution (169 JS files, 368 relative imports) | ✅ 0 errors (re-measured this revision) |
| Counts in prose (115 blocks, 39 mirrors, 1995 checks) | ✅ synced **at that revision** (current: 123 blocks, 42 mirrors, 2289 checks) |
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
  driver: **10.7 s per fold-pass at 36 folds/stream** — but not constant; it grows
  with the fold index (42.6 s at 142), so a run is O(n²) per stream (`RUN-ANALYSIS.md`
  §4, round 25b). At 36 folds/stream the count is
  `mechanismVariants × folds × (1 + auditProbesPerFold)` — 4,032 fits for the
  attempt-3 power run (11.98 h). Signal candidates are free; at the *attempt-3*
  scale a mechanism candidate is ~1.7 h (at 142 folds/stream one is 26.9 h).
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
- **Ledger churn.** Ledger counts are (30 browser entries / 42 mirrors / 2289
  checks) and `mirrors.test.js` asserts the two layout constants exactly; every
  count in the docs must be re-synced in the same commit. Round 23 avoided adding
  entries by proving the new `analysis/world.js` and `analysis/features.js` inside
  the existing `analysis.test.js`/`walkforward.test.js`, so the ledger counts only
  had to change where the entries themselves grew — and the 20 wrap-style mirrors
  were switched from `total >= N` to `result.total === N` in the same pass.
- **Latent numerics** (SQLite reload, MAD/variance proxy, percentile 0→1,
  trigger-happy stagnation, MACD alignment) are pinned/documented, not fixed;
  touching any is a golden re-freeze plus a benchmark.
