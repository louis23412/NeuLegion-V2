# RUN-ANALYSIS.md — A/B (`npm run analyze`) run log, forensics and the plan

This file is the **analysis log for `npm run analyze` runs**: what a run's artifact
directory actually contains, what it proves, what it does not, and what the next
run must do differently. `OPTIMIZATION.md` holds the *decision* (promote/reject)
for each candidate; this file holds the *evidence and the plan* that leads to it.

It is written so a future session can pick the work up cold: every claim below
cites a file, a line, or a measured number from an artifact.

**Current verdict: §10** — run `20260922T204248-seed1` (the round-26 corrected power
run, 2026-09-22, seed 1; the same design as §5): complete, 14 candidates `keep-off`,
nothing promotes at any cost level, the baseline is a *trained* model with negative
skill (§10.4), and three of the seven mechanism candidates turn out to be inert
duplicates of the baseline (§10.7, `BUGS.md` #43/#44). The decision record is in
[`OPTIMIZATION.md`](OPTIMIZATION.md).

> **READ §8, THEN §10.** The `20260921T062511-seed1` run (§7) is the first run sized
> by the round-25 machinery, and §8 shows why its `baseline` row is **not** the
> shipped model: `npm run analyze` fed the controller the whole growing candle prefix
> where production feeds it a fixed `cacheSize` window, so the controller's trade
> bookkeeping saw ancient bars and its training labels were systematically wrong
> (`BUGS.md` #33, measured: 78/144 wins in the A/B vs 156/64 with the production
> window). **The same defect invalidates §5's baseline and mechanism rows** (its
> `+0.4387` baseline and the `query-mod` DSR-0.9992 row), and §5 now carries a
> correction banner. §10 is the corrected re-run of §5's design: the fix moved every
> mechanism row as predicted and left every pure-signal row unchanged. §7's verdict
> stands for the signal family; its "the baseline is a no-op" reading did not.

---

## 1. Run `20260920T012907-seed1` — attempt 1: INTERRUPTED, no verdict

### 1.1 What the run was

`run.json` (the only top-level file in the uploaded directory) records exactly the
configuration round 23 intends:

| field | value |
| --- | --- |
| `type` | `analyze` |
| `model` | `controller` (i.e. `HiveMindController`, the shipped model) |
| `files` | 8 candle streams: `src/candles.jsonl` (BTCUSDT) + the 7 `src/data/candles_*_1h.jsonl` symbols |
| `candles` / `streams` | 4,800 / 8 (i.e. `--bars=600` over `--symbols=all`) |
| `folds` | 288 (36 walk-forward folds per stream: train 60, test 15) |
| `trainSize` / `testSize` / `maxBars` | 60 / 15 / 600 |
| `probe` / `auditProbesPerFold` | 0.05 / 2 |
| `positionPolicy` | `{ deadZone: 0.05, scale: 1 }` |
| `variants` | all 15 ids (7 mechanism flags incl. `sample-weights`, + 8 signal candidates) |
| `seed` / `node` | 1 / `v25.9.0` |

So the manifest is **exactly** what `runAnalysis` (`src/analyze.js:556-583`) writes
for the documented power run. Nothing was misconfigured; the driver produced the
intended world, the intended candidate family, and the intended policy.

### 1.2 What the directory *does not* contain (the headline)

`runAnalysis` writes the run directory as
`<stateFolder>/runs/<runId>/{run.json, report.json, run.log, models/}`
(`src/observer/report.js:4-8`; `appendLog` at `:76`, `writeReport` at `:87`).

Uploaded directory contents, counted from the workspace:

```
run.json                     1 file    1,511 B
models/                  3,725 files  1,381,600,976 B   (1.287 GiB) in 1,862 fit dirs
models/*.dbwal               1 file    4,161,232 B       (last fit only)
models/*.dbshm               1 file       32,768 B       (last fit only)
report.json                  MISSING
run.log                      MISSING
```

`report.json` and `run.log` are written **only after every variant has been
evaluated** (`src/analyze.js:648-649`). They do not exist, so the run never
reached its end and **there is no verdict in this artifact**. The `run.json`
alongside a partial `models/` is the signature of an interrupted run, not of a
complete one.

### 1.3 Forensics: exactly how far it got, and how it died

The model-state directory is the run's progress log, because the factory names each
fit dir `${variant.id}-${fitCounter++}` with **one shared counter** across the whole
run (`src/analyze.js:238` for the bare factory, `:452` for the controller one):

* `baseline` owns fits `0 … 1151` — **complete**: 1,152 dirs = 8 streams × 36
  folds × 4 passes. No gaps in the index range.
* `surprise` owns fits `1152 … 1861` — **stopped at 710 of 1,152** (61.6 %), with
  no gaps: streams 0-3 complete (4 × 144 = 576), stream 4 at 134 dirs = all 36
  scored passes + 32 complete audit groups (32 × 3 = 96) + the first 2 passes of
  the 33rd group. So the interruption landed inside fold 32's audit, after its
  base pass and first probe.
* No other variant exists. The run therefore evaluated **1,862 of the ~17,280**
  fits a full 15-variant run needs (10.8 %), and died inside the *second*
  candidate.

`models/surprise-1861/` (the last fit) is the only dir carrying a
`hivemind_controller-positive-AN-surprise.dbwal` (+ `.dbshm`) — an
**uncheckpointed WAL** on the final connection. Every other dir was checkpointed
and its sidecars removed (better-sqlite3 removes them when the handle is finalized
at GC). The final handle was never closed: the process ended abruptly, which is
consistent with the machine crash and is why the end-of-run artifacts are absent.

### 1.4 The 4-fits-per-fold structure (and what it proves about the audit)

Per fold the driver performs **four** fits — this is derived from the artifact and
confirmed in code:

| pass | source | dirs per stream |
| --- | --- | --- |
| scored pass (walk-forward) | `purgedCVBacktest` via `walkForwardEvaluate` | 36 (`idx % 144 < 36`) |
| audit *base* pass | `auditNoLookahead` (`src/analysis/walkforward.js:189`) | 36 |
| 2 audit *probe* passes | `auditProbesPerFold=2` → stride `ceil(15/2)=8` → `t = test[0], test[8]` | 72 |

Two findings, both measured on the artifact rather than argued:

1. **The audit base pass is bit-identical to the scored pass on 464/464
   fold-passes** (288 `baseline` + 176 `surprise` — every fold whose three-dir
   audit group is complete). Comparing `global_stats` (`training_steps`,
   `real_points`, `memories_sent`, `trade_wins`, `trade_losses`) of the base dir
   against the scored dir for every (stream, fold) gives **zero** differences.
   That is a real-data determinism certificate for the controller-backed factory
   (same seed + same view ⇒ same model), and it proves the audit audits *the same
   model whose metrics are reported* — which is what makes a `clean` audit
   meaningful.
2. **The probe passes changed the model's end state in only 49 of those 464
   fold-passes** (415 identical to base; `baseline` 31/288, `surprise` 18/176).
   The shock *does* reach the model: the probe dirs'
   `candles` table contains the shocked closes (verified directly on fold 0 —
   probe1 equals base through bar `60` and diverges from `61` onward, probe2
   equals base through `68` and diverges from `69`, exactly the two probe points
   `test[0]` and `test[8]`, matching `shockFactor`). So the perturbation lands on
   the input, yet the model's decision stream usually does not move.
   `auditNoLookahead` only *enforces* behavioural reach when `requireReachable` is
   set, and `runAnalysis`/`evaluateAB` leave it **false**; the report additionally
   records only `audit.clean`, never `reachable`/`probes`/`vacuous`
   (`src/analyze.js:626`, `:638`). The round-23 audit is therefore **structural**
   (views differ ⇒ not vacuous) but not **behavioural**. Turn it on and record it
   (plan P1.1).

### 1.5 Mechanism liveness from the data we do have (baseline vs surprise)

