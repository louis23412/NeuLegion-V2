# NeuLegion — lineage register (family trees, versions, branches)

**Established: round 30 planning (`PLAN-round30.md`).** This is the durable answer to *"what
design is this, where did it come from, and is it alive?"*. Before this file, a candidate was
just an `id` in `analyze.js#VARIANTS`; there was no record of which family a design belonged to,
which milestone introduced it, what it measured, or whether it was still being searched. The
machine-readable mirror is [`lineage.json`](lineage.json) (kept in lockstep with the tables
below; a future `lineage.test.js` asserts it covers every resolvable variant).

## 1. Naming scheme

```
NL-<LINEAGE>-<branch>@<version>
```

- **`NL`** — NeuLegion (the project prefix, so ids are unambiguous outside this repo).
- **`<LINEAGE>`** — one of the ten families in §2 (a family = a shared substrate + one kind of
  question). Uppercase.
- **`<branch>`** — the specific design/hypothesis inside the family, lowercase-hyphen
  (`momentum`, `reversal-xs`, `pca-hash`, `linear`). This is the *branch* of the family tree.
- **`@<version>`** — one of:
  - `@rNN` — the **milestone version**: the round whose tree introduced (or last changed the
    behaviour of) this branch. `sig-momentum@r23` = the branch as shipped in round 23.
  - `@rNN.n` — a **behavioural revision inside a round** (a parameter/threshold change that
    could move a scored number), e.g. `@r28.1`. A version bump REQUIRES either a golden
    re-pin or a recorded "no golden moved" note. A pure doc/comment change does not bump.
- **State** — `LIVE` (in the default roster, scored every run) · `KEEP` (kept, may be live) ·
  `PARK` (resolvable by id, deliberately out of the default roster — an open question, not a
  dead one) · `DROPPED` (removed from the roster *and* from future searches; reason recorded in
  [`DROPPED.md`](DROPPED.md)) · `FROZEN` (locked, golden-pinned, no behaviour change allowed
  without a re-pin) · `UNTESTED` (designed, never scored).

> **Rule:** a new candidate is not "added" until it has a lineage id here and (if it can touch a
> scored number) a version + a state. A candidate with no lineage entry is a bug in the docs.

## 2. The lineages

| lineage | substrate (what it *is*) | the question it answers | code |
| --- | --- | --- | --- |
| **NL-CTRL** | the HiveMind controller — the scored model | is the *model* skilful? | `src/hivemind/**`, `src/analyze.js` |
| **NL-MECH** | a mechanism flag on the controller/memory | does *this mechanism* move the score? | `src/hivemind/memory/**`, `src/hivemind/ensemble/**`, `src/hivemind/training/**` |
| **NL-SIG** | a causal pure signal on the OHLCV view | is there a **cross-sectional/price edge**? | `src/analysis/features.js` |
| **NL-REV** | a short-horizon (15m) reversal signal | is there a **fast mean-reversion edge**, net of cost? | `src/analysis/features.js` |
| **NL-BENCH** | a non-neural forecaster on the same causal vector | is the *architecture* or the *features* the constraint? | `src/analysis/benchmark.js` |
| **NL-LABEL** | a trade-label policy | does the *training target* matter? | `src/hivemind/controller/trades.js` |
| **NL-EVAL** | the walk-forward + significance + gate stack | is a verdict **honest**? | `src/analysis/{walkforward,decision,dependence,performance,reality_check,overfitting,forecast,backtest}.js` |
| **NL-DATA** | a data sleeve (bars / funding) | what **new information** is there? | `src/data/**`, `src/candle_fetcher.js`, `src/funding_fetcher.js`, `src/candles_audit.js` |
| **NL-HARNESS** | the test harness, goldens, lock registry | is the code **pinned**? | `test/**`, `docs/LOCKED.md` |
| **NL-LEGION** | the outer evolutionary population | can **evolution** breed a better controller? | `src/legion/**` |

## 3. NL-SIG — the causal signal family

Evidence column cites the acceptance batch (`RUN-ANALYSIS.md` §17; 8×600) and, where it
differs, the 8×200 sanity run. "adjDSR" is the dependence-adjusted DSR at the run's own `K`.

