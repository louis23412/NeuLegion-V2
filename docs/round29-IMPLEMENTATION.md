# Round 29 → 30 implementation tracker

Status board for turning [`PLAN-round29.md`](PLAN-round29.md) into code and measurements.
This file is the single place a fresh session should read to know **what is done, what is
mid-flight, and what is gated/skipped and why** — the chat is not a durable store.
`PLAN-round29.md` remains the specification; this file is the execution log.

Read order for a new agent: `README.md` (repo) → `docs/PLAN-round29.md` →
`docs/research/round29-README.md` → **this file** → `docs/RUN-ANALYSIS.md` §16 (round-29 readouts).

---

## 0. How to work / verify in this environment

* There is **no `node`/`npm`** in this workspace. The repo's own **browser test harness**
  (`test/browser/harness.js`, esbuild-wasm from `esm.sh` + the shims in
  `test/browser/shims/`) *does* run inside the AI worker: see the ephemeral driver
  `scratch/run_entry.js` (`runEntry(entryFile)` / `runEntrySafe`). It bundles an entry with
  esbuild and runs it, returning `{total, failed, failures}`.
* **Baseline test ledger measured this session** (fresh, before any round-29 edit):
  `analysis.test.js` **586 checks / 0 failed**; `analyze.test.js` **255 checks / 0 failed**;
  `features.test.js` 11/0. Re-measure after every edit batch and record in the ledger
  below. The plan's §10 item 8 ("no golden fingerprint moved") is checked by the golden
  suite in the same way.
* To run a one-off offline measurement, bundle the needed pure module(s) through the
  harness (`__fs` must expose `readTextFile`/`readFile`), e.g.
  `import { dependenceSummary } from '<P>/src/analysis/walkforward.js'`. Write bulky output
  to `scratch/` and return only a small summary.
* `P` (repo root) = `src/NeuLegion-master/NeuLegion-master`.

---

## 1. Status board

| id | item | status | artifact / where |
| --- | --- | --- | --- |
| U0 | C10 — restate the P6 market-neutral overlay on the **Step-3** journal for **every** positive-Sharpe arm | **DONE (measured)** | `RUN-ANALYSIS.md` §16.1; raw `scratch/r29/overlay-final.json` |
| P1 | model-class benchmark (base rate / linear / MLP / TSFM / controller) | **DONE (measured; G-A = negative branch)** | `src/analysis/benchmark.js` (new), `src/analyze.js`, `src/analysis/forecast.js`, `RUN-ANALYSIS.md` §16.2 |
| P2 | configuration-robust promotion + exposure matching | **DONE (measured; verdict-neutral on the retained runs; kills the §15.5(c) promotion; wired into the driver as an opt-in `--cadences` / `--exposure-match` pass)** | `analysis/decision.js`, `analysis/walkforward.js`, `analyze.js` (`configurationRobust` / `exposureMatched` report blocks); `RUN-ANALYSIS.md` §16.3 |
| P3 | 15m reversal | **DONE (measured; NON-ACCEPTANCE — the effect is real, the cost model rejects it)** | `src/data/candles_*_15m.jsonl` (new), `src/candles_audit.js`, `src/analysis/features.js`, `src/analyze.js`, `RUN-ANALYSIS.md` §16.4 |
| P4 | funding/basis carry | **DONE (measured; ACCEPTANCE on the P4 criterion, G-C does not cross; sleeve wired + guarded)** | `src/data/funding_*_8h.jsonl` (new), `src/analysis/carry.js` (new), `src/funding_fetcher.js` (new), `src/candles_audit.js`, `src/analysis/walkforward.js`, `src/analyze.js`, `RUN-ANALYSIS.md` §16.5 |
| P5 | continuous TTA (off by default) | **DEFERRED (designed + costed; gate G-D OPEN)** — DoD item 4 is conditional | `RUN-ANALYSIS.md` §16.6, `TODO.md` |
| P7 | `es ∈ {2,4,8,16}` probe | **CLOSED by G-A** (features/labels are the constraint) | `RUN-ANALYSIS.md` §16.2 |
| P6 | meta-labeling | **CLOSED by G-A** (primary has no skill) | `RUN-ANALYSIS.md` §16.2 |
| — | docs sync | **DONE** — every `PLAN-round29.md` §5.4 target updated; lockstep index ↔ registry | §6 below |

### P1 outcome (recorded before later items ran)

**G-A negative branch.** On the shared causal feature vector, no forecaster has material
positive Brier skill vs the base rate: ridge is the best and the only MCS₉₀ survivor
(~0.8–1.1 % relative Brier better than the base-rate *model*, but its Brier skill vs
`p̄(1−p̄)` is ≈0 or slightly negative), and the MLP is decisively worse. So **features/labels,
not architecture, are the constraint** ⇒ P6 and P7 are **closed** (not run) and the round's
weight goes to P3/P4. Exact table: `RUN-ANALYSIS.md` §16.2.

### P2 outcome

**Two fragility attacks, one of which fires.** (a) **Exposure matching is verdict-neutral on every
retained run** (all keep-off before and after) — the shipped failure is not a
one-arm-abstaining artefact. (b) It **kills the pipeline's only manufactured promotion**: §15.5(c)'s
turnover-policy 0-bps promotion of `sig-accel` compared a **flat** baseline (0.37 % of bars)
against an **80 %-invested** candidate; at equal exposure (~80 %) the candidate's net Sharpe falls
+1.19 → +0.92 and its dependence-adjusted DSR 0.9584 → **0.7925** (paired Sharpe p 0.077) ⇒ keep-off.
(c) The four net-positive-Sharpe Step-3 arms fail at **every** cadence of {10, 15, 30}
(0/3 passes each), so their keep-offs were not cadence-luck. Exact tables: `RUN-ANALYSIS.md` §16.3.

### P3 outcome

