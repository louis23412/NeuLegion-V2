# NeuLegion — archive index (superseded docs kept as evidence)

Nothing here is deleted: later docs cite these by path, so removal would break
the audit trail. Each entry names what supersedes it. For the live plan see
`PLAN-next.md` + `ROADMAP.md`; for rejected hypotheses see `DROPPED.md`.

| doc | status | superseded by |
| --- | --- | --- |
| `PLAN-round27.md` | IMPLEMENTED AND RUN (R27-1…R27-9, forensics §13) | `PLAN-round28.md` → `PLAN-round29.md` → `PLAN-round30.md` → `PLAN-round31.md` → `PLAN-next.md` |
| `PLAN-round28.md` | IMPLEMENTED AND RUN (readout §15) | `PLAN-round29.md` → `PLAN-round30.md` → `PLAN-round31.md` → `PLAN-next.md` |
| `PLAN-round29.md` | IMPLEMENTED AND MEASURED (P1–P4; P5 deferred) | `PLAN-round30.md` → `PLAN-round31.md` → `PLAN-next.md` |
| `round29-IMPLEMENTATION.md` | execution log, round 29→30 tracker done | `RUN-ANALYSIS.md` §16 (readouts) |
| `round29-TESTING.md` | operator test guide, consumed | `RUN-ANALYSIS.md` §16; current commands in `RUNBOOK.md` §6 |
| `PLAN-round30.md` | frozen plan, executed (M1–M3 + M7; rounds 31–110 followed) | `PLAN-round31.md` → `PLAN-next.md` |
| `MILESTONES.md` | progress ledger through round 30 + V2 audit | `ROADMAP.md` status snapshot + `PLAN-next.md` |
| `AUDIT-round31-v2.md` | red-team audit, amendments folded into plan/architecture | `PLAN-round31.md` + `ARCHITECTURE-v2.md` |
| `OPTIMIZATION.md` | optimization decision log (rounds 1–6 + splits) | live; history only — current perf work starts here |
| `METHOD.md` | evaluation-method decision record (round 26) | live reference; new method decisions append here |

Rule: superseded docs are read-only evidence. New work updates `ROADMAP.md`,
`PLAN-next.md`, `TODO.md`, `RUNBOOK.md` §6 — never these files.