| branch | lineage id | state | net Sharpe @600 | break-even | adjDSR | decision |
| --- | --- | --- | ---: | ---: | ---: | --- |
| `sig-momentum` | `NL-SIG-momentum@r23` | **KEEP (best)** | **+1.0848** | **14.64 bps** | 0.7736 | the round's best arm; fails only the dependence-adjusted DSR. Re-run at a pruned `K` + more effective bars. |
| `sig-accel` | `NL-SIG-accel@r27` | **KEEP (second)** | **+1.0194** | **11.57 bps** | 0.8608 | highest adjDSR of any arm; same single binding hurdle. |
| `sig-range` | `NL-SIG-range@r23` | **PARK (research)** | +0.4490 | 5.57 bps | 0.2611 | positive, and `RUN-ANALYSIS.md` §16.1 shows it keeps a *real cross-sectional* component (common-share 0.61) — the only positive arm that is not ~100 % market. Keep resolvable, out of the default roster. |
| `sig-agreement` | `NL-SIG-agreement@r23` | **PARK (research)** | +0.3912 | 3.71 bps | 0.2113 | same story as `sig-range` (common-share 0.66); correlated with it (r 0.81), so at most one belongs in a roster. |
| `sig-volume` | `NL-SIG-volume@r23` | **DROPPED** | −0.0008 | −0.01 bps | 0.0478 | exactly flat: no edge, no cost to reject. |
| `sig-autocorr` | `NL-SIG-autocorr@r23` | **DROPPED** | −0.0996 | −1.23 bps | 0.0306 | **regime-dependent** (+1.79 @200 bars vs −0.10 @600): not a stable edge. |
| `sig-vol-regime` | `NL-SIG-vol-regime@r23` | **DROPPED** | −0.3135 | −4.34 bps | 0.0071 | negative; fails `dsrDelta` (worse than baseline). |
| `sig-frac-momentum` | `NL-SIG-frac-momentum@r23` | **DROPPED (worst)** | −0.4185 | −1.67 bps | 0.0119 | worst in every dimension tested; turnover 2092/bar makes it cost-fragile even if the sign flipped. |
| `sig-vol-momentum` | `NL-SIG-vol-momentum@r30` | **UNTESTED (opt-in)** | — | — | — | pre-registered round-30 upgrade (gate **G-H**): trailing return / realised vol (the TSMOM sizing standard, `1904.04912`). |
| `sig-blend-momentum` | `NL-SIG-blend-momentum@r30` | **UNTESTED (opt-in)** | — | — | — | pre-registered: mean risk-adjusted momentum over the 8/16/32-bar horizons (`2112.08534`). |
| `sig-network-momentum` | `NL-SIG-network-momentum@r30` | **UNTESTED (opt-in)** | — | — | — | pre-registered: the other streams' lagged momentum — a lead-lag panel signal (`2308.11294`); **requires the panel** (`BUGS.md` #70). |
| `sig-regime-momentum` | `NL-SIG-regime-momentum@r30` | **UNTESTED (opt-in)** | — | — | — | pre-registered: momentum gated on a causal crash regime (`2105.13727`, `2604.09060`). |

**Branch relationship (the tree).** `momentum` is the trunk; `accel` is its second difference
(derivative branch, best adjDSR); `frac-momentum` is a saturating re-parameterisation of the same
input (dropped); `vol-regime` is a regime-conditioned variant (dropped); `agreement`/`range` are
same-input different-normalisation branches (parked, correlated with each other); `volume` and
`autocorr` are different inputs (dropped). The single robust branch pair is
`{momentum, accel}` — both share the *momentum* input and both are the only arms that survive
exposure matching.

## 4. NL-REV — short-horizon reversal family (PARK, awaiting a cost model)