**The documented 15m reversal is real and economically inaccessible — a full (non-)result.**
Step 0 fetched **639 992 bars** of 15m data (8 symbols, 2024-06 → 2026-09) through the existing
`fetchCandles` path and they pass the 15m-grid integrity audit cleanly; the basket is registered
as a second manifest (`CANDLE_MANIFEST_15M`, `QUARTER_HOUR_MS`) so the shipped 1h basket and the
interval-blind tests are untouched. The effect is present: lag-1 autocorrelation is significantly
negative in **6/8** symbols (SOL −0.018, XRP −0.019, LINK −0.043, DOGE −0.012, BNB −0.009,
ADA −0.007) and the momentum control is its mirror image (−0.41 gross Sharpe, 48.8 % directional
accuracy). But the per-bar gross edge is ≈0.18 bps at 0.52 turnover/bar, so the **break-even cost
is 0.32–0.56 bps** against a 5–10 bps taker fee, and at 5 bps the reversal book's interval-correct
net Sharpe is **−15.9**. Through the pre-registered gate at **three real cadences** every arm
promotes **0/3** (dependence-adjusted DSR 0.14–0.90); the look-ahead audit is clean and reachable
at every cadence. The `-4` variant gets nearest the cost bar (4.5–5.1 bps on the short harness
windows) but its DSR still fails, i.e. the near-cost-pass is a short-window artefact the
significance floor correctly refuses. Exact tables: `RUN-ANALYSIS.md` §16.4.

### P4 outcome

**The funding/carry sleeve is a real, structurally independent return source, wired and guarded.**
Step 0 fetched **57 939 rows** of Binance USDⓈ-M funding history for the eight symbols (2019-09 →
2026-09, `src/data/funding_*_8h.jsonl`) through a dedicated fetcher (`src/funding_fetcher.js`) and
audited them with the new `src/analysis/carry.js` — **0 audit problems** on the 8h grid (SOL's 98
off-grid steps are 1.47 %, inside the 2 % budget; BNB 3 600 / LINK 344 exact-zero periods are real
venue artefacts). Six of eight symbols pay ≥ 12 %/yr; the pooled delta-neutral book over the window
all eight share is **9.78 %/yr at 0.84 % vol** (carry Sharpe 11.6, maxDD −3.3 %). Its correlation
with the equal-weight price basket is **+0.003** on the full 15m grid (against the 0.29–0.52
cross-stream range the plan set as the bar) and it raises the panel's **effective streams from
1.25 to 1.54 of 9** (`meanPairwiseStreamCorr` 0.769 → 0.604). The honest caveat: the delete-one-
cluster **design effect barely moves (5.226 → 5.228, cluster SE −5.7 %)** because that estimator is
serial-dominated, so under gate **G-C** (does the sleeve move the best arm's `dsrAdjusted` across
0.95?) the answer is **no** — carry is a breadth purchase by the DSR metric and a genuine
independence purchase by the correlation/effective-streams metric. Both readings are recorded
(§16.5). What this bought the codebase beyond the number: `analyze.js` `--carry-files` /
`extraPanelStreams` wiring with the price-only dependence retained beside the extended one, a
degeneracy guard that refuses a constant sleeve, and three defects fixed before any measurement was
trusted (`BUGS.md` #64/#65/#66).

### P5 decision (deferred; the gate stays open)

**Not built.** The survey changed the premise and found the blocker, so the decision is recorded
rather than half-implemented. (i) The shipped controller **already adapts continuously within a
fold** — `getSignal` resolves filled trades and trains on their realized labels, so the only
schedule-bound element is the per-fold refit; P5 as specified would *replace* the shipped full-
parameter online update with a norm-affine-only one, i.e. it is an architecture experiment, not a
missing mechanism. (ii) The change must be enforced inside the **golden-pinned**
`hivemind/training/gradients.js`, where ~20 parameter updates are applied inline; the safe design
(freeze by construction: snapshot the parameter tree, run the ordinary training step, restore
everything except the `layerNormWeights[*].gamma1/gamma2` arrays) needs no trainer surgery but does
need a new opt-in flag threaded through `analyze.js` → `evaluateAB` → the model factory →
`fold_worker`, a causal pseudo-label objective, and bit-identity + freeze-verification tests. (iii)
Cost is *not* the reason: a controller A/B is affordable here — measured **9.1 s** for a
1-stream/100-bar/4-fold/2-arm run, so the `testSize ∈ {10,15}` × 2-arm acceptance grid is ≈ 1–1.5 h.
(iv) By the plan's own statement P5 can only remove a nuisance, never create edge, while the round's
decisive evidence is already in hand; committing half-tested online-update plumbing to the scored
path at the end of a measurement round would risk the round's one hard-won asset (an exactly
reproducible scored path). The full design + acceptance test live in `RUN-ANALYSIS.md` §16.6 and
`TODO.md`.

### Method note (this environment)