The 4 complete streams + the partial 5th give **180 scored-pass pairs**
(`baseline-k` ↔ `surprise-(1152+k)`, k in the baseline's scored-pass indices). On
those pairs, from each fit's own `global_stats`:

| quantity | paired result (surprise − baseline) |
| --- | --- |
| `training_steps` | **0 on all 180** (identical) |
| `memories_sent` | mean −0.02, sd 0.32 (i.e. unchanged) |
| `real_points` | mean **−87.5 pts**, sd 1,132, se 84.4 (t ≈ −1.04) |
| fold sign | **84 better / 96 worse, 0 ties** |

Read carefully: `real_points` is the **controller's own closed-trade P&L**, *not*
the A/B's position-stream return (which the report would have pooled). It is a
proxy. What it shows is that the surprise gate is **live** — it changes the
controller's realised outcome on 180/180 folds, with no ties — while its **sign is
a coin flip** (84/96, binomial p ≈ 0.4) and its magnitude is inside noise. It
changes memory *content* (identical training steps and memory counts), not volume.
That is consistent with the suite's "live but not obviously helpful" reading, and
it is *not* a verdict — the pooled Sharpe/DSR/SPA numbers never got computed.

Data hygiene across all 1,862 fits: **`quarantined_rows = 0` everywhere**;
`skipped_duplicate` 3 (baseline) vs 4 (surprise).

### 1.6 Cost and footprint (this is a blocker, not a footnote)

* **State**: 1,381,600,976 B for 1,862 fits = **0.708 MiB per fit**. A full
  15-variant × 1,152-fit run is **~17,280 fits ⇒ ~11.9 GiB** of per-fit SQLite
  state under `state/runs/<runId>/models/`.
* `analyze.js` **never reclaims or prunes** it: grep finds no `rmSync`/`unlink`/
  `pruneRunDirectories` in `src/analyze.js`. `pruneRunDirectories`
  (`src/observer/report.js:32`) is called only by `src/mainController.js`, so an
  `analyze` run accumulates every fit it ever makes, and 20 retained run dirs
  (`CONFIG` retention) can mean hundreds of GiB.
* **Time**: `OPTIMIZATION.md` (round 23) measured ~43 ms per `getSignal` on the
  sql.js shim. Per variant the driver makes ~4 passes × 288 folds × (train-until-
  `testStart` + 15 predictions) ≈ 388k `getSignal` calls, so the power run is a
  **multi-hour (order 10 h) job** on the real driver, and 4/5 of that compute is
  the audit (3 of the 4 passes). The cost model in §4 sizes the levers.
* **Upload**: the platform quota is ~1.5 GB/day, so uploading a run *directory* is
  neither possible nor necessary — `run.json` + `report.json` + `run.log` are a
  few hundred KB.

### 1.7 Method warning: the browser harness is not a faithful repeated-fit oracle

Verified in the browser harness (temporary probe entry, since deleted; the suite
still has exactly 30 entries) by fitting *the same fold of the same stream* several
times in one process:

* the **first** (cold) fit reproduced the artifact's `baseline-0` counts exactly
  (`training_steps 45`, `total_trades 43`) but not its `real_points` (2077.17 vs
  2115.838 — the workspace candle copy may predate a local `fetch:update`);
* every **subsequent** identical fit returned `training_steps 10` with **all-zero
  positions** (an untrained/abstaining controller).

So in the harness, repeated controller fits are *order-dependent*; on the user's
Node driver they are **not** (464/464 base == scored, §1.4). Conclusions:

1. Do not verify controller-backed A/B numbers by repeating fits in the browser
   harness; add a **Node-side determinism smoke test** instead (plan P1.2).
2. The proper way to read the artifact is against the contract above, not by
   re-deriving the numbers in the harness.

### 1.8 Conclusion

**Round 23's N3 is still open: no `npm run analyze` verdict exists.** The code
half is green under `npm test` (user-confirmed), the manifest proves the driver
runs the intended world, and the artifact even provides a real-data determinism
certificate — but the decision record in `OPTIMIZATION.md` cannot be filled from
it. The next step is therefore *not* "read the report": it is **make a run
survivable, run it, and record the verdict**.

> **▶ Superseded (rounds 24-25).** All three steps happened: the run was made
> survivable (round 24/24b), and the verdict was delivered by **attempt 3**
> (`20260920T144633-seed1`) — see **§5**. The paragraph above is the historical
> conclusion of attempt 1 and is kept as the record.

---

## 2. The plan (round 24)

> **Status: DELIVERED (round 24) — code + tests.** The plan below is kept as the
> record; this block is the **as-built** API and where each item is proved
> (`test/browser/entries/analyze.test.js` §O/§P/§Q, `test/node/analyze.test.js`).
> Everything here is off the arithmetic path, so no golden fingerprint moved.
>
> * **P0.1 → `partial-report.json`.** `evaluateAB` gained reporting-only
>   `onEvent(event)` and `onVariant({role, index, entry, decision})` hooks.
>   `runAnalysis` rewrites `partial-report.json` after **every** variant with
>   `writeJsonAtomic` (tmp + `renameSync`, falling back to a direct write), appends
>   a per-variant `progress` line to `run.log`, and on an exception writes a
>   `status:'failed'` checkpoint carrying `error.message`/`error.stack` while
>   KEEPING every finished variant's row and every completed pass. `report.json`
>   (with `status:'complete'`) is still the canonical end-of-run file. The
>   baseline is evaluated first so every row the checkpoint reports already has a
>   decision.
> * **P0.2 → `modelRetention`.** Both model factories take
>   `modelRetention: 'keep' | 'discard'` (factory default `keep`; the CLI default
>   is `discard`; `--keep-models` opts out). `makeSignalForVariant` calls the
>   model's `dispose()` in a `finally`; `dispose()` closes the fit's `_db`
>   (`HiveMindController._db`; the mind opens/closes per save) and
>   `rmSync(dir, {recursive:true, force:true})`s its state dir, is **idempotent**
>   (a second call is a no-op returning `{closed:false, removed:false}`), and never
>   fails the run (best-effort). The emitted positions are **byte-identical**
>   between `discard` and `keep` (§O), and an all-fit-discarded run leaves
>   `models/` empty and removed.
> * **P0.3 → the audit's teeth.** `auditBlock(audit)` records
>   `{ clean, vacuous, reachable, reachableFolds, viewDiffers, probes, violations,
>   violationExamples, auditStreams }` per candidate (and for the baseline);
>   `auditVerdict()` renders `audit: baseline <clean|LEAK> probes=N reachable=…
>   reachableFolds=…` in `formatAnalysis`; `probesPerFold()` sizes the pass budget;
>   `auditNoLookahead` now counts `reachableFolds` (the folds where the shock
>   demonstrably moved a *later* position). `--reachable` enforces the behavioural
>   half. A fold event carries `test`/`signals`/`returns`/`metrics`; the audit base
>   pass is proven to reproduce the scored pass exactly (§P).
> * **P0.4 → the run.** The CLI prints `upload: run.json, report.json, run.log
>   (optionally folds.jsonl)` and `--help` prints `ANALYZE_USAGE`. The run dir
>   holds `run.json`, `report.json`, `partial-report.json`, `progress.json`,
>   `folds.jsonl`, `run.log` (+ `models/` only under `--keep-models`).
> * **P1.1 → `requireReachable`.** Defaults **off**, but reachability is *always*
>   recorded (`reachable`, `reachableFolds`) so a verdict states which kind of
>   certificate it has; `--reachable` turns enforcement on.
> * **P1.2 → determinism smoke test.** `analyze.test.js` §Q runs two identical
>   `runAnalysis` calls and asserts an identical `summary` and baseline pooled
>   Sharpe; documented in `RUNBOOK.md` §6.
> * **P1.3 / P2.1 / P2.2** are unchanged (cost levers; the `OPTIMIZATION.md`
>   verdict record; the promotion/re-freeze protocol). **What remains is the run
>   itself: P0-4 smoke + power, then P2.1's verdict.** The **smoke half is done**
>   — see §3 for its verdict, the five bugs it exposed (all fixed) and the
>   recommended power run (`--reuse-base --audit-probes=1`).
>
> **Liveness.** `progress.json` is the heartbeat (`updatedAt`, `elapsedMs`,
> `phase`, `variant`, `fold`, `counters.events/eventsTotal`, `etaMs`) and stdout
> gets `[analyze] mm:ss elapsed | variant i/N id | stream s/S | phase fold i/N |
> events d/T (p%) | last event Xs`; `eventsTotal` scales with the roster (every
> variant runs the same per-variant pass set). A climbing `last event` with a
> frozen fold index is the frozen-run tell. `--progress-ms=<n>` sets the cadence
> (0 = every pass, -1 = silent); `--fold-log=all|score|off` controls `folds.jsonl`.

### P0.1 — Make an interrupted run recoverable (report checkpointing)

Today a crash at 90 % loses 100 % of the science: `report.json` is written once,
at the end. Change: `evaluateAB` gains an `onVariant(entry)` callback fired after
each variant's report is computed, and `runAnalysis` writes the accumulated state
to **`partial-report.json`** (and appends a one-line per-variant summary to
`run.log`) after every variant. `report.json` remains the canonical final file.
*Acceptance*: kill a run mid-way (or run `--variants=baseline,surprise`) and
`partial-report.json` exists with per-variant metrics, audit flags and decisions
for the variants that finished.

### P0.2 — Reclaim per-fit model state (default on, opt-out for forensics)

Each fit dir is used by exactly one pass and is then dead. Add
`modelRetention: 'discard' | 'keep'` to `makeControllerModelFactory` /
`makeHiveMindModelFactory`; in `'discard'` (CLI default) the factory
`close()`s and `rmSync(dir, {recursive:true, force:true})`s the fit dir at the end
of `predict()`. Add `--keep-models` for the forensics we just did on this run.
*Acceptance*: a full run leaves `state/runs/<id>/models/` empty (or absent) and
the pooled metrics are unchanged on a fixed subset vs `--keep-models`.
*Risk*: removing a dir SQLite still holds open — close first; verify on the real
driver (better-sqlite3), not the shim.

### P0.3 — Report the audit's teeth

Record `audit: { clean, reachable, probes, viewDiffers, vacuous }` per candidate
(currently `clean` only) at `src/analyze.js:626`, `:638`, and state it in
`formatAnalysis`. *Acceptance*: `report.json` for a full run shows non-zero
`probes` and the reachability verdict per candidate — so a `clean` audit can be
read as "and the shock moved a later position" (or not, honestly).

### P0.4 — Run it, in the cheap-then-powerful order, and upload only the report

1. Smoke + first verdict: `npm run analyze` (defaults: BTCUSDT, 300 bars, ~16
   folds, K=15). Small enough to finish quickly; exercises the whole pipeline and
   produces a complete `report.json`.
2. Power run: `npm run analyze -- --symbols=all --bars=600 --audit-probes=1`
   (≈20× the smoke run's compute: 288 folds over 8 streams vs 16 over 1, at ~¾ of
   the audit cost per fold; see §4).
3. Hand back **`run.json` + `report.json` + `run.log` only** (few hundred KB).
   Never upload `models/`.

### P1.1 — Decide `requireReachable` for the verdict run

§1.4.2 says behavioural reach is unproven. Either enable it (and accept that a
weakly-reachable model reports `vacuous`/`clean:false`, which the promotion gate
then honours) or keep it off *and* record reachability so the verdict states which
kind of certificate it has. Do not silently ship a structural-only audit.

### P1.2 — A determinism smoke test on the real driver

Two identical `npm run analyze` invocations on a small slice (`--bars=200
--test=20`) must produce identical per-candidate pooled metrics and the same
promote/reject set. Cheap, and it is the check that would have caught the harness
order-dependence in §1.7 before it confused anyone. Add it to `RUNBOOK.md`.

### P1.3 — Cost levers (documented, then chosen, not silently applied)

| lever | effect | cost |
| --- | --- | --- |
| `--audit-probes=1` | 3 passes/fold instead of 4 (−25 % total) | audit sensitivity: 1 probe/fold (only `test[0]`) |
| `--test=30` | half the folds, same pooled bars | coarser folds, fewer independent observations for the family-wise search |
| `--symbols=<subset>` | linear in streams | loses cross-symbol pooling (the N2 point) |
| `--audit=0` | −75 % total | **not acceptable for a promotion** — the gate requires a clean audit |

Screen with the smoke run; spend the power run only on candidates that survive
(and keep `trials`/K at the full family size so the multiple-testing correction
still covers the searched universe).

### P2.1 — Record the N3 verdict

Fill the `OPTIMIZATION.md` "Round 23 — verdict" block from `report.json`:
per-candidate `promote`/`keep-off` + reasons, pooled Sharpe/DSR, fold-win
fraction, audit (clean/reachable), SE/MDE95 and the family-wise SPA/StepM
p-value. Keep `OPTIMIZATION.md` as the single decision record.

### P2.2 — If anything promotes

A promotion is an intentional hot-path change: it needs the documented golden
re-freeze, the ledger re-measured (every count in `RUNBOOK.md` §6, the node mirror
constants and the prose lists) in the same pass, and a `BUGS.md`/`LOCKED.md` note.
If nothing promotes, record the honest negative and the power readout — a
power-limited null is only informative with the MDE attached.

---

## 3. Run `20260920T094400-seed1` — attempt 2 (default smoke, post-round-24b): COMPLETE, an honest underpowered null

> **This is the run the user executed with `npm run analyze` (defaults) on
> 2026-09-20; the whole run directory is uploaded.** It is the first *complete*
> `analyze` run taken with the hardened driver: `report.json` exists, carries a
> verdict, and carries every round-24b field in place (`costBps`/`reuseBase` in
> `run.json`, `probeIndex`/`reused` in `folds.jsonl`, `breakEvenCostBps` /
> `power.underpowered` / `barsToDetect1` / `audit.baseReused` in the report). A
> sibling pre-round-24b run (`20260920T081513-seed1`, since deleted) exposed the
> five defects fixed in §3.5; the two runs agree on every scored metric, which is
> itself a cross-process determinism check.

### 3.1 Manifest and completion

`run.json`: model `controller`, 1 stream (`src/candles.jsonl`, BTCUSDT), 300
candles, train/test/maxBars 60/15/300, 16 folds, all 15 variants, `probe` 0.05,
`auditProbesPerFold` 2, `modelRetention` discard, `foldLog` all, `reuseBase`
false, `costBps` 0, seed 1, node v25.9.0.

`progress.json` + `report.json`: `status: complete`, `phase: complete`, 15/15
variants, **960 events** (240 score + 240 base + 480 probe), 960/960, duration
**2,342,845 ms (39.0 min)**. Checkpointing, the heartbeat and the journal all
worked. Per-variant wall clock is ~5.7 min for each of the **7 model variants**
(baseline, surprise, homeostasis, multiprobe, querymod, pca-hash, sample-weights =
7 × 16 folds × 4 passes = 448 fits ≈ **5.23 s/fit**); the **8 signal variants are
pure functions** (no model fit) and finish in well under a second each. So the
smoke cost is 7 model variants × 64 passes, and the audit is 3 of the 4 passes per
fold (75 % of the compute).

### 3.2 The verdict: nothing promotes; all 14 candidates keep-off

`report.json` `familywise`: **SPA p = 1.0000, best = sig:momentum,
Rejects = [none], K = 15, T = 224**. Every candidate carries at least one reason;
the universal blocker is `pooled DSR < 0.95 (no demonstrated edge)`. Baseline
pooled Sharpe **-0.3105**, PSR 0.3803, DSR 0.0183, hit 0.4745, turnover 1.70.

| candidate | kind | pooled Sharpe | DSR | turnover | reachable folds | break-even (bps) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| baseline | mechanism | -0.3105 | 0.0183 | 1.70 | 16/16 | -3.65 |
| surprise | mechanism | -0.0546 | 0.0339 | 1.47 | 11/16 | -1.08 |
| homeostasis | mechanism | -1.4085 | 0.0006 | 2.69 | 13/16 | -25.51 |
| multiprobe | mechanism | 1.1538 | 0.2431 | 1.83 | 12/16 | +12.76 |
| querymod | mechanism | 0.0602 | 0.0441 | 1.90 | 14/16 | +1.16 |
| pca-hash | mechanism | -0.1518 | 0.0280 | 2.17 | 13/16 | -1.98 |
| sample-weights | mechanism | -1.1393 | 0.0020 | 1.66 | 14/16 | -13.51 |
| sig:momentum | signal | 1.5710 | 0.3953 | 44.18 | 16/16 | +14.91 |
| sig:frac-momentum | signal | 0.0836 | 0.0447 | 124.78 | 16/16 | +0.22 |
| sig:vol-regime | signal | 0.9355 | 0.1819 | 36.03 | 16/16 | +10.31 |
| sig:agreement | signal | -0.0091 | 0.0376 | 60.63 | 16/16 | -0.05 |
| sig:range | signal | 0.3120 | 0.0712 | 45.80 | 16/16 | +2.24 |
| sig:volume | signal | 1.3155 | 0.3046 | 35.07 | 16/16 | +12.61 |
| sig:autocorr | signal | 0.8758 | 0.1646 | 47.61 | 16/16 | +7.23 |
| sig:acceleration | signal | 1.6482 | 0.4233 | 46.77 | 16/16 | +13.81 |

(The break-even column is read straight from `report.json` now — each candidate
carries `breakEvenCostBps`; only the pre-fix sibling run needed the offline
recomputation of §3.4.)

Two readings, both important:

1. **Nothing is remotely significant.** The best DSR is 0.42 (sig:acceleration)
   against the 0.95 floor, and the family-wise SPA cannot reject *any* candidate
   (p = 1.0). The negative baseline Sharpe is itself within noise.
2. **A high-turnover signal is flattered by a zero cost assumption.** The 8
   signals trade 35-125× per 240 bars; the mechanisms trade 1.5-2.7×. At a
   realistic crypto taker round-trip (10-20 bps) every apparent signal edge
   (break-even 10-15 bps) is inside the cost — except sig:frac-momentum (+0.22 bps)
   and sig:agreement (-0.05 bps), which are already negative. So the signal
   family's "positive Sharpe" is a cost artifact, and round 24b prints the
   break-even cost next to every candidate so it cannot hide again.

### 3.3 The headline caveat: the run is underpowered

With 240 pooled bars the Sharpe standard error is **1.0248**, so the 95 % minimum
detectable Sharpe is **±2.009** — and every observed effect is ≤ 1.65. A null
verdict from this sample is therefore **uninformative**: it cannot distinguish
"no edge" from "an edge of 1.0 that the sample could not see". `report.power`
already carried the MDE (round 23), but nothing in the run *said* the verdict was
power-limited. Round 24b adds `power.underpowered` (MDE95 > 1.0) and
`power.barsToDetect1` (= **969** pooled bars to detect Sharpe ±1.0 at 95 %), and
`formatAnalysis` states the run-level verdict. The honest one-line summary of this
run is: **all candidates keep-off, at a power that rules out only Sharpe > 2.**

### 3.4 Offline verification of the journal

`folds.jsonl` is not a by-product; it is the source of truth that lets every report
claim be recomputed without the model. All of this was recomputed here from the
960 journal lines and matches `report.json` exactly:

* **The audit base pass reproduces the scored pass on 240/240 fold-passes** — a
  real-native-driver determinism certificate (the round-23 artifact gave 464/464
  on a different run; this one gives 240/240). That is what makes a `clean` audit
  meaningful.
* **Reachability recomputed per variant matches `audit.reachableFolds` on all 15
  variants** (baseline 16, surprise 11, homeostasis 13, multiprobe 12, querymod 14,
  pca-hash 13, sample-weights 14, every signal 16 — **except sig:volume 0/16**,
  bug B below).
* **Zero look-ahead violations:** across all 480 probe passes no probe moved the
  position at the probe bar or at any earlier bar. The audit found no leak.
* **Cross-process determinism:** the pre-fix and post-fix runs produced identical
  pooled metrics for all 15 variants (baseline Sharpe -0.3105, turnover 1.7005,
  DSR 0.0183) even though the audit shock changed — the scored path is independent
  of the probe path, exactly as designed.

### 3.5 Bugs the run exposed (all fixed in round 24b)

| # | bug | evidence from this run | fix |
| --- | --- | --- | --- |
| A | `foldRecord` dropped `probeIndex` | the pre-fix journal had only `probeAt`, so offline reachability needed `test.indexOf(probeAt)` | `probeIndex` + `reused` emitted per pass |
| B | `shockCandles` scaled OHLC but **not volume** | the pre-fix sibling had `sig:volume` reachable **0/16** (the audit could never reach a volume-driven strategy, and a future-volume leak would be invisible); the post-fix run has **16/16** | `volumeShockFactor` (phase-shifted, bounded) + volume scaling |
| C | the stdout/heartbeat fold cursor froze | the progress line sat on `fold 16/16` for the whole audit | pass events advance `foldIndex`/`foldTotal` |
| D | transaction costs were always 0 | `costBps` defaulted to 0 *and* the CLI ignored `--cost-bps`; a 125×-turnover signal was compared to a 1.7× mechanism with no penalty | `grossPnl` + `breakEvenCostBps` in the metrics and the report `cost:` line; `--cost-bps` is threaded |
| E | the report carried an MDE but not an underpowered verdict | §3.3 | `power.underpowered` + `power.barsToDetect1`; `formatAnalysis` states it |

Round 24b also renders each candidate's reachability inline
(`audit:  clean reachable=F/F probes=N`) and puts `reuseBase`/`costBps` in
`progress.json`, so a long multi-candidate run can be read for the audit's
behavioural half straight from the summary.

### 3.6 The round-24b optimization for the power run: `--reuse-base`

The scored pass *is* the audit base pass (same fold, same unperturbed view), so
refitting it is redundant work. `--reuse-base` feeds the scored signals to
`auditNoLookahead` and records `baseReused`. The verdict is provably unchanged
(the suite asserts an identical promote/keep-off set and identical audit with
`baseReused == folds` vs `0`). It removes one fit per fold:

| flags | passes/fold | power-run fits | est. wall clock |
| --- | ---: | ---: | ---: |
| (default) | 4 | 8,064 | ~12.0 h |
| `--reuse-base` | 3 | 6,048 | ~9.0 h |
| `--audit-probes=1` | 3 | 6,048 | ~9.0 h |
| `--reuse-base --audit-probes=1` | 2 | 4,032 | **~6.0 h** |

(7 model variants × 288 folds × passes/fold, at the measured 5.23 s/fit.)

### 3.7 The recommended power run

```
npm run analyze -- --symbols=all --bars=600 --audit-probes=1 --reuse-base
```

**▶ Executed as `20260920T144633-seed1` — see §5 for the completed run, its
verdict, and why the ~6 h estimate below was 2× optimistic (~10.7 s/fit measured).**

* 8 symbols × 36 folds = **288 folds, 4,320 pooled bars** (18× the smoke).
* MDE95 falls by √18 ≈ 4.24 → **≈ ±0.47 Sharpe**: enough to detect a Sharpe-1 edge
  and well past `barsToDetect1` (969). The default 16-fold single stream would
  still be ±2.0.
* ~6 h at the measured rate, with transient state reclaimed (`--keep-models` off).
* Keep `--cost-bps=0` for the scientific comparison and read the printed
  `breakEven=` per candidate; a second pass with `--cost-bps=10` shows the net
  verdict under a realistic taker cost. Either way, report the power readout with
  the verdict.
* Upload `run.json` + `report.json` + `run.log` + `folds.jsonl` (now readable
  offline). Never `models/`.

> **Storage note.** The uploaded run directory currently lives under the generator
> `src/` tree, which ships publicly. It is ~700 KB of research artifacts; it is
> read-only input and can be moved out of `src/`.

---

## 4. Cost model (for sizing the next run)

```
smoke run (BTCUSDT, 300 bars, 16 folds, K=15, 4 passes/fold):
    16 × 4 × (mean 180 streamed bars + 15 predictions) ≈ 12,500 getSignal / variant

power run (8 symbols, 600 bars, 288 folds, K=15):
    288 × 4 × (mean 322 + 15) ≈ 388,000 getSignal / variant     (audit = 3/4 of it)
    with --audit-probes=1:     288 × 3 × 337 ≈ 291,000
    × 43 ms/getSignal (round-23 measurement, sql.js shim): 3.5-4.6 h per variant
    full K=15: ~52-70 h (shim), ~12 GiB of state (measured: 0.708 MiB/fit)
```

**Measured cost model (round 25b — a CORRECTION of the round-25 statement).** The
round-25 text below said the driver costs "10.5-10.7 s per controller fit",
*independent of the stream length*. That is wrong, and the `20260921T062511-seed1`
run proved it: the same runner took **42.6 s per fold-pass at 142 folds/stream**
versus 10.7 s at 36. The cause is in the fit itself:

```js
// src/analyze.js — fit(): warm the online controller up by replaying ALL history
for (let i = 1; i <= testStart; i++) ctl.getSignal(candles.slice(0, i), 1);
```

An online model must see every prior bar before predicting a fold's test block, so
the number of warm-up `getSignal` calls **per fold grows with the fold index**.
Each call costs ≈35 ms (measured 33.2 ms/bar at 36 folds/stream, 38.2 ms at 142 —
the same constant), which gives:

```
wall clock ≈ 0.035 s × Σ_f(testStart_f) × streams × passes × mechanismVariants
Σ_f(testStart_f) = F·trainSize + testSize·F(F−1)/2          (F = folds per stream)

smoke   (1 stream,    16 folds, n=300):  7×1×2×   2,010 ≈  28,140 →  ~40 min   (measured 39.0 min)
power   (8 streams,  288 folds, n=600):  7×8×2×  11,610 ≈ 1,300,320 → ~12.6 h  (measured 11.98 h)
sig-run (8 streams, 1136 folds, n=2200): 1×8×2× 158,685 ≈ 2,538,960 → ~24.7 h  (measured 26.9 h)
```

("fit-call" = one warm-up `getSignal`; the constant absorbs per-fold construction,
prediction and probe passes.) The two power-scale observations pin the exponent:
per-fold cost is **10.7 s at 36 folds/stream and 42.6 s at 142** — a ratio of 3.98
against a fold ratio of 3.94, i.e. `cost/fold ∝ F` and `total ∝ F²`. So a run is
**O(n²) per stream, not linear in bars.** Signal variants remain free (0.3-0.8 s
each across 1136 folds).

Three load-bearing planning consequences:

1. **Cost ∝ folds-per-stream for a fixed pooled-bar budget.** With
   `pooledBars = streams × F × testSize`, `time ∝ pooledBars × F` — so *many short
   streams are far cheaper than a few long ones* (8×2200 = 26.9 h, but 32×550 ≈ 6 h
   for essentially the same pooled bars). This also aligns with the statistics: the
   binding constraint is *effective* bars, and more *diverse* streams buy effective
   bars while lowering the design effect.
2. **`--audit-probes=1` is not optional at this scale** (a full per-bar audit is ~8×).
3. The round-25 claim "adding a mechanism candidate costs ~1.7 h" holds only at the
   288-fold scale; at 1136 folds **one** mechanism variant is 26.9 h. Adding a
   *signal* candidate is still free.

The biggest **semantics-preserving** speedup is therefore not a model change: folds
are independent and each fit already gets its own state directory
(`path.join(stateDir, \`${variant.id}-${fitCounter++}\`)`), so the fold loop
parallelises across worker threads — `legion/workers.js#runWorkerThread` is the
existing settle-once, watchdogged dispatch. See `OPTIMIZATION.md` "Round 25b".

---

## 5. Run `20260920T144633-seed1` — attempt 3, the power run: COMPLETE, nothing promotes, but the verdict is neither as powered nor as robust as it reads

This is the N3 run: the first `npm run analyze` at full size with a complete
report. It is the run that produced the recorded verdict. It is also the run that
showed the report **overstating its own power** (§5.5) and the verdict being
**knife-edge on two assumptions that were never part of the experiment** (§5.6).

> **Correction (round 26, `BUGS.md` #33).** This run was made *before* the A/B's
> window-fidelity fix, so it fed the controller the whole growing candle prefix
> where production feeds a fixed `cacheSize` window. **Every `baseline` and
> *mechanism* row below is therefore not the shipped model's** — the baseline's
> `+0.4387` and `query-mod`'s DSR-0.9992 / 33.73 bps rows are the clearest
> casualties. The **8 signal rows are unaffected** (a signal is pure array math on
> the view and never constructs a controller) and are reproduced to ~1-2 % by the
> corrected re-run of the *same design* in **§10** (which is `20260922T204248-seed1`;
> its baseline is `-0.1147` and `query-mod`/`multi-probe`/`sample-weights` are
> byte-identical to it). Read §5's mechanism/baseline numbers as the pre-fix
> artifact they are; read §5's signal numbers and §5.6's cost ladder as history
> that §10 replaces. The offline-verification method in §5.3 remains correct.

### 5.1 Manifest and completion

`run.json` (config fingerprint `c0ba6493`):

| field | value |
| --- | --- |
| `type` / `model` | `analyze` / `controller` (the shipped `HiveMindController`) |
| `files` | 8 streams: `src/candles.jsonl` + the 7 `src/data/candles_*_1h.jsonl` symbols |
| `candles` / `streams` | 4,800 / 8 |
| `folds` / `trainSize` / `testSize` / `maxBars` | 288 (36 per stream) / 60 / 15 / 600 |
| `probe` / `auditProbesPerFold` | 0.05 / 1 |
| `reuseBase` / `costBps` / `requireReachable` | `true` / `0` / `false` |
| `modelRetention` / `foldLog` | `discard` / `all` |
| `positionPolicy` | `{ deadZone: 0.05, scale: 1 }` |
| `seed` / `node` | 1 / `v25.9.0` |

`progress.json` ends at `phase: complete`, `counters` 4,320 score / 4,320 base /
4,320 probe = 12,960 / 12,960 events, 15/15 variants. `durationMs` =
**43,129,704 ms (11.98 h)**; `run.log` has the matching `analyze complete` line.
Artifacts:

```
run.json              1,628 B
progress.json           816 B
run.log               4,323 B    (18 journal lines: 1 start, 15 variant checkpoints, complete)
partial-report.json  46,228 B    (the last checkpoint; the final report minus familywise)
report.json          48,854 B    (the verdict)
folds.jsonl      11,074,838 B    (12,960 lines = 4,320 score + 4,320 base + 4,320 probe)
```

### 5.2 The verdict

**All 14 candidates `keep-off`; nothing promotes.** Family-wise:
`SPA p = 0.5699, best = sig:momentum, Rejects = [none], K = 15, T = 4032`
(the 4,320 pooled bars less each fold's first, lagged-to-zero bar).

| candidate | kind | pooled Sharpe | DSR | fold-win | pos-fold | break-even | reachable | reasons |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **baseline** | mechanism | **0.4387** | 0.5179 | — | 0.4444 | 12.42 bps | 243/288 | — |
| surprise-gate | mechanism | -0.3766 | 0.0006 | 0.3958 | 0.2639 | -10.39 | 214/288 | 5 |
| homeostasis | mechanism | 0.3090 | 0.3134 | 0.4688 | 0.4097 | 7.83 | 228/288 | 5 |
| multi-probe | mechanism | 0.3101 | 0.3100 | 0.4514 | 0.3819 | 8.92 | 220/288 | 5 |
| **query-mod** | mechanism | **1.0025** | **0.9992** | 0.4653 | 0.4028 | **33.73** | 232/288 | 2 |
| pca-hash | mechanism | -0.0037 | 0.0371 | 0.4201 | 0.3611 | -0.09 | 228/288 | 5 |
| sample-weights | mechanism | 0.1945 | 0.1641 | 0.4271 | 0.3854 | 4.31 | 226/288 | 5 |
| **sig:momentum** | signal | **1.1059** | **0.9988** | 0.4514 | 0.5694 | **15.02** | 288/288 | 1 |
| sig:frac-momentum | signal | -0.4330 | 0.0003 | 0.3958 | 0.3889 | -1.66 | 288/288 | 5 |
| sig:vol-regime | signal | -0.3223 | 0.0009 | 0.4340 | 0.4653 | -4.46 | 288/288 | 4 |
| sig:agreement | signal | 0.4044 | 0.4603 | 0.3958 | 0.5000 | 3.83 | 288/288 | 4 |
| sig:range | signal | 0.4586 | 0.5529 | 0.3889 | 0.4792 | 5.70 | 288/288 | 3 |
| sig:volume | signal | 0.0173 | 0.0446 | 0.4757 | 0.5069 | 0.27 | 288/288 | 4 |
| sig:autocorr | signal | -0.1146 | 0.0126 | 0.4722 | 0.4757 | -1.42 | 288/288 | 4 |
| **sig:acceleration** | signal | **1.0502** | **0.9968** | **0.4896** | 0.6285 | **11.95** | 288/288 | 1 |

Baseline detail: PSR 0.9643, MDD 0.0242, hit 0.5117, turnover 36.2109, grossPnl
0.04497, tradeCount 2,671, MinTRL 3,595.3, finalEquity 1.0457; folds mean 0.3922 /
median 0 / std 3.6639 / positive 0.4444. Power: SE 0.2416, **MDE95 ±0.4735**,
`underpowered false`, `barsToDetect1` 969.

The reading: the **baseline controller is the strongest mechanism** (every other
mechanism flag is neutral-to-harmful), and three candidates carry large,
DSR-significant, cost-surviving gross edges:

* **`query-mod`** — DSR **0.9992** (the only candidate to clear the absolute 0.95
  floor), Sharpe 1.0025, MDD **0.0081** (3× smaller than the baseline's), turnover
  29.8 (lower than the baseline's 36.2), break-even **33.73 bps**. Blocked *only*
  by the fold-consistency pair: fold-win 0.4653 < 0.5 and positive-fold 0.4028 <
  baseline 0.4444.
* **`sig:momentum`** — Sharpe **1.1059**, DSR 0.9988, break-even 15.02 bps,
  reachable 288/288, and the **lowest family-wise p-value** of the whole family
  (StepM p = 0.5638 — still not significant). Blocked only by fold-win 0.4514.
* **`sig:acceleration`** — Sharpe 1.0502, DSR 0.9968, break-even 11.95 bps, the
  highest positive-fold fraction in the family (0.6285) and the highest median
  fold Sharpe (1.4030). Blocked by fold-win **0.4896 — 3 folds short of 0.5**.

So the honest one-line verdict: **nothing promotes; the family-wise test rejects
nothing; three candidates have real (aggregate) edges that fail the per-fold
consistency hurdle.** Note also that "no demonstrated edge" fires as a reason for
every candidate except these three: the gate's 0.95 absolute DSR floor is doing
most of the work.

### 5.3 Offline verification of the journal (why this verdict is citable)

`folds.jsonl` carries every pass, so the whole report was recomputed here from the
journal alone, with no model and no access to the run's process. Every check is
exact:

1. **Shape** — 12,960 lines, exactly 4,320 `score` + 4,320 `base` + 4,320 `probe`,
   288 of each per variant.
2. **The base pass reproduces the scored pass on 4,320/4,320 fold-passes**
   (`baseReused` = 288 per variant, `reused: true` on every base row, 0 signal
   mismatches). The smoke run's determinism certificate was 240/240; at scale it is
   4,320/4,320.
3. **Zero look-ahead violations across 4,320 probe passes** — the position at the
   probe bar never moved when only information *after* that bar changed; 0
   non-finite emitted positions, 0 signal/length mismatches.
4. **Reachability matches `report.audit.reachableFolds` on all 15 variants**
   (baseline 243, surprise 214, homeostasis 228, multiprobe 220, querymod 232,
   pca-hash 228, sample-weights 226, and **all 8 signal variants 288/288**). Bug B
   (volume-blind shock) is fixed at scale: `sig:volume` was 0/16 in the smoke and
   is 288/288 here.
5. **Every per-fold metric reproduces exactly** — recomputing
   `backtestMetrics(..., trials: 15)` for all 4,320 scored folds reproduces the
   stored `netSharpe`, `dsr` and `turnover` with 0 mismatches.
6. **Every pooled metric reproduces exactly for all 15 variants** — Sharpe, PSR,
   DSR, MDD, hit rate, turnover, grossPnl, break-even cost, tradeCount,
   finalEquity, MinTRL (the only "difference" is `MinTRL: Infinity` in a direct
   computation vs `null` in JSON — a serialisation round-trip of a negative-Sharpe
   case, see §5.5.3).
7. **The family-wise test and the whole promotion decision reproduce** — SPA
   p = 0.5699, K = 15, T = 4032, all 15 per-candidate StepM p-values, the
   promote/keep-off set and each candidate's reason count.

So the verdict is citable: it is reproducible from the uploaded journal end to end.

### 5.4 The wall-clock shape of the run (and why `run.log` *looks* broken)

`run.log`'s 15 checkpoints are spaced ~102.7 min apart for the first 7
(`baseline` … `sample-weights`) and then the remaining **8 land within 0.66 s**
(`02:45:22.848` → `02:45:23.504`). That is not a logging bug — the timestamp is
taken at `appendFileSync` time (`observer/report.js:112`) and `onVariant` fires
synchronously after each variant (`analyze.js:465`). It is the **cost model**: the
7 mechanism variants each refit the controller 288 × 2 = 576 times (~10.7 s/fit →
~103 min), while the 8 signal variants are pure array math and finish instantly.
Same for the heartbeat: `progress.json` is a single rewritten file, so it only
ever shows the *last* state.

> **Observability note for round 25:** the checkpoint line should carry the
> variant's own elapsed ms and its kind (`mechanism|signal`), so this shape is
> self-explanatory in the artifact rather than requiring the cost model to explain
> it. Minus this, a future reader will read the 0.66 s tail as a bug.

### 5.5 Two defects the run exposes — both are the report overstating itself

Round 24b's lesson was "a null verdict must say it is underpowered". This run shows
the next layer: **the power block can say `underpowered: false` when the run is not
adequately powered at all, and the verdict it prints has no cost assumption
attached.** Both are recorded in `BUGS.md` #26/#27.

1. **`power` ignores cross-stream correlation (the design effect).**
   `sharpeStandardError` treats the 4,320 pooled bars as independent. They are not
   even across streams: the mean pairwise correlation of the per-fold Sharpe series
   between the 8 symbols is **0.452** (baseline), 0.414 (querymod), 0.524
   (sig:momentum), 0.471 (sig:accel). Under an equicorrelation model with r ≈ 0.47
   the pooled SE is understated by √(1 + 7·0.47) ≈ **2.1**, i.e. the honest MDE95 is
   **≈ ±0.98**, not ±0.47 — right at `UNDERPOWERED_MDE = 1.0`. The run is therefore
   *marginal*, not "not underpowered", and the baseline's Sharpe 0.4387 is not
   distinguishable from zero at the corrected MDE. This does not invalidate the
   verdict (nothing promoted either way) but it does mean this **null is still not
   the decisive experiment**, and that `barsToDetect1 = 969` should be read as
   ~4,300 bars under the corrected design effect.
2. **The verdict is not cost-robust, and it is knife-edge on the fold-win
   threshold.** `costBps: 0` was chosen as the "scientific" comparison, but cost 0
   is *not* a neutral null: because the gate compares a candidate's raw fold-win
   fraction and positive-fold fraction against the baseline's, and cost degrades
   the low-turnover baseline (turnover 36.2) relatively *faster* than it degrades a
   high-turnover signal, the hurdle moves with the cost assumption. Recomputing the
   whole decision from the journal at 2 bps turns `sig:acceleration` into a
   **PROMOTE with zero reasons** (Sharpe 0.8745, DSR 0.9741, fold-win 0.5104,
   positive-fold 0.6007 ≥ baseline 0.4236) — see the ladder in §5.6. So two of the
   three candidate verdicts are decided by (a) an unstated cost assumption and
   (b) 0.4896 vs 0.5000 on one statistic. The verdict needs a **cost-robustness
   block**, not a single cost level, and the fold-consistency hurdle should be a
   significance statement rather than a raw 0.5 threshold on 288 correlated folds.
3. **Minor report-integrity nits.** `minTrackRecordLength: Infinity` serialises to
   `null`, so a reader cannot distinguish "infinite" from "not computed"
   (5 candidates). Also `report.power` describes the baseline only, so a reader
   can't see that a candidate's MDE differs slightly (0.4734-0.4740).
   *(Round 25 fixed the first with an explicit `minTrackRecordLengthStatus`
   (finite | beyond-horizon | unavailable); the second is now covered per candidate
   by the `dependence` and `promotionTest` blocks, which carry the candidate's own
   cluster-jackknife numbers — see §6.1.)*

### 5.6 Supplemental analyses computed offline from the journal (not in `report.json`)

`folds.jsonl` holds the raw returns and emitted signals per fold, so these are all
recomputable without the model. They are the *inputs* to the round-25 plan —
**none of them is in the report today.**

**(a) Cost ladder** — the whole decision recomputed at 0/2/5/8/10/15 bps:

| cost | baseline Sharpe / DSR | query-mod | sig:momentum | sig:accel | sig:range | SPA p | promotes |
| ---: | --- | --- | --- | --- | --- | ---: | --- |
| 0 bps | 0.4387 / 0.5179 | 1.0025 / 0.9992 | **1.1059** / 0.9988 | 1.0502 / 0.9968 | 0.4586 / 0.5529 | 0.5699 | none |
| 2 bps | 0.3680 / 0.4028 | 0.9437 / 0.9975 | 0.9590 / 0.9909 | 0.8745 / 0.9741 | 0.2980 / 0.2904 | 0.5998 | **sig:accel** |
| 5 bps | 0.2619 / 0.2469 | 0.8553 / 0.9887 | 0.7382 / 0.9130 | 0.6108 / 0.7841 | 0.0567 / 0.0613 | 0.7370 | none |
| 8 bps | 0.1559 / 0.1306 | 0.7666 / 0.9614 | 0.5172 / 0.6500 | 0.3469 / 0.3660 | -0.1848 / 0.0064 | 0.8229 | none |
| 10 bps | 0.0853 / 0.0783 | 0.7073 / 0.9244 | 0.3698 / 0.4023 | 0.1710 / 0.1412 | -0.3459 / 0.0010 | 0.8906 | none |
| 15 bps | -0.0908 / 0.0159 | 0.5587 / 0.7403 | 0.0014 / 0.0388 | -0.2681 / 0.0023 | -0.7479 / 0.0000 | 0.9470 | none |

`query-mod` is the cost-robust one (break-even 33.7 bps; still DSR 0.92 at 10 bps).
The momentum family is real but high-turnover: it survives to ~10-15 bps and the
SPA's "best" switches from `sig:momentum` to `querymod` at ≥ 5 bps.

**(b) Per-symbol Sharpes** (stream order: BTCUSDT, ETH, SOL, BNB, XRP, ADA, DOGE,
LINK; break-even in bps below):

```
              BTC   ETH   SOL   BNB   XRP   ADA  DOGE  LINK
cost 0: base 1.48  0.42  0.30  0.53  0.98  0.78  0.29 -0.46
        qmod 1.20  0.80  0.16  1.88  1.04  1.32  0.94  0.98
        mom  1.25  0.94  1.46  1.77  1.54  0.30  1.02  1.18
        acc  1.25  0.95  1.39  1.17  1.70  0.52  1.10  0.69
cost 5: base 1.24  0.25  0.12  0.20  0.81  0.62  0.12 -0.59
        qmod 1.01  0.62 -0.12  1.63  0.93  1.21  0.83  0.84
        mom  0.67  0.52  1.08  1.25  1.23 -0.05  0.72  0.85
        acc  0.62  0.47  0.95  0.54  1.32  0.10  0.70  0.31
break-even: qmod 31.0 22.2  2.8 36.6 48.1 55.8 45.4 33.0
            mom  10.7 11.3 19.3 16.8 24.8  4.4 16.9 18.0
            acc   9.9  9.8 15.8  9.3 22.5  6.3 13.8  9.1
```

The candidates' edges are **broad, not single-symbol**: 8/8 symbols positive at
cost 0 for query-mod, sig:momentum and sig:accel, and at 5 bps `sig:accel` is the
only candidate still positive in all 8. The baseline is negative on LINK.

**(c) The edge is event-driven and shared.** Ranked by per-fold gross P&L, the
top-5 folds of **every** signal candidate include **fold 10** (test bars 210-224) in
streams 4-7, plus stream 4 folds 28/30; the baseline's top folds are unrelated
(fold 34 in streams 0,1,4,5,6) and it shares **zero** top-5 folds with any
candidate. The excess per-fold Sharpe is also lumpy: `sig:accel` wins 141/288
head-to-head folds (0.4896) with a **negative median excess (-0.146)** but a
positive mean (+0.611) — i.e. a handful of large event folds carry it. That is
precisely what the fold-win / positive-fold hurdles are designed to catch.

**(d) The candidates are ~1.5 bets, not 3.** Correlation of the per-fold *excess
over baseline*: `sig:momentum ~ sig:accel` **0.863**, `querymod ~ sig:momentum`
0.553, `querymod ~ sig:accel` 0.544. (The baseline is uncorrelated with them:
-0.07 / -0.13.) So "three DSR-significant candidates" is closer to one common bet
plus a query-side variant, and the family-wise K = 15 overstates the independent
search that actually happened.

### 5.7 What this run means for the next one

1. **The null stands, but it is not decisive yet.** With the design-effect
   correction (§5.5.1) this run sits at MDE ≈ ±1.0. A decisive experiment needs
   ~4× the effective independent data (more *diverse* symbols, not more correlated
   majors; or more folds per symbol), or a decision procedure that is honest about
   the correlation.
2. **Make the verdict cost-robust before it is re-used.** The ladder in §5.6(a) is
   O(T) per level and would cost seconds inside the run; emitting it turns a
   knife-edge verdict into a stated sensitivity.
3. **Re-examine the fold-consistency hurdle.** It is the *only* binding constraint
   for all three real candidates, it is applied as a raw 0.5 threshold on 288
   *correlated* folds, and it flips at 2 bps. It should be a significance statement
   (paired sign/bootstrap test against the baseline with the effective-n
   correction), not a fixed fraction.
4. **`query-mod` deserves its own investigation** independent of promotion: DSR
   0.9992, MDD 0.0081, turnover *lower* than the baseline, break-even 33.7 bps, and
   its own family-wise p is 1.0000 only because the StepM family-wise correction is
   extremely conservative here (nothing in K = 15 rejects at T = 4,032). The
   question worth answering is *why* it is so smooth (MDD 0.008) — smoothness that
   the fold-win test punishes is exactly the profile of a low-frequency, high-conviction
   filter, and it is worth checking whether the dead zone is causing it to abstain
   on most folds (querymod's median fold Sharpe is 0.0000).

> **Storage note.** This run directory has been moved OUT of the generator `src/`
> tree (it was ~11.6 MB, 11.07 MB of it the fold journal, and `src/` ships
> publicly); the user holds it at `state/runs/20260920T144633-seed1/`. Only the
> summary above, and the derived analyses in §5.6, need to survive — every number
> in this document was recomputed and cross-checked against the journal before the
> directory was moved.

## 6. Round 25 — implementation record

Everything §5.7 asked for is now in the code, behind either the report layer (no
model, no re-run) or a default-off option. Nothing on the training hot path moved,
and all 11 golden fingerprints are unchanged.

### 6.1 Delivered

| §5.7 item | What shipped | Where |
| --- | --- | --- |
| 1. Honest power under dependence | `dependenceSummary` measures the delete-one-cluster jackknife SE of the pooled Sharpe over fold-window clusters and reports `designEffect = (seCluster/seIid)^2`, `effectiveBars = bars/designEffect`, `adjustmentNeeded`, and the Kish equicorrelation reading; `powerSummary` carries `seDependent`/`mdeSharpeDependent`/`underpoweredDependent`/`varianceInflation` ALONGSIDE the i.i.d. numbers | `analysis/dependence.js`, `analysis/walkforward.js` |
| 1b. Adjusted floors | `backtestMetrics`/`poolFolds` take `effectiveBars` and emit `psrAdjusted`/`dsrAdjusted` (null, not the unadjusted value, when no design effect was justified) | `analysis/backtest.js` |
| 2. Cost-robust verdict | `restateReportAtCost` re-scores the retained per-fold (returns, signals) at any cost with the exact scored arithmetic (defaulting `trials` to the report's own deflation count); `costLadder` runs the whole decision at 0/2/5/10 bps; the driver emits it by default and `--cost-ladder=` overrides | `analysis/walkforward.js`, `analyze.js` |
| 3. Fold consistency as significance | `pairedPromotionTest` = paired delete-one-cluster Sharpe-difference t(C−1) + the exact sign test over the same clusters; `promoteDecision` gains `requireSharpeDiff`/`requireBreadth`/`minDsrAdjusted`, each recorded as `applied` / `skipped-no-panel` / `not-needed` / `off`. **Round 26 (R26-7)** demotes the sign test to a *reported* statistic (`promotionTest.breadth`) and makes the shipped gate magnitude + stability: `requireSharpeDiff` (the paired cluster Sharpe effect-size floor) together with `requireClusterStability` (the leave-one-cluster-out check — the pooled difference must stay positive when any single fold-window cluster is deleted, `clusterStability` in `dependence.js`) plus `dsrAdjusted` | `analysis/dependence.js`, `analysis/walkforward.js` |
| 4. query-mod investigation | `nonZeroFraction` + `meanAbsPosition` participation metrics in every pooled report, so "abstains on most folds, bets big on a few" is visible instead of hidden in a turnover number | `analysis/backtest.js` |
| 5. Search concentration | `familyCorrelation` reports the per-fold excess-return correlation matrix, the strongest pair, and the Kish effective trial count — DIAGNOSTIC ONLY (the deflated Sharpe keeps `trials = K`) | `analysis/walkforward.js` |
| 6. Observability nits | `minTrackRecordLengthStatus` (finite / beyond-horizon / unavailable) so a JSON `null` MinTRL is not ambiguous; per-variant wall times in `timings`; the gate and the ladder recorded in `run.json`, both checkpoints and the report | `analysis/backtest.js`, `analyze.js` |

### 6.2 Two real defects found while building it

Both are recorded in `docs/BUGS.md` (#28, #29) and both were found by the new
tests rather than by inspection:

- **`studentTPValue` swallowed its own infinite cases.** The `Number.isFinite(t)`
  guard sat ABOVE the `t === ±Infinity` branches, so the branches were dead code
  and a degenerate cluster-robust t (zero jackknife SE with a non-zero difference)
  returned `NaN` instead of `0` — silently turning a perfectly dominant candidate
  into "not significant". Fixed by handling the infinite cases first.
- **`effectiveBars > n` was conflated with "no panel".** When the streams are
  *diversifying* (designEffect < 1) the i.i.d.-equivalent sample exceeds the bar
  count, `backtestMetrics` declines to inflate confidence, and `dsrAdjusted` is
  null — which the gate initially reported as `skipped-no-panel`. It now reports
  `not-needed`, and the two states can no longer be confused in a report.

Two further defects were caught in the review pass *after* the implementation
(both in the new code/docs, both fixed):

- **The report's `paired:` line was unwired.** `formatReport` read
  `report.promotionTest`, but nothing in production ever attached it (only the
  tests set it by hand), so the new line could never appear in a real run's
  summary. `formatReport` now takes `promotionTest` as an explicit option and the
  driver hands it the candidate's decision, so a single-stream run renders
  `paired: n/a (reason)` instead of silently omitting the hurdle's evidence.
- **The new test section collided with an existing label.** The round-25 tests
  were labelled §AB, which round 12 already used; they are now §AD, with every
  reference updated. Same pass: stale Node-mirror failure messages (they still
  cited 49/143/390 checks while asserting 62/158/437), and a `dependence.js` row
  that had silently failed to insert into `docs/LOCKED.md`.

### 6.3 Calibration and the size of the new gate

- The jackknife's variance inflation is exact against Monte Carlo: for a K-stream
  panel with equicorrelation ρ, the measured `seCluster/seIid` ratio is
  0.988 / 1.653 / 2.124 / 2.512 at ρ = 0 / 0.25 / 0.5 / 0.75, against the
  predicted `sqrt(1+(K-1)ρ)` = 1.000 / 1.658 / 2.121 / 2.500 (`analysis.test.js` §AD).
- The gate's size on zero-skill panels: over 24 null rounds of 4 correlated streams
  × 5 folds the dependence gate falsely promoted at most as often as the classic
  gate and never more than twice in 24 (≈ an alpha-level rate for two hurdles). Its
  power is separately pinned: on an 8-window panel with a clear per-window excess
  it clears all three hurdles and promotes.
- The ladder's whole point is now pinned as a test: an AR(1) momentum edge with the
  shipped signals promotes at 0-20 bps and **stops promoting at 40 bps** (DSR falls
  from ≥0.99 to 0.82), i.e. a verdict that is about the cost assumption is
  detectable rather than implicit.

### 6.4 What is still open (for the next run, not for this round)

- The attempt-3 verdict was recorded at `costBps: 0` with `auditProbesPerFold: 1`.
  The round-25 gate and ladder would have changed **what the run says**, not what it
  measured: the per-fold returns are identical. Re-running is only necessary to get
  the new blocks into a *fresh* `report.json`. The binding constraint is *effective*
  bars = pooled bars / designEffect (attempt 3: 4,320 / 2.1 ⇒ an honest MDE95 of
  ±0.98, not the i.i.d. ±0.47), so the next run should buy effective data either by
  pooling more *diverse* streams (a lower design effect) or by spending the bar
  budget where it buys the most. The measured cost model is
  `time ≈ 10.7 s × mechanism variants × folds × (1 + probes)`, so dropping the
  mechanism variants and spending the same wall time on a longer history roughly
  doubles the power of a signal-family read.
- `querymod`'s smoothness (MDD 0.0081, median fold Sharpe 0.0000) now has a
  measurable signature (`nonZeroFraction`), but the *cause* — whether the dead zone
  is abstaining — needs the next run's participation numbers to settle.


---

## 7. Run `20260921T062511-seed1` — the signal-family power run: the round-25 gate works in production, and the science says "no, not on this data, not at these costs"

This is the first run made *with* the round-25 machinery, and the first sized by the
corrected power maths. 9 variants (baseline + the 8 causal signals), 8 streams,
2,200 bars each, **1,136 folds / 17,040 pooled bars**, `--reuse-base`,
`--audit-probes=1`, `--cost-bps=0`, gate `dependence` at alpha 0.05. It took
**96,897,745 ms (26.9 h)** — see §4 for why that was 4× the prediction.

### 7.1 The round-25 machinery worked

Everything round 25 added is present and correct in a real run: `gate: dependence
(alpha=0.0500)` in the header; `depend`, `power*`, `adjusted`, `part` and
`paired` lines on every candidate; `gate-skipped=` never printed because every
hurdle was genuinely applied; the full cost ladder; the `family:` diagnostic; and
`gate: {minDsrAdjusted: applied, requireSharpeDiff: applied, requireBreadth: applied}`
on all 8 candidates. The design-effect machinery also behaves exactly as designed on
data it was not calibrated on:

| | pooled Sharpe | PSR | DSR | adj. DSR | eff. bars | stream corr | design effect |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | -0.0318 | 0.397 | 0.038 | 0.046 | 6,897 | 0.184 | 2.47 |
| sig:volume (best) | 0.2266 | 0.968 | 0.634 | 0.276 | 4,191 | 0.410 | 4.07 |
| sig:range | 0.1737 | 0.924 | 0.463 | 0.195 | 3,704 | 0.489 | 4.60 |

The key structural reading: **the controller's positions are nearly uncorrelated
across symbols (0.184) while every signal's are strongly correlated (0.35-0.57).**
That is expected — a signal computes the same feature on 8 correlated majors, so it
is close to *one* common bet, whereas the controller's idiosyncratic positions are
closer to 8. The consequence is that the signals' honest MDE95 is ±0.43-0.51 rather
than the i.i.d. ±0.24, i.e. **a signal's apparent power is about a quarter of what
its bar count suggests.** This is exactly the over-confidence round 25 was built to
expose, and it is the single most important number in the run.

### 7.2 The verdict: nothing promotes, and the family-wise test agrees

All 8 candidates `keep-off`; SPA p = 0.4494, best = `sig:volume`, Rejects = [none],
K = 9, T = 15,904 (the first bar of each 1,136 folds carries no exposure, so the
family-wise test trims 17,040 → 15,904). The family is worth **3.63 effective
trials of 8** (`excessCorr` 0.172), `maxPair` = `sig-agreement ~ sig-range` at
r = 0.78.

The best candidate is `sig:volume`: pooled Sharpe **0.2266**, PSR 0.9685 — but
DSR 0.6337 and, honestly, **adjusted DSR 0.2758** at 4,191 effective bars. PSR
0.97 is the number that *looks* publishable; the design-effect-adjusted DSR 0.28 is
the one that is true.

### 7.3 Which hurdle actually bound

Of the three round-25 hurdles, **all 8 candidates passed `requireBreadth` and all 8
failed `requireSharpeDiff` and `minDsrAdjusted`.** Three candidates (range, volume,
autocorr) won *every one* of the 142 fold windows, hitting the sign test's
resolution floor exactly (p = 2^-142 ≈ 1.8e-43), while their paired Sharpe
difference was insignificant (best: t = 0.86, p = 0.196 for volume).

That is not a contradiction — it is the finding. The candidate is *consistently
slightly better* than a near-zero baseline in almost every window (so the sign is
unanimous), but the *magnitude* of the improvement is not distinguishable from
noise because the per-window differences swing widely. **The breadth hurdle is
therefore non-discriminating in this regime**: passing a sign test against a weak
baseline is nearly automatic, its floor is 2^-C, and it separated nothing (8/8
passed). The binding hurdles are the magnitude ones. Round 26 should either give
`requireBreadth` a magnitude floor or replace it (see `TODO.md`). **Resolved in round
26 (R26-7):** the sign test is now a reported statistic only, and the shipped
dependence gate is magnitude (`requireSharpeDiff`) + stability
(`requireClusterStability`, `clusterStability` in `dependence.js`).
**Correction (round 26b, `BUGS.md` #39):** the `requireBreadth` numbers in this
section were produced by a `pairedClusterSignTest` that compared *all-but-window-c*
(the delete-one-cluster jackknife input) rather than each window on its own, so the
"8/8" and "won every one of the 142 fold windows / p = 2^-142" figures are
leave-one-out sign statistics, not the per-window win counts the surrounding text
describes. The per-window form is now the shipped behaviour. The *conclusion* —
that breadth separated nothing and belonged out of the gate — is unaffected (it is
also why the hurdle was reported-only); the exact counts are superseded.

### 7.4 Costs kill every signal, and it is not close

| candidate | turnover | gross P&L | break-even cost |
| --- | ---: | ---: | ---: |
| baseline | 138 | -0.0137 | -0.99 bps |
| sig:volume | 2,402 | 0.8335 | **3.47 bps** |
| sig:range | 3,476 | 0.6430 | 1.85 bps |
| sig:autocorr | 3,189 | 0.3206 | 1.01 bps |
| sig:momentum | 3,353 | 0.1626 | 0.48 bps |
| sig:frac-momentum | 8,808 | 0.0831 | 0.09 bps |

`breakEvenCostBps` is the per-unit-turnover cost at which the gross edge is exactly
consumed. Every signal needs **0.09-3.47 bps**, against a realistic 1h taker cost of
5-10 bps. The signals trade **17-64× the baseline's turnover** with almost no
abstention (`nonZero ≈ 0.933`, `meanAbsPos ≈ 0.45`). The cost ladder confirms the
whole family is dead at every level — and note the *baseline itself* is already
Sharpe -0.19 at 5 bps, so "do nothing" would beat both.

This is the most actionable single fact in the run: **the signal family's problem is
turnover, not signal quality.** Its gross edge per unit of turnover is 0.1-3.5 bps
and it needs to be 5-10× that, which means holding positions far longer than one
bar (or a much stronger signal). The position policy (`deadZone 0.05`, `scale 1`) is
currently untuned and is the obvious knob.

### 7.5 The baseline is effectively a no-op

The shipped controller, evaluated honestly, produces `meanAbsPos 0.0375` and
turnover 0.12/fold across 17,040 bars, for pooled Sharpe -0.032 and a *negative*
break-even cost. Its per-fold positive fraction is 0.382, its mean fold Sharpe
-0.0037 — indistinguishable from zero. So this A/B is really "signal vs doing
nothing", and on this data the answer is "doing nothing is also fine". Two readings
are possible and the run cannot separate them: (a) the controller has no edge on 1h
crypto, or (b) its outputs hover near 50 (no confidence) so the dead zone keeps it
flat. The report does not expose the model's own training counters, so (b) is not
testable from the artifact — that is a gap worth closing (see `TODO.md`).

### 7.6 Concentration: the surviving edge lives in ~20 folds

Recomputing per-fold gross P&L from `folds.jsonl` (10,224 scored fold-passes) is
sobering. For `sig:volume`, the best 20 of 1,136 folds carry **108% of the gross
edge** — the remaining 1,116 folds are net negative. Its positive sum is +4.97 and
its negative sum -4.13, so the net 0.83 is a **17% residual of two ~5-unit opposing
flows**, and 589/1,136 folds (52%) are positive. Most signals are worse:
`sig:autocorr` has the top 20 folds at 293% of its gross; `sig:accel` 15.8× the
whole edge in the top 20.

The signal family's edge is a thin, high-variance residual concentrated in a
handful of episodes. The round-25 gate did not have to be told this — the clustered
Sharpe-difference test and the adjusted DSR already failed it — but a reader could
mistake PSR 0.97 for a result, so a concentration readout belongs in the report
(see `TODO.md`).

### 7.7 What this means for the next run

1. **Do not re-run this experiment bigger.** The law in §4 makes it unaffordable
   (2,200 bars × 8 streams × 7 mechanisms ≈ 190 h) and §7.4/§7.6 say the ceiling is
   the cost structure, not the sample size. More bars buys significance for an edge
   that cannot pay for itself.
2. **Fix the economics before the statistics.** Sweep the position policy /
   turnover (offline if the pre-policy signal is journaled) so a candidate's
   break-even clears 5-10 bps, *then* spend compute on power.
3. **Buy diverse streams, not bars.** Adding non-crypto streams lowers the design
   effect (effective bars) and costs linearly, whereas bars cost quadratically.
4. **Parallelise the fold loop** so any of the above is affordable at all (§4,
   `OPTIMIZATION.md` "Round 25b").
5. **Tighten the gate's discriminating power** (breadth floor; concentration
   readout) and **surface the model's training counters** so "no edge" can be told
   apart from "never trained".

---

## 8. The round-26 controller / A-B fidelity sweep — why §7's `baseline` row is not the shipped model

The round-26 plan (§7.7) was to attack the economics: parallelise the fold loop,
journal the pre-policy signal, sweep the position policy, buy diverse streams. The
user's instruction before implementing any of it was: *"do a sweep + bug check on
all controllers, just to be 100% sure no bug is causing faulty readings."* That
sweep is written up in `ROADMAP.md` round 26 (the inventory, the invariants, the
fixtures). Its **first pass** found one defect that invalidates a reported reading
(#33), two that make a reported comparison unfair (#34/#35) and — in the **second
pass** (§8.4) — two more measured defects in the labels and their reporting
(#36/#37), together with the correction of a cost claim the plan was about to size
compute on. The full write-ups are `BUGS.md` #33-#37; this section records the
evidence and what it does and does not change.

### 8.1 The finding

The A/B's controller factory streams the **whole growing candle prefix** into
`getSignal`:

```js
// src/analyze.js — makeControllerModelFactory, fit() and predict()
for (let i = 1; i <= testStart; i++) ctl.getSignal(candles.slice(0, i), 1);
... ctl.getSignal(candles.slice(0, t + 1), 1)
```

Production does not. `legion/runner.js` pushes one candle, holds `state.cache` at
`maxCache`, and `legion/workers.js` passes `state.cache.slice(-cacheSize)` — the
last `cacheSize` candles — to `getSignal`. The controller trims its own candle
table to `cacheSize` (`_getRecentCandles`'s `DELETE … NOT IN (… LIMIT
cacheSize)`), so a production call's not-yet-seen candles are the newly arrived
one(s) and `recentCandles` is one candle long. Fed the prefix, the cleanup has
already discarded everything older than `cacheSize`, so the next call
**re-inserts the whole trimmed history** and `recentCandles` becomes that history.
`_updateOpenTrades` then tests every open trade's TP/SL against every one of those
ancient bars.

Measured in the browser harness (instrumenting `_getRecentCandles`;
`cacheSize = 120`; 260 synthetic candles; identical seed, candles and controller):

| call | `recentCandles.length` (prefix) | (production window) |
| ---: | ---: | ---: |
| 1 | 1 | 1 |
| 130 | 10 | 1 |
| 200 | 80 | 1 |
| 260 | 140 | 1 |

and the labels it produces:

| run | wins | losses | `trainingSteps` | open at end |
| --- | ---: | ---: | ---: | ---: |
| prefix (current A/B) | 78 | 144 | 233 | 1 |
| window (production-shaped) | 156 | 64 | 231 | 10 |

At 600 bars the emitted confidence also differs (`fracOutsideDeadZone` 0.328 vs
0.224, `probStd` 2.55 vs 2.27).

### 8.2 What this invalidates, and what it does not

- **Invalidated:** §7.5's reading of the `baseline` row ("the shipped controller is
  effectively a no-op"; `meanAbsPos 0.0375`, `tradeCount 10230`, pooled Sharpe
  −0.0318, and the §7.6 concentration numbers for the baseline). Those numbers
  describe a controller trained on mislabelled trades. They must be re-derived
  after the fix before any conclusion is drawn about the shipped model's edge.
  **The cost claim is corrected:** round 25c expected the fix to remove a large
  per-call churn term, but measuring the control shows a production-shaped window
  costs the same per call as the prefix in the shim (56.6 vs 55.4 ms/call at calls
  150-200; equal in every block). So the wall-clock figures in §4 may move — but by
  an unmeasured amount, and `OPTIMIZATION.md` "Round 26b" now carries the measured
  per-call breakdown (inference ≈ 54 %, full-state checkpoint ≈ 25 %, training
  ≈ 14 %, churn ≤ 8 %) instead of the churn attribution.
- **Not invalidated:** every signal-family row of §7, and §7.2/§7.3/§7.4's verdict.
  `makeSignalForVariant` returns `variant.signal(view, test)` — pure array math on
  the view — and never constructs a controller, so the signal candidates were
  measured on exactly the data they claim. The family-wise null (SPA p = 0.4494),
  the "all 8 fail `requireSharpeDiff` and `minDsrAdjusted`", the breadth hurdle
  being non-discriminating, and the turnover/break-even table all stand. Round 26
  therefore still starts from "the ceiling is economic", but it no longer assumes
  the baseline comparison is meaningful.
- **Changed interpretation of "no edge vs no confidence":** §7.5 offered (a) no
  edge or (b) outputs near 50 with the dead zone keeping it flat, and said the
  report cannot separate them. The sweep shows a third possibility that was
  actually in play — a **mislabeling** path — and it also shows the readiness
  counters that would settle (a)/(b) are computed by the factory's `stats()` and
  thrown away (`BUGS.md` #35). Both are fixed in round 26 (R26-0, R26-2).

### 8.3 Why the sweep is a permanent artefact, not a one-off

The defect is a **caller-contract** defect: nothing in the suite asserted what the
A/B passes a model per call, so a wrong window was invisible for six rounds of
green tests. The sweep in `ROADMAP.md` therefore ends in contract tests (input
width, increment size, no pre-entry close, non-vacuity of the training counters),
not just in a patch — the same discipline #22 applied to the audit's reachability.

### 8.4 The second pass (round 26b): the control measurement, the cost breakdown, and three more findings

The user asked for the same request again — another sweep, a coherence and
research-grounding check, more tests, and an optimisation of the analyse run. The
second pass re-ran the sweep against the *plan's own assumptions* and produced
four things worth recording here.

**1. The round-25c cost claim does not survive a control.** Same controller, seed,
candles, `cacheSize = 120`, one call per bar, mean ms/call by call block (shim):

| calls | window (production-shaped) | prefix (current A/B) |
| --- | ---: | ---: |
| 1-20 | 12.1 | 6.8 |
| 20-50 | 43.9 | 45.2 |
| 50-100 | 56.1 | 51.2 |
| 100-150 | 56.9 | 53.7 |
| 150-200 | 56.6 | 55.4 |

Window and prefix are the same, block for block. The `8.8 → ~50 ms/call` ramp that
round 25c called the onset of the churn is **early-run warm-up** and appears in
window mode too. Over 600 bars the whole difference is ≤ 8 % (51.2 vs 55.1
ms/call), while the prefix's `recentCandles` grows to 480. So #33 is a correctness
fix, its speed benefit is unmeasured, and the corrected native constant must be
re-measured after it lands. `OPTIMIZATION.md` "Round 26b" replaces the round-25c
section.

**2. Where the per-call cost actually is.** Instrumenting one warm controller over
100 window-shaped bars: `predict` 53.7 %, `dumpState()` 24.6 %, `train` 14.2 %,
`broadcastMemory` 0.5 %, rest ~7 %. `dumpState()` rewrites the *entire* ensemble
state to SQLite on every call, and the A/B never reads it back — so about a quarter
of every fold is a checkpoint nobody loads. That is the largest semantics-preserving
throughput lever found in the sweep (new item R26-12).

**3. Two more label defects (#36).** A bar that spans both barriers is booked as a
win (take-profit tested first), a gapped stop is filled at the stop price, and an
untriggered trade is never closed or labelled. Measured exposure at the shipped
factors: ~0.03 % of 1h bars have both barriers inside the range at the entry price
and ~1.0 % span ≥ 3 ATR; and the window shape's label base rate is 27 % TP
(155/411 on 600 bars) versus the prefix's 57 % (322/248).

**4. A readings defect (#37).** The A/B reports no label base rate and no skill
score, so a 27 %-base-rate problem reads as "71 % accurate" for a model that always
predicts the stop. Fixed by R26-2/R26-8.

The sweep matrix, with one row per component × invariant and a status cell for
each, is written to **§9** as part of round 26 (this section is the finding; §9 is
the standing audit). The plan's response to all of the above — the new items, the
test additions, and the corrected expectations — is `ROADMAP.md` round 26,
"Revision 2".

---

## 9. The round-26 sweep matrix — component × invariant × status (standing audit)

R26-1's permanent output. §8 is the *finding* (the prefix/window defect and the
second pass); this is the *standing audit*: every stateful component classified, the
ten invariants checked for each, the sixteen verified suspects resolved, and the
contract test that pins each finding. It is re-checked whenever a stateful component
changes — the discipline #22 applied to the audit's reachability, applied to the
controller's whole caller/callee surface.

**Status legend.**

- **fixed** — a defect was confirmed, written up in `BUGS.md`, fixed, and a contract
  test now pins it;
- **clean** — checked, no defect; the proving test is named;
- **documented** — a real limitation or a deliberate scope decision, recorded with
  the remedy/decision; not silently dropped;
- **pending** — a cell whose remedy is a later round-26 item (R26-4/R26-7/R26-8/
  R26-10/R26-13/R26-14); listed so it is not mistaken for resolved;
- **pure** — a stateless module re-checked for contract drift only (already dense-tested).

### 9.1 Component inventory

| class | components |
| --- | --- |
| **A** online controller | `HiveMindController` core: `getSignal`, `_getRecentCandles`, `_updateOpenTrades`, `_processClosedTrades` |
| **B** controller modules | `controller/{candles,trades,accuracy,features,database}.js` |
| **C** online model | `HiveMind` + `kernels/*`, `memory/*`, `ensemble/*`, `training/*` |
| **D** online pipeline | `legion/{runner,batch,workers,state}.js`, `consolidation_worker.js` |
| **E** online support | `observer/{collector,legion_metrics,alerts}.js`, `http_server_worker.js`, `dashboard.js` |
| **F** pure | `analysis/*` (incl. `parallel.js`; `fold_worker.js` is its process entry), `indicatorProcessor`, `candle_quality`, `candles_audit`, `price_precision`, `consolidation_logic`, `legion/{sanitize,rng,structure,serialization,signals}.js`, `analyze.js` |

### 9.2 The ten invariants

1. **Input-shape fidelity** — every caller passes the callee the same *shape* input
   production passes (width, increment, ordering, read-vs-mutate, window-vs-history).
2. **Ordering/timestamp assumptions** — anything assuming strict order must guard.
3. **Read-vs-write** — a nominally-read op that mutates state a later statistic
   depends on must be documented, and the mutation unit made deterministic.
4. **Counter provenance** — every reported number is the one the code path produced.
5. **Boundary degradation** — shuffled / duplicate-timestamp / corrupt / `NaN` /
   short / empty inputs degrade at the boundary, never silently mislabel.
6. **Determinism under a seed** — same `(variant, fold)` ⇒ same positions, serial
   *and* parallel.
7. **Resource bounds** — no unbounded growth (`open_trades`/`closed_trades`,
   `state.cache`, model dirs, the 1-row-per-call drain).
8. **Dead guards** — a guard that can never fire is a false certificate.
9. **Label realism & lifecycle** — the labeler resolves an unresolvable bar
   conservatively when asked, gives *every* opened trade a bounded horizon, and
   reports a base rate the accuracy is referenced to.
10. **Cost & persistence attribution** — cost is attributed to the stage that
    produces it, and no full-state dump is written that is never read back.

### 9.3 The matrix

Rows are the invariants, columns the component classes (§9.1). Cells give the status
and the pin.

| invariant | A controller core | B controller modules | C HiveMind | D pipeline | E support | F pure |
| --- | --- | --- | --- | --- | --- | --- |
| 1 input shape | **fixed** (R26-0; `analyze.test.js` window contract) | **fixed** (R26-0; same) | **clean** (`features.js` consumes the fed window) | **clean** (production is the reference; `runner_smoke`) | **clean** (read-only) | **clean** |
| 2 ordering | **fixed** (R26-0 timestamp guard; `core.test.js` E/F) | **clean** (`candles.js` filters non-finite) | **n/a** (no candles) | **clean** (monotonic feed; `fetcher`/`runner_smoke`) | **clean** | **clean** |
| 3 read-vs-write | **documented** (`getSignal` trains by design; the fold is the parallel unit — R26-4) | **documented** (same) | **documented** (`predict` also trains, by design) | **clean** | **clean** | **clean** |
| 4 counter provenance | **fixed** (R26-2 lifecycle counters; `core.test.js` I) | **fixed** (R26-2 persistence) | **clean** (`diagnostics()` vs disk; `sanity` I) | **clean** (`observer` recomputes) | **clean** | **clean** (`folds.jsonl` repro; R26-3) |
| 5 boundary degrade | **fixed** (R26-0 insert guard; R26-2 dropped-candle count; R26-10 fixture matrix **pending**) | **fixed/clean** (`guards.test.js`) | **clean** (`guards.test.js`) | **clean** (malformed line counted; `runner_smoke`) | **clean** | **clean** (named errors) |
| 6 determinism | **clean** (`withSeed`; deterministic positions test) | **clean** | **clean** (`sanity` E) | **clean** | **clean** | **fixed** (R26-4: the async twins are byte-identical to the serial ones; the worker dispatch is pinned node-only) |
| 7 resource bounds | **documented** (`open_trades` unbounded under the default `optimistic`; the opt-in `triple` bounds it — R26-11; 1-row-per-call drain surfaced) | **documented** | **clean** (vault capacity) | **clean** (failure budget; `worker_pool`) | **clean** | **clean** (per-fit reclamation, R24) |
| 8 dead guards | **fixed** (R26-2: the dead `undertrained` gate removed; `ready` is the gate) | **fixed** (R26-2) | **clean** | **clean** | **clean** | **fixed** (R26-2 readiness; `analyze.test.js`) |
| 9 label realism | **fixed** (R26-11 opt-in `conservative`/`triple`; `core.test.js` J) | **fixed** (R26-11; `trades.js`/`accuracy.js`) | **n/a** | **clean** (labels created by A/B) | **clean** | **fixed** (R26-2 base rate/skill block) |
| 10 cost/persistence | **fixed** (R26-12 `saveInterval`; `checkpoint_throttle.test.js`) | **fixed** (R26-12) | **fixed** (R26-12 `flushState`) | **clean** | **clean** | **clean** (`timings` per row) |

### 9.4 The sixteen suspects, resolved

| # | suspect | status | evidence / pin |
| ---: | --- | --- | --- |
| 1 | `BUGS.md` #33 prefix/window defect | **fixed** (R26-0) | `analyze.test.js` window contract + contiguous window; §8.1 |
| 2 | `_updateOpenTrades` no timestamp guard | **fixed** (R26-0) | `core.test.js` section E; native `core.test.js` |
| 3 | unguarded open-trade insert (duplicate PK) | **fixed** (R26-0) | `core.test.js` section G; `openTradeWriteErrors` non-enumerable |
| 4 | `BUGS.md` #34 position-policy asymmetry | **fixed** (R26-3) | `analysis.test.js` + `analyze.test.js` unified-policy checks |
| 5 | `BUGS.md` #35 readiness discarded + dead guard | **fixed** (R26-2) | `analyze.test.js` readiness + `core.test.js` section I |
| 6 | two full-table `SELECT`s/call + unbounded `open_trades` | **documented** | deliberate under the default labeller (a default change is forbidden); the opt-in `triple` policy bounds the backlog (`core.test.js` J); the scans are indexed by timestamp. Not an arithmetic defect |
| 7 | re-insert churn (#33 cost half) | **fixed** (R26-0) | control measured equal per call (≤ 8 % over 600 bars); cost claim withdrawn — §8.4(1), `OPTIMIZATION.md` "Round 26b" |
| 8 | silent candle drops | **fixed** (R26-2) | `core.test.js` section I: `droppedCandles` counted + surfaced non-enumerably |
| 9 | A/B fold purge exclusions not honoured | **documented** | a streaming model cannot skip bars; the window shape is now reconciled (R26-0). Recorded as a limitation, not a defect |
| 10 | warm-up depth vs production | **documented** | R26-2: `testStart >= warmup` is reported via `undertrained`; readiness (`trainingSteps > 0`) is the gate; depth is visible in the `model` block |
| 11 | #36 optimistic intrabar tie-break | **fixed** as opt-in (R26-11) | `core.test.js` J: `conservative` labels a both-barrier bar as the stop |
| 12 | #36 gapped stop fills at the stop price | **fixed** as opt-in (R26-11) | `core.test.js` J: `conservative` fills at the worst traded price |
| 13 | #36 untriggered trade never closed | **fixed** as opt-in (R26-11) | `core.test.js` J: `triple` closes at the horizon; `resolvedTimeBarrier` counted |
| 14 | `dumpState()` on every call | **fixed** (R26-12) | `core.test.js` H + `checkpoint_throttle.test.js`; identical signal stream at k = 1, 3, ∞ |
| 15 | A/B exercises only the `positive` polarity | **documented** | deliberate scope: the A/B evaluates one polarity, and the `negative` polarity is the signed mirror of the same controller (production's evolution picks between them). Recorded as a sweep item, not a defect; a polarity dimension is a future item if the family search shows it matters (R26-13) |
| 16 | back-in-time / non-contiguous mass re-insert | **fixed** (R26-0) | `analyze.test.js` contiguous-window check (every input is the advancing window; `recentCandles.length ≤ 1`) |

### 9.5 Contract tests for the invariants

The R26-10 test plan (`ROADMAP.md` Part F) is the test half of this matrix. Landed
with R26-0/2/3/11/12/4/5: **1** window contract, **2** no pre-entry close, **3** unified
policy, **4** readiness surfacing, **7** parallel = serial (R26-4; browser
byte-identity + the node-only real-worker `parallel_folds.test.js`), **11**
contiguous window, **12** label-policy fixtures (browser + native), **13** base rate
+ skill, **14** checkpoint equivalence, **17** turnover policy (R26-5; browser
section AF + the node-only spawned-CLI `analyze_cli.test.js` — the block is pure
post-processing and moves no scored number), **18** stream interval + basket
selection (R26-6; browser section AG + the analyze driver's opt-in `--interval`/
`--select-streams` checks — a design choice that cannot change how an included
stream is scored). **15** paired seeds/CRN (R26-13; browser section AH + the
node-only spawned-CLI `analyze_cli.test.js` seed aggregate — CRN is on by default
and `--crn=0` restores the historical per-variant seed, recorded in
`run.json`/`report.json` and the summary). **16** forecast block + MCS
(R26-14; browser section AI + the analyze driver's default-on `forecast` block,
DM and MCS checks and the node-only spawned-CLI `--forecast=0` — measurement
only, moving no scored number). **6** breadth replacement (R26-7; browser section
AJ — `clusterStability` hand-checked on stable/fragile/unavailable panels and the
gate fixtures proving a tiny edge fails the magnitude floor while a broad-but-thin
edge fails stability and a real spread edge passes, plus the driver's `gateOptions`
asserted in `analyze.test.js`; no new node-only block, because the change lives in
the pure dependence/walkforward layer).
**5** concentration readout (R26-8; browser section AK — `foldConcentration`'s exact
top-K/signed sums, its leave-one-fold-out Sharpe range and per-fold marginal
contribution against an independent sweep, and the run-level composition asserted in
`analyze.test.js`) and **10** report completeness (R26-8; the six-question `decision`
block, every missing input an explicit `{available:false, reason}`, rendered in the
summary). **8** the six-case boundary-degradation fixture matrix (R26-10;
`guards.test.js` section K drives the reader over empty / short / corrupt row / NaN /
duplicate timestamp / shuffled order / `maxBars`, while `core.test.js` G and the
`analyze.test.js` window contract cover the duplicate-timestamp and back-in-time
component cases) and **9** dead-guard audit (R26-10; `analyze.test.js` pins the
`undertrained` statistic to the controller's warm-up floor — not the dead
`testStart >= 40` — and the readiness gate abstains on a never-trained model). Every
cell now has a landed test. The round-26b review then completed the one R26-8
sub-clause still open — clause 6's "seeds/folds a paired comparison would need"
(`nextRunPlan.pairedUnits`, with an exact browser check) — and fixed `BUGS.md`
#38/#39/#40/#41, all shape/wiring defects in this layer that the original fixtures
could not see (`analysis.test.js` 559 → 562, `analyze.test.js` 221 → 222, ledger
2285 → 2289; the §7.3 breadth counts are superseded, see its correction note).

### 9.6 What the sweep certifies, and what it leaves open

It certifies that **no unresolved defect is causing a faulty reading**: the one
reading-invalidating defect (#33) is fixed and pinned, the two unfair-comparison
defects (#34/#35) are fixed, and the three label/report defects (#36/#37) are fixed
or made opt-in. It leaves open, deliberately and by name: the polarity scope (#15),
the purge-exclusion limitation (#9), the unbounded default backlog (#6, bounded by
the opt-in `triple`), and the pending contract tests above. None of those changes a
reported number; each is recorded so a later reader cannot mistake it for checked.

> **Update — the `20260922T204248-seed1` round-26 run (§10).** The arithmetic half of
> this certification held at scale: the corrected run's journal reproduces every
> per-fold and pooled metric exactly, with a clean audit and 4,320/4,320 base
> reuses. But the run exposed a class of defect this sweep was not looking for — a
> **reading** defect, not an arithmetic one: three of the seven mechanism candidates
> emit byte-identical positions to the baseline (#43 `sample-weights` never enables
> its mechanism; #44 `multi-probe`/`query-mod` steer a path a fold never reaches), so
> their rows and their 15 keep-off "reasons" are artefacts of a duplicated series and
> `K = 15` counts three untested candidates; and the decision block's training answer
> describes only the winning row (#45). Invariant 4 (*counter provenance*) and the
> non-vacuity discipline of #22 should be extended to **candidate liveness** — "did
> this candidate differ from the baseline at all?" — as a report-level check. See
> §10.7 and `BUGS.md` #43/#44/#45.

---

## 10. Run `20260922T204248-seed1` — the round-26 corrected power run: the fidelity fix moved exactly the rows it should have, the gate holds at every cost, and three mechanism rows turn out to carry no information (#43/#44)

This is the first full-size run made **with** the round-26 corrections — R26-0's
window-fidelity fix (`BUGS.md` #33), R26-2/R26-8's model & label diagnostics
(#35/#37), R26-3's confidence→position policy, R26-7's shipped dependence gate,
R26-12's checkpoint throttle, R26-13's CRN, R26-14's forecast/MCS panel. It is
deliberately the **same design as §5's attempt-3 power run**, so §5 and §10 are a
controlled before/after of the fidelity fix alone: 8 streams × 600 bars, 288 folds,
4,320 pooled bars, 15 variants, seed 1, `costBps 0`,
`positionPolicy {deadZone 0.05, scale 1}`, `--audit-probes=1`, `--reuse-base`. The
`configFingerprint` is unchanged (`c0ba6493`). Everything else that moved is a
round-26 report change.

### 10.1 Manifest and completion

`run.json` (fingerprint `c0ba6493`):

| field | value |
| --- | --- |
| `type` / `model` | `analyze` / `controller` |
| `files` / `streams` | 8 (candles.jsonl + the 7 `candles_*_1h` symbols) |
| `candles` / `folds` / `maxBars` | 4,800 / 288 (36 per stream) / 600 |
| `trainSize` / `testSize` | 60 / 15 |
| `probe` / `auditProbesPerFold` | 0.05 / 1 |
| `reuseBase` / `costBps` / `requireReachable` | `true` / 0 / `false` |
| `modelRetention` / `foldLog` / `saveInterval` | `discard` / `all` / `inf` |
| `labelPolicy` / `labelHorizonBars` | `optimistic` / `null` |
| `concurrency` / `intervalBars` / `streamSelect` | 1 / 1 / `false` |
| `commonRandomNumbers` / `forecast` / `decision` | `true` / `true` / `true` |
| `gate` / `gateAlpha` / `gateOptions` | `dependence` / 0.05 / `{requireSharpeDiff, requireClusterStability, minDsrAdjusted 0.95, alpha 0.05, periodsPerYear 252}` |
| `trials` / `positionPolicy` | 15 / `{deadZone 0.05, scale 1}` |
| `seed` / `node` | 1 / `v25.9.0` |

`progress.json` ends at `phase: complete`, counters 4,320 score / 4,320 base /
4,320 probe = 12,960 / 12,960 events, 15/15 variants, `etaMs: null`.
`durationMs` = **28,418,998.5 ms (7.90 h)**; `run.log` has the matching
`analyze complete` line. Artifacts:

```
run.json              1,943 B
progress.json           816 B
run.log               4,323 B    (18 journal lines: 1 start, 15 checkpoints, complete)
partial-report.json 533,243 B
report.json         551,481 B    (the verdict)
folds.jsonl      12,955,808 B    (12,960 lines = 4,320 score + 4,320 base + 4,320 probe)
```

Two new certificates are present and clean:

```
policyRoundTrip: { ok: true, mismatch: 0, folds: 288 }   // R26-3: confidence -> position -> report
audit:           clean over 4,320 probe passes, 0 violations, 288 base passes reused per variant
```

### 10.2 The verdict: same in kind as §5, and now cost-robust

**All 14 candidates `keep-off`; nothing promotes.** Family-wise:
`SPA p = 0.4731, best = sig:momentum, Rejects = [none], K = 15, T = 4032`.

| candidate | kind | pooled Sharpe | DSR | adj. DSR | turn. | break-even | fold-win | reachable | reasons |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **baseline** | mechanism | **-0.1147** | 0.0124 | 0.0235 | 31.1 | -2.58 bps | — | 229/288 | — |
| surprise-gate | mechanism | -0.0284 | 0.0295 | 0.0344 | 30.9 | -0.67 | 0.1563 | 226/288 | 7 |
| homeostasis | mechanism | -0.1627 | 0.0071 | 0.0185 | 30.6 | -3.52 | 0.4375 | 219/288 | 7 |
| multi-probe | mechanism | **-0.1147** | 0.0124 | 0.0235 | 31.1 | -2.58 | 0.0000 | 229/288 | 5 |
| query-mod | mechanism | **-0.1147** | 0.0124 | 0.0235 | 31.1 | -2.58 | 0.0000 | 229/288 | 5 |
| pca-hash | mechanism | -0.1104 | 0.0130 | 0.0240 | 31.1 | -2.48 | 0.0104 | 228/288 | 6 |
| sample-weights | mechanism | **-0.1147** | 0.0124 | 0.0235 | 31.1 | -2.58 | 0.0000 | 229/288 | 5 |
| **sig:momentum** | signal | **1.0848** | **0.9984** | 0.7375 | 810.4 | **14.64 bps** | 0.4931 | 288/288 | **2** |
| sig:frac-momentum | signal | -0.4185 | 0.0003 | 0.0091 | 2091.9 | -1.67 | 0.4479 | 288/288 | 7 |
| sig:vol-regime | signal | -0.3135 | 0.0011 | 0.0053 | 677.6 | -4.34 | 0.4826 | 288/288 | 6 |
| sig:agreement | signal | 0.3912 | 0.4381 | 0.1811 | 1024.6 | 3.71 | 0.4618 | 288/288 | 5 |
| sig:range | signal | 0.4490 | 0.5366 | 0.2265 | 832.8 | 5.57 | 0.4097 | 288/288 | 5 |
| sig:volume | signal | -0.0008 | 0.0380 | 0.0381 | 581.7 | -0.01 | 0.4792 | 288/288 | 5 |
| sig:autocorr | signal | -0.0996 | 0.0147 | 0.0240 | 793.2 | -1.23 | 0.4688 | 288/288 | 6 |
| **sig:acceleration** | signal | **1.0194** | **0.9953** | 0.8343 | 860.5 | **11.57 bps** | 0.5347 | 288/288 | **1** |

Baseline detail: PSR 0.3175, MDD 0.0195, hit 0.4947, grossPnl -0.0080, tradeCount
2,362, nonZero 0.5081, meanAbsPos 0.0289; folds mean -0.0441 / median 0 / std 3.6914
/ positive 0.3646. Power (baseline): SE 0.2415, **MDE95 ±0.4734**,
`underpowered false`, `barsToDetect1` 969; under the cluster jackknife
**SE 0.5328, MDE95 ±1.0442, `underpoweredDependent true`, inflation 4.87×,
effective bars 887.9**. The signals' own fold-cluster design effects differ
(momentum 3.62, accel 2.46, vol-regime 2.73, frac-momentum 7.00; the baseline's
4.87), and their positions are more correlated across symbols than the controller's
(mean pairwise stream corr 0.520 for momentum vs 0.354 for the baseline) — the two
dependence readings (fold-cluster jackknife vs stream equicorrelation) are both
reported per variant and need not agree.

**The cost ladder promotes `[none]` at all four rungs** (0 / 2 / 5 / 10 bps), unlike
§5 where 2 bps promoted `sig:acceleration` (`BUGS.md` #27). The round-26 gate
replaced the raw fold-win / positive-fold hurdles with the dependence-adjusted DSR
floor, which is *much* stricter, so the verdict no longer flips with the unstated
cost assumption. At 5 bps momentum's fold-win does cross 0.5 (0.5104) yet it still
keeps off, on adjusted DSR 0.3881; at 10 bps both real candidates keep off on
adjusted DSR 0.1344 / 0.0745.

Family correlation: `excessCorr` 0.0996, `effectiveTrials` **6.10 of 14**,
`maxPair = sig-agreement ~ sig-range r = 0.8098`; `sig:momentum ~ sig:acceleration`
r = 0.697, `sig:momentum ~ sig:range` 0.709. Forecast/MCS: base rate 0.5005,
baseline brier 0.2522 / log 0.6975; **MCS90 = MCS95 = the 7 mechanism variants**
(baseline + the 6 flags); all 8 signals eliminated (each at p = 0.000999),
`lastPValue` 0.4346 — see §10.8.

### 10.3 The fidelity fix moved exactly the rows it was supposed to — and left the signals alone

§5 and §10 are the same design, so the delta is the round-26 correction (principally
#33). It is a clean causal fingerprint: the *mechanism* rows move enormously, the
*pure-array-math signal* rows are reproduced to ~1-2 % (a change to the controller
path cannot move a signal).

| variant | §5 Sharpe | §10 Sharpe | §5 break-even | §10 break-even |
| --- | ---: | ---: | ---: | ---: |
| baseline | **+0.4387** | **-0.1147** | 12.42 | -2.58 |
| surprise-gate | -0.3766 | -0.0284 | -10.39 | -0.67 |
| homeostasis | +0.3090 | -0.1627 | 7.83 | -3.52 |
| multi-probe | +0.3101 | -0.1147 (≡ baseline) | 8.92 | -2.58 |
| query-mod | **+1.0025** (DSR 0.9992) | -0.1147 (≡ baseline) | 33.73 | -2.58 |
| pca-hash | -0.0037 | -0.1104 | -0.09 | -2.48 |
| sample-weights | +0.1945 | -0.1147 (≡ baseline) | 4.31 | -2.58 |
| sig:momentum | 1.1059 | 1.0848 | 15.02 | 14.64 |
| sig:frac-momentum | -0.4330 | -0.4185 | -1.66 | -1.67 |
| sig:vol-regime | -0.3223 | -0.3135 | -4.46 | -4.34 |
| sig:agreement | 0.4044 | 0.3912 | 3.83 | 3.71 |
| sig:range | 0.4586 | 0.4490 | 5.70 | 5.57 |
| sig:volume | 0.0173 | -0.0008 | 0.27 | -0.01 |
| sig:autocorr | -0.1146 | -0.0996 | -1.42 | -1.23 |
| sig:acceleration | 1.0502 | 1.0194 | 11.95 | 11.57 |

Three consequences:

1. **§5.2's reading is falsified.** The buggy controller appeared to be "the
   strongest mechanism" (+0.4387) and `query-mod` appeared to be a DSR-0.9992,
   33.7 bps, low-drawdown star that missed promotion by a hair. With the
   production-shaped window, the baseline is a *negative* near-no-op and `query-mod`
   is identical to it. Neither was a real reading; §5 is annotated accordingly.
2. **§8.2's "not invalidated: every signal-family row" is now *demonstrated*, not
   argued.** Every signal Sharpe, break-even and turnover reproduces. The
   family-wise null, the signals' cost/participation profile and §7's economic
   verdict all stand on this design.
3. **Round 26 cost 34 % of the wall clock.** The identical design took 11.98 h in §5
   and 7.90 h here. The measurable causes are R26-12's checkpoint throttle
   (`saveInterval: "inf"`; §8.4 attributes ≈25 % of per-call cost to the
   never-read `dumpState()`) plus the #33 window fix's removal of the re-insert
   churn (measured ≤ 8 %); this run is *not* a controlled measurement of either, so
   treat 34 % as the combined effect, not an attribution.

### 10.4 The baseline is a trained model with negative skill

§7.5 could not separate "no edge" from "never trained" and (b) "outputs near 50 kept
flat by the dead zone"; R26-2/R26-8 close that. Every model-backed variant reports
`trainingSteps 170,004`, `warmErrors 0`, `notTrainedFolds 0`, `undertrainedFolds 0`,
`quarantinedRows 0`, `openTradeWriteErrors 0`, `resolved {takeProfit 64,197,
stopLoss 105,447, total 169,644}`, `heldBars {count 185,937, max 1, mean 1}`,
`status: "base-rate"`, `baseRate 0.3784`, **`brierSkill -0.0751`,
`accuracySkill -0.1379`**.

So the answer is (a): the controller *trained, on ~170k labelled bars, and is worse
than its own base rate*. The near-flat positions (meanAbsPos 0.0289, nonZero 0.508)
and the 59/288 folds whose audit probe is **vacuous** (every emitted position is
zero, so perturbing the future cannot change anything) are the consequence of a
model with no skill, not of a dead code path. That is the honest "no edge on this
data" reading, and it is now *evidence* rather than inference.

### 10.5 What binds, and the closest-to-promoting candidate yet

* **`sig:acceleration` now fails exactly one hurdle**: the dependence-adjusted DSR
  floor (0.8343 < 0.95). It passes `requireSharpeDiff` (paired dSharpe 1.1341,
  se 0.6684, **t 1.6969, one-sided p = 0.0493**), the stability half (all 36
  leave-one-window differences positive) and the fold-win half (0.5347). In §5 the
  same candidate bound on fold-win 0.4896 (three folds short); restoring the window
  fidelity moved it above 0.5 and left the DSR floor as the only binding hurdle.
* **`sig:momentum`** binds on **fold-win 0.4931** (one fold short of 0.5) and the
  adjusted DSR (0.7375). Its paired test is significant (dSharpe 1.1995, se 0.6136,
  p = 0.0293), its stability is perfect (`full` 1.1995, worst-window delta 0.8515,
  all 36 positive), and its width/index breadth is 19/36 (p = 0.434).
* Both are *magnitude*-limited, not cost-limited: `nextRun.cheapestFlip` names the
  binding lever as **magnitude** (needed ≈ 0.9022 = 1.96 × seCluster; current
  1.1995; factor 0.752). Concentration is real but not a lottery: top-1 fold 4.6 %,
  top-5 22.1 %, top-20 69.3 % of a gross 1.1865 built from +2.0010 / -0.8145, and
  the leave-one-fold-out Sharpe stays in [1.045, 1.139] (worst #262).
* Sizing: effective bars 1,192 (design effect 3.62); `mde95` 0.474, dependence-corrected
  0.902; `underpowered: false` for the *candidate* (`barsToDetectObserved` 823,
  `barsToDetectDependent` 3,512); a 576-fold run is projected at 56.8 M ms
  (≈15.8 h, a lower bound — the replay is O(n²)); the paired test would need **37
  clusters** to resolve the observed difference (64 for the dependence-corrected
  target) against the 36 it has.

**A caveat the two runs together expose.** §7's 2,200-bar signal-family run put
`sig:momentum`'s break-even at **0.48 bps** (and `sig:volume`, at 0.2266, was the
family's best). This 600-bar design puts it at **14.64 bps** — clearing a realistic
5-10 bps taker cost, which §7.4 concluded no signal did. The per-bar turnover is
essentially the same (0.19/bar in both) while the gross P&L per bar is ~29× higher
in the recent window, i.e. **the momentum edge is concentrated in the most recent
~600 bars and is absent over the longer sample**. The two runs do not contradict each
other's method; they are different samples. But it means the "costs kill every
signal" verdict (`METHOD.md` §2 rests on it) is *window-dependent* and should not be
treated as a property of the strategy. The dependence-adjusted DSR — the shipped
gate — is the statistic that is stable across both windows (0.7375 / 0.8343 < 0.95
in both), which is the argument for keeping it as the decision axis rather than the
break-even.

### 10.6 The journal verifies the report end-to-end (again)

`folds.jsonl` carries every pass, so the report was recomputed here from the journal
alone (no model, no run process). All exact:

1. **Shape** — 12,960 lines = exactly 4,320 score + 4,320 base + 4,320 probe; 288 of
   each per variant.
2. **Base reuse / determinism** — 4,320/4,320 base rows are `reused: true` and
   byte-identical to their scored row (`0` signal mismatches).
3. **Look-ahead audit** — 0 violations across 4,320 probe passes: for every fold the
   emitted position at `probeIndex` is unchanged when only information after that bar
   changes, while the later bars do move (`viewDiffers`), so no probe is vacuous in
   the fold. Recomputing reachability per variant reproduces `report.audit.reachableFolds`
   **exactly on all 15 variants** (baseline 229, surprise 226, homeostasis 219,
   multiprobe 229, querymod 229, pca-hash 228, sample-weights 229, every signal
   288/288). The 59 unreachable baseline folds are the all-abstain folds.
4. **Per-fold metrics** — recomputing from the journaled positions (`signals` is the
   position *as computed at bar i*; the traded position at bar i is `signals[i-1]`,
   the first bar flat) reproduces, for **all 4,320 folds with 0 mismatches**:
   `netSharpe` (sample-sd, annualised √252), `turnover` (total variation of the
   lagged position), `meanAbsPosition`, `nonZeroFraction` and `maxDrawdown`.
5. **Pooled metrics** — concatenating the per-fold realised net returns
   (`signals[i-1] × returns[i]`) reproduces `grossPnl` **and** `perPeriodNetSharpe`
   **exactly for all 15 variants** (agreement to machine precision), hence
   `netSharpe` too. PSR/DSR come from the same locked `backtestMetrics` primitive.

So the verdict (and every number in §10.2/§10.3) is citable: it is reproducible from
the uploaded journal end to end. The upload set is `run.json` + `report.json` +
`run.log` (+ `folds.jsonl` for the offline recomputation); `models/` was reclaimed
(`modelRetention: discard`).

### 10.7 Three of the seven mechanism candidates carry no information (`BUGS.md` #43/#44)

Comparing the journaled position series fold by fold:

| candidate | folds byte-identical to baseline | maxAbsDiff |
| --- | ---: | ---: |
| surprise-gate | 189/288 | 0.1488 |
| homeostasis | 42/288 | 0.1598 |
| pca-hash | 282/288 | 0.0581 |
| **multi-probe** | **288/288** | **0** |
| **query-mod** | **288/288** | **0** |
| **sample-weights** | **288/288** | **0** |

Three candidates emit **byte-identical positions to the baseline on every fold**, so
their rows (and the 15 keep-off "reasons" they contribute: `fold win fraction 0 <
0.5`, `cluster stability 0 of 36`, `dSharpe=0 se=0 t=0 p=0.5`) are artefacts of a
duplicated series, and `K = 15` counts three candidates that were never exercised.
`familyCorrelation.effectiveTrials = 6.10 of 14` is a second, independent symptom.
This is `BUGS.md` #43 (nothing ever sets the controller's `_sampleWeightConfig`, so
the sample-weights candidate cannot differ from the baseline — and `TODO.md` #5's
"walk-forward run showing sample weighting improves PSR/DSR" therefore cannot be
answered by this run) and #44 (multi-probe/query-mod set
`_multiProbeConfig`/`_queryModConfig` on the mind, but the path they steer —
`knowledge/transfer.js → _getGlobalLSHCandidates` — is not reached in a fold's
training, so the flags are inert on the shipped model). The report should mark an
inert candidate rather than printing reasons derived from a duplicate of the
baseline.

The **round-27 planning sweep** re-derived both from the code and both are stronger
than this run's first reading — see `PLAN-round27.md` §2 and `BUGS.md` #43/#44/#46/#47/#48:

- **#43 is a mathematical no-op, in production too, not a missing `configure`.** The
  drain is always a batch of *one* label (`CONFIG.baseProcessCount = 1`; the A/B
  hardcodes `1`), and `spanWeightsFromEntries([k], cfg)` is `[1]` for every
  normalization (measured; ten consecutive entries give 0.825–1.355, ESS 9.64 of 10,
  so the estimator is fine and the batch is degenerate). No wiring can fix it — the
  mechanism must be redefined for a streaming trainer (R27-3).
- **#44 is "the path cannot act", not "the path is not reached".**
  `_getGlobalLSHCandidates` has one caller (`transfer.js:74`, inside the read-only
  `broadcastMemory`), whose result is the *signal payload* while `translateMemory`
  receives `[]` and early-returns without mutating; the live retrieval path
  (`retrieval.js:251`/`:303`) reads the buckets directly and consults neither flag.
  `pca-hash` is live **only** through that undocumented reader (and partly through a
  bucket-content-dependent `Math.random()` draw count), which is why it moved 6/288
  folds while the other two moved none (R27-1/R27-2).

### 10.7b The `20260922T204248-seed1` positions, one line per candidate (round-27 re-read)

| candidate | folds byte-identical to baseline | maxAbsDiff | status (round-27 taxonomy) |
| --- | ---: | ---: | --- |
| surprise-gate | 189/288 | 0.1488 | live (memory write gate, in-path) |
| homeostasis | 42/288 | 0.1598 | live (per-member LR, in-path) |
| pca-hash | 282/288 | 0.0581 | live **via `_retrieveTopRelevantProtos`** (undocumented reader) |
| multi-probe | 288/288 | 0 | **not-applicable** on the controller (`broadcastMemory`'s result is discarded) |
| query-mod | 288/288 | 0 | **not-applicable** on the controller (same) |
| sample-weights | 288/288 | 0 | **inert by construction** (batch of one ⇒ weight exactly 1) |

### 10.8 The forecast/MCS panel: a real result, with a cross-kind caveat

The R26-14 panel is the run's second family-level check and it does something the
Sharpe ranking does not: it rejects **all eight signal variants** from the Model
Confidence Set at both 90 % and 95 %, leaving only the seven mechanism variants.
The mechanism behind that is visible in the scores: the baseline's `confidence` is a
probability-like number (brier 0.2522, log 0.6975, i.e. at the base rate), while the
signals' `confidence` is a *raw signal score* whose per-bar Brier loss is far worse
(sig:momentum 0.3394, sig:range 0.3492 — worse than a constant 0.5), so the DM test
favours the baseline for every signal.

That is a genuine, reportable result (a signal's raw magnitude is not a calibrated
probability) **and** a caveat: the panel is comparing incommensurable quantities
across `kind` — a mechanism's calibrated confidence against a signal's uncalibrated
score — so "eliminated from the MCS" for a signal means "its score is not a
probability", not "its P&L forecast is worse". The block carries `kind` per variant
but does not group by it. Recorded as a method note (TODO), not a defect: no verdict
moves, because the MCS is diagnostic and the family-wise SPA (on Sharpe) is the
cross-check the decision cites.

### 10.9 What this run means for the next one

1. **The round-26 correction is validated.** A controlled before/after on the same
   design moved the baseline and every mechanism row (as predicted) and left every
   pure-signal row unchanged (as required). The recorded N3 verdict's *baseline and
   mechanism* content is superseded by §10; its signal-family content stands.
2. **Nothing promotes, at any cost level, and the reason is now the honest
   statistic** — the dependence-adjusted DSR floor and, for momentum, fold-win by a
   single fold. The two near-misses (`sig:momentum`, `sig:acceleration`) are the
   first candidates the project has had that pass the paired cluster magnitude test,
   the stability test and (accel) the fold-win test, and fail only the corrected-DSR
   floor.
3. **Fix the reading defects before another run.** #43/#44 mean 3 of 7 mechanism
   candidates are untested and inflate `K`; #45 means the decision block's training
   answer describes only the winning (signal) row. None changes arithmetic; all
   three mislead a reader of a run. #43 additionally blocks the *only* experiment
   that can answer the sample-weighting question.
4. **Do not read the economic ceiling off one window.** Momentum's break-even is
   0.48 bps over 2,200 bars and 14.64 bps over 600. Any "costs kill the signals"
   (or "the signals clear costs") claim must name the window; the
   dependence-adjusted DSR is the statistic that agrees across both.
5. **The sample-weighting item is still open, and so is the label-policy
   experiment** (`--label-policies`, R26-11) — both are opt-in and neither has been
   run at power. Once #43 is fixed, `--label-policies` + a fixed `sample-weights`
   are the cheapest remaining falsifiable experiments, at 600 bars.

### 10.10 The round-27 re-read: the journal is an exact witness, and K is not what holds the near-misses back

Two results from the second round-27 sweep (`PLAN-round27.md` §1.3/§2.7), both
computed **offline from the uploaded journal** (`folds.jsonl`), with no model:

**(a) The journal reproduces every pooled metric exactly.** Reconstructing each
variant's pooled net returns from the per-fold `returns` + `signals`
(`analysis/backtest.js#strategyReturns`, `costBps: 0`) and re-deriving
`sharpeRatio`/`skewness`/`kurtosis` → `deflatedSharpeRatio` reproduces the report's
`perPeriodNetSharpe` to ~1e-9 and every `dsr` to the printed 6 dp for all 15
variants (baseline recon `−0.007224877` vs report `−0.0072248766596337685`;
`sig-accel` recon `dsr 0.995306` vs report `0.995306`). A trials/K or cost
restatement is therefore pure post-processing of the journal — it never needs a
model re-run.

**(b) Excluding the three structurally inert arms from K cannot manufacture a
promotion.** `dsrAdjusted` (the failing `minDsrAdjusted 0.95` hurdle) restated at
K = 15 / 12 / 8 (K = 12 = 15 − multiprobe − querymod − sample-weights; K = 8 is
further than the correction can go):

| candidate | K=15 | K=12 | K=8 | promotes at 0.95? |
| --- | ---: | ---: | ---: | --- |
| `sig-accel` | 0.8343 | 0.8608 | 0.9036 | no (would need K ≲ 2) |
| `sig:momentum` | 0.7375 | 0.7736 | 0.8350 | no |
| `surprise` | 0.0344 | 0.0433 | 0.0658 | no |
| `baseline` | 0.0235 | 0.0301 | 0.0471 | — |

So the R27-1 K correction is a *reading* fix, not a verdict flip: even at K = 8 the
two near-misses stay under the floor. This is the property that makes the K
exclusion safe to ship, and it is measured rather than assumed.

**(c) The `triple`-label and sample-weighting experiments were never expressible.**
`report.json` records `heldBars { count: 185937, sum: 185937, max: 1, mean: 1 }`:
every closed trade was "held" one bar, because `_updateOpenTrades` counts bars only
within the single newly-inserted candle it is handed per call (`BUGS.md` #49). The
shipped labeler therefore produces **non-overlapping 1-bar labels**, so
sample-uniqueness weighting is mathematically inert on it (uniqueness ≡ 1), and the
`triple` policy's vertical barrier is unreachable for `horizonBars > 1`. Both the
sample-weighting item (TODO #5) and the label-policy experiment are blocked on the
R27-4b fix, not on a `configure`.

---

## 11. The round-27 plan (IMPLEMENTED: R27-1…R27-6, R27-8 and R27-9; the four runs are DONE — §13)

Round 26 closed with three *reading* follow-ups and two unrun experiments. The
round-27 planning sweep (triggered by the user's "plan the next step, double-check
the controller, add the checks you think are needed, and bake the flags in") turned
those into a concrete, tested plan and found four more findings in the same class
(`BUGS.md` #43/#44 sharpened, #46/#47/#48 new). The plan is
[`PLAN-round27.md`](PLAN-round27.md); it is **implemented (R27-1…R27-6, R27-8,
R27-9) and run (R27-7a–d; §13)** (§12 has the implementation record).

Its shape:

- **Liveness first.** Every candidate carries a `liveness` certificate computed from
  the already-journaled fold signals (`live` / `inert` / `skipped` /
  `not-applicable` / `duplicate-of:<id>`); an untested candidate contributes exactly
  one explanatory reason, is excluded from `K` and the family-wise search, and is
  listed in the report. The DSRs are re-deflated at the reduced `K` via the existing
  `restateReportAtCost`, with `trialsRoster`/`trialsInactive` recorded; §10.10(b) shows
  the correction cannot promote the near-misses. A contract test requires at least
  one live mechanism candidate on the shipped controller roster.
- **Honest taxonomy.** `appliesTo: controller | broadcast | agnostic`; `multi-probe`
  and `query-mod` are `not-applicable` on the controller (their only reader's result
  is discarded), and `pca-hash`'s note names the reader that actually makes it live.
- **Reachability (#49).** `heldBars` is structurally 1 and the `triple` policy's
  vertical barrier is unreachable; R27-4b computes the elapsed bars from the cached
  window, leaving the optimistic/conservative positions byte-identical. This is the
  enabling fix for the label experiment.
- **Sample weighting re-scoped.** Because the shipped labeler's labels do not
  overlap, uniqueness weighting is inert on it; the causal-window mechanism is
  implemented as a modifier of the (now reachable) `triple` label, and TODO #5 is
  closed `not-applicable` for `optimistic` (with a clean falsification test under
  `triple`).
- **Fail-closed inputs:** a degraded prediction abstains instead of taking a full
  short; a rejected training row cannot corrupt `trainingSteps`.
- **Diagnostics that can fire:** `undertrainedFolds` (always 0) is replaced by
  `shallowHistoryFolds` + a real `underTrainedFolds`; the decision block names its
  model referent; the partial report carries the config echo; `streamLabel` is
  normalised (the journal currently embeds the operator's absolute paths).
- **Runs:** a minutes-long liveness validation on two streams; a label-policy run
  (`conservative` + the now-reachable `triple`); a weighting run with a `triple`
  baseline (the only setting in which the weighting question is answerable); and an
  optional 3-seed replication of the two near-miss signals (id `sig-accel`, not
  `sig-acceleration`).
- **A design note (R27-8): buy independence, not bars.** The run's own numbers say
  so (`effectiveStreams` 2.30 of 8, dependence inflation 4.87×) — more bars of the
  same basket barely move the statistic the gate uses.

Acceptance criteria, the exact commands, the file map and the resolved decisions
(§3.5) are in `PLAN-round27.md` §3–§9.

## 12. Round-27 implementation record (what landed; the four runs are DONE — §13)

Round 27's code and tests are in the tree and `npm test` is green (`RUNBOOK.md` §6
ledger, 2347 checks). What changed, and what pins each item:

- **R27-1 — liveness + active-K restatement.** Every candidate carries a `liveness`
  certificate computed by comparing its per-fold position series with the baseline's
  (`live` / `inert` / `duplicate-of:<id>` / `not-applicable` / `skipped`); an inactive
  candidate is excluded from `K` and the family-wise search with exactly one reason and
  its pre-restatement report kept in `reportRoster`, and every row then carries the
  active K (`trialsRoster = trials + trialsInactive`). Pinned by `analyze.test.js`
  section M2 and `controller_invariants.test.js`. The K change is a reading fix, not a
  verdict flip: §10.10's restatement of this journal shows no near-miss promotes at any
  K ≥ 8.
- **R27-2 — taxonomy.** `appliesTo ∈ {agnostic, model, controller, broadcast}`;
  `multi-probe`/`query-mod` are `not-applicable` on the controller (their only reader's
  result is discarded) and `pca-hash`'s note names the live reader
  (`_retrieveTopRelevantProtos`); `--list-variants` prints the taxonomy. Pinned by the
  taxonomy contract in `analyze.test.js` and the broadcast-flag bit-identity check in
  `walkforward.test.js`.
- **R27-3 — sample weighting re-scoped.** Closed `not-applicable` on `optimistic`; the
  causal-window estimator is a pure helper (`causalWindowWeight`) usable as an opt-in
  modifier of the `triple` label. A variant may carry its own precise `inertReason`
  (the shipped `sample-weights` states that one-bar labels do not overlap, so it
  reaches the model path and multiplies by 1) instead of the generic "never reaches"
  wording. Pinned by `sample_weights.test.js` (45), `analyze.test.js` and
  `controller_invariants.test.js`.
- **R27-4 / R27-4b — fail-closed inputs and a reachable vertical barrier.** `predict`
  → `NaN`, `train` → the current count + `rejectedTrainRows`; the controller's guard
  is `finite && >= 0` (a negative can never reach the NOT NULL `confidence` column);
  `barsAfterEntry` is
  window-derived (capped at `cacheSize − 1`) so `triple` can fire at `H > 1`, with the
  optimistic/conservative positions byte-identical. Pinned by `sanity.test.js`,
  `core.test.js` (browser + node) and `controller_invariants.test.js`.
- **R27-5 — report honesty.** `shallowHistoryFolds` + a fireable `underTrainedFolds`
  (with the `minTrainingSteps` floor and the per-fold distribution); the decision
  block's baseline `modelReferent`; `neededForObserved`; the `partial-report.json`
  config echo; the `run.log` variant `kind`/`elapsedMs`; the per-kind forecast block;
  and the normalised `streamLabel`.
- **R27-9 — defaults baked in.** `requireReachable: true` (`--reachable=0` opts out),
  `--audit-probes` default 1, liveness/taxonomy always on, `sample-weights` out of the
  default roster. Pinned by a fourth `analyze_cli.test.js` block (spawns the real CLI:
  the flags are documented, threaded into `run.json`/`report.json`, and
  `--list-variants` starts no run).

**Done (operator):** R27-7's four runs landed — see §13 (forensics) for what each one
proves. Step 0.5's offline K restatement is already measured in §10.10. (R27-8's
design note is already written — `METHOD.md` §5.)

## 13. The round-27 runs (R27-7a–d) — what happened, what it proves, what it does not

Four runs, all `status: complete`, all `node v25.9.0`, all on the same tree (round-27
code, `npm test` green). Read them as one programme: **Step 1 tests the liveness
*certificate*; Steps 2–3 turn on the two features the certificate cleared only where
they could fire; Step 4 asks whether the two near-misses survive a seed distribution.**
The headline is a split verdict — the *machinery* worked (each run reports what it
was built to report, with no runtime warnings and two cross-process bit-reproductions),
the *science* returned one genuine positive (`label-conservative`), a clear negative on
the weighting experiment (live, but harmful — modulo a confound, #54), one zero-cost
promotion with a knife-edge margin, and three defects in the reading layer (#53 in
`pca-hash`'s certificate, #54 in the sample-weight normalisation, #55 in the decision
block and the family-correlation label) that only a real run could surface.

### 13.1 Manifest (all four; `costBps: 0`, `seed: 1`, `requireReachable: true`, `reuseBase: true`, `auditProbesPerFold: 1`, `commonRandomNumbers: true`)

| run | id | what it was | scale | wall | folds | variants |
| --- | --- | --- | --- | --- | --- | --- |
| Step 1 | `20260923T105845-seed1` | liveness validation | 2 streams × 200 bars | 554 s | 18 | 6 + baseline |
| Step 2 | `20260923T111159-seed1` | label policy | 8 streams × 600 bars | 8 259 s | 288 | `label-conservative`, `label-triple` + baseline |
| Step 3 | `20260923T133315-seed1` | weighting under `triple` | 8 streams × 600 bars | 5 515 s | 288 | `sample-weights` + baseline |
| Step 4 | `20260923T150720-seed1` | near-miss seed replication | 8 streams × 600 bars | 2 726 s | 288 | `sig-momentum`, `sig-accel` + baseline, `--seeds=1,2,3` |

All four report `configFingerprint c0ba6493`. That is **expected, not a bug**:
`configFingerprint` hashes only the legion **structure** keys
(`sanitize.js`'s `STRUCTURE_CONFIG_KEYS`), so it does not change with `--variants`,
`--label-policy` or `--cost-ladder`; `run.json` echoes the full config beside it.

### 13.2 Step 1 — the liveness certificate works as designed; one certificate lies about *why* (`BUGS.md` #53)

`liveness {roster 7, active 3, inert 2, notApplicable 2}`, `trials 3`, `trialsRoster 7`,
`trialsInactive 4`. Every inactive candidate carries exactly one reason, is excluded
from `K` and the family-wise search, and its `promotionTest.available` is `false` with
the "excluded from K and the family-wise search" note. The four expected outcomes are
all present and correctly classified:

| candidate | status | reason |
| --- | --- | --- |
| `sample-weights` | **inert** | the *variant-specific* reason: the optimistic labeller emits one-bar labels, no two spans overlap, every uniqueness weight is exactly 1 |
| `multi-probe`, `query-mod` | **not-applicable** | `broadcastMemory -> _getGlobalLSHCandidates`, whose output the scored model never reads back |
| `surprise` | **live** | 2/18 folds differ (16 identical), `maxAbsDiff 0.0617` |
| `homeostasis` | **live** | 15/18 folds differ (3 identical), `maxAbsDiff 0.1249` |
| `pca-hash` | **inert** ⚠ | **the generic reason** — "the mechanism never reaches the model path" |

`sample-weights`'s model block carries the measured evidence of its inertness:
`sampleWeights {count 3438, min 1, max 1, mean 1, ess 43.825, n 43.825,
effectiveFraction 1}` — an all-ones vector, so the certificate is a provable statement,
not an inference. This is exactly what R27-3 was built to show.

**The defect (#53).** `pca-hash` is on the model path (`appliesTo: 'model'`; `BUGS.md`
#44 documents it live via `_retrieveTopRelevantProtos`, and the round-26 8×600 run
measured it **differing on 6/288 folds**), yet on Step 1 it is certified `inert` with
the generic string claiming it *never reaches the model path*. Two consequences:

1. **The generic reason is the wrong class of explanation for a `model`-scoped
   variant.** "Identical on all 18 folds" is a factual, per-run statement; "never
   reaches the model path" is a structural claim the round-26 run falsifies. This is
   the exact shape `inertReason` exists to fix (as `sample-weights` uses it), and
   `pca-hash` has none.
2. **Liveness is run-dependent.** The same variant is live at 8 streams × 600 bars and
   inert at 2 streams × 200 bars. A liveness certificate is a property of *a run*, so
   the report should say "identical on all N folds of THIS run" and never imply a
   structural unreachability it has not proved.

Instrumentation of the real pipeline (a browser-harness probe of `runAnalysis`, plus a
`HiveMind._refreshLshHyperplanes` wrapper and a logging controller subclass) shows the
mechanism *does* execute on the scored mind — the refresh returns `true` and replaces
the hyperplanes — but no emitted position changes at this run's prototype-pool / probe
budget. So the honest status for Step 1 is `inert` with a *measured* reason, and the
open question (does the basis ever change the selected prototype set at a smaller probe
budget or a larger pool?) is an experiment, not a conclusion. Note also that the
tension is real on both sides: `binarypc`/`lsh` prove the refresh changes the *hash
buckets*, and #44 itself warns that the retrieval probe draws a bucket-content-dependent
number of `Math.random()` values — so "the run differs" is not clean evidence the
*signal* changed either.

Two smaller reading observations from the same run, neither a crash. The summary's
family-correlation line prints `maxPair=sample-weights~multiprobe` when only
`surprise`/`homeostasis` are active — the *matrix* is correctly built over the active
arms (2×2, `rho = −0.0594`), but the `maxPair` **label** is resolved against the full
candidate list (`analyze.js`'s `familyPairLabel` indexes `result.candidates`, not the
active subset), so it names two arms that were never correlated (the label, not the
number, is wrong). And the tiny run's family-wise SPA panel is degenerate
(`spaPValue 0`, `rejects [baseline, surprise-gate]`) even though its own power line
says `UNDERPOWERED` (`MDE95 ±1.90` i.i.d.). Treat the Step-1 panel as a liveness check,
not evidence. Filed together as #53/#55.

### 13.3 Step 2 — the label policy is the round's one genuine positive (`label-conservative`)

This is the first run in which the two alternative labellers are *reachable* (R27-4b
fixed `barsAfterEntry`) and *scored at power* (8 streams, 4 320 pooled bars), and both
beat the optimistic baseline on the paired, cluster-based statistic:

| variant | net Sharpe | DSR (adj.) | fold-win | paired ΔS | p(1-sided) | stability (LOO) | breadth | break-even | folds ≠ baseline |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline (`optimistic`) | **−0.1147** | 0.1428 | — (ref.) | — | — | — | — | **−2.58 bps** | — |
| `label:conservative` | **+0.1017** | 0.2521 | 0.2014 | **+0.2164** (se 0.1355) | **0.0597** | **1.0** (36/36, worst +0.105) | 17/17/2 | **+2.24 bps** | 100/288 |
| `label:triple` | **+0.0194** | 0.2074 | 0.4132 | +0.1340 (se 0.1072) | 0.1098 | 1.0 (36/36, worst +0.0626) | 22/14 | +0.42 bps | **232/288** |

What is actually established:

- **The alternative labellers are not duplicates** (R27-4b verified): `conservative` and
  `triple` differ from the baseline on 100/288 and 232/288 of folds respectively (i.e.
  188/288 and 56/288 are byte-identical), and
  `triple`'s model block reports `resolvedTimeBarrier 16244` with
  `heldBars {max 20 = horizon, mean 6.77}` — the vertical barrier is reachable and fires.
  (Contrast the corrected optimistic baseline: `heldBars {max 72, mean 7.82}` — also no
  longer ≡ 1, which is the #49 fix visible in production.)
- **The sign of the effect is consistent, not a lottery.** Both candidates' cluster
  stability is 1.0 (every one of the 36 leave-one-window-out paired differences is
  positive), and `conservative`'s is the stronger of the two. The worst single window
  removal still leaves `+0.105`.
- **The baseline's gross edge is negative** (`breakEvenCostBps −2.58`: it loses money
  before any cost), while both candidates have a *positive* break-even (2.24 and 0.42
  bps). So the improvement is "from a negative-edge model to a ~zero-edge model", not
  "from zero to a money-maker".
- **Neither clears the gate.** `conservative` binds on the DSR floor
  (adj. 0.2521 < 0.95) and the fold-win majority (0.2014 < 0.5); `triple` binds on the
  same two (0.2074, 0.4132) plus the relative positive-fold hurdle. The family-wise
  SPA agrees (`p 0.6567`, best `label:conservative`, no rejects).
  **Note (§14, `BUGS.md` #57):** the "fold-win majority" here is the raw fraction over 288
  folds; the error-controlled **cluster** sign test is **0.500** (17/17/2). The raw hurdle is
  an always-on legacy reason that contradicts `DESIGN.md` §6.1's recorded round-25 decision
  (the raw fraction should be a *reported statistic*); it is verdict-neutral here (the DSR
  floor binds regardless), and `PLAN-round28.md` P1e reconciles code and record.
- **Sizing** (`decision.nextRun`): to make the *observed* paired difference significant
  at the required power, `conservative` needs ~55 fold-window clusters and has 36
  (`pairedUnits.neededForObserved 55`); the cheapest single lever is
  **`magnitude` ×4.95** (the clustered test needs a ΔS of ~1.07 vs the observed 0.2164).
  `barsToDetectObserved` is 93 577 bars at design effect 5.12 — i.e. **more bars of the
  same basket is the wrong lever**; more independent folds/streams, or a larger effect,
  is the right one (R27-8).

  **⚠️ Corrected by the round-28 re-read (§14).** Both the 55 and the ×4.95 are artefacts.
  `cheapestFlip` multiplied the *pooled level's* cluster SE (0.54654) by 1.96 and compared it
  to the *paired* difference (whose own SE is 0.13554), and `pairedUnitsNeeded` used a
  two-sided z while the test it sizes is one-sided (`pairedClusterTest.significant ⇔
  pOneSided ≤ alpha`). The honest numbers: the required |Δ| at the 36 clusters is
  `t(35, 0.05 one-sided) × 0.13554 = 0.228998` against the observed 0.21640 — **94.5 %,
  factor 1.058** — and **41 clusters** would make it significant (89 for ≈80 % power — the
  plan's `81` is the normal approximation; §14.7a; 54 come
  from `--test=10` on the same 600 bars). `barsToDetectObserved` sizes a *single series*, not
  the paired decision: the DSR floor is crossed at a Sharpe of ≈1.02–1.08 (`sig-accel`
  1.0194 → 0.9742; `sig:momentum` 1.0848 → 0.9487614), so the labeller's 0.1017 is ≈10× short
  and the floor is a **magnitude** gate, *not* a power purchase. More bars *does* buy
  fold-window clusters (675 bars → 41) — the lever the paired hurdle actually needs. See
  `BUGS.md` #56 and `PLAN-round28.md` §C1/§0.

One wording nit (#55): `decision.training.labelPolicy` reads `"optimistic"` for this
run because it names the *run-level* policy, while the featured model (the named
`modelReferent`, `label:conservative`) was trained under `conservative`. The training
block's numbers are the referent's own, so only the label is ambiguous — but an
operator reading the decision block can be misled. Worth renaming (`runLabelPolicy`)
or reporting the referent's own policy.

### 13.4 Step 3 — weighting is *live* under `triple`, and it hurts; but the A/B is confounded by an effective-LR change (`BUGS.md` #54)

The plan's falsification condition for R27-3 was `ess ≈ n` (i.e. the causal window
weights are all ≈ 1 and there is nothing to weight). **That did not happen**: on the
`triple` baseline `sample-weights` is **live** (only 50/288 folds byte-identical to the
baseline, `maxAbsDiff 0.1717`) and its model block reports
`sampleWeights {count 177817, min 0.7208, max 9.1542, mean 2.6112, ess 48.06, n 58.27,
effectiveFraction 0.8248}` — the mechanism moved (`ess < n`). But it moved the wrong way:

| variant | net Sharpe | DSR (adj.) | fold-win | paired ΔS | p(1-sided) | stability | break-even |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline (`triple`) | **+0.0194** | 0.3148 | — | — | — | — | +0.42 bps |
| `sample-weights` | **−0.2083** | 0.1674 | 0.4028 | **−0.2276** (se 0.1665) | 0.9098 | **0/36** positive | **−4.51 bps** |

The result is emphatic and internally consistent: the weighted objective is worse than
unweighted on the pooled Sharpe, the dependence-adjusted DSR, every cluster-stability
window (0/36 positive), and the turn-over break-even. **Read as "AFML ch.4
average-uniqueness weighting buys nothing on this data and costs ~0.23 paired Sharpe"**
— which, combined with §13.2's proof that it is inert on the shipped labeller, is the
evidence to close TODO #5 (subject to the confound below).

**However (the confound).** The weights are `mean1`-normalised **over the causal
window**, but the controller trains on exactly one new label per closed-trade drain, and
that label is the **newest span** of the window (the ring's older spans were already
trained). So the *emitted* weights are not a mean-1 sample: their run mean is **2.6112**.
`HiveMind.train` feeds the weight straight into `dL_dLogit = (probability − target) *
sampleWeight` (`training/gradients.js`), so this arm ran at ≈ **2.6× the baseline's
effective learning rate** — the code comment's "mean-1 … the effective learning rate is
unchanged" is false in operation, because only the newest span is ever trained. The
pure module reproduces the run's readout from realistic spans (horizon 20, one-bar
entry spacing: mean weight 2.65, `effectiveFraction` 0.813 vs the run's 2.6112/0.8248),
so this is not a hunch. The Step-3 comparison therefore **conflates credit
redistribution with an LR/objective-scale change**; before TODO #5 is closed
*conclusively*, the emitted weights must be renormalised so the trained stream has
mean 1 and the run repeated. (The unweighted conclusion — "inert on `optimistic`" — is
untouched by this; it is a property of non-overlapping labels.)

Positive controls in the same run: the `triple` baseline reproduces Step 2's
`label:triple` candidate to the last digit (`netSharpe 0.01935514227636181`,
`trainingSteps 175657`), proving the A/B is bit-reproducible across separate processes
under common random numbers; and with a single candidate the report honestly emits
`familyCorrelation {available: false, reason: "fewer than two candidates — there is no
family to correlate"}`.

### 13.5 Step 4 — the near-miss replicates into a promotion, at zero cost (`sig-accel`)

The 3-seed replication of the two near-misses returns the round's only `promote: true`:

| candidate | net Sharpe | DSR (adj.) | fold-win | paired ΔS | p | stability | breadth | audit | break-even |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `sig:momentum` | 1.0848 | **0.9487614** | **0.4931** | +1.1995 | **0.0293** | 1.0 | 19/17 | 288/288 | 14.64 bps |
| `sig:acceleration` | 1.0194 | **0.9742** | 0.5347 | +1.1341 | **0.0493** | 1.0 | 24/12 (p 0.0326) | 288/288 | 11.57 bps |

What it shows:

- **`sig-accel` promotes** with no reasons, a clean audit (`reachableFolds 288/288`),
  perfect cluster stability (all 36 LOO differences positive, worst +0.806), and a
  concentrated-but-broad edge (`top 1 fold = 4.3%` of gross, `top 20 = 57.6%`,
  LOO Sharpe `[0.985, 1.094]`).
- **`sig-momentum` fails on two knife-edge floors despite a *higher* Sharpe and
  *stronger* paired evidence**: the always-on fold-win majority (`0.4931 < 0.5`) and
  the adjusted-DSR floor (`0.9487614 < 0.95` — 0.0012 short). This is the gate doing
  its job: it is measuring breadth and consistency, not peak Sharpe. Both margins are
  small enough to report explicitly.
- **The promotion is a zero-cost promotion.** The cost ladder is decisive: at 0 bps
  `sig-accel` promotes; at **2 bps it fails** (adjusted DSR 0.9223, paired p 0.0628);
  at 5/10 bps both fail. `run.json` records `costBps: 0`, so the verdict is a statement
  about a zero-cost strategy with a healthy gross break-even (11.57 bps) but a
  dependence-adjusted DSR that the first basis point of cost erodes past the floor.
- **`--seeds` replication is vacuous for model-free signals.** `replication.json` shows
  the two signals' `perSeedMean` identical across seeds 1/2/3 to 15 significant digits
  (`seedVariance ≈ 1e-31`, `seedFraction ≈ 1e-32`) — they are deterministic functions
  of the data — while the baseline varies (`perSeedMean [−0.0441, +0.5168, −0.1780]`,
  `seedFraction 0.65%`, `foldFraction 99.35%`). So the replication is a seed
  distribution for the *model-backed* baseline only; it correctly demonstrates that the
  near-misses are not single-seed artefacts (they cannot be), and it cannot quantify
  their seed sensitivity because there is none. The IQM CI is still informative about
  *fold* uncertainty: `sig-accel` IQM 1.1429 CI `[0.8507, 1.4099]`, `sig-momentum` IQM
  0.7372 CI `[0.4074, 1.0328]` — both CIs sit above the pooled baseline (−0.115).
- **Throughput:** the baseline's total fit time was 2 716 s (≈99.6% of the run's
  2 726 s wall); each signal candidate cost **4.57 s** (≈600× cheaper) because it is
  model-free. The three-seed run is essentially the baseline's fits; a signal-family
  sweep is nearly free. This reinforces R27-8 ("buy independence, not bars") from the
  cost side.
- **Family correlation:** `sig-momentum ~ sig-accel` excess returns correlate
  `r = 0.6972` (`effectiveTrials 1.178 of 2`) — the two near-misses are largely the same
  bet, so "two arms survive" is weaker evidence than it looks (the DSR keeps `trials =
  K` on FWER grounds, per the panel's own reader).
- **R27-5's per-kind forecast grouping is verified in production:** Step 4's
  `forecast.kinds = [controller(1), signal(2)]`, and the top-level `mcs` is the
  *baseline's kind*'s MCS (`[baseline]` — "a single model is its own MCS"), with
  `forecast.byKind.signal.mcs` holding the signal family. The `byKind[kind].mcs`
  structure the reader promises is present.

### 13.6 Cross-run invariants (the good news)

- **Bit-reproducibility across processes under CRN.** Step 2's baseline ≡ Step 4's
  baseline (`netSharpe −0.11469136136703602`, `trainingSteps 170004`, same turnover);
  Step 3's baseline ≡ Step 2's `label:triple` candidate (`0.01935514227636181`,
  `175657`). Independent processes, same numbers.
- **No runtime errors, warnings or quarantine.** `run.log` carries only `info`
  progress events in all four runs; `warmErrors`, `quarantinedRows`, `droppedCandles`
  and `openTradeWriteErrors` are 0; `progress.json` ends `phase: complete` with the
  pass budget (`events === eventsTotal`) fully spent.
- **The honesty machinery fires.** Inactive candidates carry one reason each and are
  outside `K`; the audit is clean and `reachable` in every row; the single-candidate
  family correlation is honestly `available: false`; the forecast groups by kind;
  `partial-report.json` echoes the config. The three defects found by the round-26 run
  (#43/#44/#45) and the reachability bug #49 are all visibly fixed in these reports.

### 13.7 What the runs prove, and what they do not

| run | proves | does not prove |
| --- | --- | --- |
| Step 1 | the liveness taxonomy works; `sample-weights` is inert on `optimistic` with measured evidence; `surprise`/`homeostasis` are live — **and** `pca-hash` is *per-run* live (live at 8×600, inert at 2×200), so the generic inert reason must not claim a structural cause (#53) | anything at power; whether `pca-hash` could move a position at another pool/probe budget |
| Step 2 | `conservative`/`triple` are reachable, non-duplicate, and both improve the paired Sharpe vs the negative-edge baseline with every LOO window positive; the vertical barrier now fires (`resolvedTimeBarrier 16244`) | a promotion (neither clears the DSR floor or the fold-win majority); whether the effect survives a different basket/cost/label horizon |
| Step 3 | causal-window uniqueness weighting *can* move the objective (`ess/n 0.825`) and makes it **worse** on every pooled and LOO statistic | whether the effect is intrinsic to uniqueness weighting or an artefact of the 2.6× effective-LR inflation (#54) — needs the normalised re-run |
| Step 4 | `sig-accel` promotes at 0 bps with a clean audit, perfect stability and a broad edge; `sig-momentum` fails two knife-edge floors; the near-misses are structurally seed-free so `--seeds` is vacuous for them; signals are ~600× cheaper than the model | that the promotion survives any cost (`costBps: 0`; it fails at 2 bps); that either signal is a durable regime effect (fold variance still dominates) |

### 13.8 What this means for the next run (summary; the plan is `PLAN-round28.md`)

> **Corrected in §14 (round-28 re-read).** Items 3 and 5 below quote the sizing block's
> `neededForObserved 55` and `magnitude ×4.95`, which §14 shows are artefacts of mixing the
> *paired* difference with the *single-series* cluster SE and of a two-sided z in a one-sided
> test; the honest requirements are 41 clusters (significance) / 89 (80 % power, t-based —
> the plan's `81` is the normal approximation; §14.7a) and a
> magnitude factor of 1.06, and the DSR floor is a *magnitude* gate (Sharpe ≈1.02–1.08), not a
> sample-size one. Read §14 before acting on items 3 and 5.

1. **Reconcile `pca-hash`'s liveness honestly** (#53): give it an `inertReason` that
   states the measured per-run cause (the refresh runs; no emitted position changes at
   this budget) and qualify #44's "live" claim; then design the probe-budget × pool-size
   experiment that decides whether the basis can ever matter.
2. **Re-run Step 3 with emitted weights renormalised to the trained stream's mean 1**
   (#54) before closing TODO #5 — otherwise the "weighting hurts" verdict is
   confounded with a learning-rate change.
3. **`label-conservative` is the best arm the programme has produced** (+0.2164 paired,
   p 0.0597, stability 1.0, positive break-even). Decide whether to buy power
   (~55 needed vs 36 clusters; `magnitude ×4.95`) or to reduce the question's noise
   (new independent streams). Do not re-run more bars.
4. **Treat the `sig-accel` promotion as arm-level, not deployable**: it is a 0-bps
   promotion and fails at the first basis point; record it as "the strongest arm is
   model-free, cost-fragile, and correlated 0.70 with the other near-miss".
5. **Buy independence, not bars (R27-8), now with the runs' own numbers**:
   `effectiveStreams` 2.30 (Step 2), 2.47 (Step 3), 1.89 (Step 4) out of 8 majors;
   `barsToDetectObserved` 93 577 in Step 2. The binding constraint is the number of
   *independent* streams, not the bar count.
6. **Reading polish**: `decision.training.labelPolicy` should name the referent's
   policy (or be renamed `runLabelPolicy`); report knife-edge margins explicitly; and
   fix the `familyCorrelation` summary's `maxPair` label to resolve against the active
   arms the matrix was built from (it currently indexes the full candidate list).

---

## 14. Round-28 coherence re-read of the four reports (plan-only round; `PLAN-round28.md`)

This section is the round-28 planning pass: every number in the four `report.json` files was
re-read against the code that produced it, against the recorded method decisions
(`METHOD.md`, `DESIGN.md` §6.1) and against each other. It found **three new reading defects**
(`BUGS.md` **#56/#57/#58**), **two recorded-decision-vs-code drifts**, and it **corrected the
sizing arithmetic the round-27 summary quoted**. No scored number is wrong; the *descriptions*
are, and one hint pointed at the wrong lever. All arithmetic below is re-derived from the
reports (`src/20260923T*/report.json`) and is reproducible.

### 14.1 The sizing block mixes a *paired* quantity with a *single-series* one (`BUGS.md` #56)

Step 2 (`20260923T111159-seed1`, candidate `label-conservative`) carried:

| field | value | source |
| --- | --- | --- |
| `promotionTest.sharpeDifference` | value 0.2164017, **se 0.1355364**, t 1.5966319, df 35, pOne 0.0596693 | paired, candidate-vs-baseline |
| `dependence.seCluster` | **0.5465402** | single series (the candidate's own Sharpe level) |
| `decision.nextRun.mde95Dependent` | 1.0711991 = `1.959964 × 0.5465402` | single series |
| `decision.nextRun.cheapestFlip.requiredSharpeDifference` | **1.0711991** | `1.959964 × seCluster` |
| `decision.nextRun.cheapestFlip.factor` | **4.95005** = 1.0711991 / 0.2164017 | — |
| `decision.nextRun.pairedUnits.neededForObserved` | **55** | `36 × (1.959964 × 0.1355364 / 0.2164017)²` |
| `decision.nextRun.pairedUnits.needed.mde95Dependent` | **3** | pairs the 0.1355 SE with the 1.0712 target |

`cheapestFlip` therefore multiplies the **level's** SE by 1.96 and compares it to the **paired
difference**. The paired difference's own reference (`t(35) = 1.6895725`, one-sided, because
`pairedClusterTest.significant ⇔ pOneSided ≤ alpha`, `dependence.js:235`) gives the honest
requirement `1.6895725 × 0.1355364 = 0.2289985` — the observed 0.2164017 is **94.50 %** of it,
i.e. **factor 1.058**, not 4.95. Cluster counts for a significant paired difference (one-sided
t, t-crit recomputed per df):

| clusters | 36 (have) | 41 | 55 | 81 (89 at 80 % power, §14.7a) |
| --- | --- | --- | --- | --- |
| paired SE | 0.13554 | 0.12702 | 0.10965 | 0.09036 |
| `t` at Δ = 0.21640 | 1.5966 | 1.7036 | 1.9736 | 2.3950 |
| significant (5 %) | ✗ (p 0.0597) | **✓** | ✓ | ✓ (≈80 % power) |

In bar terms (`clusters = floor((bars − train)/testSize)`): 41 clusters = **675 bars** at
`test 15`, or **`--test=10` on the existing 600 bars = 54 clusters** (a ~1.5× fit increase).
`barsToDetectObserved` = **93 576** is `(1.959964 / (0.1017103/√252))²`, i.e. the **single
series'** i.i.d. bar requirement — not the paired decision's lever.

### 14.2 The absolute-edge floor is a *magnitude* gate, not a sample-size one

The adjusted-DSR floor (`minDsrAdjusted 0.95`) is crossed in these runs at a Sharpe of
≈**1.02–1.08**:

| candidate | pooled Sharpe | adjusted DSR | clears? |
| --- | --- | --- | --- |
| `sig-accel` (Step 4) | 1.0194213 | 0.9742028 | ✓ |
| `sig:momentum` (Step 4) | 1.0848066 | 0.9487614 | ✗ by 0.00124 |
| `label:conservative` (Step 2) | 0.1017103 | 0.2521276 | ✗ (≈10× short on Sharpe) |

Buying the whole dependence panel (design effect 5.12057 → 1) improves the *effective* sample
by `deff` but the Sharpe standard error only by `√deff ≈ 2.26×`, so it cannot close a 10×
Sharpe gap. **Consequence:** `label:conservative` cannot promote at any affordable sample; the
DSR floor is asking for an absolute edge the labeller does not have, and it is behaving
correctly. The *only* promotion-relevant hurdle that is affordable is the paired test (41
clusters). This corrects `RUN-ANALYSIS.md` §13.3/§13.8 and `TODO.md` 76 (item 82).

### 14.3 The always-on raw fold-majority hurdle contradicts the recorded decision (`BUGS.md` #57)

`DESIGN.md` §6.1: the round-25 gate replaced `foldWinFraction >= 0.5` and
`positiveFraction >= baseline` with the paired cluster Sharpe test + leave-one-window
stability, and "the raw fraction is still reported, as a statistic". The code keeps both as
always-on reasons (`walkforward.js:800–812`). Measured on the round-27 runs:

| candidate (run) | raw `foldWinFraction` (288 folds) | cluster sign test (36 windows) | other binding reasons |
| --- | --- | --- | --- |
| `label-conservative` (Step 2) | 0.2013889 ❌ | 0.5000 (17/17/2), p 0.5679 | unadj. DSR 0.3327, adj. DSR 0.2521, paired p 0.0597 |
| `label:triple` (Step 2) | 0.4131944 ❌ | — | DSR floors + positive-fold |
| `sig:momentum` (Step 4 @0 bps) | 0.4930556 ❌ | 0.5277778 (19/17), p 0.4340 | adj. DSR 0.9487614 |
| `sig-accel` (Step 4 @0 bps) | 0.5347222 ✓ | 0.6666667 (24/12), p 0.0326 | — (promotes) |

So the raw hurdle and the error-controlled cluster statistic disagree in direction for the
round's best arm, and the raw hurdle is one of exactly two reasons the near-miss
`sig:momentum` fails at 0 bps. **Verdict-neutral:** every candidate that fails the raw hurdle
also fails the DSR floor and/or the paired test, so implementing the recorded decision changes
no verdict — to be proved mechanically before landing (`PLAN-round28.md` P1e).

### 14.4 `pca-hash`'s inert reason is not "measured", and the retrieval liveness is confounded (`BUGS.md` #53)

Step 1: `pca-hash` `{appliesTo: 'model'}`, `identicalFolds 18/18`, `maxAbsDiff 0`, reason
`"inert: identical to the baseline on all 18 folds (the mechanism never reaches the model
path)"` — a structural claim the round-26 6/288-fold difference falsifies, from the generic
fallback (`analyze.js:1042`). Additional confound: `_retrieveTopRelevantProtos` consumes
`Math.random()` a **bucket-content-dependent** number of times
(`retrieval.js:268/294/295/300/342`), so changing the hash basis moves the trajectory by the
draw count, and "positions differ" is not evidence the *retrieved prototype set* changed. The
P2 experiment therefore measures the **retrieved id set** (deterministic given the hyperplanes)
and the draw count, not just positions.

### 14.5 The `optimistic` label spans overlap — the sample-weight inertness is a config artefact (`BUGS.md` #58)

The `sample-weights` `configure` sets the causal ring's span horizon to
`_labelHorizonBars > 1 ? floor(_labelHorizonBars) : 1` (`analyze.js:151–158`) → **1** on any
`optimistic` run. Step 1's certificate is consequently all-ones
(`sampleWeights {min 1, max 1, mean 1, ess = n = 43.8254799, effectiveFraction 1}`) and the
shipped reason attributes it to one-bar labels. The **#49-fixed** `heldBars` on the *same*
`optimistic` baseline is:

| run | `heldBars` |
| --- | --- |
| Step 1 baseline | `{count 4369, max 54, mean 8.300984}` |
| Step 2 baseline | `{count 185937, max 72, mean 7.824548, cap 119}` |
| Step 2 `label:triple` | `{count 186246, max 20, mean 6.771523}`, `resolvedTimeBarrier 16244` |

So labels are held ~8 bars on `optimistic` and **do overlap**; average uniqueness is ≈1/8, not
1. The all-ones vector is the *span parameter*, and the mechanism has never been tested on the
shipped labeller. (The step-3 confound is the second half: emitted mean **2.6112098** at
`ess/n 0.8248488`, and the model is plain SGD — `_applyGradients` subtracts `Σ grad · lr /
steps` — so the arm ran at ≈2.6× the effective LR.)

### 14.6 The corrected next-step summary (replaces §13.8 items 3–6)

1. **Fix the sizing block** (#56): paired hints read the paired SE and the one-sided reference;
   name each field's scale.
2. **Reconcile the gate with the record** (#57): the raw fold fractions become reported
   statistics; prove verdict-neutrality on these four runs.
3. **Correct the weight inertness story and re-test the mechanism** (#58, #54): a *measured*
   causal span + emitted mean-1 normalisation + a scale-control arm (`PLAN-round28.md` P3).
4. **`label:conservative`:** ship it as an opt-in *labeller* (a real improvement of a
   negative-edge baseline to ≈break-even) and buy the **affordable** paired hurdle
   (`--test=10` → 54 clusters ≥ 41); do **not** buy bars for the DSR floor (§14.2).
5. **`sig-accel`:** arm-level; economically viable to ~11.6 bps but the 2-bps failure is the
   knife-edge DSR floor, so the lever is **cost/turnover** — test a no-trade region offline
   first (`restateReportAtPolicy` + `turnoverSweep`).
6. **Independence:** measure the market-neutral overlay offline before building any
   cross-sectional candidate (`effectiveStreams` 2.05–2.47/8, design effect 5.12).
7. **`pca-hash`:** measured inert reason + a retrieval-liveness probe (P2); reading polish
   (#55) unchanged.

---

## 14.7 Round-28 implementation record (the plan landed; what each change reproduces)

This subsection is the *implementation* record for `PLAN-round28.md` P1/P2: what landed, the
numbers re-derived from the four retained reports, and the tests that pin each. All arithmetic
below is recomputed from the four `src/20260923T*/report.json` files (re-read this session and
retained in-session; the run directories themselves are no longer in the tree — see §14.8).

### 14.7a The corrected sizing block, recomputed for every round-27 candidate (`BUGS.md` #56)

`decision.nextRun`'s paired fields, recomputed with the test's own **one-sided** cluster-t
reference `t(df, 0.05)` and the **paired** SE (`analyze.js` `pairedUnitsNeeded` /
`cheapestFlip`, the shapes pinned by `analysis.test.js` §AM):

| run | candidate | paired Δ | paired SE | df | p(one-sided) | one-sided requirement `t(df)×SE` | factor | `neededForObserved` | `neededForObservedPower80` |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Step 1 (2×200) | `surprise` | 0.01596 | 0.14429 | 8 | 0.4573 | 0.26832 | 16.81 | 1993 | 4550 |
| Step 1 (2×200) | `homeostasis` | −1.24678 | 0.44726 | 8 | 0.9882 | (wrong direction) | −0.667 | 6 | 9 |
| Step 2 (8×600) | **`label-conservative`** | **0.21640** | **0.13554** | **35** | **0.05967** | **0.2289985** | **1.0582** | **41** | **89** |
| Step 2 (8×600) | `label:triple` | 0.13405 | 0.10724 | 35 | 0.10980 | 0.1811839 | 1.3516 | 65 | 144 |
| Step 3 (8×600) | `sample-weights` | −0.22762 | 0.16653 | 35 | 0.90980 | — (`cheapestFlip` = `cost`) | — | 55 | 121 |
| Step 4 (8×600) | `sig:momentum` | 1.19950 | 0.61358 | 35 | 0.02931 | 1.0366883 | 0.8643 | 28 | 60 |
| Step 4 (8×600) | `sig-accel` | 1.13411 | 0.66835 | 35 | 0.04930 | 1.1292325 | 0.9957 | 36 | 79 |

Three corrections worth naming:

* **The old `×4.95` was ×4.7 too large** and pointed at the wrong lever. On Step 2 the
  one-sided requirement is `t(35)×0.1355364 = 0.2289985` against the observed `0.2164017` —
  **94.50 %, factor 1.0582** (§14.1).
* **`neededForObserved` is 41, not 55** (the old form used the two-sided 1.959964 in a
  one-sided t test). The `pairedUnits.needed.mde95Dependent` cross-scale target is gone; the
  paired MDE at the current cluster count is `reference.pairedMde95 = t(35)×SE = 0.2289985`.
* **80 % power is 89 clusters, not 81.** `PLAN-round28.md` §0/§P4 quote `81` from the normal
  approximation `(1.6449 + 1.95996)²·(SE/Δ)²`; the fitted quantity the code reports is the
  *smallest n with `(t(n−1, 0.05) + z_0.80)·SE·√(C/n) ≤ Δ`*, which is **89** here (the t
  critical value exceeds the normal constant at small df, so the exact answer is larger). The
  fixture value is pinned in `analysis.test.js` §AM
  (`neededForObserved 41`, `neededForObservedPower80 89`, factor `1.0582470005895548`).

Two sanity checks fall out of the table: `sig:momentum`'s paired test is already resolved at 36
clusters (factor 0.864 — its only binding reason is the adjusted-DSR floor), and Step 3's
`sample-weights` reports `cheapestFlip.kind = 'cost'` (break-even −4.51 bps < the cheapest
tested cost), so its cheapest lever is cost, not power. Both are the honest readings.

### 14.7b The gate reconciles with the record, verdict-neutral on all four runs (`BUGS.md` #57)

`promoteDecision` now reports the raw fold-win / positive-fold fractions as statistics
(`hurdles[].gated === false`, still carrying their honest `failed`/`margin`) and the shipped
`gateOptions` pass `rawFoldHurdles: false` (`analyze.js:2016`; pinned by `analyze.test.js`). The
verdict-neutrality proof, re-derived from the reports' own `reasons` arrays (the gate is
deterministic and the stored `reasons` *are* its output; a raw-fold reason is exactly one
beginning `fold win fraction `/`positive-fold fraction `):

| run | candidate | `promote` (round-27 gate) | raw-fold reasons | error-controlled / other reasons | `promote` with the raw hurdles off | unchanged |
| --- | --- | --- | ---: | ---: | --- | --- |
| Step 1 | `surprise` | false | 2 | 5 | false | ✓ |
| Step 1 | `homeostasis` | false | 2 | 5 | false | ✓ |
| Step 2 | `label-conservative` | false | 1 | 3 (unadj. DSR, adj. DSR, paired p) | false | ✓ |
| Step 2 | `label:triple` | false | 2 | 3 | false | ✓ |
| Step 3 | `sample-weights` | false | 2 | 5 | false | ✓ |
| Step 4 | `sig:momentum` | false | 1 | 1 (adj. DSR 0.9487614) | false | ✓ |
| Step 4 | `sig-accel` | **true** | 0 | 0 | **true** | ✓ |

**8/8 unchanged.** The decisive case is `sig:momentum`: its raw win fraction (0.4930556 < 0.5)
is an always-on reason today, but the adjusted-DSR floor (0.9487614 < 0.95) binds
independently, so removing the raw hurdle neither promotes nor blocks it. Pinned by
`analysis.test.js` §AM with a 3-stream × 6-window fixture whose candidate wins **1/3 of the
folds** and **6/6 window clusters** (raw off → promotes with zero reasons; raw on → blocked by
the raw majority alone) — a case where the two breadth statements disagree in direction, which
is exactly the `label-conservative` / `sig:momentum` pattern.

### 14.7c The P2 retrieval-liveness measurement (`BUGS.md` #53 / #59)

`_retrieveTopRelevantProtos` draws `Math.random()` for two kinds of work: bucket-probe flips
(basis-dependent) and index-picks over `semProtos` (`semProtos[floor(rand·numSem)]`,
basis-independent). Under a **fixed** retrieval RNG seed, therefore, if the two configs consume
the **same number of draws** their streams stay in lockstep and every index-pick is identical —
so any difference in the returned result is attributable to the hash basis, not to desync.
Measured on `makeAnisotropicBank` (the genuine anisotropic regime; `lsh.test.js` §K):

| width | hash bits | pool | retrieved **set** differs? | returned **list** differs? | draw counts |
| --- | ---: | ---: | --- | --- | --- |
| production | 107 | 80 | **never** (0/4 queries × 3 seeds) | 1/4 queries at 3/3 seeds (`rs` 2, 3, 5) | **equal** (23 200 000) |
| production | 107 | 200 | never | 1/4 at `rs` 5, 7 | equal |
| production | 107 | 600 | never | never | equal |
| narrow | 6 | 200 | never | never | **unequal** (38 448 vs 38 249) |

So the honest status is **reachable, and retrieval-set-inert at every tested budget**: the
aligned basis never changes *which* prototypes a query retrieves, but at production width it
*does* change the duplicate multiplicity of the returned list (attributable — equal draw
counts), and at narrow width the draw streams desync so a difference there would not be
attributable at all. Two consequences the round's documents carry:

* the `pca-hash` certificate quotes the **set** invariance and the two budget figures, never a
  structural unreachability (`analyze.js`; `analyze.test.js` §M2);
* the multiplicity itself is a real reader defect — the fallback fillers guard with
  `semCandidates.has(proto)` but never add to that Set, so the same prototype can enter the
  returned list more than once — filed as **`BUGS.md` #59**, *reported, not fixed*, because
  de-duplicating the scored path would move every golden fingerprint.

Pinned by `lsh.test.js` §K (6 checks; ledger `lsh` 69 → 75).

### 14.7d The weighting mechanism is re-armed (P1b/P1c, `BUGS.md` #54/#58)

`sample_weights.js` gained `emittedWeightNormalizer` (a causal EMA of the raw weights, three
modes: `mean1`, `scale`, `none`) and `trades.js` feeds the ring a **causal** span horizon — the
EMA (α 0.1) of the realized holding periods of trades drained *before* each label, never the
span of the label being weighted — overridable with `--sample-weight-horizon=<n>`. `analyze.js`
registers the opt-in `sample-weights` (default `mean1`) and the **scale control**
`sample-weights-scale-control` (constant `scale`), and `sampleWeightSummary` reports
`{mean, meanUnnormalised, min, max, ess, n, horizonBars, measureHorizon}` so a
mis-normalisation is visible. The `null`-config path is bit-identical (goldens unmoved). Pinned
by `sample_weights.test.js` §E and `controller_invariants.test.js` §D (measured span 8,
`min < 1 < max`, `ess < n`, prefix causality, and the `none` arm reproducing the raw stream).

### 14.7e Reading polish (`BUGS.md` #55)

`decision.training.labelPolicy` now names the **referent** model's policy, with the run-level
flag beside it as `runLabelPolicy`; `familyCorrelation` labels its `maxPair` against the
**active** candidate list the matrix was built from (`familyPairLabel`); and every evaluated
hurdle carries `{value, threshold, margin, direction, failed, gated}` so a knife-edge miss is
legible (`formatDecision` prints the tightest hurdle and the referent policy). Pinned by
`analysis.test.js` §AM and `analyze.test.js`.

## 14.8 The Step-0.5 offline restatements (`PLAN-round28.md` §3)

The plan's Step 0.5 asks for three pure-post-processing readouts from the retained round-27
journals. **One is done, two are blocked by missing journals** — stated plainly, because the
whole round is about not over-claiming:

**(a) The P4 sizing / decision table — DONE.** §14.7a is exactly it: the one-sided paired
requirements (41 clusters for significance, 89 for 80 % power, factor 1.058) and the corrected
DSR-floor reading (a Sharpe ≈1.02–1.08; the labeller's 0.1017 is ≈10× short). This is the
arithmetic `METHOD.md` §7 records and `TODO.md` 76/82 carry.

**(b) The market-neutral overlay (P6) — NOT MEASURABLE from the *round-27* artefacts, but
reconstructible from any retained multi-stream journal.** The plan
specifies pure post-processing of a candidate's retained `streamReturns` (`r_s(t) − mean_s
r(t)`). The four round-27 `report.json` files do **not** retain `streamReturns` (they retain
only the derived `dependence` block, `familyCorrelation`'s excess-correlation pairs and the
forecast scores), and the round-27 `folds.jsonl` journals are no longer in the tree (the four
`20260923T*` run directories are absent; only `src/20260920T094400-seed1/` retains a journal,
which is a 1-stream 300-bar smoke run — no cross-section to demean). So the decisive
measurement cannot be reproduced here.

A retained `folds.jsonl` **is** sufficient, however: every scored line carries `stream`,
`fold`, `test` (the bar indices) and the per-bar `returns` of that stream's fold, so the
cross-sectional panel `r_s(t)` is rebuildable from the journal alone (this is the same route
§1.3's round-24 reconstruction and the round-27 `dependence` block were computed by). The
round-28 Steps 1/2 are `--symbols=all` runs and write `folds.jsonl` at the default
`--fold-log=all`, so **their journals unblock (b) without re-running the round-27 design**:
align the 8 streams by `test` within each fold, demean each bar across streams, and recompute
`dependenceSummary`; compare that design effect against the retained 5.12×.

What *can* be said from the retained Step-2 `dependence` block is a **bound**, not a
measurement. Step 2 reports `meanPairwiseStreamCorr 0.41519`, `equicorrelationDesignEffect
3.90630` (exactly `1 + 7 × 0.41519`, so the equicorrelation model is internally consistent),
the jackknife `designEffect 5.12057`, and `effectiveStreams 2.048` of 8. If the mean pairwise
correlation were *entirely* a single common factor and cross-sectional demeaning removed it,
the equicorrelation component would fall to 1 and the design effect would fall to the residual
`5.12057 − 3.90630 + 1 = 2.21427` → an SE gain of `√(5.12057 / 2.21427) = 1.52×`; the absolute
ceiling (the whole design effect were the common factor, DE → 1) is `√5.12057 = 2.26×`. So a
perfect market-neutral sleeve buys **between ≈1.5× and ≈2.3× on the pooled level's SE** — a
real but bounded help, and (as §14.2 already notes) nowhere near the ≈10× a DSR-floor promotion
would need. The *paired* SE's response is a different quantity and is not bounded by this
algebra; it needs the panel. The plan's cross-sectional candidate therefore stays **gated** on
an actual overlay measurement.

**(c) The `sig-accel` no-trade-region / minimum-hold sweep (P5) — NOT RUNNABLE from *this*
tree.** The
sweep (`restateReportAtPolicy` + `turnoverSweep`) is pure over the journaled pre-policy
confidence. That per-bar series is not in the reports, but it **is** in `folds.jsonl` (`signals`,
aligned to `test`), so — exactly as in (b) — the sweep is runnable from any retained journal of
the relevant variant; the reports retain only its summary —
`sig-accel` `confidence {bars 4320, pairs 4032, lag1 0.89077, halfLife 5.99}` — plus the cost
ladder). The retained Step-4 cost ladder is the surviving evidence and is worth stating exactly,
because it frames the question:

| candidate | Sharpe @0 bps | adj. DSR @0 | Sharpe @2 | adj. DSR @2 | adj. DSR @5 | adj. DSR @10 | break-even |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `sig-accel` | 1.0194 | **0.9742** ✓ | 0.8434 | **0.9223** ✗ | 0.7443 | 0.3029 | 11.57 bps |
| `sig:momentum` | 1.0848 | 0.9488 ✗ | 0.9370 | 0.8933 | 0.7542 | 0.4359 | 14.64 bps |
| `label-conservative` | 0.1017 | 0.2521 ✗ | 0.0110 | 0.2024 | 0.1408 | 0.0707 | 2.24 bps |

`sig-accel` clears the floor by 0.0242 at 0 bps and misses it by 0.0277 at 2 bps — a knife-edge,
not a loss (its gross break-even is 11.57 bps). A holding rule that removes turnover would need
to lift the 2-bps adjusted DSR by ≥0.0277 without dropping Sharpe below the floor; the
`confidence` summary (lag-1 0.891, half-life ≈6 bars) says the signal is persistent, which is
the precondition the classical no-trade region needs (Constantinides 1986; Davis & Norman 1990;
Gârleanu & Pedersen 2013; alpha decay arXiv 2502.04284). **To actually run it, the operator
re-runs Step 4 with `--fold-log=all` retained (the round-27 runs did write `folds.jsonl`, but
those files are gone from this tree) and post-processes with
`--turnover-sweep`/`restateReportAtPolicy`; the exact grid is `analysis/holding.js
DEFAULT_TURNOVER_GRID`.** Note that neither scheduled round-28 run journals a *signal*
candidate (Step 1's arms are `sample-weights`/`sample-weights-scale-control`, Step 2's is
`label-conservative`), so unblocking (c) specifically needs a signal-family re-run with
`--fold-log=all` (omit `--variants`, or pass the `sig:*` ids). Until then, the P5 claim is
limited to "the lever is cost, and the surviving summary is consistent with cost being
attackable".

**Operator commands** (from `PLAN-round28.md` §3, unchanged): Step 1 is the corrected weighting
A/B (`--variants=sample-weights,sample-weights-scale-control`), Step 2 the label-policy paired
confirmation (`--test=10`, 54 clusters ≥ 41), Step 0.5(b)/(c) the two offline readouts above —
each of which needs its run's `folds.jsonl` retained (`--fold-log=all`, the default). **(b) is
unblocked by either new run's journal** (both are `--symbols=all`, so the 8-stream panel is in
`folds.jsonl`); **(c) additionally needs a signal-family run** because no scheduled run journals
`sig-accel`.
