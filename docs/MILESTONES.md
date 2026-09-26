# NeuLegion — milestones

The project's check-marked progress. A milestone is closed only when its **acceptance test ran and
its numbers are recorded** (a negative result closes a milestone too — the project's rule is that a
documented, powered keep-off *is* a result). Every milestone names its readout and its evidence.

Legend: ✅ closed · 🔬 in progress · ⏳ planned · ⛔ deferred (with gate open)

| # | milestone | round | status | the acceptance test that closed it | readout |
| --- | --- | --- | --- | --- | --- |
| M0–M5 | run integrity, determinism, observability, the A/B driver, the honest gate, the signal family | 21–27 | ✅ | full suite green; the A/B runs and nothing promotes | `RUN-ANALYSIS.md` §6–§13, `BUGS.md` #26–#59 |
| **M6** | **the round-28 reading layer** — honest sizing, the weighting confound, the label decision | 28 | ✅ | three operator runs; the sizing arithmetic is explicit | `RUN-ANALYSIS.md` §15 |
| **M7** | **round 29: stop tuning the game, find the edge** — P1 model-class benchmark, P2 configuration-robust + exposure-matched gate, P3 15m reversal, P4 funding/carry sleeve; P5 deferred | 29 | ✅ | P1 negative branch (G-A), P2 verdict-neutral + kills the manufactured promotion, P3 measured non-acceptance, P4 independence purchase | `RUN-ANALYSIS.md` §16, `round29-IMPLEMENTATION.md` |
| **M7.1** | **the acceptance batch** — five operator runs independently reproduce the round-29 readouts | 29→30 | ✅ *(with two unmeasured gates)* | P1 arms to 5 dp; P2 cadence grid to 4 dp; `--cadences` proven pure post-processing (3d ≡ 3e); parallel determinism re-established; full suite **2558/0** | `RUN-ANALYSIS.md` §17 |
| **M7.2** | **the lineage + purge planning phase** — family trees, the dropped register, the corrected re-runs, the round-30 map | 30 (planning) | ✅ **closed** | the planning deliverables below + the end-to-end suite re-run | `PLAN-round30.md`, `LINEAGE.md`, `DROPPED.md`, `research/round30-winning-mechanisms.md` |
| **M8** | round 30 execution (prune, fix #69/#70, re-run P3/P4, multi-seed, breadth, a signal upgrade, the pruned verdict run) | 30 | 🔄 *(M1–M3, M7 done)* | M1–M9 of `PLAN-round30.md` §7 | **M1–M3 + M7 closed:** roster pruned + register contract (`src/lineage.js`, `analyze.test.js` §A2b), `#69`/`#70` fixed, the four pre-registered momentum upgrades implemented (`features.js#SIGUP_CANDIDATES`, `analysis.test.js` §G-H, registered `UNTESTED`), full suite **2585/0**, `golden` 23/0, `locks` 41/0; M4–M6/M8 await operator data (`RUN-ANALYSIS.md` §18, to be written) |
| **M9** | P5 continuous TTA (gate **G-D** open) | ? | ⛔ | designed + costed, not built (`TODO.md` 96) | `RUN-ANALYSIS.md` §16.6 |

---

## M7.2 — the planning milestone (closed 2026-09-25)

**What it certifies.** Before round 30 spends any compute, the project now has: a **pruned,
pre-registered roster** (the dead branches documented to their measurement), a **family-tree
register** with versions and states, a **corrected re-run plan** for the two off-spec acceptance
gates, and a **bounded code/test/experiment map** — all built on the acceptance batch's numbers.

**Deliverables (this milestone):**

| artefact | what it is |
| --- | --- |
| [`PLAN-round30.md`](PLAN-round30.md) | the round-30 plan: purge, the K/independence arithmetic, code/test/experiment map, gates, DoD, anti-re-tread |
| [`LINEAGE.md`](LINEAGE.md) + [`lineage.json`](lineage.json) | the family trees: ten lineages, the `NL-<LINEAGE>-<branch>@<version>` scheme, the state taxonomy, version discipline |
| [`DROPPED.md`](DROPPED.md) | the dropped register — every rejected hypothesis + the measurement, and the explicit "what is NOT being deleted" note |
| [`research/round30-winning-mechanisms.md`](research/round30-winning-mechanisms.md) + `research/raw/arxiv-sweep-2026-09q.json` | the research pull on what proved working (momentum/trend, carry, decorrelation, costs, evaluation robustness) |
| `RUN-ANALYSIS.md` §17 | the acceptance-batch readout the plan is built from |

**Checks run (this milestone, end-to-end):**

| check | result |
| --- | --- |
| full browser suite via the repo's own harness | **2558 checks / 30 assert entries (+ `bench` timings) = 31 entries / 0 failures** |
| `golden.test.js` | 23 / 0 — no engine fingerprint moved |
| `locks.test.js` | 41 / 0 — every locked export present, both directions closed |
| report self-consistency over the five runs (70 checks) | all pass (ladder↔pooled, ladder excludes inactive, `trials`↔active+baseline, `familywise.K`↔`trials`, promote⇔no gated failure on every active arm, tightest-hurdle is a failed gated one, `effectiveBars`/`dsrAdjusted` integrity, break-even sign) |
| dead-module scan | no orphan `src/**` modules |

Raw logs: `scratch/checks/SUITE.json`, `scratch/checks/report-coherence.json` (ephemeral; the
certified counts are mirrored in `RUNBOOK.md` §6). **Not runnable here:** the 13 node-only suites
(real `worker_threads`/SQLite/HTTP) — run `npm test` on a native driver (`round29-TESTING.md` §1).

**What it does NOT certify.** P3 and P4 remain **unmeasured** (their acceptance commands expanded
empty shell variables; `PLAN-round30.md` §6.3 / `round29-TESTING.md` §5). The plan deliberately
leaves those gates open rather than claiming a result it does not have.

**Status: closed 2026-09-25.** All M7.2 deliverables are written (`PLAN-round30.md`, `LINEAGE.md` +
`lineage.json`, `DROPPED.md`, `research/round30-winning-mechanisms.md`, the raw sweep
`arxiv-sweep-2026-09q.json`), the end-to-end suite and the five-run report self-consistency checks
are green, and the register cross-checks: every paper cited in the research note is backed by a
durable raw sweep file, `lineage.json` parses and covers every resolvable variant, and every
internal doc link resolves. Nothing in the scored path changed — the round-30 **implementation**
is M8 (`PLAN-round30.md` §7, M1–M9).

---

## How a milestone is added

1. The round's plan (`PLAN-roundNN.md`) pre-registers its gates and its roster.
2. The readout lands in `RUN-ANALYSIS.md` §NN with the raw tables.
3. The execution log (ledger, decisions, per-item outcome) lands in `roundNN-IMPLEMENTATION.md`.
4. A row is added (or updated) in the table above with the acceptance test and the readout link.
5. `LINEAGE.md`/`lineage.json` and `DROPPED.md` are updated for every branch the round added,
   kept, parked or dropped. A round that changes the roster without updating the register is
   incomplete.
