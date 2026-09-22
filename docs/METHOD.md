# METHOD.md — evaluation-method decisions (round 26, R26-9)

This file records decisions about *how* the walk-forward evaluation is computed when
the choice changes the statistics the verdict rests on. It is a decision record, not
a feature: each entry states the question, the options, the re-derivation, the
evidence, and the decision. It is linked from `ROADMAP.md` round 26 (Part E) and
`src/README.md`.

## 1. Per-fold replay vs per-stream warm snapshot (R26-9)

**Question.** The walk-forward currently re-fits the model from scratch on each
fold's training prefix (a full replay, O(n²) per stream in bars). The cheap
alternative is to warm one controller per stream and *snapshot* its fitted state at
each fold boundary, so each fold starts from the previous fold's state instead of a
fresh fit (O(n)). Does the cheaper path preserve the properties the inference layer
assumes?

**Why this is a statistical decision, not an optimisation.** Round 25's dependence
layer treats the **fold window as the sample's natural independent unit**: the
promotion gate's magnitude test is a delete-one-cluster jackknife over fold-window
clusters, and its stability half requires the paired Sharpe difference to survive
deleting any single window. Both read the per-fold statistics as if the clusters
were approximately exchangeable draws of the same process. A warm snapshot breaks
that: consecutive folds share the same fitted state, so their outcomes carry a
common component that a fresh replay does not have. The reported SE, the sign test
and the stability verdict would all be computed on a sample that is *not* the one
the method assumes.

**Re-derivation under the correlated-fold null.** Model each fold window's
outcome as a binary win with probability ½ under the null, with a common latent
component. If the pairwise correlation between window outcomes is ρ, the win count
over C windows has variance

```
Var(wins) = C·¼·(1 + (C-1)·ρ)
```

i.e. the **equicorrelation design effect** `1 + (C-1)·ρ` (`dependence.js`,
`equicorrelationDesignEffect`). The i.i.d. analysis (the exact sign test, and the
delete-one-cluster SE) assumes ρ = 0. At C = 40:
- ρ = 0.25 → design effect 10.75; ρ = 0.5 → design effect 20.5.
- The nominal α = 0.05 sign test becomes anti-conservative by a factor that grows
  with the design effect; the delete-one-cluster SE understates the true SE by
  ≈ √design-effect.

**Evidence (fixture).** `analysis.test.js` §AL simulates the null exactly — a
deterministic LCG, C = 40 windows, 400 replications — and records the sign test's
rejection rate:

| regime | pairwise ρ | 5 % rejection rate |
| --- | ---: | ---: |
| fresh replay (independent folds) | 0 | ≈ 0.043 |
| warm snapshot, mild | 0.25 | ≈ 0.31 |
| warm snapshot, strong | 0.5 | ≈ 0.36 |

A calibrated 5 % test rejects at ~5 % only for the independent (fresh-replay)
windows. The same fixture checks that the null variance matches the design-effect
formula `1 + (C-1)·ρ` exactly.

**Decision.**
1. **The scored walk-forward keeps the per-fold full replay.** It is what makes the
   fold windows the independent unit the dependence layer claims, and the
   simulation shows the alternative is not merely noisier — it invalidates the
   gate's size.
2. A snapshot implementation is **not shipped**. If it is ever added as a cost
   lever, it must be a *separate, explicitly labelled* report; carry the measured
   inter-fold correlation; re-derive the SE with the fold-correlation design
   effect rather than the i.i.d. one; and never feed the promotion gate or the
   `decision` block. The gate's contract (`DEPENDENCE_GATE_READER`) is written
   against independent fold-window clusters, and a snapshot path would need its
   own reader justifying the changed unit.
3. The honest cost lever that *is* shipped is different: the audit can reuse the
   scored pass as its base pass (`--reuse-base`, verdict-identical), and the fold
   loop can run at bounded concurrency (`--concurrency=N`, byte-identical). Neither
   changes the sample the inference reads.

**Grounding.** López de Prado (2018) — purging/embargo and the independence
assumptions of walk-forward evaluation; Pardo (2008) — walk-forward efficiency
under refitting regimes; Cawley & Talbot (2010) — the selection bias of reusing one
fitted model across folds; arXiv 2412.10545 — retraining as the response to drift,
which is the argument *for* replaying rather than carrying a stale fitted state
forward. The design-effect form is Kish (1965), already used by the dependence
layer.

## 2. Whether to search the family by racing (R26-15) — gate currently CLOSED

**Question.** Once a fold is cheap (R26-12 `saveInterval`, R26-13 paired seeds) and
the comparison is paired, the expensive part of "find the best family" stops being a
fold and becomes the number of arms (variants × seeds × policy configurations).
Successive halving / Hyperband is the standard answer: score every arm at a small
budget, eliminate the arms statistically out of contention, and reallocate the freed
budget to the survivors.

**Decision (round 26).** The **engine is built and validated; the driver is not
shipped, because the gate is closed.**
- `src/analysis/race.js` (registered `LOCKED-invariant`) implements
  `halvingRounds`/`halvingSchedule`/`successiveHalving`/`formatRace`. It is
  evaluator-agnostic, deterministic, and reports both the evaluation count and the
  budget-weighted cost (`spentBudget` vs `gridBudget`).
- `analysis.test.js` §AM **validates it against the full-grid oracle**: on a fixture
  the race's winner equals the brute-force winner at the top budget, which is the
  precondition the plan attached to trusting it ("a racing budget may not change the
  *decided* set"). This is a test, not a promise.
- The `--race` **driver is deliberately absent from `analyze`**. The gate named in
  `ROADMAP.md` is *an economics win (R26-5) or a diversity win (R26-6) giving a
  reason to search a **larger** family*. `RUN-ANALYSIS.md` §7 measured neither: every
  signal is cost-dead (break-even 0.09–3.47 bps against a 5–10 bps taker cost), so a
  wider search would spend compute to rank candidates that all lose money. Racing is
  a tool for spending a budget on the candidates that matter, not a substitute for
  having candidates worth testing.

**Conditions to open the gate.** Wire `--race` only when either (a) a candidate
clears its break-even cost at a realistic taker fee (so ranking the family has an
economic point), or (b) a measured diversity win (R26-6 stream selection / interval)
gives the family a reason to grow; and only after (c) a full-grid validation on one
small real run confirms the race's decided set matches the grid at the top budget.
Until then the engine stays a tested primitive, and the full-grid search stays the
path.

**Grounding.** Jamieson & Talwalkar (2016, arXiv 1502.07943); Li et al. (2018, arXiv
1603.06560).