Because there is no node, every *run* below is reproduced **offline from retained journals**
using the repo's own pure modules (the same arithmetic the report uses) — which is exactly
what the plan's "pure post-processing" items (U0, P2 retrospective, C10) call for. **Correction
(round-29 P4/P5):** the earlier claim that `analyze.js --model=controller` "cannot be executed
here" is **wrong** — with the harness's `better-sqlite3` shim (`await __ensureSql()`) and
`HiveMindController` injected into `runAnalysis`, a shipped-controller A/B runs in-process
(measured: 9.1 s for 1 stream / `maxBars 100` / 4 folds / 2 arms; the cost law is
`O(streams × folds² × arms)`). The `model: 'bare'` runs used for the P1/P3 rosters are still the
cheap choice for *signal-family* questions (a signal arm costs nothing, so a roster of signals is
essentially the baseline's cost), but the controller path is available when a question needs it.

**Ledger sweep at the end of this round.** All **31** browser entries were run through the harness
after the last edit: **0 failures**, ~2 547 check assertions in total (`golden.test.js` 23/0 is the
DoD item-8 certificate: no golden fingerprint moved; `bench.test.js` returns timings, not checks).

---

## 2. Unit 0 (C10) — measured result

**Method (exact, reproduces `RUN-ANALYSIS.md` §15.5b byte-for-byte).** Rebuild each variant's
8-stream × bar panel from `folds.jsonl` (`stage:"score"`, `testStart`, `returns`, `signals`);
the held position at bar `i` is `signals[i-1]` (the journal stores the *pointwise*
confidence→position map; `strategyReturns` applies the one-bar lag). Per bar,
`gross_s = pos_s·ret_s`; `common = S·mean_s(pos)·mean_s(ret)`; `cross = gross − common`;
`retNeutral` = pooled Sharpe of `pos_s·(ret_s − mean_s ret)`; `posNeutral` = pooled Sharpe of
`(pos_s − mean_s pos)·ret_s`; `dEff`/`effectiveStreams`/`rbar` from the real
`dependenceSummary`. **Cross-check:** for the six arms the plan quotes, every recomputed value
matches §15.5b (raw/retNeutral/posNeutral/dEff/effStreams/rbar/commonShare) — e.g. Step-2
baseline `gross 0.077934`, `common 0.078524`, `cross −0.000590`, `commonShare 1.0076`,
`dEff 2.611`, `effStreams 2.417`.

**Result — Step-3 journal, all four positive-Sharpe arms (this is the new content).**

| arm | net Sharpe | `retNeutral` | `posNeutral` | common share | dEff / effStreams | r̄ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `sig-momentum` | +1.0848 | +0.0890 | +0.1101 | **0.9582** | 3.624 / 1.725 | 0.5196 |
| `sig-accel` | +1.0194 | −0.0586 | −0.0698 | **1.0291** | 2.465 / 1.890 | 0.4617 |
| `sig-range` | +0.4490 | +0.3536 | +0.3406 | **0.6095** | 3.121 / 1.913 | 0.4546 |
| `sig-agreement` | +0.3912 | +0.2747 | +0.2679 | **0.6570** | 3.342 / 1.930 | 0.4492 |

(For reference the two arms with the *largest* residual Sharpe but **negative** raw Sharpe:
`sig-frac-momentum` −0.4185 → retNeutral +0.0940; `sig-vol-regime` −0.3135 → +0.0580.)

**Reading (a correction to the plan's §1.2, recorded as U0's acceptance).** The *universal*
claim "~100 % of every positive-Sharpe arm's gross is net-exposure × market" is **false as
stated**: `sig-range` (0.61) and `sig-agreement` (0.66) keep a substantial cross-sectional
component (+0.35 / +0.27 retNeutral Sharpe). The claim **is** true of the two arms that carry
all the level — `sig-momentum` (0.958) and `sig-accel` (1.029), whose retNeutral Sharpe is
+0.089 / −0.059. So the honest restatement is: *the arms with any cross-sectional content are
the two that do not clear the gate (adjDSR 0.261/0.211), and the arms that clear everything but
the dependence-adjusted floor are ~100 % market.* This sharpens, rather than weakens, the
diagnosis: there is no *independent* edge, and the residual that exists is too weak to promote.

---

## 3. Ledger (measured, per edit batch)

| batch | analysis.test.js | analyze.test.js | features.test.js | notes |
| --- | ---: | ---: | ---: | --- |
| pre-round-29 | 586 / 0 | 255 / 0 | 11 / 0 | baseline this session |
| P1 (benchmark module + wiring + forecast grouping + tests) | 591 / 0 | 257 / 0 | 11 / 0 | +5 analysis checks, +2 analyze checks |
| P2 (decision + restatement + exposure matching + tests) | 599 / 0 | 257 / 0 | 11 / 0 | +13 analysis checks over baseline; exposure-match bug fixed (§4 I5) |
| P3 (15m basket + reversal family + panel + tests) | 607 / 0 | 258 / 0 | 11 / 0 | candles.test.js **139** / 0 (the 15m basket is audited on its own grid) |
| P4 (carry module + funding data + panel wiring + fetcher + tests) | **621** / 0 | 258 / 0 | 11 / 0 | candles.test.js **192** / 0, fetcher.test.js **111** / 0 (+45 funding-basket, +8 byte-round-trip, +10 fetcher checks); 3 defects fixed (#64/#65/#66) |
| **final sweep (all 31 entries)** | 621 / 0 | 258 / 0 | 11 / 0 | **0 failures everywhere**, ~2 547 assertions; `golden.test.js` 23/0 (DoD 8), `candles.test.js` 192/0, `fetcher.test.js` 111/0, `walkforward.test.js` 63/0 |
| **docs sync + lock registration** (registry entries + 3 count mirrors; no `src/` arithmetic changed) | 621 / 0 | 258 / 0 | 11 / 0 | subset re-run: `locks` 41/0 (new entries validate), `candles` 192/0, `fetcher` 111/0, `golden` 23/0 (unmoved), `walkforward` 63/0 |
| **P2 driver wiring** (`analyze.js` `--cadences` / `--exposure-match` + 11 checks + node mirror; rounds 4–5 audit) | 621 / 0 | **269** / 0 | 11 / 0 | all 30 entries re-run: **2558 / 0** (`golden` 23/0 unmoved; the flags are default-off and pure post-processing, so no scored number moves) |

(Fill a row after every code change. Any non-zero `failed` must be resolved before moving on.)
Raw digest of the final sweep: `scratch/r29/ledger-all.json` (ephemeral — the numbers are repeated
here so they survive the session).

---

## 4. Decisions taken during implementation (beyond `PLAN-round29.md` §6)

Recorded here as they are made; keep `PLAN-round29.md` unchanged as the historical spec.

* **I1.** P1 is implemented by **reusing `evaluateAB`** rather than writing a second
  walk-forward: a new *benchmark* variant kind whose `fit/predict` is a base-rate / ridge /
  MLP forecaster on the **same causal `featureVector`** the bare path already uses. This puts
  the benchmark on the same folds, the same pooled OOS bars, the same audit, gate, cost ladder
  and `forecastComparison` as every other arm — so "same inputs" is structural, not asserted.
* **I2.** `forecastComparison` gains a **calibration group**: the probability-calibrated kinds
  (controller + the benchmark models) are grouped and MCS'd together; signals keep their own
  group. This is a generalisation of R27-5's within-kind rule, backward-compatible (a
  controller-only or signal-only run groups exactly as before).
* **I3.** The TSFM arm stays **pluggable and not-run** unless a small local pretrained model is
  already available: the plan lists it as "one arm, offline, and droppable" (§8). Recorded so
  the branch is decided on base-rate/linear/MLP + the controller, with the TSFM marked
  `not-run (no dependency)` in the P1 table.
* **I4.** `promotionAcrossCadences` is **majority-pass with a catastrophic veto**, not a
  unanimity rule: unanimity across an odd grid of ≥3 cadences is nearly a single-cadence gate at
  the worst cadence (it would reject a real edge that one cadence's partition happens to split
  badly), while a bare majority with no veto lets a candidate that is *outright losing* at one
  cadence through. Default `majorityFraction = 0.5` means *more than half*; the veto is a failed
  look-ahead audit or a negative pooled net Sharpe (`defaultCatastrophic`), both of which are
  "this arm is broken at this cadence", not "this arm is unlucky at this cadence".
* **I5.** `exposureMatchedPair` restates at the policy **before** reading the two families'
  in-market shares (a report built from a journal carries no `pooledMetrics`, so reading it off
  the report silently gave a zero target and a *degenerate* match where both arms sat flat — the
  first retrospective did exactly this and was discarded). The matched row also **drops any
  holding band**: a band's `enter`/`exit` is another absolute confidence-space threshold that
  suffers the same scale mismatch, and its hysteresis floors the attainable exposure, so an exact
  match requires a scale-free (pointwise-dead-zone) rule. `keepBandInMatch: true` is available for
  a caller that wants the banded match, and `matchedWithinTolerance` reports when a discrete
  confidence distribution could not be pushed to the target share.
* **I6.** The 15m basket is a **second manifest**, not extra entries in `CANDLE_MANIFEST`:
  `candles.test.js` audits `CANDLE_MANIFEST` with the 1h constant `HOUR_MS` and keys parsed series
  by SYMBOL (so a duplicate `BTCUSDT` at 15m would collide with the 1h one and every 15m row would
  read as off-grid), and `multisymbol.test.js` replays **every** manifest entry through the
  controller. A separate `CANDLE_MANIFEST_15M` (+ `CANDLE_FILES_15M`, `QUARTER_HOUR_MS`) keeps the
  1h basket's invariants, `--symbols=all` and the heavy replay test exactly as they were; the 15m
  files are addressed by path (`--files=` / `runAnalysis({files})`).
* **I7.** The reversal family is **opt-in** (`REVERSAL_VARIANTS`, resolved by id) for the same
  reason as the P1 benchmarks and the label policies: adding candidates to the DEFAULT roster
  raises `K` and re-deflates every Sharpe in every future run. (The `analyze.test.js` assertions
  that the default roster is 14 arms / 13 candidates stay green, which is the check that this
  property holds.)
* **I8.** A cross-sectional signal reads the cross-section through a new optional `view.panel`
  (`{streamIndex, labels, returnsByStream}`), attached per stream in `runAnalysis` and passed
  through `makeCandleViewFor` — including on the look-ahead audit's perturbed pass (so the
  structural non-vacuity check and the behavioural reachability probe stay meaningful) and in the
  worker request (`fold_worker.js`), so a `--workers>1` run cannot silently score a
  cross-sectional arm as flat. With no panel (a single-stream run) the arm abstains rather than
  throwing.