| branch | lineage id | state | evidence |
| --- | --- | --- | --- |
| `sig-reversal` | `NL-REV-reversal@r29` | PARK (opt-in) | 15m: dir. acc. 0.5191 on 639 992 bars, break-even **0.337 bps** vs 5–10 bps taker (`RUN-ANALYSIS.md` §16.4) |
| `sig-reversal-4` | `NL-REV-reversal-4@r29` | PARK (opt-in) | best break-even of the family (**0.562 bps**), still 9× short |
| `sig-reversal-vol` | `NL-REV-reversal-vol@r29` | PARK (opt-in) | 0.323 bps; vol-scaling adds ~nothing (the paper's "signs not magnitudes") |
| `sig-reversal-xs` | `NL-REV-reversal-xs@r29` | PARK (opt-in) | cross-sectional; **requires the panel** — degenerate on a single-stream run (`BUGS.md` #70) |

State is PARK, not DROPPED, because the rejection is a **taker-cost** rejection: a maker-fee /
queue-position model could revisit it (`TODO.md` 94).

## 5. NL-MECH — controller/memory mechanisms

| branch | lineage id | state | evidence |
| --- | --- | --- | --- |
| `surprise` | `NL-MECH-surprise@r2` | **DROPPED** | ≈baseline: +0.098 @200 / −0.028 @600; never significant |
| `homeostasis` | `NL-MECH-homeostasis@r2` | **DROPPED** | negative: −0.225 @200 / −0.163 @600 |
| `pca-hash` | `NL-MECH-pca-hash@r13` | **DROPPED** | inert at 200 bars (72/72 folds identical); 6/288 at 600 but economically nil (paired ΔSharpe 0.0043, p 0.19, foldWin 0.01) |
| `multiprobe` | `NL-MECH-multiprobe@r16` | **PARK** | `appliesTo:'broadcast'` — cannot reach the scored path (R27-2); retained as a documented memory-subsystem feature, never scored here |
| `querymod` | `NL-MECH-querymod@r17` | **PARK** | same: broadcast path only |
| `sample-weights` | `NL-MECH-sample-weights@r28` | **PARK** | opt-in, confounded (`BUGS.md` #54); needs its own clean re-run |
| `sample-weights-scale-control` | `NL-MECH-sample-weights-scale-control@r28` | **PARK** | the LR-only control arm for the above |
| *(memory subsystem itself)* | `NL-MECH-memory@r29` | FROZEN | `lsh`/`replay`/`consolidation`/`banks`/`protos` are **core**, golden-pinned, heavily tested — the *hypotheses* above are dropped, **not** the code |

> **Purge rule (important):** a DROPPED *mechanism hypothesis* removes the candidate from the
> A/B roster and the future search — it does **not** delete the underlying memory/subsystem code,
> which is part of the hivemind and is covered by `lsh.test.js`/`core.test.js`/`golden.test.js`.
> See `DROPPED.md` §"what is NOT being deleted".

## 6. NL-BENCH — model-class benchmarks (PARK, reference only)

| branch | lineage id | state | evidence |
| --- | --- | --- | --- |
| `bench-base-rate` | `NL-BENCH-base-rate@r29` | **PARK (reference)** | the bar every forecaster must beat; un-auditable as a strategy (`vacuous`, expected) |
| `bench-linear` | `NL-BENCH-linear@r29` | **PARK (reference)** | MCS₉₀ winner, but `brierSkill −0.0008` ≈ **no skill** vs `p̄(1−p̄)`; break-even 1.54 bps |
| `bench-mlp` | `NL-BENCH-mlp@r29` | **DROPPED** | decisively the worst forecaster (Brier 0.27431, `brierSkill −0.0972`) |

## 7. NL-EVAL, NL-DATA, NL-HARNESS, NL-LEGION

| branch | lineage id | state | note |
| --- | --- | --- | --- |
| walk-forward + gate | `NL-EVAL-gate@r26` | **FROZEN** | the dependence gate; `--cadences`/`--exposure-match` wired as pure post-processing (proved by 3d ≡ 3e, §17.1) |
| significance stack | `NL-EVAL-significance@r25` | FROZEN | PSR/DSR/MinTRL + SPA/Romano-Wolf (`reality_check.js`) |
| 1h basket (8×) | `NL-DATA-1h-8@r22` | LIVE | 8 symbols, 1h |
| 15m basket (8×) | `NL-DATA-15m-8@r29` | LIVE | P3; `CANDLE_MANIFEST_15M` |
| funding (8×8h) | `NL-DATA-funding-8@r29` | LIVE | P4 carry sleeve; the one measured **independence** lever |
| harness + golden | `NL-HARNESS-golden@r29` | FROZEN | 2558 checks / 30 entries (31 with bench); `golden` 23/0 |
| outer legion | `NL-LEGION-evolve@r22` | **UNTESTED** | built, never run against a scored verdict |

## 8. Version discipline (the rules)

1. **Bump `@rNN`** when a new round changes a branch's *behaviour* (parameters, formula, gate).
2. **Bump `@rNN.n`** for an in-round behavioural revision; record "no golden moved" or re-pin.
3. **A DROPPED branch is never re-added under the same id.** A re-opened question gets a new
   branch name (e.g. a maker-cost reversal would be `NL-REV-reversal-maker@rNN`, not
   `reversal@r30`), so the record of *why the first one died* is never lost.
4. **A promotion must name its lineage id** in the report (`verdict`/`nextRun`), so a verdict is
   citable as "`NL-SIG-momentum@r23` cleared the gate at `K=3`" and not just "sig-momentum".
5. **The default roster is a pre-registered list of lineage ids.** Reducing it (`K` pruning) is
   the single cheapest DSR lever — but it is only honest *ex ante*: you may pre-register a smaller
   roster for a *future* run, you may **not** re-report an old run at a smaller `K`.
   (See `PLAN-round30.md` §3.1 — the K-sensitivity table makes the temptation explicit.)
