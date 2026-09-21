# NeuLegion — TODO / research backlog

Living backlog, ordered by expected value. Each item names the research note it
belongs to (`docs/research/`) and what "done + provable" means. The rule from
the task: a component is only promoted into the **LOCKED** registry
(`docs/LOCKED.md`, `test/lock-registry.js`) once a test proves it *and* a
citation grounds it; anything not yet provable stays **EXPERIMENTAL** in
`src/analysis/` or is listed under `npm test` for a local run.

## Scope freeze + prioritized backlog

> **The consolidated, current plan is [`ROADMAP.md`](ROADMAP.md).** This list is
> the short form and is kept in sync with it.

The intended design is **frozen** — the locked core is defined in
[`DESIGN.md`](DESIGN.md) and new systems are added only when demonstrably
essential and passing its definition of done. The research leads below are a
catalogue, **not** a schedule.

**Done — the local gate and its promotions**

1. [x] Run `npm test` on a machine with Node + `better-sqlite3` and confirm the
   full suite is green. **Done: 89/89 blocks, 0 failures** (`BUGS.md` #18).
2. [x] Promote the three `NEEDS-LOCAL-RUN` controller bags (`controllerDatabase`,
   `controllerAccuracy`, `controllerTrade`) to `LOCKED-invariant`. **Done**
   (`test/lock-registry.js`, [`LOCKED.md`](LOCKED.md)); **0 remain**.
3. [x] Fix the golden engine-sensitivity (the one failing check). **Done**
   (`BUGS.md` #17; `hm:predictions` now compared at 6 significant digits and
   guarded by `test/node/engine_portability.test.js`).

> **Round 22 — the whole P0–P3 programme below is now implemented and covered.**
> Deliverables + proofs: `src/legion/sanitize.js` + `rng.js` (`guards.test.js`
> 58), `src/legion/workers.js` watchdog + `batch.js` isolation
> (`worker_pool.test.js`, `runner_smoke.test.js`), `NEULEGION_*` overrides
> (`config_env.test.js`), run directory/manifest/spool + retention
> (`report_lifecycle.test.js`), SIGINT checkpointing (`shutdown.test.js`),
> `npm run preflight` (`preflight.test.js`), `npm run dryrun` (`dryrun.test.js`),
> the served dashboard + SSE (`http_view.test.js`), `src/observer/*`
> (`observer.test.js` 76), `npm run analyze` A/B driver (`analyze.test.js`, 143
> after round 24), and the `hm:postReloadPrediction` rounding (`BUGS.md` #19).
> `npm test` **ran green on the native driver: 115/115 blocks across 39 files,
> ~5.9 min** (`BUGS.md` #21), after #20 fixed one false-negative `preflight`
> check.
>
> **Round 23 — N0/N1/N2 are implemented (see item 15-17, 19).** The A/B now
> evaluates the shipped controller through a non-vacuous audit, over a 15-candidate
> causal family, with a power/MDE readout and cross-symbol pooling. **The only
> remaining step is N3 — the verdict run** (`npm run analyze`, item 18).
> Browser suite: 1995 checks (every wrap-style mirror now asserts its count
> exactly).

**P0 — run integrity (must land before any long run; no hot-math change)**

4. [x] **Fault-isolate the pipeline** so one bad controller, corrupt DB row or
   non-finite value cannot abort a run or corrupt its data: replace
   `batch.js`'s `process.exit(1)`-on-reject with per-controller isolation + a
   failure budget, add worker watchdogs, validate constructor/config inputs, and
   sanitize every DB write. Add the controller-coverage tests (never-throws
   property, corrupt-row, malformed-config). Detail: `ROADMAP.md` P0-1.
5. [x] **Determinism & durability**: opt-in run seed, `run.json` manifest +
   config/structure fingerprint, graceful shutdown + atomic checkpoint, and a
   crash-recovery test. Detail: `ROADMAP.md` P0-2.
6. [x] **Legion test harness**: the `NEULEGION_*` overrides (`STATE`, `FILE`,
   ephemeral `HTTP_PORT`, `maxBatches`/`onBatch`), `npm run dryrun`,
   `npm run preflight`, and the node-only runner/worker/fault-injection/HTTP/
   shutdown tests. Detail: `ROADMAP.md` P0-3.

**P1 — observe the legion (read-only / additive; no hot-path change)**

7. [x] **Monitor dashboard** replacing the raw JSON-over-LAN broadcast: a served,
   self-contained page at `/` with a same-origin JSON API + SSE, bound to
   loopback. Detail: `ROADMAP.md` P1-1.
8. [x] **Dedicated outer analyzer** (`src/observer/`): calibration, diversity,
   influence concentration, drift, memory/pipeline/data health → alerts + a
   `report.json`, shared with the dashboard and the A/B. Detail: `ROADMAP.md` P1-2.

**P2 — the decisive evaluation (the gate; runs on the trustworthy P0 runner)**

9. [x] Build the runnable walk-forward **feature A/B driver** (`src/analyze.js` /
   `npm run analyze`) and decide promote/reject for each of the six default-off
   features (surprise, sample-weights, homeostasis, multiprobe, pca-hash,
   querymod) on the shipped candles against their off-by-default baseline, with
   `promoteDecision` + `familywiseSearch`. Re-freeze `hm:broadcast` where the hot
   path changes. Grounding `financial-validation.md`, `lsh-ann.md`.
   Detail: [`ROADMAP.md`](ROADMAP.md) P2-1.
10. [x] Expose the full analysis battery (PSR/DSR/MinTRL, PBO/CSCV, RC/SPA/StepM,
   k-FWER/FDP) from the same CLI (`ROADMAP.md` P2-2).
11. [x] Close the last raw-float fingerprint (`hm:postReloadPrediction`)
   (`ROADMAP.md` P2-3) — **done**: now hashed rounded to 6 significant digits like
   `hm:predictions`; `f9cef898 -> 5f703135`, the other ten hashes unchanged
   (`BUGS.md` #19).

**P3 — coverage, remaining hardening, candidate systems**

12. [~] Grow the feature universe K on the family-wise path (detail in item 11 of the
   history below): define a larger family of genuinely causal signals and run the
   family-wise (SPA / Romano–Wolf) gate plus the k-FWER/FDP relaxations over it
   (`ROADMAP.md` P3-1). **Partially met — re-opened as N1.** What shipped is the
   family-wise gate over the six *mechanism flags*; the named causal signals
   (fractionally-differenced momentum, volatility regime, volume/turnover) were
   never added as candidates, so the real feature family is still open.
13. [x] Decide the proven-but-unimported low-rank ES (`legion/evolve.js`):
   **formally deferred** — it stays a registered `LOCKED-invariant` support module
   (`evolve.test.js`) that nothing imports, so it cannot move a hot-path
   trajectory; wiring it would need its own A/B and a `DESIGN.md` §6 decision
   (`ROADMAP.md` P3-2).
14. [ ] Remaining untested surfaces (fetcher CLIs, vault capacity/prune, exact-count
   ledger floors) and SQLite reload bit-idempotency (`ROADMAP.md` P3-3/P3-4).

**Round 23 — make the evidence real (the current plan; `ROADMAP.md` N0-N3)**

15. [x] **N0 · Fidelity**: `analyze.js` now has a *controller-backed* model factory
   (`makeControllerModelFactory`) so the A/B evaluates the shipped
   `HiveMindController` (10 real indicator series, trade bookkeeping,
   closed-trade training) instead of a bare `HiveMind` on a 6-element return
   vector; `sample-weights` is evaluated (not skipped) on that path; every report
   names the model path, the streams, the probe and the position policy. The
   prerequisite audit fix landed too: `auditNoLookahead` takes a `viewFor` hook
   and perturbs the model's actual input (`analysis/world.js`), with a
   structural `vacuous` flag so an unreachable input can no longer pass
   (`BUGS.md` #22). Default path byte-identical; `walkforward.test.js` section K
   is the regression guard.
16. [x] **N1 · Real signal family**: new pure `src/analysis/features.js` — 8 causal
   point-in-time features (momentum, fractional-diff momentum, realized-vol
   regime, multi-horizon momentum agreement, range location, volume/turnover
   imbalance, lag-1 autocorrelation, acceleration), each reduced to a position by
   one causal z-score -> clamp pipeline and exposed as a candidate on the SAME
   family-wise gate, so the searched universe is now K = 15 (7 mechanism flags +
   8 signals) instead of 7. Exact reference vectors + a causality invariance
   check in `analysis.test.js` section AC.
17. [x] **N2 · Power + the unused dataset**: every report carries a Sharpe
   standard error + 95% MDE (Lo 2002); `poolReports` merges one walk-forward per
   symbol into a single pooled report via the same `poolFolds` arithmetic as a
   single stream; the CLI gained `--symbols=a,b|all`, `--files`, `--model=`,
   `--probe`, `--audit-probes`, `--variants`, and `readCandles` streams full
   OHLCV from any manifest file (all 8 audited symbols are usable).
18. [x] **N3 · Verdict**: **DELIVERED** by attempt 3 (`20260920T144633-seed1`,
   2026-09-20, seed 1) — the full power run completed in 11.98 h (12,960 passes,
   15/15 variants, 288 folds / 4,320 pooled bars): **all 14 candidates keep-off**,
   **SPA p = 0.5699** (Rejects = [none], best `sig:momentum`, K = 15, T = 4,032),
   baseline pooled Sharpe **+0.4387** / DSR 0.5179 / break-even 12.42 bps. The
   decision record is in `OPTIMIZATION.md`; the forensics (manifest, the exact
   offline verification of the journal, the cost/per-symbol/correlation analyses)
   are `RUN-ANALYSIS.md` §5. `query-mod` (DSR 0.9992), `sig:momentum` (Sharpe
   1.1059) and `sig:acceleration` (1.0502) miss only the fold-consistency hurdles.
   Nothing promoted ⇒ **no golden re-frozen**. Two report-honesty defects found
   (`BUGS.md` #26/#27) ⇒ round 25, items 31-36.
   **Attempt 1 (2026-09-20, seed 1) ran out of road and produced NO verdict** —
   forensics in `RUN-ANALYSIS.md` §1: the manifest was exactly the intended power
   run, but the process died inside the second candidate (1,862 of ~17,280 fits,
   `baseline` complete + 61.6 % of `surprise`), leaving an uncheckpointed `-wal`
   and no `report.json`/`run.log`. Fixed by items 20-21.
19. [x] **Hygiene**: the 20 wrap-style node mirrors now assert **exact** check
   counts (`assert.equal(result.total, N)`) instead of a floor, and every count
   was re-measured in the harness before pinning (the three that changed:
   `analysis` 354->390, `analyze` 47->98, `walkforward` 31->48; total
   1845->1949 in round 23, then round 24 raised `analyze` 98->129 (total 1980) and round 24b raised it to 143 with `walkforward` 48->49 (total 1995). `bench.test.js` still prints timings only — it has no node mirror
   so `npm test` never runs it, and an absolute ms ceiling there would be
   hardware-dependent; the counters it prints are the hardware-independent part
   (see `RUNBOOK.md` §6).

**Round 24 — make a verdict run survivable, then get it (plan: `RUN-ANALYSIS.md` §2)**

20. [x] **P0 · Report checkpointing** — delivered. `evaluateAB` gained reporting-only
   `onVariant(entry)` (and `onEvent`); `runAnalysis` rewrites
   `partial-report.json` with an ATOMIC (tmp+rename) write after every variant,
   appends a per-variant `progress` line to `run.log`, and on a crash writes a
   `status:'failed'` checkpoint that keeps every finished variant and every
   completed pass (`BUGS.md` #24.1; proved by `analyze.test.js` §Q).
21. [x] **P0 · Reclaim model state** — delivered. `modelRetention: 'discard' |
   'keep'` on both model factories (factory default `keep`, CLI default
   `discard`, `--keep-models` opts out); `makeSignalForVariant` calls the
   model's idempotent `dispose()` in a `finally`, which closes the fit's `_db`
   and `rmSync`s its state dir. The emitted positions are byte-identical to the
   `keep` run (`analyze.test.js` §O), so the measured 0.708 MiB/fit (~11.9 GiB
   per full run) is gone with no arithmetic change (`BUGS.md` #24.2).
22. [x] **P0 · Report the audit's teeth** — delivered. `auditBlock()` records
   `{ clean, vacuous, reachable, reachableFolds, viewDiffers, probes, violations,
   violationExamples }` per candidate and `formatAnalysis` prints
   `audit: baseline <clean|LEAK> probes=N reachable=... reachableFolds=...`;
   `probesPerFold`/`auditVerdict` are exported (`analyze.test.js` §P). Evidence
   it matters: the probe passes changed the model's end state in only 31/288 folds
   (`RUN-ANALYSIS.md` §1.4.2).
23. [x] **P0 · Run it** (P0-4): **DONE — both halves.** The smoke run
   (`20260920T094400-seed1`) completed in 39.0 min / 960 passes and gave an honest,
   underpowered null; forensics in `RUN-ANALYSIS.md` §3 found five defects (all
   fixed in round 24b, `BUGS.md` #25). The **power run**
   (`--symbols=all --bars=600 --audit-probes=1 --reuse-base`) then completed as
   `20260920T144633-seed1` in 11.98 h / 12,960 passes and gave the **N3 verdict**
   (item 18): all 14 candidates keep-off, SPA p = 0.5699, no promote, no golden
   re-frozen. Only `run.json` + `report.json` + `run.log` + `folds.jsonl` were
   uploaded (never `models/`), and the journal was verified offline end to end
   (`RUN-ANALYSIS.md` §5.3). Its forensics also produced the measured cost model
   (**10.7 s/controller fit** — `RUN-ANALYSIS.md` §4, ~2× the old 5.23 s estimate,
   correcting the "~6 h" plan to 11.98 h) and two new open defects
   (`BUGS.md` #26/#27 ⇒ items 31-36).
24. [x] **P1 · Determinism smoke test** — delivered as `analyze.test.js` §Q (two
   identical runs give an identical `summary` and baseline pooled Sharpe) and
   documented in `RUNBOOK.md` §6. (`RUN-ANALYSIS.md` §1.7: repeated controller
   fits are order-dependent in the browser harness, so the harness is not the
   right oracle for the real-driver determinism claim.)
25. [x] **P1 · `requireReachable`** — decided: it defaults OFF but reachability
   is ALWAYS recorded (`audit.reachable`, `audit.reachableFolds`), so a verdict
   states which kind of certificate it has; `--reachable` turns enforcement on.

**Round 24b — premium hardening of the analysis path (from the completed smoke
run; `RUN-ANALYSIS.md` §3, `BUGS.md` #25)**

26. [x] **Volume-aware audit shock** — delivered. `world.js#volumeShockFactor`
   scales volume on a probe pass (`DEFAULT_SHOCK.volumePhase`); the real run had
   `sig:volume` reachable **0/16**, now a volume-only signal is audited
   reachable. `analyze.test.js` §R.
27. [x] **Assumption-free break-even cost** — delivered. `grossPnl` +
   `breakEvenCostBps` (`1e4·grossPnl/turnover`, `null` at zero turnover) in
   `backtestMetrics`/`poolFolds`, a `cost:` line in `formatReport`, and
   `--cost-bps` threaded to the scoring (it was previously accepted and ignored).
   §R.
28. [x] **Offline-readable journal + liveness cursor** — delivered. Each
   `folds.jsonl` pass carries `probeIndex` and `reused`; pass events advance the
   stdout/heartbeat fold cursor (it used to freeze on the last scored fold for the
   whole audit). §P/§Q.
29. [x] **Power honesty** — delivered. `power.underpowered` (MDE95 > 1.0) and
   `power.barsToDetect1` from the pure helper `barsToDetect`; `formatReport` marks
   an underpowered power line and `formatAnalysis` states the run-level verdict.
   `analyze`/`walkforward`/`analysis` tests.
30. [x] **`--reuse-base`** — delivered. Reuse the scored pass as the audit base
   pass (verdict-identical, `baseReused` recorded), dropping the power run from 4
   to 3 passes/fold (2 with `--audit-probes=1`): ~12 h → ~6 h. §R.

**Round 25 — make the verdict trustworthy, then make it decisive (from the
attempt-3 power run; `RUN-ANALYSIS.md` §5, `BUGS.md` #26/#27)**

31. [x] **Power must see the design effect (`BUGS.md` #26).** *(Delivered round 25: `powerSummary` now emits `seDependent` / `mdeSharpeDependent` / `underpoweredDependent` / `varianceInflation` / `effectiveBars` beside the i.i.d. ones, and `dependenceSummary` carries `seCluster` / `designEffect` / `adjustmentNeeded` / `meanPairwiseStreamCorr`. Calibrated on a deterministic Monte-Carlo panel — see `RUN-ANALYSIS.md` §6.3.)* `powerSummary` gains
   the mean pairwise cross-stream correlation of the per-stream per-fold Sharpe
   series, `effectiveStreams`, and a correlation-corrected `se`/`mdeSharpe`;
   `underpowered` reads the corrected MDE (raw + corrected both recorded).
   Measured evidence: the 8 streams correlate 0.41-0.52 per fold, so attempt 3's
   printed MDE95 ±0.4735 (`underpowered: false`) is really ≈ ±0.98. Tests: a
   synthetic correlated-stream fixture where the raw MDE says powered and the
   corrected one does not, plus the `barsToDetect` re-derivation.
32. [x] **The verdict must carry its cost sensitivity (`BUGS.md` #27).** *(Delivered round 25: `costLadder` + `restateReportAtCost`, `--cost-ladder=0,2,5,10` default-on, `breakEvenCostBps` in every report and the `10 bps` scored cost in the summary header.)* Emit a
   `costLadder` block (pooled metrics + full `promoteDecision` at
   `--cost-ladder=0,2,5,10`, default on) and print the scored cost in the summary
   header. O(T) per level. Evidence: at 2 bps `sig:acceleration` promotes with
   zero reasons (ladder in `RUN-ANALYSIS.md` §5.6(a)).
33. [x] **Fold consistency as a significance statement, not a fraction.** *(Delivered round 25: `pairedPromotionTest` — paired cluster `t(C-1)` Sharpe-difference + exact sign test over fold-window clusters — behind the `--gate=dependence` default, with the fractions kept as reported statistics. `DESIGN.md` §6.1, tests in `analysis.test.js`/`walkforward.test.js`.)*
   Replace `foldWinFraction >= 0.5` / `positiveFraction >= baseline` with a paired
   test against the baseline (sign test / stream-block bootstrap with the
   effective-n correction) at a stated alpha; keep the fractions as reported
   statistics. This is a decision-procedure change → rationale in `DESIGN.md` §6 +
   dedicated tests. Evidence: all three real candidates fail *only* this hurdle
   (0.4653 / 0.4514 / 0.4896 vs 0.5) and the outcome flips with the cost level.
34. [x] **Report the candidate family's correlation.** *(Delivered round 25: `familyCorrelation` — per-fold excess-Sharpe correlation matrix, `meanPairwiseExcessCorr`, `maxPair`, `effectiveTrials` — printed as a `family:` diagnostic line; explicitly NOT used to deflate `trials`, which stays K for FWER reasons.)* Attach the excess-vs-baseline
   cross-candidate correlation and an effective-trials estimate to the family-wise
   block, so K = 15 and "three DSR-significant candidates" are not read as 15 or 3
   independent things (`sig:momentum ~ sig:acceleration` = 0.863).
35. [x] **Explain `query-mod`.** *(Addressed round 25: `backtestMetrics` now carries `nonZeroFraction` and `meanAbsPosition`, so the fold-hurdle question "does the dead zone make it abstain?" is answerable from a report; and the cost ladder shows the ranking is cost-dependent (querymod leads only at 5–10 bps).)* DSR 0.9992, MDD 0.0081, turnover *below* baseline,
   break-even 33.7 bps, median fold Sharpe exactly 0. Determine whether the dead
   zone makes it abstain on most folds, and whether that is a feature the fold
   hurdle should stop punishing.
36. [x] **Buy independence, not bars.** *(Measurement half delivered round 25: the corrected MDE (`effectiveBars` / `seDependent`) and the measured cost model make the sizing arithmetic explicit; the actual run-size decision is still open and is the point of the next run.)* The corrected MDE says the decisive
   experiment needs ≈ 4× the effective independent data (`barsToDetect1` 969 is
   i.i.d.; ≈ 4,300 bars under a 2.1 design effect). Cost it with the measured model
   (10.7 s/fit ⇒ `time ≈ 10.7 s × mechanismVariants × folds × (1 + probes)`);
   decide between more diverse symbols, longer per-symbol history, and a
   lower-frequency bar.
37. [x] **Observability polish.** *(Delivered round 25: each variant checkpoint/timing carries its own `elapsedMs` and `kind` (`mechanism|signal`), the report has a `timings` block, and `onVariant` includes `in <clock>`.)* Each checkpoint line carries the variant's own
   elapsed ms + `kind` (`mechanism|signal`) — the attempt-3 `run.log` reads as if 8
   variants took 0.66 s (`RUN-ANALYSIS.md` §5.4); serialise
   `minTrackRecordLength: Infinity` explicitly rather than as `null`.

**Deferred — research leads (NOT scheduled; see `DESIGN.md` §5)**

- A Locality-Sensitive Filtering index tier (2604.24323); temporal-co-occurrence
  retrieval (2602.11322); a fuzzy-dedup similarity floor (2606.03001); graph /
  learned indexes (2607.28999, 2607.09909). None are in scope for the frozen core.

## In progress / done this cycle

- [x] Expand the shipped candle dataset to 8 symbols / 567k rows, full audit.
- [x] `src/candles_audit.js` — pure integrity auditor + manifest (95 checks).
- [x] `src/candle_quality.js` — impossible-wick winsorizer, wired into the runner.
- [x] `docs/research/*` + `docs/CITATIONS.md` — literature grounding per domain.
- [x] `docs/LOCKED.md` + `test/lock-registry.js` + `locks.test.js` (28 checks).
- [x] Analysis supercharges: `performance.js`, `splits.js`, `labels.js`,
      `uniqueness.js` + `analysis.test.js` (97 checks, exact reference vectors +
      a full-pipeline random-walk control).
- [x] `src/update_candles_basket.js` + `docs/ci/update-candles.yml` + npm scripts.
- [x] **Round 2 — multi-symbol bug hunt.** Found + fixed the hardcoded 2-dp
      target grid (`BUGS.md` #9): sub-cent symbols (DOGE/ADA/XRP) had every trade
      direction silently inverted. New `src/price_precision.js` (LOCKED-invariant),
      `price_precision.test.js` (29), `multisymbol.test.js` (28). Golden
      fingerprints unchanged.
- [x] **Round 2 — analysis pipeline noise control + `BUGS.md` #10.** Found + fixed
      the stationary-bootstrap block-restart bug (it never re-drew its block
      start, so the null distribution was far too narrow: 17.5% false positives
      at the 5% level on pure noise -> 5.8% after the fix). `analysis.test.js`
      gained section G2 (bootstrap calibration + power) and section R (full
      pipeline on a random walk: CUSUM -> labels -> uniqueness -> purged CV).
      Suite then **774 checks, 0 failures** (`analysis` 97, `locks` 30, `lsh` 33).
- [x] **Round 2 — LSH recall-preservation proof.** New `lsh.test.js` (33 checks)
      proves the hyperplane index is mathematically sound: unit-norm projection
      metric (with the historical `1/sqrt(lowDim)` rescale reproduced and shown
      to fail the 0.35 filter), bit-exact hash words vs a brute-force recompute,
      a leak-free bucket index under insert/remove/update, 100% exact-match
      recall in both the min and production-width configs, the Charikar
      `Pr[flip]=θ/π` law matched to ≤0.03 and monotone in noise, and end-to-end
      `_retrieveTopRelevantProtos` recall. The `lsh` bag now lists
      `lsh.test.js` (+ the Lv 2007 multi-probe citation). No hot-path change:
      goldens untouched. This satisfied item 2's "recall-preservation test"
      prerequisite.
- [x] **Round 2 — surprise-gated memory writes (Titans arXiv 2501.00663).** New
      pure module `src/hivemind/memory/surprise.js` (gate/bounds/monotonicity/
      EMA momentum) wired into `banks.js#_updateSemanticProtos`: the semantic
      merge and new-prototype reinforcement paths are now scaled by
      `surpriseGate(1 - bestSim)`. Ships **off by default** (`_surpriseGateEnabled
      = false`), so `floor=1` collapses the multiply to an exact no-op and all 11
      golden fingerprints are bit-identical. `surprise.test.js` (32 checks) proves
      the pure math (exact vectors + properties), the bit-exact off switch (two
      identically-seeded banks fingerprint equally), and the end-to-end effect
      (measured gated/ungated write ratio `== surpriseGate(1 - bestSim)`, novel
      written >2× more strongly than predictable).
- [x] **Round 2 — sample-uniqueness-weighted training (Lopez de Prado AFML
      ch. 4).** New pure hot-path module `src/hivemind/training/sample_weights.js`
      (average uniqueness, clamp, mean-1/sum-1 normalisation, Kish ESS,
      horizon-based entry weights). `HiveMind.train(inputs, target, sampleWeight)`
      now takes an optional per-sample loss weight; `_accumulateGradients`
      multiplies the logit gradient by it. The controller gains
      `_sampleWeightsForBatch` and feeds `train(..., w)` — both **off by
      default** (`_sampleWeightConfig = null`, `w = 1`), so every golden
      fingerprint is bit-identical. `sample_weights.test.js` (36 checks) proves
      the pure math (bit-for-bit agreement with `analysis/uniqueness.js`), the
      overlap semantics, that the train step is exactly linear in `w`
      (gradient-energy ratio `w²`), and that `w = 1` / non-finite `w` are
      bit-exact no-ops. Suite now **845 checks, 0 failures** (`analysis` 97,
      `locks` 33, `lsh` 33, `surprise` 32, `sample_weights` 36).
- [x] **Round 2 — homeostatic plasticity for per-member learning rates
      (Turrigiano synaptic scaling; arXiv 2609.13771).** New pure module
      `src/hivemind/ensemble/homeostasis.js` (bounded/monotone multiplier with
      an exact set-point fixed point, EMA activity signal, RMS, deviation
      energy, and the proven contraction condition `0 < gain·target < 2`).
      `_updateAdaptiveLearningRates(outputs)` now applies the multiplier when
      `_homeostasisEnabled` is true; the rank-based controller it wraps is
      blind to common-mode shifts, which the absolute set-point corrects.
      Ships **off by default** (`_homeostasisEnabled = false`), so every golden
      fingerprint stays bit-identical. `homeostasis.test.js` (30 checks) proves
      the pure math, closed-loop convergence to `target/k` across a `k`-sweep
      with the set-point error decreasing every step, and that enabled-with-
      `gain=0` is a bit-exact no-op against the default path. Suite now
      **876 checks, 0 failures** (`analysis` 97, `locks` 34, `lsh` 33,
      `surprise` 32, `sample_weights` 36, `homeostasis` 30).
- [x] **Round 2 — low-rank evolution strategies (EGGROLL arXiv 2609.10980).**
      New additive module `src/legion/evolve.js` (nothing imports it yet):
      antithetic ES gradient estimate, random orthonormal subspaces, backtracking
      line search, and a `runEvolution` loop that redraws the subspace each
      generation. `evolve.test.js` (36 checks) proves the exact quadratic identity
      `ĝ = S·Hθ`, the PSD descent-direction guarantee, full-rank alignment with
      the true gradient, low-rank unbiasedness for the projected gradient, and
      **monotone fitness** to the optimum on a toy convex quadratic (full-rank and
      rank-3). This is the provable prerequisite for item 3. Suite now
      **913 checks, 0 failures** (`analysis` 97, `locks` 35, `lsh` 33,
      `surprise` 32, `sample_weights` 36, `homeostasis` 30, `evolve` 36).
- [x] **Round 2 — margin-ordered multi-probe LSH (Lv et al., VLDB 2007).** New
      module `src/hivemind/memory/multiprobe.js`, now wired into the locked
      `_getGlobalLSHCandidates` behind the default-off `_multiProbeConfig` flag:
      probe the hash bits in ascending order of the query's margin
      `|dot(queryProj, hyperplane)|` — the hyperplanes a near neighbour is most
      likely on the other side of — instead of flipping an arbitrary prefix.
      `multiprobe.test.js` (77 checks) proves the structure and cost ordering
      exactly, the **flip lemma** (`bit b flips ⇔ |δ_b| > |q_b|` and opposing
      sides, so the lowest-margin cover is complete: zero violations in 300
      trials), that P(flip) decreases monotonically with margin (0.48 → 0.04
      across octiles), that margin order dominates the historical prefix probe at
      every budget and beats every sampled random order, the exact ≤1-bit/≤2-bit
      completeness identities, and — on a **real 107-bit HiveMind index** — that
      margin probing lifts self-recall under noise from 0.03 to 0.30 at σ=0.25,
      exactly where the lean prefix helper collapses. Section F closes the wiring loop:
      with the flag set, the real `_getGlobalLSHCandidates` pool self-recall at
      σ=0.25 rises from **0.167 → 0.517** (with the flag unset it is byte-identical
      to the old prefix probe, so `golden.test.js` stays 23/0). This is the provable
      prerequisite for item 2. Suite now **966 checks, 0 failures** (`analysis` 97,
      `locks` 36, `lsh` 33, `surprise` 32, `sample_weights` 36, `homeostasis` 30,
      `evolve` 36, `multiprobe` 52).

- [x] **Round 2 — walk-forward evaluation harness (Pardo 2008; LdP AFML; arXiv
      2605.23959).** New pure module `src/analysis/walkforward.js`: `barReturns`/
      `logReturns`, `probToPosition`, `isCausalFold`, `aggregateFolds`,
      `foldWinFraction`, **`auditNoLookahead`**, `walkForwardEvaluate`,
      **`promoteDecision`**, `formatReport`. It turns an *online* model into an
      honest out-of-sample report and a mechanically reproducible feature-
      promotion decision. `analysis.test.js` section S (32 checks) proves
      barReturns/aggregateFolds exact, the audit **flagging** a `t+1` signal
      (17/18 test bars) and a full-sample-mean signal while a causal signal is
      clean, `walkForwardEvaluate` throwing on non-causal folds, and the
      promotion gate's **size + power**: over driftless-walk seeds the
      relative-only rule false-promotes ~37–41% of the time, versus **~3.5%** with
      the absolute `DSR ≥ 0.95` floor, at full power on an AR(1) momentum edge
      (Sharpe 5.5 vs −1.6). New `walkforward.test.js` (15 checks) is the
      real-candle end-to-end run: it parses a shipped symbol, refits a live
      `HiveMind` per fold (frozen after training, seeded `Math.random` like the
      goldens), and asserts the live causal model passes the audit, a `t+1`
      feature is caught, always-long reproduces per-fold buy-and-hold exactly, a
      flat signal is exactly inert, and repeated runs are bit-identical. Suite now
      **1013 checks, 0 failures** (`analysis` 129, `locks` 36, `lsh` 33,
      `surprise` 32, `sample_weights` 36, `homeostasis` 30, `evolve` 36,
      `multiprobe` 52, `walkforward` 15).

- [x] **Round 2 — combinatorial purged CV + finance research refresh (AFML ch.
      12).** New pure `combinatorialPurgedSplit` in `analysis/splits.js`: partition
      the series into `k` contiguous groups, take every choice of `m` groups as
      the test set → `C(k,m)` folds, each test set a union of whole groups, each
      observation tested exactly `C(k-1,m-1)` times — the number of backtest
      *paths*, so the fold metrics become a distribution over paths rather than
      one number. `analysis.test.js` section I2 (9 checks) proves the fold count,
      the group-union structure, the `C(k-1,m-1)` multiplicity, disjointness, zero
      label-window leakage, `m=k-1 ⇒ k` folds, and that embargo monotonically
      shrinks the training set. Research refresh
      (`docs/research/raw/arxiv-sweep-2026-09c.json`): added the AlgoXpert
      IS/WFA/OOS protocol (2603.09219), GT-Score (2602.00080), regime-conditional
      strategy comparison (2606.31251), and the key result that a **leaky
      Sharpe-35 oracle survives DSR/PBO** (2608.27734) — the empirical reason the
      harness audits causality structurally instead of trusting DSR. Finally,
      `walkforward.test.js` section G closes the loop: it A/Bs the default-off
      features through the harness on real candles, proving their **inert settings
      are bit-identical to off end-to-end** (surprise `floor=1`, homeostasis
      `gain=0`), that live settings change the trajectory, and that the promotion
      gate returns a well-formed decision — so a future promotion changes exactly
      one thing. Also fixed `BUGS.md` #11: `purgedCVBacktest`'s pooled report
      scored the pooled net stream with a synthetic all-long overlay, so
      `turnover`/`tradeCount`/`totalCost`/`grossSharpe` described the overlay
      (turnover structurally 1) rather than the strategy; they are now the
      per-fold sums and the pooled gross Sharpe. Suite now
      **1030 checks, 0 failures** (`analysis` 141, `locks` 36,
      `lsh` 33, `surprise` 32, `sample_weights` 36, `homeostasis` 30, `evolve` 36,
      `multiprobe` 52, `walkforward` 20).

- [x] **Round 3 — structure-scaling audit + lock upgrade (`dimensions`).** The
      `forceMin = false` branch of `persistence/dimensions.js` was the one
      component `docs/BUGS.md` recorded as unaudited. New `dimensions.test.js`
      (185 checks) audits both branches: the compact (production) overrides are
      frozen as exact constants; the full-size branch is swept over an
      `es × is` grid and checked for tensor/declared-count agreement (hidden
      divisible by heads, `headDim = hiddenSize/heads`, `lowDim` in its declared
      band, `numLshSets = floor(numProjections/3)`), a width-scaling monotonicity
      law (layers/heads/hidden non-increasing in `es`, learning rate
      non-decreasing; saturation for `es ≥ 1000`; only `lr` depends on `is`), and
      end-to-end churn (LSH index consistent with exact bucket multiplicity,
      finite weights, unit-norm projections). **Result: no defect.** The bag is
      promoted `LOCKED-structural → LOCKED-invariant` with citations (Kaplan
      2020, μP 2203.03466, Deep Ensembles) and a node mirror. Suite
      **1030 → 1237, 0 failures**.
- [x] **Round 3 — probability of backtest overfitting (PBO/CSCV).** New pure
      module `src/analysis/overfitting.js`: `cscvBlocks`, `cscvSplit` (the
      `C(S,S/2)` symmetric in-sample/complement splits), `relativeRank` (the
      rank→`omega` mapping), `oosOnIsRegression`, and
      `probabilityOfBacktestOverfitting`. This is the **non-parametric**
      companion to the deflated Sharpe (Bailey, Borwein, López de Prado & Zhu,
      2016; AFML ch. 12): it measures selection bias by cross-validation instead
      of modelling it, and assumes neither Normality nor trial independence.
      `analysis.test.js` section T (19 checks) proves the exact split structure,
      the rank/logit mapping, and **calibration**: 20 iid-noise strategies give
      `PBO = 0.464` (~the coin-flip baseline) with a ~0 degradation slope, a
      persistent edge gives `PBO = 0`, a planted regime flip gives `PBO = 1`, an
      all-flat matrix gives `PBO = 1` under the documented tie convention, and
      four malformed inputs throw. Registered `LOCKED-invariant`. Literature
      refreshed into `docs/research/raw/arxiv-sweep-2026-09d.json`.
- [x] **Round 3 — bug hunt in the analysis splitters (`BUGS.md` #12, #13).** Two
      real robustness defects, both fixed with regression tests.
      **#12:** `walkForwardSplit` accepted any `step`, so a `step` of `0`
      (or negative / `NaN` / `Infinity`) made the fold cursor never advance and
      the `while` loop hung forever — a synchronous freeze from a
      legal-looking argument. It now rejects a non-positive/non-finite `step`.
      **#13:** `combinatorialPurgedSplit` (C(k,m) folds) and `cscvSplit`
      (C(S,S/2) splits) materialised their fold/split objects without bounding
      the count, so `k=40`/`blocks=60` would attempt ~1e11–1e17 objects and
      hang/OOM. Both now compute the binomial count directly and reject an
      oversized enumeration up front (`MAX_COMBINATORIAL_FOLDS = 100000`,
      `MAX_CSCV_SPLITS = 200000`); valid inputs are unaffected.
- [x] **Round 3 — lock-map completion for the pure core helpers.** Registered two
      more hot-path pure modules as `LOCKED-invariant` in
      `SUPPORT_MODULES`/`SUPPORT_REGISTRY`: `consolidation_logic.js` (the memory
      lifecycle, proven by `consolidation.test.js` + `consolidation_worker.test.js`)
      and `candle_quality.js` (the impossible-wick winsorizer, proven by
      `candles.test.js`). This closes the "map out and LOCK" evaluation for the
      pure helpers that already had dedicated suites; the only components still
      not `LOCKED` are the three `NEEDS-LOCAL-RUN` controller DB bags, which
      require `npm test` on a machine with native `better-sqlite3`.
- [x] **Round 4 — White's Reality Check + Hansen's SPA (`analysis/reality_check.js`).**
      New pure module completing the honest-evaluation battery alongside DSR
      (`performance.js`) and PBO (`overfitting.js`). RC bootstraps
      `sqrt(T)·max_k mean(f_k)`; SPA studentizes each candidate by its bootstrap
      standard error and takes `max(0, mean_k/SE_k)`, which is **less
      conservative than RC** when many candidates are poor. Both resample the
      SAME Politis-Romano block timeline (`stationaryBlockIndices`, exactly
      i.i.d. at `blockLength=1`, default `floor(T^(1/3))`), preserving
      cross-sectional dependence. `analysis.test.js` section U (31 checks)
      proves the exact benchmark handling and statistics, the i.i.d. identity of
      the block resampler, and calibration: ~5% null size with ~Uniform p-values
      (150 reps, K=5, T=100), `p<0.02` on a strong edge, and SPA p=0.078 vs RC
      p=0.762 on one real edge among nine poor high-variance candidates.
      Registered `LOCKED-invariant` (citations White 2000, Hansen 2005, Politis
      & Romano 1994). Literature refreshed into
      `docs/research/raw/arxiv-sweep-2026-09e.json`, headlined by the
      independent 2026 **MinervaScore** study (arXiv 2608.23808) which composes
      exactly **DSR + PBO + SPA + MinTRL** over 359,062 production backtests.
      Suite **1237 → 1268, 0 failures**.
- [x] **Round 5 — Consistent SPA_c + Romano–Wolf StepM (section V).** Extended
      `analysis/reality_check.js` with Hansen's *consistent* recentring
      (`consistentRecentring`: recentre to zero any candidate more than
      `A_k = omega_k·sqrt(2 log log T)` below the benchmark), `hansenSpaConsistent`,
      and `romanoWolfStepM`, the step-down max-t that names WHICH candidates beat
      the benchmark while controlling the family-wise error rate. Shares the one
      stationary-bootstrap pass, so no new RNG. `analysis.test.js` section V
      (25 checks) proves the exact bound (inclusive at the threshold, sub-linear
      in T), bit-identity with upper SPA when every candidate is valid, the
      consistent<upper<RC ladder **0.058<0.078<0.762** on the section-U flagship,
      that the first StepM step IS the single-step SPA p-value with monotone step
      p-values, a degenerate guard (a candidate exactly at the benchmark is never
      rejected — a `>` comparison bug fixed here), and measured 5% FWER
      **0.075** (default block) / **0.065** (`blockLength=1`) with **0.89** power.
      Diagnosis recorded: the residual liberal-ness is the block *resampling* on
      i.i.d. noise (HAC omega only moves it to ~0.078), not the studentization or
      the max logic. Registered `LOCKED-invariant` (adds Romano & Wolf 2005);
      suite **1268 → 1293, 0 failures**.

- [x] **Round 6 — automatic block-length selection (Politis & White 2004).**
      Extended `analysis/reality_check.js` with `politisWhiteBlockLength` (the
      flat-top-lag-window selector, faithful to `arch.bootstrap.optimal_block_length`)
      and `autoBlockLength`, and wired `blockLength: 'auto'` into
      `bootstrapRelativeMeans` (default unchanged, so locked p-values are
      bit-identical). `analysis.test.js` section W (30 checks) reproduces `arch`'s
      published oracle exactly — stationary **13.635665130318229** / circular
      **15.608940081363109** on `RandomState(0)` + `standard_normal(10100)` AR(0.3),
      with m/optM/Kn/mMax/bMax/cv = 6/3/5/105/300/0.04 and circular/stationary =
      (3/2)^(1/3) — self-validating the NumPy stream against its known first
      draws. The pooled-selector ladder is monotone (0.651 -> 8.429 as phi: 0 -> 0.8).
      Opt-in auto block restores i.i.d. size **0.047** (vs 0.087 fixed) and under
      AR(0.8) beats a fixed `b = 1` (**0.413** vs 0.74, mean block 8.0).
      Registered `LOCKED-invariant` (adds Politis & White 2004; Patton, Politis &
      White 2009). Also bug-hunted the residual size distortion and pinned it to a
      bootstrap-SE **scale** bias (`bootSE/trueSE` best 0.72 at phi=0.8, T=120; ESS
      13), not the block length — HAC and quadratic-spectral omegas fail the same
      way. The variance-consistent resampling fix is the new item 7. Suite
      **1293 -> 1323, 0 failures**. Literature refreshed into
      `docs/research/raw/arxiv-sweep-2026-09g.json` (lugsail / LRV /
      variance-consistent inference).

- [x] **Round 7 — variance-consistent subsampling inference (section X; fixes the
      section-W limitation).** Extended `analysis/reality_check.js` with
      `neweyWestSE` (exact Bartlett HAC standard error of the mean),
      `subsamplingSpa` and `subsamplingStepM` (Romano-Wolf step-down), plus
      `DEFAULT_SUB_CONFIG`. The reference distribution comes from every
      overlapping window of the same series with ONE bandwidth shared by the
      window and full scales, so the studentization is pivotal and no
      long-run-variance estimate is needed — the exact fix the section-W
      measurement called for. `analysis.test.js` section X (28 checks) pins the
      Bartlett SE (m=0/1/2 exact), the structure (`nWindows = T-b+1`, default
      `b = round(T/3)`, `m = round(b/6)`, `shrink = sqrt(1-b/T)`) and
      determinism, then the payoff: 5% size **0.0533 / 0.0533 / 0.0567 / 0.0433**
      at phi = 0 / 0.2 / 0.5 / 0.8 (T=100, K=5, 300 fixed reps) vs the block
      bootstrap’s **0.20 / 0.4067** at phi = 0.5 / 0.8 — a ~9x distortion cut,
      gap >= 0.30 — with power **0.7167** (T=100) / **0.80** (T=120) at phi=0;
      StepM FWER **0.0533** at phi=0.8, power **0.72**, first step == single-step
      SPA (0.6667 pinned). Registered `LOCKED-invariant` (adds Politis & Romano
      1994 subsampling; Politis, Romano & Wolf 1999). Suite **1323 -> 1351, 0
      failures**.
- [x] **Round 8 — family-wise search on the honest-evaluation path (sections Y +
      H).** `subsamplingSpa`/`subsamplingStepM` gained an opt-in `groups`
      (segment lengths tiling `T`) so the long-run variance is estimated *within*
      a segment — the mean-shift case of arXiv 2603.17226 — with `groups=[T]`
      bit-identical to the ungrouped path; `walkforward.js` gained
      `familywiseSearch` (whole-family SPA + StepM over the pooled out-of-sample
      returns) and `walkForwardSearch` (mapping back to candidate labels, using
      each fold's length as a segment and trimming its no-exposure first bar);
      `promoteDecision` gained the opt-in `maxSearchP`/`requireSearchReject`
      hurdles and `formatReport` appends one search line. On the real-candle
      walk-forward the DSR floor and the family-wise StepM agree on all five
      candidates (neither promotes a real feature; both catch the injected
      oracle). New checks: section Y (25) and `walkforward.test.js` section H (5);
      suite **1351 -> 1381**.
- [x] **Round 9 — generalised error rates on the family-wise path (section Z:
      k-FWER + FDP).** `reality_check.js` gained `subsamplingKfwer` (single-step
      k-FWER, Romano & Wolf 2007, arXiv 0710.2258) and `subsamplingFdp` (the
      corrected Romano–Wolf / Delattre–Roquain step-down, arXiv 1311.4030, with
      the growing reference `k_l = floor(fdpTarget·l)+1`; shipped
      **EXPERIMENTAL**), both on the same deterministic subsampling-window grid
      as the section-X/Y instruments and backed by a new private
      `subsamplingReference` helper that leaves `subsamplingStepM`'s arithmetic
      bit-identical. Pinned global-null calibration (K=4, 200 reps): FWER/2-FWER
      **0.07/0.075** at T=200 and **0.04/0.055** at T=80; the FDP estimator
      rejects nothing beyond the first step in ~95% of reps. The naive
      survivor-order-statistic step-down was measured to **fail** (2-FWER 0.085
      at T=80, 0.145 at T=200) and is documented as REJECTED. `familywiseSearch`
      / `walkForwardSearch` take opt-in `kfwer`/`fdpTarget` (default-off →
      byte-identical). New checks: section Z (33); suite **1381 -> 1414, 0
      failures**.
- [x] **Round 10 — power / FDP validation on a mixture family (section AA) + the
      Round-9/10 literature sweep.** `analysis.test.js` section AA (11 checks)
      plants a fraction of true edges among AR-noise candidates on the same
      deterministic window grid, closing section Z's size-only story: k=2 k-FWER
      is strictly more powerful than k=1 (**0.155 -> 0.4975** on a weak 2-edge
      family) while FWER/2-FWER stay at/below alpha, and the FDP step-down on a
      20-candidate / 10-edge family rejects monotonically more as the target
      loosens (**6.833 < 9.05 < 9.783** of 20; reported `kHat` **1.2/2.6/3.7**),
      beating the strict max-t step-down (**9.783 vs 7.0**) with realised FDP
      below target (0.0098/0.0257/0.0528) — but slightly **OVER-running** a tight
      target on a sparse family (**0.1014 > 0.10** with an estimated FDP of 0),
      the measured finite-sample non-control that keeps `subsamplingFdp`
      EXPERIMENTAL. Literature: `docs/research/raw/arxiv-sweep-2026-09i.json`
      (k-FWER under dependence **2504.17611**; closed-testing FDP admissibility
      **1901.04885**; FDP uncertainty **2207.00926** / **2207.01619**; stepwise
      asset-pricing selection **2601.10279**; dynamic-factor multiple testing
      **2303.07631**) + `CITATIONS.md`. Suite **1414 -> 1425, 0 failures**.
- [x] **Round 11 — the family-wise gate on a longer real-candle walk-forward
      (section I).** `walkforward.test.js` section I (6 checks) repeats the
      section-H family-wise A/B on the full 150-bar slice with 6 folds of 15 test
      bars, so the same `walkForwardSearch` path runs over **48 windows** (groups
      `14^6`, `b=7`, `m=1`) instead of 18. The wider grid is well-formed, keeps
      finite per-candidate statistics, still catches the oracle control and
      promotes no real feature, and the DSR floor and the family-wise step-down
      still agree on every candidate — the power lever item 10 asks for, exercised
      on real candles. Suite **1425 -> 1431, 0 failures**.
- [x] **Round 12 — edge-case / invariant hardening of the generalised error rates
      (section AB).** `analysis.test.js` section AB (8 checks) bug-hunts the
      degenerate families: a single-candidate matrix throws (K >= 2 required — the
      module's `relativePerformance` guard, now an explicit check), an all-zero
      family rejects nothing through the `t = 0` guard, exactly tied candidates
      share a statistic / p-value / decision, a series benchmark zeroes the
      candidate equal to it, `groups=[T]` is bit-identical to the ungrouped path
      for both k-FWER and FDP, a tiny target keeps `kHat = 1`, a near-zero alpha
      never rejects more than the 5% level, and a missing / empty / too-short
      matrix throws for both procedures. **No defect found** — suite **1431 ->
      1439, 0 failures**.
- [x] **Round 13 — data-aware binary principal components (PCA-aligned LSH
      hyperplanes), engine + proof.** New additive pure module
      `src/hivemind/memory/binarypc.js` (BinaryPC arXiv 2608.04405; the
      training-free, data-aware alternative to random-hyperplane SimHash), with
      `binarypc.test.js` (24 checks) + a node mirror: seeded power iteration
      (vector-movement convergence), exact PCA on a diagonal covariance
      (descending eigenvalues, exactly orthonormal components, trace
      decomposition), planted-direction recovery (`|cos| > 0.999`), and the
      flagship **Eckart–Young** dominance — the PCA-aligned 3-subspace beats
      **every** one of 20 random 3-subspaces on reconstruction error (>2× margin)
      with error non-increasing in bits; `pcaHashTables` yields orthonormal,
      PC-subspace, seed-deterministic tables; `bits > dim` / zero-variance throw.
      Registered `LOCKED-invariant` (`lsh`); additive and not wired yet, so every
      golden fingerprint is untouched. Suite **1439 -> 1464, 0 failures**
      (`locks` 36 -> 37, `binarypc` 24).
- [x] **Round 14 — data-aware (PCA-aligned) LSH hyperplanes, wired and measured.**
      New `alignedHashTables` in `binarypc.js` (the oversubscribed-budget variant:
      `rank = min(bits, dim, nrows-1, maxRank)` aligned directions + random unit
      surplus) plus `_refreshLshHyperplanes` in the locked `lsh` bag, behind the
      default-off `_pcaHashConfig` (mirroring `_multiProbeConfig`; `golden.test.js`
      stays 23/0 because the flag is null, i.e. the disabled branch never runs).
      `binarypc.test.js` gained section G (7 checks: identity with `pcaHashTables`
      when `bits <= dim`, oversubscribed shape/orthonormality, `maxRank` cap,
      rank-deficiency cap, degenerate-input throws) and `lsh.test.js` gained
      section I (14 checks: the off-state no-op, a full sweep, bucket-index
      integrity after the rebuild, unit-norm hyperplanes, seeded determinism, and
      the `minRows` fallback). **Measured on a real 107-bit / lowDim-71 index**
      with a planted anisotropic bank (paired, 200 queries, margin multi-probe on):
      aligned hyperplanes raise self-recall under noise from **0.68 → 0.775** at
      σ=0.25 and **0.01 → 0.04** at σ=0.5, lift the prefix probe **0.315 → 0.395**,
      and never lose at σ=0.1 (1.0) — **but aligning every direction is a no-gain
      config (0.655, below random)** because it dedicates bits to the low-variance
      noise tail. The optimum is a broad plateau near `dim/4`, which the wiring
      uses as its default. Grounding: `lsh-ann.md`; BinaryPC 2608.04405; the
      data-dependent-hashing optimality of Andoni–Indyk–Laarhoven 1501.01062;
      Density Sensitive Hashing 1205.2930; weighted Hamming 2009.08591. Suite
      **1464 -> 1492, 0 failures** (`lsh` 33 -> 54, `binarypc` 24 -> 31).
- [x] **Round 15 — bit-reliability theory + data-driven aligned rank.** New pure
      module `src/hivemind/memory/bitweight.js` + `bitweight.test.js` (44 checks):
      the exact per-bit flip law `P = arccos(sqrt(lambda/(lambda+sigma^2)))/pi`
      (Charikar's `theta/pi` with `theta` the signal/noise angle), its
      binary-symmetric-channel reading (`reliabilityWeight = 1 - 2P`,
      `bitInformation = 1 - H2(P)`), the margin law
      `flipProbabilityFromMargin = Phi(-|margin|/sigma)` (which proves ascending
      margin order IS flip-probability order, i.e. Lv's multi-probe is optimal),
      the spectral noise estimator, `selectReliableRank`, `reliabilityWeights` and
      the weighted-Hamming metric. Validated against Monte Carlo (max deviation
      0.00055 over 2e5 draws) and against a **real PCA-aligned index** (the law
      predicts the measured flip rate to within 0.012). `binarypc.js` gained
      `tableVariances` (exact per-direction data variance) and an opt-in
      `rankPolicy` (`above-mean` | `noise`), wired through
      `_pcaHashConfig.rankPolicy`; `_lshAlignedRank` records the chosen rank. On
      the real 107-bit / lowDim-71 index the `above-mean` policy reads ranks
      **22-23** off the spectrum (not the `dim/4` constant) and reaches **0.75**
      self-recall at sigma=0.25 vs **0.68** random and **0.655** full alignment.
      `binarypc` 31 -> 39, `lsh` 54 -> 59, `locks` 37 -> 38. **Recorded negative
      result** (bitweight.test.js section I): reliability-weighted *candidate
      ranking* does not beat plain Hamming on the rotation-based index, because
      the rotation already equalises per-direction variance and the pool is
      re-scored by the exact projection cosine downstream — so it is deliberately
      left unwired. Grounding: `lsh-ann.md`; Charikar 2002; Lv 2007; Cover &
      Thomas 2006; weighted Hamming 2009.08591; Density Sensitive Hashing
      1205.2930; NeuRoute 2608.15438.
- [x] **Round 16 — query-adaptive probe budget.** `memory/bitweight.js` gained the
      budget primitives: `bitFlipProbabilities`, the exact Poisson-binomial
      `poissonBinomialPmf`/`poissonBinomialQuantile`, `expectedFlippedBits`, the
      monotone containment coverage (`marginContainmentCoverage`,
      `marginContainmentDepth`), the exact recovery coverage
      `probeRecoveryCoverage` (containment factor x P(inside count <= maxFlips),
      no union bound), the single-pass O(n^2) `recoveryDepth` (proven equal to a
      brute-force forward scan over 120 random spectra) and
      `calibrateNoiseFromFlips`. `memory/multiprobe.js` gained the off-by-default
      `adaptiveMultiProbeConfig`/`adaptiveSingleBitBudget`/`adaptiveSingleBitKeys`:
      per query, `maxFlips` = the Poisson-binomial quantile of the flip count and
      `depth` = the smallest number of smallest-margin bits whose EXHAUSTIVE
      subset enumeration reaches the requested recovery coverage, capped so the
      subset count fits `budgetCap` (`rankPerturbations` gained the `exhaustive`
      mode). Idempotent, byte-identical when off. `bitweight` 44 -> 69,
      `multiprobe` 52 -> 77 (total 1550 -> 1600). Measured on the real 107-bit
      index with sigma calibrated from the measured Hamming distance: the adaptive
      budget dominates the prefix-4 probe at every noise level, needs no probes
      for many queries at low noise (below the fixed budget of 8) and beats the
      fixed 8-probe budget at high noise. **Caveat recorded**: at low noise a
      broad fixed budget can out-recall the adaptive depth (it enumerates more
      multi-bit subsets than the query needs). Grounding: `lsh-ann.md`; NeuRoute
      2608.15438; adaptive bucket probing 2604.04603.
- [x] **Round 17 — dynamic query modification (the query-side recall fix).**
      New pure module `src/hivemind/memory/querymod.js` + `querymod.test.js`
      (51 checks): the l2-normalised centroid `<c>` of the neighbours found so
      far, with the four results the paper is built on proved exactly —
      **Theorem 1** (`<c>` maximises `Σ x·u`; `Σ(<c>·x) = ‖Σx‖ = k‖mean‖`
      exactly), **Theorem 2** (first-order ACP `½ + Σ x·u/(kπ)` maximised at
      `<c>`, which also beats the average random direction on the exact Charikar
      ACP), **Appendix C.1** (`averageCovariance = const − ((Σ x·u)/k)²`,
      minimised at `±<c>`), and **Section 6.4** (the centroid collides with a
      member on EVERY direction — 0 failures in 200 — while a raw query can
      collide with none; exact singleton witness `q = −x` fails 200/200).
      Charikar's law matched by 4e4 random hyperplanes to <0.01; the **denoising
      law** (the 40-view centroid at σ=0.3 cuts the per-bit error rate
      several-fold); and the **synthetic regime sweep** — query modification
      strictly raises pool recall while the hash is informative (6..12 bits, e.g.
      `0.540 → 0.789` at 6 bits) with the gain decaying monotonically to `0.001`
      at 24 bits. Wired into the locked `_getGlobalLSHCandidates` behind the
      default-off `_queryModConfig`; `lsh.test.js` section J proves the pool is
      mechanically a SUPERSET (recall can never fall), the branch is **live** on
      the narrow `forceMin` 6-bit index (pool grows for most queries) but a
      **measured no-op** on the production 107-bit index (`differ = 0` — the
      empty-consensus-bucket regime: buckets hold ~0.1–1 protos, so each set's
      found set is empty or a single already-probed candidate). `locks` gained
      the `querymod.js` registry entry. `querymod` 51, `lsh` 59 -> 69, `locks`
      38 -> 39 (total 1600 -> 1662), 0 failures. Grounding: `lsh-ann.md`;
      arXiv 2605.23807; Charikar 2002; Lv 2007; DensHash 1205.2930.
- [x] **Consolidation cycle — freeze the core design.** No new subsystems. Added
      [`DESIGN.md`](DESIGN.md) (the frozen core: the pipeline, the locked systems
      with their registry statuses, the six default-off features, the out-of-scope
      list, and the definition of done), [`RUNBOOK.md`](RUNBOOK.md) (requirements,
      install, commands, the `CONFIG` knobs, how to enable each default-off flag,
      and the expected test ledger), and a **prioritized backlog** (P0 local run,
      P1 feature-universe growth, P2 deferred leads) at the top of this file.
      `locks.test.js` now also asserts the two frozen-design docs exist
      (39 -> 41); total 1662 -> 1664, all green (browser harness: 27 entries, 0
      failures). Research consolidated under a scope-freeze banner (leads are a
      catalogue, not a schedule) with the Round-17 sweep snapshot
      (`raw/arxiv-sweep-2026-09n.json`). **Next gate: `npm test` locally.**
- [x] **Local-run follow-up — the `npm test` entry point was Node-version
      incompatible (`BUGS.md` #14).** The first local run (`npm install` clean,
      0 vulnerabilities; Node **v25.9.0**) died with
      `Error: Cannot find module '.../test/node'` and `tests 1 / fail 1`, i.e.
      before executing a single test file. Cause: the script was
      `node --test test/node/` — a bare *directory* argument, which Node ≤ 21
      accepted (and searched recursively) but Node ≥ 22 resolves as a **glob**
      and then hands to the module loader. Fixed to
      `node --test "test/node/*.test.js"`; minimum Node is now **22**
      (`RUNBOOK.md` §1/§3/§7, `README.md` § Tests). The focused scripts
      (`test:locks`, `test:candles`, `test:analysis`) pass file paths, which are
      valid globs in both regimes and were never broken. **Next gate: re-run
      `npm test` locally.**
- [x] **Local-run follow-up 2 — the first real `npm test` run (25 mirror files,
      82 `test()` blocks: 76 pass / 6 fail) exposed three *mirror-harness*
      defects, none in `src/` (`BUGS.md` #15).** (1) `test/node/legion.test.js`
      imported `'../src/legion/*.js'` from `test/node/` — one level short, so all
      four of its tests died with `ERR_MODULE_NOT_FOUND .../test/src/legion/...`;
      now `'../../src/legion/*.js'`. (2) The mirrors injected
      `stateDir: (label) => tempStateDir(label)`, which mints a NEW directory per
      *call*, while every entry treats the label as a pure path
      (`state/<suite>-<label>`) and saves+reloads through the same label — so the
      LSH suite's round-trip check reloaded an empty database
      (`roundTrip=false reloadRefsOk=false protos=0/200`, `1/69` checks). Fixed
      with the memoised `labelledStateDir` in `test/node/helpers.js`, used by all
      seven `stateDir` mirrors (the other six were latent). Reproduced and fixed
      in the browser harness: per-call dirs `144/0`, memoised `144/144`.
      (3) `test/browser/entries/multisymbol.test.js` statically imported the
      sql.js shim, dragging its `https://cdn.jsdelivr.net/...` module into Node
      (`ERR_UNSUPPORTED_ESM_URL_SCHEME`); now loaded lazily behind
      `{ ensureSql }`. Everything that ran on native SQLite passed — `sanity`
      (9 blocks incl. persistence + determinism), `dimensions` (185),
      `multiprobe` (77), `analysis` (354), `candles` (95), `indicators` (75),
      `bitweight` (69), `walkforward` (31 on shipped candles).
- [x] **Local-run follow-up 3 — closed the coverage gaps that audit found
      (`BUGS.md` #16).** (a) `golden` had **no node mirror**, so the bit-exactness
      lock — and therefore every `BIT_EXACT` status in the registry — had only
      ever been verified through the sql.js shim. The entry is now injectable
      (`{ ensureSql, stateDir }`, lazily-imported shim, default
      `state/golden-<label>` paths preserved byte-for-byte; re-verified 23/23 with
      all 11 hashes unchanged) and `test/node/golden.test.js` runs those
      fingerprints on the **real** driver. Justification that this must reproduce
      them: the prototype loader is fully `ORDER BY`+indexed
      (`persistence/load.js`), matrices/stats are raw byte-exact float32/64 BLOBs,
      and `diagnostics()` carries no path/clock/driver-derived field (verified by
      re-running with an **injected different state dir**: hashes unchanged).
      (b) The wrap-style mirrors' count floors were loose by up to 12×
      (`analysis` asserted `>= 30` for 354 checks, `modules` asserted `> 0` for
      50), so a section returning early (e.g. a *passing* "no reader" skip branch)
      could drop hundreds of checks while `failed === 0` held; all 17 floors now
      assert their `RUNBOOK.md` §6 ledger count. (c) New Node-only
      `test/node/mirrors.test.js` pins the layout: every pass/fail browser entry
      has a node mirror (the gap that allowed (a)), no orphans, and the `test`
      script passes a `*.test.js` glob rather than a directory (the #14
      regression). `npm test` is now **27 mirror files / 86 `test()` blocks**.
      **Next gate: re-run `npm test` locally, then P0 item 2.**
- [x] **Local-run follow-up 4 — the second local run (86 tests: 85 pass / 1 fail)
      was the golden mirror, and the cause was engine-sensitivity rather than
      driver-dependence (`BUGS.md` #17).** The failure was `1/23 golden checks`,
      `hm:predictions`, `expected a2ce390b, got c0d32aad (len 176)`; all ten other
      fingerprints (including the five controller hashes and the post-reload
      prediction) matched bit-for-bit, with an identical payload length. The
      golden workload does no DB work until its final `dumpState()`, so the
      divergence is pure JS: `hm:predictions` was the **only** fingerprint
      hashing raw, unrounded float64 `predict()` output, while every other one is
      a count, a float32-quantised value, or a rounded output. Reproduced in the
      browser harness by bumping every `Math.exp` result by exactly +1 ulp: only
      `hm:predictions` moved, everything else held — the same signature. Fix:
      that one fingerprint is now hashed at 6 significant digits
      (`Number(p.toPrecision(6))`; ~1e-16 measured engine noise vs a 1e-6
      resolution), `EXPECTED['hm:predictions']` re-frozen once
      `a2ce390b -> b6ca75d6`, and `run()` still returns the **raw** array for
      debugging. Institutionalised as Node-only
      `test/node/engine_portability.test.js`: it runs the golden entry **once**
      with a systematic +1-ulp `Math.exp` drift in force and asserts all 23
      checks still pass (pre-fix this exact setup failed 1/23), then shows
      directly that a 1-ulp move in the returned raw predictions changes the
      *raw* fingerprint but not the rounded one. `npm test` is now
      **28 mirror files / 89 `test()` blocks**; browser side unchanged (1664
      checks, 23/23 golden, same 11 hashes except the deliberately re-frozen
      rounded one). **Next gate: re-run `npm test` locally, then P0 item 2.**
## Next (additive supercharges, each needs proof before promotion)

> **Historical detail log.** The *prioritized* view is "Scope freeze + prioritized
> backlog" at the top. Items here that are struck through are DONE; the open ones
> are folded into P0/P1 above. No new subsystem is scheduled.
>
> **Round 23 supersedes the "promote the default-off features" framing below**
> (`ROADMAP.md` N0-N3): the A/B driver exists, but it evaluates a **bare
> `HiveMind`** on a 6-element return vector, so it cannot yet decide anything
> about the shipped controller. Fix fidelity first (N0), then the real signal
> family (N1), then power (N2), then run and record the verdict (N3).

1. **Promote the default-off features using the harness.** The
   walk-forward harness above is done (engine + no-lookahead audit + promotion
   gate + a real-candle runner) and the driver is `npm run analyze`. **Caveat
   (round 23, N0):** the driver's model is a bare `HiveMind` on a synthetic
   6-element return vector — not the shipped `HiveMindController` on its 10 real
   indicator series — so its verdicts are a proxy until N0 lands. Once N0 does,
   evaluate the surprise gate, sample-uniqueness weights, homeostasis and
   multi-probe each as a *candidate* against their off-by-default *baseline* on
   the shipped candles, and flip on by default any that `promoteDecision`
   accepts (re-freezing `hm:broadcast` where the hot path changes). Grounding:
   `financial-validation.md`, `memory-retrieval.md`, `continual-learning.md`,
   `ensemble-evolution.md`, `lsh-ann.md`.

2. **PCA-aligned LSH hyperplanes** (arXiv 2608.04405) and **dynamic query
   modification** (arXiv 2605.23807). The recall-preservation prerequisite is
   already done (`lsh.test.js`), and so is the **margin-ordered multi-probe
   engine** (Round 2: `memory/multiprobe.js` + `multiprobe.test.js` (77 checks),
   which proves the flip lemma and a 0.03 → 0.30 self-recall gain on a real
   107-bit index at σ=0.25). The **flag-gated wiring** of
   `multiprobe.js` into `_getGlobalLSHCandidates` is **DONE** (default-off
   `_multiProbeConfig`; `golden.test.js` proves the off-state no-op and section F of
   `multiprobe.test.js` measures 0.167 → 0.517 self-recall at σ=0.25 with the flag
   on). The PCA-aligned side is now **built, proven AND wired** (Round 14:
   `memory/binarypc.js` `alignedHashTables` + the default-off `_pcaHashConfig`
   driving `lsh.js#_refreshLshHyperplanes`; `lsh.test.js` section I measures
   0.68 → 0.775 self-recall at σ=0.25 on a real 107-bit index with multi-probe on,
   and pins the noise-tail caveat — full-rank alignment is a no-gain config).
   The query-side companion — **dynamic query modification** (2605.23807) — is
   now **built, proved AND wired** (Round 17: `memory/querymod.js` +
   `querymod.test.js` (51 checks) and `lsh.test.js` section J; default-off
   `_queryModConfig`, with the honest measured negative that it is a no-op at
   the production 107-bit width and live at narrow widths). **What remains** is
   (b) an intentional
   re-freeze of `hm:broadcast` to switch `_multiProbeConfig` and/or
   `_pcaHashConfig` on by default, measured by the walk-forward harness. A new
   research lead from the Round-14 sweep was to **weight or drop the low-variance
   tail bits** — **DONE** (Round 15): the exact flip law and BSC weight live in
   `src/hivemind/memory/bitweight.js` (69 checks), the data-driven `above-mean`
   rank policy replaces the `dim/4` constant, and the reliability-weighted
   candidate ranking is a recorded **negative** result (the rotation already
   equalises per-direction variance, so weighting the code does not beat plain
   Hamming; the pool is re-scored by the projection cosine anyway). The remaining
   reliability lead is the **query-side** adaptive/uncertainty-weighted probe
   budget (NeuRoute 2608.15438 prioritises the query's least-certain bits) — **DONE**
   (Round 16): `adaptiveMultiProbeConfig` (off by default) derives the probe depth
   per query from the exact recovery coverage `[∏_{b∉top-depth}(1−q_b)]·P(K_inside
   ≤ maxFlips)`, enumerates that depth exhaustively so the guarantee is exact, and
   records the measured real-index result (no probes for many confident queries at
   low noise; beats a fixed budget under noise). Grounding: `lsh-ann.md`, section G
   of `multiprobe.test.js`, section J of `bitweight.test.js`.
   Grounding: `lsh-ann.md`.
3. ~~**Low-rank ES mutation layer** (arXiv 2609.10980) behind a flag.~~
   **DONE** (Round 2) — see the in-progress list above. `src/legion/evolve.js` +
   `evolve.test.js` (36 checks) prove the exact quadratic identity, the
   positive-semi-definite descent-direction guarantee, and monotone fitness on a
   toy convex objective (full-rank and low-rank). Still to do before it is allowed
   near the trainers: a monotone-fitness demonstration on a member's real training
   objective (not just a quadratic), and a flag-gated A/B showing it does not
   regress the locked trajectory. Grounding: `ensemble-evolution.md`.
4. ~~**Surprise-gated memory writes** (Titans).~~ **DONE** (Round 2) — see the
   in-progress list above. `src/hivemind/memory/surprise.js` + `surprise.test.js`
   (32 checks) prove the gate is an exact no-op at `floor=1` and multiplies the
   semantic write by `surpriseGate(1 - bestSim)` when enabled. Still to do before
   promotion to on-by-default: a walk-forward backtest showing the gated write
   policy improves PSR/DSR versus the ungated baseline on the shipped candles.
   Grounding: `memory-retrieval.md`.
5. ~~**Sample-uniqueness-weighted training.**~~ **DONE** (Round 2) — see the
   in-progress list above. `src/hivemind/training/sample_weights.js` +
   `sample_weights.test.js` (36 checks) prove exact weights on fixed
   label-interval sets, and `train(..., w)` is exactly linear in `w`. The
   controller bridge (`_sampleWeightsForBatch`) ships off by default. Still to do
   before promotion to on-by-default: a walk-forward run showing which
   normalisation/floor improves PSR/DSR vs the unweighted baseline on the
   shipped candles. Grounding: `financial-validation.md`.
6. ~~**Homeostatic plasticity controller** (arXiv 2609.13771).~~ **DONE**
   (Round 2) — see the in-progress list above.
   `src/hivemind/ensemble/homeostasis.js` + `homeostasis.test.js` (30 checks)
   prove the multiplier is bounded/monotone with an exact set-point fixed point,
   and that the closed loop converges to `target/k` across a `k`-sweep with the
   set-point error strictly decreasing. It wraps the existing rank-based
   `_updateAdaptiveLearningRates` and ships off by default
   (`_homeostasisEnabled = false`). Still to do before promotion to on-by-default:
   a fixed-workload A/B showing the homeostatic controller improves composite
   accuracy / PSR versus the rank-only rule (the same walk-forward harness item 1
   needs). Grounding: `continual-learning.md`.
7. ~~**Variance-consistent resampling for the RC/SPA/StepM bootstrap.**~~
   **DONE** (Round 7 / section X) — see the in-progress list above.
   `subsamplingSpa`/`subsamplingStepM` + `neweyWestSE` replace the low-biased
   block bootstrap’s studentization with overlapping-window subsampling that
   shares ONE bandwidth across the window and full scales; the 5% size is nominal
   at every persistence (0.0433 at phi=0.8 vs the block bootstrap’s 0.4067) with
   power 0.72-0.80. Grounding: `financial-validation.md`; Politis & Romano (1994),
   Politis, Romano & Wolf (1999).
8. ~~**Wire the variance-consistent p-values into the reporting battery and the
   walk-forward promotion gate.**~~ **DONE** (Round 8 / sections Y + H) — see the
   in-progress list above. `reality_check.js`'s `subsamplingSpa`/`subsamplingStepM`
   gained an opt-in `groups` (segment lengths tiling `T`) so the long-run variance
   is estimated *within* a segment — the mean-shift case of arXiv 2603.17226 —
   with `groups=[T]` bit-identical to the ungrouped path; `walkforward.js` gained
   `familywiseSearch` (whole-family SPA + StepM over the pooled out-of-sample
   returns) and `walkForwardSearch` (mapping back to candidate labels, using each
   fold's length as a segment and trimming its no-exposure first bar);
   `promoteDecision` gained the opt-in `maxSearchP`/`requireSearchReject` hurdles
   and `formatReport` appends one search line. On the real-candle walk-forward
   (live HiveMind, 3 folds, family `[baseline, surprise, homeostasis, multiprobe,
   oracle(ctrl)]`) the DSR floor and the family-wise StepM **agree on all five
   candidates** (`dsrPromotes = fwRejects = [false, false, false, true]`, step
   p-values `[1, 1, 0.333, 1, 0]`): neither promotes a real feature, both catch the
   injected oracle. New checks: `analysis.test.js` section Y (25) and
   `walkforward.test.js` section H (5); suite now **1381**. Grounding:
   `financial-validation.md`; Romano & Wolf (2005); arXiv 2603.17226.
9. ~~**Grow the candidate universe on the family-wise path.**~~ **DONE** (Round 9
   / section Z) — see the in-progress list above. `reality_check.js` gained the
   generalised error rates on the same deterministic subsampling-window grid:
   **`subsamplingKfwer`** (single-step k-FWER, Romano & Wolf 2007, arXiv
   0710.2258) rejects candidate `i` iff its k-th-largest window statistic
   `p_i^(k) <= alpha`, reference kept over the FULL family, so
   `P(k or more false rejections) <= alpha`; **`subsamplingFdp`** is the
   corrected Romano–Wolf / Delattre–Roquain step-down (arXiv 1311.4030 §1.3/§1.5)
   with the growing reference `k_l = min(floor(fdpTarget·l)+1, K)` and
   `estimatedFdp = (kHat-1)/nRejected`. The private `subsamplingReference` helper
   now backs `subsamplingStepM` (still max-t / `k=1` only) with **bit-identical**
   arithmetic, so every golden fingerprint and section-X/Y pin is unchanged.
   New pinned calibration (deterministic, given seeds): global null, K=4, 200
   reps, T=200 → FWER(k=1) **0.07**, 2-FWER(k=2) **0.075**, and the FDP
   estimator rejects nothing beyond the first step in ~95% of reps; T=80 →
   **0.04** / **0.055**. `familywiseSearch`/`walkForwardSearch` take opt-in
   `kfwer`/`fdpTarget` (default-off → byte-identical report), and
   `promoteDecision` keeps its additive `maxFdp` hurdle. New checks: section Z
   (33); suite now **1414**. **Honest negative result (recorded in the module):**
   the "k-th largest of the surviving set at each step" generalisation was
   measured to *worsen* with data (2-FWER **0.085** at T=80, **0.145** at T=200)
   and is documented as REJECTED — the reference must stay full-family with `k`
   growing only with the step index. Grounding: `financial-validation.md`;
   Romano & Wolf (2007); Delattre & Roquain (2014).
10. ~~**Sustained power on the family-wise path.**~~ **DONE** (Round 10 / section
   AA + Round 11 / section I) — see the in-progress list above. The *synthetic*
   power/FDP question is answered by section AA (k=2 k-FWER strictly more powerful
   than k=1, 0.155 -> 0.4975; the FDP step-down gains power with its target while
   its realised FDP is below target there — and over-runs a tight target on sparse
   families, which is *why* it stays EXPERIMENTAL). The *real-candle* grid is
   widened by section I: the same family-wise gate runs over 48 windows instead of
   18 on the full 150-bar / 6-fold slice, with an unchanged verdict (oracle caught,
   no real feature promoted, DSR and family-wise agree). **Still open** (a new item
   11 below): growing the *feature universe* K on the family-wise path and
   comparing the FDP relaxation against the strict FWER step-down on
   promoted-effect recovery. Grounding: `financial-validation.md`; `docs/research/
   raw/arxiv-sweep-2026-09i.json`.
11. [x] **Grow the feature universe K on the family-wise path.** Sections Y/H/I run
   the gate over K=4 real features; section AA exercises K=20 only on *synthetic*
   mixtures. Next: define a genuinely larger real feature family (more
   causal signals from the controller — e.g. fractionally-differenced momentum,
   volatility regime, volume/turnover — each as a walk-forward candidate), run the
   family-wise gate plus the k-FWER/FDP relaxations over it, and compare the FDP
   relaxation against the strict FWER step-down on promoted-effect recovery.
   Grounding: `arxiv-sweep-2026-09i.json` — 2601.10279 (stepwise asset-pricing
   model selection), 2303.07631 (multiple testing under a high-dimensional dynamic
   factor model), 1901.04885 (FDP admissibility).

## Local run (`npm test`) — DONE

The browser suite runs headless via esbuild-wasm + sql.js shims; the Node suite
uses real `better-sqlite3` and real `worker_threads`. The local gate has run and
is **green: 115 tests, 115 pass, 0 fail at round 22** (`docs/BUGS.md` #20/#21;
89/89 at round 21, #18), including the full `test/node/*.test.js` mirror set and
the P0-P3 tooling suites. On that basis:

- `controllerDatabase`, `controllerAccuracy`, `controllerTrade` were promoted
  `NEEDS-LOCAL-RUN → LOCKED-invariant` and recorded in `docs/LOCKED.md`.
- The registry now has **0 `NEEDS-LOCAL-RUN`** and **0 `EXPERIMENTAL`** entries.

Re-run `npm test` locally after any change to the hot path, the mirrors, or the
lock registry.

## Known limits that are deliberately not "fixed"

See `docs/BUGS.md`. The main ones: SQLite is not bit-idempotent (float32 blobs +
derived state recompute), `_computeVariance` is an MAD proxy, `_computePercentile`
maps 0→1.0, and `_isStagnating` is trigger-happy. The `forceMin=false` dimension
branch is no longer on this list — it is now audited by `dimensions.test.js`
(185 checks, no defect found), so flipping `CONFIG.forceMin` is a deliberate
re-freeze between two tested branches rather than a blind change. Each remaining
item is pinned by the golden fingerprints; changing one is a deliberate re-freeze,
not a bug fix.