* **I9.** An extra panel stream (the P4 carry sleeve) is a **per-stream** series, and the panel is
  a `K × per-stream-bars` matrix — so `poolReports` compares an extra stream's length against
  `priceStreamReturns[0].length`, **not** the concatenated `pooled.length`. The first version
  compared against `pooled.length` (8× on the shipped basket), which silently excluded the sleeve
  from *every* real run (`BUGS.md` #64). The wrapper also reports **why** a sleeve was excluded
  (`panelMismatchReason: 'length' | 'degenerate'`) instead of a bare boolean.
* **I10.** A panel stream must **carry information** to participate: a constant (zero-variance)
  extra stream makes every pairwise correlation undefined, so it is excluded by
  `poolReports` and never appended by the producer (`analyze.js` records
  `carry.unavailable: true` + the reason). This class — a silently-degenerate input that keeps the
  right shape — is what produced the all-zero sleeve of #66; the guard turns it into a reported
  exclusion.
* **I11.** Timestamps are normalized to epoch ms **at the comparison site**, not at the producer:
  the shipped candle JSONL stores ISO strings and `readCandles` passes them through (only
  `parseCandlesJsonl` normalizes), so `carryOnBarGrid` coerces both the bar axis and the funding
  rows (`toMs`). A funding row is realized **at** its own timestamp, so `auditFundingSeries`'s
  `unclosed` counts rows dated in the *future* (the candle rule `t + interval > now` flagged the
  newest period of all eight symbols — #66).
* **I12.** P5 is **deferred, not dropped**: the design (freeze-by-construction, gamma-only
  allow-list, causal pseudo-label objective, optional changepoint trigger, `tta` flag off by
  default, G-D acceptance) and the measured cost wall (9.1 s per small controller A/B → ~1–1.5 h
  for the 4-run acceptance grid) are recorded in `RUN-ANALYSIS.md` §16.6 + `TODO.md`, because the
  DoD item is explicitly conditional and the change class (a new dynamical element in the
  golden-pinned scored path) needs the off-by-default/bit-identity treatment the plan's §8
  requires. The gate G-D stays **OPEN**.
* **I13.** The two new pure analysis modules are **registered in the lock map**, not left
  unclassified: `analysis/benchmark.js` and `analysis/carry.js` are `LOCKED-invariant` entries in
  `test/lock-registry.js` (with `analysis.test.js`/`analyze.test.js` as their proving tests and
  existing citation keys), imported by the `locks` browser entry, and documented in
  `docs/LOCKED.md`. `funding_fetcher.js` is a top-level **driver** (like `candle_fetcher.js` /
  `fetch_candles.js`) and is deliberately *not* a registry entry. The `locks` check count is
  unchanged at **41** (the registry validity checks are aggregate, not per-module), so no mirror or
  RUNBOOK count moved for it. The docs sync also repaired stale ledger numbers the round-29 counts
  had left behind: the three exact-count node mirrors (`test/node/{analysis,analyze,candles}.test.js`)
  now assert 621 / 258 / 192, and `RUNBOOK.md` §6 / `LOCKED.md` carry the new four-entry ledger
  (`candles` 192, `fetcher` 111, `analysis` 621, `analyze` 269; total **2558**).

* **I14.** The P2 decision primitives are **wired into the driver**, not left as library code: `runAnalysis` gains opt-in `cadences` (`--cadences=a,b,c`) and `exposureMatch` (`--exposure-match`) options. With `cadences`, every ACTIVE candidate is re-scored on each fold grid with `restateReportAtCadence` at the run's own `positionPolicy`/`costBps`/`trials` (the fixed-position restatement the retrospective used — pure post-processing of the journaled confidence, no model), the gate is re-applied per grid (`promoteDecision`) and `promotionAcrossCadences` returns the majority-pass + catastrophic-veto verdict into a new `report.configurationRobust` block. With `exposureMatch`, `exposureMatchedPair` quotes each active candidate against the baseline at a matched in-market share into `report.exposureMatched`. Both blocks are **null unless the flag is set**, so the default report is byte-identical and no golden moves (this is the I7 principle applied to the decision procedure: a new behaviour must be opt-in and must not move the default). This closes `PLAN-round29.md` §7's `src/analyze.js` rows (the P2 cadence-grid restatement and the exposure-matched dead zone) and makes `METHOD.md` §10's "shipped decision procedure" wording literally true; the *re-train* cadence sweep (a stronger test than the fixed-position restatement) stays `TODO.md` 97. Verified by 10 new `analyze.test.js` checks (269 total) including the identity that the cadence-equal-to-the-scored-grid restatement reproduces the scored pooled Sharpe exactly.

---

## 5. Open questions / risks carried

* P3/P4 depend on network fetches; the **step-0 audit is a hard gate** (plan §8). If the 15m /
  funding history cannot be fetched and audited cleanly, the item is recorded as a data
  rejection, not skipped silently. *(Both were fetched and audited cleanly: 15m in §16.4, funding
  in §16.5. The funding series' only imperfection — SOL's 98 off-grid steps, 1.47 % — is inside
  the audit's budget and is recorded in `FUNDING_MANIFEST`'s audit table.)*
* P7/P6 are gated on P1's branch; if G-A says "features/labels are the constraint" they are
  *closed with a reason*, not run.
* One seed (`--seed=1`) everywhere: no cross-seed claim (FG12).
* The P2 cadence sweep is a **fixed-position restatement** (re-uses the models trained once at
  `testStart=60`, re-partitions the fold grid). It measures the *fold partition*, not the
  *training-set size*; a full `runAnalysis` per cadence would be the stronger test and is a cheap
  follow-up. (P3's gate **is** a real re-train sweep: three independent runs at
  `testSize ∈ {10,15,30}`.) Recorded so nobody reads the P2 readout as a full cadence sweep.
* **P5's gate (G-D) is OPEN**, not closed: the item is deferred with a design and a measured cost
  wall (`RUN-ANALYSIS.md` §16.6), so no reader should infer "TTA does not remove the cadence
  dependence" — nothing was measured. The one substantive finding is that the shipped controller
  already adapts continuously *within* a fold.
* **P4's caveat is load-bearing**: 9.78 %/yr is the *funding leg only* (no basis risk, execution,
  borrow/margin, liquidation, or the spot leg's own carry), measured on six years of one venue, and
  the DSR-level reading (G-C) does **not** cross. Any future round that wants the sleeve as a
  tradeable book must fetch a basis/mark series and cost the spot leg — recorded in `TODO.md`.
* P3's near-miss (`sig-reversal-4` at 4.5–5.1 bps break-even on short windows) needs the maker-fee
  / queue-position model before it can be called closed on economics rather than on the DSR floor.
  Recorded in `TODO.md`.

---

## 6. Docs sync (`PLAN-round29.md` §5.4) — completed

Every target in the plan's §5.4 checklist was updated as the items landed; the record is closed here
so a fresh session can see it was done:

| target | state | what it carries |
| --- | --- | --- |
| `RUN-ANALYSIS.md` | **DONE** | §16.1–§16.6: U0 overlay, P1 G-A, P2 gate, P3 reversal, P4 carry, P5 deferral |
| `METHOD.md` | **DONE** | **§10** configuration-robust promotion + exposure matching (P2); **§11** an independence purchase dated by correlation + effective streams, not DSR alone (P4). (The plan's "§10 (configuration)" is realised as §10 here.) |
| `DESIGN.md` | **DONE** | **§6.1 Addendum 3**: the round-29 decision-procedure changes (cadence gate, exposure matching, extra panel streams + guards, `FUNDING_MANIFEST`, P5 deferred) |
| `BUGS.md` | **DONE** | "Found by the round-29 implementation — #63–#67, all FIXED"; plus the round-5 "Found by the round-5 final cleanup — #68, FIXED" (the fold-worker factory and the dropped `sampleWeightHorizon`) |
| `TODO.md` | **DONE** | item 93 delivered; new 94 (maker-fee/queue model), 95 (basis + spot leg), 96 (P5 deferral + G-D acceptance), 97 (P2 true re-train cadence sweep) |
| `ROADMAP.md` | **DONE** | round-29 heading → IMPLEMENTED; outcome paragraph (G-A/G-B/G-C/G-D/G-E resolved) |
| `CITATIONS.md` | **DONE** | implementation note: the landed code reuses the existing anchors, with the mapping |
| `research/README.md` | **DONE** | "Implementation verdicts (round 29 → 30)" paragraph pointing at index §8 + `RUN-ANALYSIS.md` §16 + `TODO.md` 94–97 |
| `research/round29-README.md` | **DONE** | **§8 Implementation verdicts** (verdict table, gate outcomes, lockstep note) |
| `research/round29-registry.json` | **DONE** | `status: implemented`, `implemented: true`, new `implementation` block, `outcome` on every gate + direction, `coherence_corrections` |
| `src/README.md` | **DONE** | round-29 section (benchmark / carry / funding_fetcher modules, the two new manifests, the decision changes, P5), intro paragraph updated, ledger counts (analysis 621, fetcher 111) |
| `LOCKED.md` (beyond §5.4) | **DONE** | `benchmark.js` + `carry.js` rows in the analysis-supercharge table; `candles.test.js` count 95 → 192 |
| `test/lock-registry.js` + `locks.test.js` (beyond §5.4) | **DONE** | `benchmark.js` and `carry.js` registered `LOCKED-invariant` (ANALYSIS_MODULES + ANALYSIS_REGISTRY + imports); `locks` re-run **41/0** |
| `RUNBOOK.md` (beyond §5.4) | **DONE** | §6 ledger: `candles` 192, `fetcher` 111, `analysis` 621, `analyze` 269, total **2558**; a round-29 count-change paragraph |
| `test/node/{analysis,analyze,candles}.test.js` (beyond §5.4) | **DONE** | the three exact-count mirrors now assert 621 / 269 / 192 |

**Verification of the docs-sync + lock-registration batch** (harness, this session): `locks` 41/0
(the new registry entries validate and every export resolves), `analysis` 621/0, `analyze` 269/0,
`candles` 192/0, `fetcher` 111/0, `golden` 23/0 (no fingerprint moved — DoD 8), `walkforward` 63/0,
`features` 11/0.

The index ↔ registry lockstep check (plan risk C9 / §8): the verdict lines in
`research/round29-README.md` §8 and the `implementation` block of `research/round29-registry.json`
carry the same five gate outcomes (G-A negative, G-B negative, G-C not crossed, G-D open, G-E closed
with P7) and the same P1–P7b verdicts; both point at `RUN-ANALYSIS.md` §16 as the authority.

---

## 7. Post-implementation coherence / sanity / bug audit (round 29 → 30)

Run after the docs sync, as an independent pass over everything the round touched. Eight parts.

**1. Independent reproduction of the headline readouts from the shipped data.** Each was recomputed
through the repo's *own* pure modules (no retained journal needed) and matched the documented number
exactly:

| readout | result |
| --- | --- |
| `RUN-ANALYSIS.md` §16.2, P1 `testSize 15` | base-rate model Brier `0.25296` / skill `−0.0118` / acc `0.5005`; ridge `0.25020` / `−0.0008` / `0.5196` (`accuracySkill +0.0191`, MCS₉₀ `{linear}`); MLP `0.27431` / `−0.0972` / `0.5035`; bare HiveMind `0.25382` / `−0.0153` / `0.4866`; pooled OOS bars `4032` — **all exact** |
| §16.4, 15m lag-1 autocorrelation | 6/8 significantly negative; SOL `−0.0185` (t −5.2), XRP `−0.0188`, LINK `−0.0434`, DOGE `−0.0117`, BNB `−0.0090`, ADA `−0.0073`, BTC `−0.0065`, ETH `+0.0045` — **all exact** |
| §16.5, funding audit | per-symbol rows / off-grid / zero rates / ann-carry match the table exactly (57 939 rows total; SOL 98 off-grid; BNB 3 600 zero; LINK 344 zero; 0 audit problems) |
| §16.5, pooled delta-neutral carry | **6 606** periods (the timestamp intersection), mean `8.93069e-5`, **9.78 %/yr**, vol **0.84 %**, Sharpe **11.61**, maxDD **−3.34 %**, 22.2 % negative — **all exact** |
| §16.5, panel dependence | 8 streams `seIid 0.019847` / `seCluster 0.045370` / DE **5.226** / effBars 122 422 / r̄ 0.7686 / effStreams **1.2539**; +sleeve `0.018712` / `0.042784` / DE **5.228** / 137 668 / 0.6044 / **1.5424**; bar correlation **+0.0027** — **all exact** |
| §16.5, end-to-end probe | the shipped `runAnalysis({carryFiles})` reports `dependence.streams 9` / `dependenceWithoutExtras.streams 8` / `carry.panelStreams 1` / `pooledMeanRatePerBar 1.29e-6` / `correlationWithBasket −0.128`, and **8 streams + `carry:null`** without the flag — **matches** |

**2. Full suite.** All **30** pass/fail entries re-run through the harness after the audit edits:
**0 failures**, **2558** checks (`golden` 23/0 — no fingerprint moved; `bench` is timings-only).

**3. Defects and coherence gaps found, and fixed.**

* **`BUGS.md` #67 (code).** `restateReportAtCadence`'s *default* `trainSize` was `testStart − foldLen`
  (one `testSize` short); latent because every caller passed `trainSize`. Fixed to read the length
  from `folds[0].testStart`, and the existing P2 restatement check now pins the default (it is
  discriminating — the old expression failed it). No scored number moves (`analyze.js` never calls
  the function).
* **Lock registry (`test/lock-registry.js`) was not covering the round-29 additions to the three
  already-registered modules.** `ANALYSIS_MODULES` now lists `walkforward.js`'s
  `exposureDeadZone`/`restateReportAtCadence`/`exposureMatchedPair`, `decision.js`'s
  `promotionAcrossCadences`/`defaultCatastrophic`, and `features.js`'s
  `reversal`/`reversalWindow`/`reversalVol`/`crossSectionalReversal`/`REVERSAL_CANDIDATES`; the three
  `ANALYSIS_REGISTRY` notes gained a round-29 paragraph. `locks` re-ran **41/0**.
* **Stale test counts repaired** (round-28/round-29 churn the docs sync missed):
  repo `README.md` `controller_invariants` 16 → **23**; `src/README.md` `lsh` 69 → **75**;
  `docs/LOCKED.md` `lsh` 69 → **75** and `sample_weights` 45 → **57**; `docs/DESIGN.md`
  `sample_weights` 45 → **57**; `docs/research/lsh-ann.md` `lsh` 69 → **75**;
  `docs/RUN-ANALYSIS.md` `sample_weights` 45 → **57**.
* **Two round-29 count claims corrected:** `RUN-ANALYSIS.md` §16.4 said the reversal family was
  "exercised by 11 new `analysis.test.js` checks" (it is **8**) and the 15m basket added "35 new
  checks" in `candles.test.js` (it is **44**, matching the ledger's 95 → 139).
* **`src/analysis/analyze.js` doc comment** — an orphaned first line above `forecastKindOf` was
  restored.

**4. Plan coverage.** DoD items 1, 2, 3, 5, 6, 7, 8, 9 are met; item 4 is explicitly conditional and
**P5 is the one item not built** — deferred with the design + a measured cost wall and gate **G-D
still OPEN** (`RUN-ANALYSIS.md` §16.6, `TODO.md` 96). All other `PLAN-round29.md` §7 file-map entries
are delivered or deliberately superseded with a recorded decision (I1–I13).

**5. Second audit pass (round 2) — documentation coherence.** The round-29 `analyze.js` edits
inserted code near the top of the file, so the plan-time line references in `PLAN-round29.md` §1.8
MC4 / §1.9 FG2 no longer resolve against the shipped code. The living mirrors were reconciled to the
current lines and the plan-time → current mapping recorded in `round29-registry.json`
(`coherence_corrections`): `es = 4` operating point `:415` → `:454`; `useController` `:2009` →
`:2118`; controller factory `:761/:842` → `:846` (constructions `:927`/`:945`); legacy bare path
`:508` → `:506` (its hard-coded `3` at `:547`). The frozen plan keeps its plan-time refs as the
historical spec. The same applies to the pre-round-29 `analyze.js:NNN` pointers inside the round
logs (BUGS.md's earlier bug reports, RUN-ANALYSIS.md §1–§15, METHOD.md's round-28 correction
blocks, PLAN-round28.md): they describe the code as it was in their own round and are left as the
historical record rather than mechanically rewritten — only the **current-state** references (the
module inventory `src/README.md`, the round-29 research index/mirror, `round29-registry.json`,
`LOCKED.md`) are reconciled to the shipped lines. Two further coherence errors fixed: the module inventories (`src/README.md`,
`test/lock-registry.js`, `LOCKED.md`) advertised a `model: 'benchmark'` run mode that **does not
exist** — the
benchmark is a `kind: 'benchmark'` *variant* selected by `--variants=bench-*`, dispatched to its own
factory under either `--model`; and `src/README.md` attributed the `+45` funding-basket and `+8`
byte-round-trip checks to `fetcher.test.js` when they live in `candles.test.js` (the fetcher's own
contribution is `+10`). Code re-checked end to end (`benchmark.js`, `carry.js`, `funding_fetcher.js`,
the `walkforward`/`decision`/`features` additions, and the `analyze.js` wiring): **no defects found** —
the funding audit's default `now` was probed (the shipped clock is past the newest row, so `unclosed`
is 0), the index-aligned `pooledCarry` was verified sound (all eight candle axes are byte-identical),
and the reversal primitives correctly abstain (`NaN` → 0) rather than reading partial windows. The
full suite re-ran **2558 checks / 0 failures** after these doc edits.

**6. Third audit pass (round 3) — lock-registry completeness.** The `locks` suite validated only
that each *listed* export resolves; it could not see an export that was **not listed**, so a locked
module could grow an un-contracted entry point silently. Audited both directions directly (diffing
every module's real exports against `ANALYSIS_MODULES` / `SUPPORT_MODULES`) and found **eight
unregistered, real exports across five modules**, all now registered:

| module | exports that were unlisted |
| --- | --- |
| `performance.js` | `EULER_MASCHERONI` (the DSR expected-max constant) |
| `backtest.js` | `poolFolds`, `purgedCVBacktestAsync`, `annualizeSharpe` (a re-export) |
| `walkforward.js` | `walkForwardEvaluateAsync` |
| `sanitize.js` | `SIGNAL_NUMERIC_FIELDS`, `CONSENSUS_NUMERIC_FIELDS` |

Every one is exercised by `analysis.test.js` except the two field allow-lists and the constant
(which are read internally). The root cause was fixed, not just the instances: the locks test's
"every analysis export exists" check now verifies **both** directions (listed-but-missing *and*
exported-but-unlisted) in the same aggregate check, so the count stays **41** while the contract is
now closed. `analyze.js` is deliberately excluded from that completeness half — it is a *driver*
(CLI, run-directory I/O, the parallel dispatcher), so its list is a curated public-API subset; the
registry entry now says so explicitly so it is not re-flagged. Verified after the change: `locks`
**41/0**, every pure-analysis module's registry list is complete, and the full suite is unchanged at
**2558 / 0**.

**7. Fourth audit pass (rounds 4–5) — plan integration + test-quality + ledger.** This pass asked a
different question from rounds 1–3: *is every `PLAN-round29.md` acceptance item actually reachable in
the shipped code, and is the record internally consistent after the round's edits?* It found one
genuine integration gap (fixed), three stale lock-registry counts (fixed), and a ledger total that
had to move (propagated).

* **Plan-integration walk (`PLAN-round29.md` §5.2 gates, §7 file map, §10 DoD).** Every gate has its
  recorded outcome (G-A negative, G-B negative, G-C not crossed, G-D open, G-E closed with P7);
  DoD items 1, 2, 3, 5, 6, 7, 8, 9 are met, and item 4 is conditional (P5 deferred with a design —
  I12). Walking the §7 file map against the shipped code showed **one row genuinely undelivered**:
  `src/analyze.js` was listed for "the P2 cadence-grid restatement" and "the P2 exposure-matched
  dead zone", but `analyze.js` did not reference `restateReportAtCadence`, `exposureDeadZone`,
  `exposureMatchedPair` or `promotionAcrossCadences` at all — the P2 gate was a pair of tested
  *primitives* plus an offline retrospective, and `METHOD.md` §10's "shipped decision procedure"
  wording was therefore an over-claim. Fixed by wiring both as **opt-in, default-off** driver
  passes (decision **I14**): `--cadences=a,b,c` → `report.configurationRobust` (per-cadence
  restatement + majority-pass/catastrophic-veto verdict) and `--exposure-match` →
  `report.exposureMatched`. The `--carry-files`, `--variants=bench-*`, `/sig-reversal/` and
  panel-passthrough paths were checked and are correctly reachable (the worker request carries
  `panel: s.panel || null`, and `fold_worker.js` rebuilds its view with it). P5's §7 row stays the
  recorded deferral; the P7/`es` row stays closed by G-A.
* **Test-quality audit.** Diffed every round-29 export against its test references: all of
  `benchmark.js`, `carry.js`, `decision.js`'s P2 pair, `features.js`'s reversal family and
  `walkforward.js`'s exposure/cadence primitives appear in `analysis.test.js`/`analyze.test.js`;
  the three carry *constants* (`FUNDING_GRID_MS`, `FUNDING_PER_YEAR`, `carryPerPeriod`) have no
  direct by-name assertion but are exercised transitively (the grid constant is the audit default
  and every bar-grid test relies on it; `carryPerPeriod` is the return `carryReturns` is pinned on).
  The new wiring is pinned by 6 `analyze.test.js` checks — including the discriminating identity
  that the restatement on the *same* grid as the scored run reproduces the scored pooled Sharpe
  exactly, and that the flags change no scored number.
* **Stale counts found in `test/lock-registry.js` (round-1/2/3 miss).** The registry's per-module
  notes carried three counts that had drifted: `guards.test.js` 58 → **65**, `observer.test.js`
  75 → **76**, `analyze.test.js` 245 → **269**. (Round 1 repaired six counts in the *docs*; these
  three live in the registry notes and were not in that sweep.) Fixed and verified by re-running
  each entry.
* **Ledger propagation.** The `analyze` entry grew 258 → **269** (+11 checks: 8 P2-wiring + the P4+P2 sleeve-chaining check + the 2 fold-dispatch-contract checks), so the
  ledger total moved 2547 → **2558**. Propagated to every authority file: `docs/RUNBOOK.md` §6
  (table + total + the node-blocks contrast), `docs/BUGS.md` (the ledger header + the `analyze`
  breakdown), `README.md`/`src/README.md` tables, `docs/ROADMAP.md` (4 places),
  `docs/research/round29-README.md` and `round29-registry.json` (lockstep), and
  `test/node/analyze.test.js` (the exact-count mirror now asserts 269).
* **Full suite re-run after every edit batch.** All **30** pass/fail entries: **2558 checks / 0
  failures**, with `golden.test.js` **23/0** (no fingerprint moved — DoD 8, which also certifies
  that the new default-off blocks are byte-identical). Per-entry spot-checked against the ledger:
  `analysis` 621, `analyze` 269, `candles` 192, `fetcher` 111, `locks` 41, `walkforward` 63,
  `guards` 65, `observer` 76, `dimensions` 185 — all matching the updated table.

**8. Fifth audit pass (round 5) — final cleanup: a real defect fixed + the operator guide.** The
pass found **one real code defect**, caught by `npm test` on a native Node driver and invisible to
the browser harness (its concurrency tests inject their own inline fold fake):
`analysis/fold_worker.js` handed `makeSignalForVariant` the **pre-built model** instead of a
function of the variant, so the function invoked the model as a factory and every
`--concurrency > 1` fold died with `WORKER_ERROR: ... factory is not a function`; the same probe
found the dispatch request silently dropping `sampleWeightHorizon` (a `--sample-weight-horizon`
run would have desynced serial from parallel without throwing). Both are fixed (`BUGS.md` #68) and
pinned by two new `analyze.test.js` dispatch-contract checks (the request must carry every key the
worker reads). The pass also closed the **last untested combination** of the round-29 wiring with
the P4+P2 sleeve-chaining check (`analyze.test.js`: a cadence restatement must carry the
funding/carry extra panel stream onto the new grid — `panelStreams === 1` at every cadence).
Together these moved `analyze` 266 → **269** and the ledger 2555 → **2558** (propagated
everywhere); and it wrote the operator test guide [`round29-TESTING.md`](round29-TESTING.md) — the
exact command order (`npm install` → `npm test` → `preflight`/`dryrun` → the P2/P1/P3/P4 acceptance
runs → the optional full-size verdict) and the exact files to send back (`run.json` +
`report.json` + `run.log`, plus `folds.jsonl` to recompute offline).

**Final certification.** All **30** pass/fail entries re-run after the last edit: **2558 checks / 0
failures**, `golden` **23/0** (DoD 8). **Plan status: fully implemented except the
explicitly-conditional P5** — every `PLAN-round29.md` §5.2 gate has its recorded outcome (G-A
negative, G-B negative, G-C not crossed, G-D open, G-E closed with P7), every §7 file-map row is
delivered or superseded by a recorded decision (I1–I14), and DoD items 1, 2, 3, 5, 6, 7, 8, 9 are
met with item 4 conditional on P5. Nothing else is outstanding.
