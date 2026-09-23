# NeuLegion — Optimization log

The CPU-bound core is `src/hivemind/hiveMind.js` (Rounds 1–4). The controller
layer in `src/hivemind/hiveMindController.js` was also audited for non-arithmetic
waste (Round 5). Both are almost entirely hand-rolled, so optimization here means
removing redundant work and allocation while **preserving the exact
floating-point results**, so that training trajectories and the "hivemind"
behaviour do not change. This document records what was changed, how it was
verified, and what remains.

> **Structure note (Round 6).** Both classes have since been split into thin
> shells plus component modules (see `COMPONENTS.md` / `../src/README.md`). The
> methods named below as `#private` now live as `_`-prefixed methods in those
> modules, with byte-identical bodies. The A/B method below still describes how
> any arithmetic change is validated; the golden suite is now the automated
> version of it.

Profile setup: `HiveMind(dir, es=64, is=125, id, forceMin=true)` (which yields
`H=8, FF=32, L=2, NH=2, headSize=4, lowDim=4, numProjections=6, lshSets=2,
lshTables=2, lshHashBits=6`), trained for 25 steps after a 3-step warmup.
Numbers below are per training step and are noisy on a shared machine; treat
call *counts* as the reliable signal and timings as indicative.

---

## Round 22 — the only golden re-freeze (P2-3, not a performance change)

No optimization was applied in round 22 (the work was run integrity,
observability and the A/B driver — see `ROADMAP.md` and `BUGS.md` #19). One
golden fingerprint WAS deliberately re-frozen: `hm:postReloadPrediction`
`f9cef898 -> 5f703135`. It was the last fingerprint hashing an unrounded float64
observable (the reloaded prediction), so it now hashes the value rounded to 6
significant digits — exactly like `hm:predictions` (Round 17/`BUGS.md` #16). The
other ten fingerprints are byte-identical, and `golden.test.js` is 23/23. This is
recorded here because any promote/re-freeze must be intentional and documented.

## Round 23 — the evaluation is now *shipped-model* fidelity (no hot-path change; N3 verdict delivered by attempt 3, then corrected by the round-26 re-run — nothing promotes)

No optimization was applied in round 23 — it is a *measurement* round
(`ROADMAP.md` N0-N3). It is recorded here because the project's rule is that any
promote/re-freeze must be intentional and documented, and because the round-23
verdict itself belongs in this file.

What changed (all off the training hot path: `src/analyze.js`,
`src/analysis/{walkforward,world,features}.js` and the test suites):

1. **The A/B now evaluates the shipped model.** `makeControllerModelFactory`
   builds a real `HiveMindController` per fold over real OHLCV, streams
   `1..testStart-1`, then reads `getSignal(candles[0..t])` **prequentially** and
   maps `prob -> position` with the documented policy
   `CONTROLLER_POSITION_POLICY = { deadZone: 0.05, scale: 1 }` (the controller's
   confidence is a small deviation around 50, so the dead zone is what stops a
   coin-flip from being traded). The `-1` untrained sentinel and a throwing
   controller both **abstain** rather than propagate.
2. **The look-ahead audit is no longer vacuous for a candle-driven model.**
   `auditNoLookahead` takes a `viewFor(returns, perturb)` hook, and
   `analysis/world.js` builds the view a candle model actually consumes: the real
   candles on the base pass; on a probe pass every bar after `t` is scaled by a
   bounded, deterministic, NON-uniform factor (`1 + probe*(1 + sin(freq*t))`,
   `DEFAULT_SHOCK.probe = 0.05`) and `returns` is re-derived from the shocked
   closes. A `viewFor` whose views do not differ is reported
   `vacuous: true, clean: false` (`BUGS.md` #22). The default returns-only path is
   byte-identical, so all 11 goldens are unchanged (`golden.test.js` 23/23).
3. **A real causal candidate family (K = 15).** `analysis/features.js` adds 8
   point-in-time features, each reduced to a position by one causal
   z-score → clamp pipeline; they sit on the SAME family-wise gate (subsampling
   SPA / Romano-Wolf) as the 7 mechanism flags, so the multiple-testing
   correction now covers a genuinely searched universe.
4. **Power + the unused dataset.** Every report carries the Lo (2002) Sharpe SE
   and the 95% MDE; `poolReports` merges one walk-forward per symbol into a single
   pooled report using the same `poolFolds` arithmetic as a single stream;
   `readCandles` + `--symbols=a,b|all` make all 8 audited symbols usable.
   Measured cost (sql.js shim): ~43 ms per `getSignal`, 16 folds / 2376 calls on
   the default 300-bar BTCUSDT window ⇒ minutes; the 8-symbol pooled run is ~8x.

**Golden fingerprints: unchanged (11/11, literal).** Nothing here is imported by
the hot path; `analyze.js` is CLI-only and `analysis/*` is additive tooling.

**Attempt 1 — `20260920T012907-seed1` (2026-09-20, seed 1): INTERRUPTED, no
verdict.** The run was configured exactly as intended (`model: controller`, 8
streams, 4,800 candles, 288 folds, train 60 / test 15 / bars 600, probe 0.05,
audit-probes 2, deadZone 0.05, all 15 variants) and the driver's manifest proves
it ran the intended world — but it died inside the **second** candidate: the
state dir holds 1,862 of the ~17,280 fits (all of `baseline`, 61.6 % of
`surprise`), the final fit left an uncheckpointed `-wal`, and **`report.json` /
`run.log` were never written, so no pooled metric, decision or family-wise
p-value exists**. Full forensics, what the artifact *does* prove (a real-data
determinism certificate, the audit's structural-only teeth, surprise liveness on
real candles) and the resulting plan for the re-run are in
[`RUN-ANALYSIS.md`](RUN-ANALYSIS.md) §1-§2. Nothing was promoted or rejected, so
**no golden fingerprint was re-frozen** and this file records no decision yet.

**Attempt 2 — `20260920T094400-seed1` (2026-09-20, seed 1), the default smoke run
(post-round-24b): COMPLETE, nothing promoted, the verdict is an honest underpowered
null.** The run finished in 2,342,845 ms (960 passes, 15/15 variants, 39.0 min) and
`report.json` carries the first real verdict: **all 14 candidates `keep-off`**,
family-wise **SPA p = 1.0000** (best = `sig:momentum`, Rejects = [none], K = 15,
T = 224), baseline pooled Sharpe **-0.3105** / PSR 0.3803 / DSR 0.0183. A sibling
pre-round-24b run gave identical scored metrics and exposed the five defects fixed
in round 24b (its `sig:volume` audit reachability was 0/16; the post-fix run is
16/16). The best candidate DSR is 0.4233 (`sig:acceleration`), far below the 0.95
floor. It is **underpowered**: `report.power.underpowered === true`, MDE95 ±2.009
over 240 bars with 969 bars needed for Sharpe ±1.0, and every apparent signal edge
(break-even 10-15 bps) sits inside a realistic taker cost. Full forensics (manifest, completion, the offline
verification of the journal, the break-even table and the power-run plan) are in
[`RUN-ANALYSIS.md`](RUN-ANALYSIS.md) §3. Nothing was promoted, so **no golden
fingerprint was re-frozen**. Round 24b fixed the five defects this run exposed
(`BUGS.md` #25) and added `--reuse-base`.

**Attempt 3 — `20260920T144633-seed1` (2026-09-20, seed 1), the POWER run
(post-round-24b): COMPLETE in 43,129,704 ms (11.98 h), 12,960 passes, 15/15
variants, 288 folds / 4,320 pooled bars. NOTHING PROMOTES — the N3 verdict.**

> **⚠️ SUPERSEDED (round 26, `BUGS.md` #33).** This run predates the A/B's
> window-fidelity fix, so `makeControllerModelFactory` fed the controller the whole
> growing candle prefix instead of production's fixed `cacheSize` window. **Every
> `baseline` and *mechanism* row in the table below — including `query-mod`'s
> DSR-0.9992 / 33.73 bps — is therefore not the shipped model's**, and the table's
> `fold-win`/`pos-fold` hurdles are computed against a baseline that never existed.
> The **8 signal rows are unaffected** (a signal is pure array math and never
> constructs a controller). The current verdict is the **same-design corrected
> re-run `20260922T204248-seed1`** — all 14 keep-off, SPA p = 0.4731, baseline
> Sharpe **-0.1147** (`brierSkill -0.0751`), `query-mod`/`multi-probe`/
> `sample-weights` byte-identical to the baseline, `sig:momentum` 1.0848 /
> `sig:acceleration` 1.0194 failing only the dependence-adjusted DSR floor, cost
> ladder promotes `[none]` at 0/2/5/10 bps — in
> [`RUN-ANALYSIS.md`](RUN-ANALYSIS.md) **§10**. Read the table below as the pre-fix
> artifact it is.

| candidate | kind | pooled Sharpe | DSR | fold-win | pos-fold | break-even | reachable | reasons |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | mechanism | 0.4387 | 0.5179 | — | 0.4444 | 12.42 bps | 243/288 | — |
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
| **sig:acceleration** | signal | **1.0502** | **0.9968** | 0.4896 | 0.6285 | **11.95** | 288/288 | 1 |

Family-wise: **SPA p = 0.5699**, best = `sig:momentum`, **Rejects = [none]**, K = 15,
T = 4,032. Power: SE 0.2416, MDE95 ±0.4735, `underpowered false`,
`barsToDetect1` 969. Audit: all 15 clean, `reachable true` for every variant, all
8 signal candidates reachable 288/288 (the volume-shock fix holds at scale).
Offline verification of the journal is exact on all seven checks —
`RUN-ANALYSIS.md` §5.3. **No golden fingerprint was re-frozen** (nothing promotes;
the whole run is off the hot path).

**The verdict with its caveats attached (they are why round 25 exists):**

1. **Three candidates have real aggregate edges that fail only the fold-consistency
   hurdle** — `query-mod` (DSR 0.9992, MDD 0.0081, break-even 33.7 bps; fails
   fold-win 0.4653 and positive-fold 0.4028 < 0.4444), `sig:momentum` (Sharpe
   1.1059, DSR 0.9988, break-even 15.0; fails fold-win 0.4514) and
   `sig:acceleration` (Sharpe 1.0502, DSR 0.9968, break-even 11.95; fails fold-win
   0.4896). Every other candidate also fails the absolute DSR ≥ 0.95 floor.
2. **The stated power is optimistic (BUGS.md #26).** The 8 streams are not
   independent (mean pairwise per-fold-Sharpe correlation 0.41-0.52), so the
   pooled SE is understated by ≈ 2.1× and the honest MDE95 is **≈ ±0.98**, i.e. at
   the underpowered threshold. This null is not yet the decisive experiment.
3. **The verdict is not cost-robust (BUGS.md #27).** Recomputing the decision from
   the journal at 2 bps turns `sig:acceleration` into a PROMOTE with zero reasons.
   `costBps: 0` is not a neutral comparison, because the fold-consistency hurdles
   are computed relative to the baseline and cost degrades the low-turnover
   baseline relatively faster.
4. **The edge is event-driven and shared across candidates** (fold 10 of streams
   4-7 dominates every signal candidate; momentum~accel excess correlation 0.863),
   which is exactly the profile the per-fold hurdles exist to reject.

The decision record is therefore: **no promote, no re-freeze, and the promotion
gate itself is now on the work list** (round 25 — see `TODO.md` items 31-37 and
`ROADMAP.md` round 25).

**Round-26 update — the corrected re-run, and the current decision.**
`20260922T204248-seed1` (the same 288-fold / 4,320-bar design, run *with* the
round-26 corrections) completed in 28,418,998 ms (7.90 h) and is the current
decision record: **all 14 candidates `keep-off`**, **SPA p = 0.4731**, the whole
verdict promoted `[none]` at **every** cost level (0/2/5/10 bps — the §3 caveat
above is fixed), baseline **Sharpe -0.1147 / PSR 0.3175 / DSR 0.0124 / break-even
-2.58 bps** — a *trained* model (`trainingSteps 170,004`/variant, `warmErrors 0`)
with **negative skill** (`brierSkill -0.0751`, `accuracySkill -0.1379`), which is the
honest "no edge" reading §7.5 could not establish. `query-mod`, `multi-probe` and
`sample-weights` are **byte-identical to the baseline on 288/288 folds**
(`BUGS.md` #43/#44 — three untested candidates; their keep-off reasons are artefacts
and `K = 15` counts them). The two real near-misses are `sig:momentum` (1.0848,
break-even 14.64 bps; binding: fold-win 0.4931 + adjusted DSR 0.7375) and
`sig:acceleration` (1.0194, 11.57 bps; binding: adjusted DSR 0.8343, with the paired
cluster test significant at p = 0.0493, perfect stability and fold-win 0.5347). **No
golden fingerprint was re-frozen; the run is entirely off the hot path.** Full
forensics, including an exact offline reproduction of every per-fold and pooled
metric from `folds.jsonl`: [`RUN-ANALYSIS.md`](RUN-ANALYSIS.md) **§10**.

## Verification method (bit-exact A/B)

Any change that touches arithmetic is checked by training two copies of the
class side by side under identically seeded PRNGs and comparing *fingerprints*,
not raw buffers:

1. Snapshot the pre-change `hiveMind.js` and make the change in a second copy.
   Each copy's `./utils.js` import must be rewritten to a specifier the bundler
   can resolve (either the workspace-relative path, or vendor the two
   predicates), otherwise the harness treats it as external.
2. Train both copies for N steps with `Math.random = mulberry32(seed)`
   **re-seeded before every constructor, train and predict** (predict is
   stochastic), and after each step compare the public `diagnostics()`
   fingerprint:
   `[weights.count, nonFinite, min, max, sum, sumSq, gradients.sum,
   totals.semantic, totals.attention, totals.adaptive, totals.coreEpisodic,
   deadInBuckets, missingFromBuckets]`.
3. Predict M times from fresh inputs the same way and compare with exact
   `Object.is` equality (no tolerance), plus the `lshConsistent` /
   `problems` fields.

A change is accepted only when every per-step fingerprint is identical,
`maxPredDiff` is `0`, the semantic/memory counts match, and the LSH stats stay
clean. The regression suites (`sanity.test.js` 60 checks, `core.test.js` 46,
`indicators.test.js` 75) are then re-run.

> Note: the earliest harness instrumented the class with `__weightHash` /
> `__gradHash` / `__lshStats` probes. Those hooks were later removed from the
> source, so that old comparator no longer builds. The current comparator uses
> only the public `diagnostics()` surface — which is strictly better, since it
> exercises the same code a real caller sees.

---

## Applied changes

### Round 1 (earlier)
1. **`#accumulateGradients` guard replacement.** The hot method ran ~26
   `isValidNumber`/`isFiniteNumber` validity guards per call. All but two are
   on arithmetic-derived values, where `Number.isFinite` is exactly equivalent
   (the full predicates differ only by additionally accepting numeric strings).
   Replaced 24 + 2 sites with `Number.isFinite`; the two that can receive raw
   inputs were left alone. Own-time improved a few percent.
2. **`#feedForwardBatch` / `#softmax` guards.** Same reasoning at the silu and
   softmax validity/max scans (all callers pass arithmetic-derived number
   arrays).
3. **`#specWExpandScratch` flattened.** `Array(H)` of `Float64Array(FF)` became
   a single `Float64Array(H*FF)` (row `a` at offset `a*FF`), removing a layer of
   indirection in the specialization-weight expansion.
4. **`#consolidateSemanticProtos` symmetric Gram matrix.** The per-row O(n²)
   projection sweep now builds one symmetric `Float32Array(n*n)` Gram once
   (`dot(i,j) === dot(j,i)` exactly, since IEEE-754 multiply is commutative and
   both directions reduce k in the same order) and mirrors the upper triangle.
   Falls back to the original sweep for n > 1024.
5. **`#projSimilarity`** — hoisted `#lowDim`; **`#computeProjNorms`** — single
   `WeakMap.get` with an `undefined` check instead of `has` + `get`.

### Round 2 (this revision) — redundant LSH re-registration
`#updateProtoInLSH` = `#removeProtoFromLSH` + `#insertProtoToLSH`, and
`#insertProtoToLSH` recomputes the full set of LSH hashes. Four call sites were
doing this work twice (or three times) in a row:

- `#updateSemanticProtos` merge path: `#updateProtoInLSH` + `#computeContentHash`
  immediately followed by `#finalizeSemanticProto`, which does both again.
- `#consolidateSemanticProtos` pair-merge: `#finalizeSemanticProto` then
  `#computeProjNorms(keep.mean)` + `#updateProtoInLSH` even though `keep.mean`
  was unchanged in between.
- `#consolidateSemanticProtos` split: `#updateProtoInLSH` + `#computeContentHash`
  followed by `#finalizeSemanticProto`.
- `#consolidateSemanticProtos` split: `#finalizeSemanticProto(newProto, …)`
  followed by a standalone `#insertProtoToLSH(newProto)` (idempotent, and
  redundant).

Because each remaining `#finalizeSemanticProto` performs the registration and
the hash, dropping the duplicates leaves the final LSH index and content hashes
identical. Verified bit-exact (40 trains, 0 weight diffs, 0 prediction diffs,
identical semantic lengths, clean LSH stats).

Measured effect (per training step, ES=64):

| call site                | before  | after   |
|--------------------------|--------:|--------:|
| `#updateProtoInLSH`      | 19,254  | 15,327  |
| `#insertProtoToLSH`      | 23,181  | 15,327  |
| `#removeProtoFromLSH`    |    —    | 19,194  |

i.e. ~20% fewer remove+h+insert cycles and ~34% fewer hash-insert operations
per step. Wall-clock self-time of these methods is small (~30–50 ms/step of a
~1.3–1.7 s step), so this is a modest but real and, importantly, provably
result-preserving win.

### Round 3 — cached specialization weights and attention scratch

All three changes only move work out of hot loops or reuse buffers; each was
accepted by the A/B fingerprint check.

1. **`#feedForwardBatch` specialization expansion cache.** The forward FFN
   needs two tiled views of the per-member specialization gate,
   `specWE[kk][j] = specW[kk][j % hidden]` and
   `specWT[i][kk] = specW[kk][i % hidden]`. The old code rebuilt both (and paid
   a `% hidden` per inner step) on every call. They are pure functions of the
   cached spec matrix, so they are now built once per matrix generation and
   cached in `#specExpandCache[idx]`, keyed by the *identity* of the matrix
   returned by `#getSpecWeightMatrix` (the matrix is rebuilt whenever the spec
   weights/scores are written, which invalidates the cache automatically).
2. **`#computeAttentionWeights` scratch rows.** The per-(member, position)
   softmax loop runs `ensembleSize * inputSize` times per call and previously
   allocated two short-lived arrays each iteration
   (`innerSums` + its `.map(...)`). It now reuses
   `#attnWeightScoreScratch` / `#attnWeightProbScratch`, whose `length` is pinned
   to `considerLen` before each use, so `#softmax` sees exactly the same
   elements in the same multiply-add order — bit-identical values, no per-iter
   allocation.
3. **Removed the dead `prevAug` computation.** A `prevAug` buffer was produced
   every hop in `#contextAwareAttention` but never read; it has been deleted
   outright.

### Round 4 — copy/alias cleanups in `#contextAwareAttention` + LSH hoists

Five small, purely mechanical edits, all verified bit-exact with the
`diagnostics()` comparator (ES=16, IS=64, 40 trains: `trainDiagDiffs 0`,
`maxPredDiff 0`, exact prediction match, identical semantic counts, clean LSH):

1. **`#contextAwareAttention`: `protoMeans` no longer deep-copied.**
   `selectedProtos.map(p => p.mean.slice())` → `map(p => p.mean)`. The means are
   only ever read (build K/V, sample the diversity centroid) — they are never
   written through — so the pastLen × hidden copy per call was pure overhead.
2. **`#contextAwareAttention`: `augmented` aliases `rawComponent`.**
   `const augmented = rawComponent.map(row => row.slice())` →
   `const augmented = rawComponent`. `rawComponent` is this call's own freshly
   allocated scratch buffer (never aliased with the caller's `inputs`), and its
   values are only ever read through `augmented`, so the defensive deep-copy was
   redundant. This removes an `inputSize × hidden` copy per call.
3. **`#computeLSHHashesLow`: hoisted `numTables` / `hashBits` / `lowDim`.**
4. **`#insertProtoToLSH`: hoisted `numLshSets` / `numTables`.**
5. **`#removeProtoFromLSH`: hoisted `numLshSets` / `numTables`.**

The private-field hoists remove a getter indirection from the innermost LSH
loops (which run ~28k times per step at ES=64). They are neutral-to-slightly
positive in wall-clock; the two copy removals are the substantive part
(allocation/GC reduction).

**Honest wall-clock caveat.** Interleaved timing runs (same process, alternating
A/B) put the Round-4 total within ±2% of baseline with per-run medians swinging
either way depending on machine noise — i.e. the engine is arithmetic-bound and
these edits do not move the needle on their own. They are applied because they
are provably result-preserving and strictly remove work/allocation; the
*behavioural* win of this round is the two indicator test suites (see
`BUGS.md`), not a speedup.

### Round 5 — `HiveMindController#interleave` quadratic → linear

The one *algorithmically* wasteful loop found in the controller layer. `#interleave`
merges two vectors as `[a1_0, a2_0, a1_1, a2_1, …]` and is called once per
prototype memory in the tier>1 `#extractFeatures` path. The old implementation:

```js
return arr1.reduce((acc, item, i) => { acc.splice(i * 2, 0, item); return acc; }, [...arr2]);
```

is O(n²): each `splice` shifts the whole remaining (growing) array, so an
`hidden`-sized merge costs `O(hidden²)` element moves, once per memory per
signal. Rewritten as a single O(n) pass that emits the identical sequence
(`a1_0,a2_0,a1_1,a2_1,…` then any left-over tail), with `arr2`'s tail appended
when the two lengths differ.

Verified by exhaustive differential test rather than by inspection: the old and
new implementations were run over **all `(n, m)` with `n, m ∈ 0..12` and 40
seeded random value-pairs each — 6760/6760 exact `Object.is` matches**, plus
object-element and duplicate-element cases. `features.test.js` then pins the
emitted sequence through the real `getSignal` path (it asserts the vector is an
interleave, not a concatenation).

Caveat: for the actual dimensions in play (`hidden` per tier is small — the
feature vector is truncated to `inputSize`, e.g. 10 at tier 2) this is a
microsecond-scale win; it is applied because it is provably equivalent and
removes the only quadratic loop in the controller, not because it changes the
wall clock.

### Round 6 — component split (structure, not speed)

`hiveMind.js` (7,550 lines) and `mainController.js` (2,477 lines) were broken
into thin shells plus component modules, with `hiveMindController.js` split the
same way (see `COMPONENTS.md`). This is **not** a performance change: the method
bodies are byte-identical, and results are pinned by fingerprints.

- `hiveMind.js` → shell + 22 bags under `hivemind/<domain>/` (100 methods),
  installed by `installMethods`.
- `hiveMindController.js` → shell + 5 bags under `hivemind/controller/`
  (11 methods).
- `mainController.js` → 13-line entry + 16 modules under `legion/`.

Verified by the new **golden** suite (11 FNV-1a fingerprints of a seeded,
deterministic training + controller trajectory — all unchanged), the new
**modules** suite (50 assembly checks), the new **legion** suite (57 checks),
and the full pre-existing suite (still green). This is the payoff of Round 1–5's
"preserve exact results" discipline: a large-scale refactor can now be proven
safe automatically.

---

Numbers from an instrumented build (enter/exit probes around every method), one
process, ~1.8 s/step on the dev box. **Treat call counts as the reliable signal
and timings as indicative** — the probes add a fixed per-call cost that visibly
inflates the tiny leaves (e.g. `#projSimilarity` at 142k calls/step). Inclusive
times overlap (each callee's inclusive time is contained in its caller's).

| method                        | calls/step | own ms | incl ms |
|-------------------------------|-----------:|-------:|--------:|
| `#processTransformer`         |      64    |   41   |  1354   |
| ├ `#multiHeadAttention`       |     128    |  167   |   758   |
| │ └ `#updateMemoryBanks`      |     128    |   16   |   436   |
| │   └ `#consolidateSemanticProtos` |  64   |   83   |   261   |
| ├ `#contextAwareAttention`    |      64    |  316   |   478   |
| `#accumulateGradients` (leaf)|       1    |  473   |   476   |
| `#softmax` (leaf)             |  40,001    |  156   |   156   |
| `#retrieveTopRelevantProtos`  |      64    |   94   |   129   |
| `#projSimilarity` (leaf)      | 141,720    |   68   |    68   |
| `#poolMultiPrototype`         |     256    |   57   |   100   |
| `#feedForwardBatch` (leaf)    |     128    |   43   |    43   |
| `#computeProjNorms` (leaf)    |  13,386    |   36   |    36   |
| `#kernelSimilarity` (leaf)    |  58,532    |   30   |    30   |
| `#rmsNorm` (leaf)             |  48,000    |   24   |    24   |
| `#computeContentHash` (leaf)  |  49,970    |   23   |    23   |
| `#insertProtoToLSH`           |  13,772    |   22   |    48   |
| `#computeLSHHashesLow`        |  27,672    |   20   |    27   |

The picture is unambiguous: the cost is **arithmetic on real data**, not
overhead. `#softmax` runs 40k times/step over 125-element score rows (≈5M
`Math.exp` calls/step); `#projSimilarity` runs 142k times/step inside the
consolidation O(n²) sweep; `#kernelSimilarity` does 3 `Math.log` + 1 `Math.exp`
per hidden dim per call. `#accumulateGradients` is a single call of pure dense
math over preallocated `Float64Array` scratch buffers. Every remaining "slow
loop" is either this inherent arithmetic or the algorithmic O(n²) similarity
sweep — and altering either changes the model's behaviour, so they are not
optimization targets. The low-hanging allocation/indirection waste has been
removed.

---

## Round 25 — no hot-path change; the eval/report layer only

Round 25 touches the decision and reporting layer, never the training hot path.
The training step, the controller fit and every golden fingerprint are
bit-identical (verified by the 11-fingerprint golden suite), so nothing here can
move a model trajectory. The new cost is all O(small) or O(C):

- **`dependence.js`** — the jackknife is `C` statistic evaluations (C = fold-window
  clusters), the sign test is one exact binomial tail, the paired test is two
  jackknife passes. On attempt 3's C = 288 clusters this is microseconds against a
  12-hour run. The only non-constant piece is `regularizedIncompleteBeta`, a
  fixed-iteration continued fraction.
- **`familyCorrelation`** — one correlation per candidate pair; O(K² · folds) with
  K = 15, and only per-fold excess-Sharpe means are retained (not the returns),
  so it is a few thousand multiplies.
- **`costLadder`** — the full `promoteDecision` restated at each level; the
  expensive part is bounded by cluster count, not bar count, and each candidate's
  per-fold returns are reused (no refit). Measured: negligible beside the fits.
- **`timings` / per-variant `elapsedMs`** — the observability fix is two
  `Date.now()` reads per variant, and it is what makes the cost model legible
  (attempt 3's `run.log` looked as if 8 variants took 0.66 s; the report now
  attributes time per variant).

**The measured cost model is the one optimisation input that matters for the next
run:** a single controller fit costs **~10.7 s** at 36 folds/stream, so a run costs
`time ≈ 10.7 s × mechanismVariants × folds × (1 + probes)`. **SUPERSEDED by
"Round 25b" below** — the per-fit cost is not constant: it grows with the fold
index (42.6 s at 142 folds/stream) and a run is O(n²) per stream, because the fit
replays all history to warm the online controller. Round 25 makes the
corrected MDE (hence the honest required sample) computable *before* spending it,
so the next run can be sized from the model rather than from a guess. No change to
the fit itself is implied or taken — the O(n²) similarity sweep and the
recomputation-vs-storage tradeoff below remain the only known hot-path
opportunities, and both are still rejected for bit-exactness.

## Round 25b — the measured cost law, and why the run is O(n²)

The `20260921T062511-seed1` signal-family run settled what the round-25 cost model
got wrong. It ran **9 variants over 8 streams × 2,200 bars (1,136 folds, 17,040
pooled bars)** and its `timings` block is unambiguous:

| variant | kind | folds | elapsed |
| --- | --- | ---: | ---: |
| `baseline` | mechanism | 1,136 | **96,890,845 ms (26.9 h)** |
| 8 × `sig:*` | signal | 1,136 | 309-775 ms each |

**All 26.9 hours were one mechanism variant.** Signals are pure array math on the
view and cost nothing (`makeSignalForVariant`). That is the first lesson: the
cost of an experiment is the cost of its *model* variants, so narrowing a run to
the signal family is essentially free while adding a mechanism variant multiplies
the whole run.

### The law

`fit()` warms an online controller by replaying history:

```js
for (let i = 1; i <= testStart; i++) ctl.getSignal(candles.slice(0, i), 1);
```

The number of warm-up calls per fold grows with the fold index, so:

```
time ≈ 0.035 s × Σ_f(testStart_f) × streams × passes × mechanismVariants
Σ_f(testStart_f) = F·trainSize + testSize·F(F−1)/2
```

with ≈35 ms per warm-up call (33.2 ms measured at F=36, 38.2 ms at F=142 — the same
constant, which is what makes the law predictive rather than fitted). Two
consequences:

- **`cost/fold ∝ F`, so `total ∝ F²` and the run is O(n²) per stream** (per-fold
  cost 10.7 s at 36 folds/stream vs 42.6 s at 142 — measured ratio 3.98 against a
  fold ratio of 3.94).
- **For a fixed pooled-bar budget, `time ∝ pooledBars × folds-per-stream`.** Since
  `pooledBars = streams × F × testSize`, MANY SHORT STREAMS are much cheaper than a
  few long ones: 8 × 2,200 ⇒ 26.9 h, but 32 × 550 ⇒ ≈6 h for the same pooled bars.

### The levers, in order of value

1. **Parallelise the fold loop across worker threads (semantics-preserving, the big
   win).** Every fold is an independent model fit and already gets its own state
   directory (`stateDir/<variant>-<counter>`), so the folds are embarrassingly
   parallel: ~8-16× on a desktop. `legion/workers.js#runWorkerThread` is the
   existing settle-once, watchdogged dispatch, and `consolidation_worker.js` shows
   the pattern for a heavy per-item job. The only care needed is journal ordering
   (`folds.jsonl` and the per-variant checkpoints are written in fold order today,
   so results would need buffering and a stable emit order to keep the offline
   journal byte-comparable). This changes no arithmetic and no random draw — the
   per-fold seed is already `(variantSeed + testStart·977)`, i.e. independent of
   scheduling.
2. **Size with short streams.** With the law, a run's wall clock is a design choice:
   prefer more *diverse* streams at fewer bars — it is cheaper (linear in streams,
   quadratic in folds-per-stream) *and* statistically better (more effective bars,
   lower design effect).
3. **Journal the pre-policy signal** so position-policy/cost sweeps can be restated
   offline. Today `folds.jsonl` records the *emitted* positions, so a different
   `positionPolicy` requires a refit; recording the pre-policy value would make the
   turnover/cost economics a pure post-processing experiment. (Not implemented yet —
   it is on the round-26 plan.)
4. **Trim the allocation churn (secondary).** `candles.slice(0, i)` allocates a
   fresh `O(i)` array per warm-up call; `Σ_i O(i) = O(F²)` copies per stream. It is
   not the dominant term (the `getSignal` compute is), but passing an end index (or
   a shared subarray view) would remove it without touching arithmetic.

### Deliberately NOT taken

**Warming up once per stream and snapshotting at fold boundaries** would collapse
the O(n²) to O(n) — but the per-fold fresh seed `(variantSeed + testStart·977)` is
what makes each fold an independent random draw, and reusing one controller would
correlate the folds' trajectories and change the very fold-level statistics the
cluster inference reads. That is a statistical decision, not an optimisation, so it
stays out of this document. **Replaying history is the online training** — it must
not be "optimised" away.

### Round-26 measurement — the same design at 600 bars, and the combined 34 % saving

The `20260922T204248-seed1` run (`RUN-ANALYSIS.md` §10) is the same design as §5's
attempt 3 (8 streams × 600 bars ⇒ 36 folds/stream, `Σ_f(testStart_f)` = 11,610) with
`saveInterval: "inf"`, so its `timings` give a corrected reading of the law:

| variants | kind | folds | elapsed |
| --- | --- | ---: | ---: |
| 7 × mechanism (`baseline`…`sample-weights`) | mechanism | 288 | 3.89M – 4.19M ms each |
| 8 × `sig:*` | signal | 288 | 50 – 162 ms each |

Total 28,418,998 ms (7.90 h); the eight signals sum to ≈0.6 s, so the run is still
entirely mechanism cost (≈4.06M ms per mechanism variant ⇒ ≈14.1 s per fold-pass).
That backs out to ≈0.02-0.035 s per warm-up call, the same constant round 25b
measured — the law is unchanged by the fidelity fix.

**The identical design fell from 11.98 h to 7.90 h (a 34 % reduction).** This is *not*
a controlled attribution: R26-12's checkpoint throttle (`saveInterval: inf`;
`dumpState()` measured at ≈25 % of per-call cost — "Round 26b" below) and the #33
window fix's removal of the re-insert churn (measured ≤ 8 %) both land in it, and the
new run also does less training (2,362 baseline trades vs 2,671). Treat 34 % as the
combined effect; the per-call breakdown in "Round 26b" is the only measured
attribution.

## Round 26b — where the A/B's per-call cost actually goes, and the correction of round 25c

Round 25b attributed the fit's cost constant (`≈ 0.035 s` per warm-up call) to the
inherent "replay history through an online model" cost and concluded the only
semantics-preserving lever was parallelism. Round 25c then attributed a large part
of that constant to the round-26 fidelity defect (`BUGS.md` #33): the A/B passes
`getSignal` the whole growing prefix, the controller trims its candle table to
`cacheSize`, so a prefix-shaped call re-inserts every trimmed candle, builds an
`IN (?,…)` statement with thousands of placeholders and hands `_updateOpenTrades`
the whole old history.

**That attribution was wrong, and the second sweep pass caught it by measuring the
control.** Same controller, same seed, same synthetic candles, `cacheSize = 120`,
one call per bar, mean ms/call by call block (shim, sql.js):

| calls | window (production-shaped) | prefix (current A/B) |
| --- | ---: | ---: |
| 1-20 | 12.1 | 6.8 |
| 20-50 | 43.9 | 45.2 |
| 50-100 | 56.1 | 51.2 |
| 100-150 | 56.9 | 53.7 |
| 150-200 | 56.6 | 55.4 |

The two are **the same, block for block**. In prefix mode the re-insert volume
grows to hundreds of candles per call (measured `recentCandles` up to 480 at 600
bars); in window mode it is exactly 1 — and the per-call cost does not differ. The
`8.8 → ~50 ms/call` "ramp" the round-25c table read as the onset of the churn
appears **identically in window mode**: it is early-run warm-up (JIT, DB growth,
WASM), not the defect. Across a full 600-bar run the difference is ≤ 8 % (window
51.2 vs prefix 55.1 ms/call), which is a churn term that is real but small.

So `#33` is a **correctness** fix. Its speed benefit on the native driver is
**unmeasured**, and no round-26 item may be sized on the assumption that it is
large. `BUGS.md` #33's "secondary payoff" sentence is qualified to say exactly
this, and the corrected constant must be re-measured natively after R26-0 lands.

**Where the per-call cost actually is.** Instrumenting one warm controller over 100
bars (window-shaped, after the early ramp; shim):

| stage | share of per-call time | per call |
| --- | ---: | ---: |
| `HiveMind.predict` (inference) | 53.7 % | 14.97 ms |
| `HiveMind.dumpState()` (full state save) | 24.6 % | 6.85 ms |
| `HiveMind.train` (label training) | 14.2 % | 3.95 ms |
| `broadcastMemory` | 0.5 % | 0.13 ms |
| `translateMemory`, SQLite IO, bookkeeping | ~7 % | ~2 ms |

`dumpState()` re-opens the state DB, re-runs ~50 `CREATE TABLE IF NOT EXISTS` and
~50 `DELETE FROM` statements, and re-inserts the **entire ensemble state** —
transformer weights, gradient accumulators, every memory prototype and history —
**on every call that predicts or trains**. In the A/B that state is never read
back: `makeControllerModelFactory` pre-creates the mind and discards the directory
per fold (`modelRetention`), and the controller's own candle DB is the only
persisted thing the driver reads. So roughly **a quarter of every fold's compute is
a checkpoint nobody ever loads**.

That is a clean, semantics-preserving throughput lever: **checkpoint on an
interval, not on every call** (round-26 item R26-12). Default `1` keeps the
current behaviour bit-exact; the A/B sets "final only". The interval tradeoff is
the classical checkpoint-interval problem (Young 1974; Daly 2006) — cost per unit
time against expected lost work per failure — and a *production* run's failure
window (a worker restart) is exactly where the interval should be bounded rather
than infinity.

As before, the shim is not the native driver: the *shares* above may move on
native better-sqlite3, and the absolute constant must be re-measured there before
it sizes anything. What the shim does establish is the *order*: inference first,
persistence second, training third, and the fidelity defect's churn last.

### R26-12 — landed (round 26)

Implemented exactly as scoped above, with the semantics proof attached:

- `src/hivemind/hiveMindController.js` — `_saveInterval` (class field, default
  `1`) and `_saveTicks`; the checkpoint is gated to every `k`-th *eligible* call
  (`Math.floor(_saveInterval)`, so a non-integer floors and a non-finite value
  never matches the modulo). Default `1` ⇒ `_saveTicks % 1 === 0` on every
  eligible call ⇒ byte-identical to the previous unconditional `dumpState()`, which
  is why the 11 golden fingerprints are unmoved. Also added `flushState()` — an
  explicit on-demand write that ignores the interval (a no-op before the mind
  exists; used by the A/B only when a fit is KEPT and the interval never dumps, so
  a forensic state directory is not left empty).
- `src/analyze.js` — `makeControllerModelFactory({ saveInterval })` (default `1`,
  the direct-call behaviour) and `runAnalysis({ saveInterval = Infinity })` (the
  A/B never reads a fit's state back, so it does not pay for the write). The value
  is recorded in `run.json` and `report.json` as a number or `'inf'`.
  `--save-interval=<n>|inf` is the CLI switch; the default is `inf`, and
  `--save-interval=1` restores the historical per-call dump.
- **Evidence, not inference.** Note that the throttle *cannot* change an emitted
  signal by construction (`dumpState` is a pure read of the model, and its return
  value is only assigned to `_lastSaveStatus`, which is not in the signal payload).
  The suite nonetheless asserts it end-to-end: `core.test.js` section H drives
  three controllers over the same candles with a deterministic mind stand-in and
  shows (a) the signal stream is identical at `k = 1, 3, Infinity`, (b) the write
  count is exactly `ticks` / `floor(ticks / k)` / `0`. `analyze.test.js` pins the
  factory default (`1`), the override, the driver default (`Infinity`), the
  recorded field, and the one-shot kept-fit flush.
- **Not yet measured natively.** The ~24.6 % share is a shim number. The native
  saving (and the corrected fit constant) must be re-measured with
  `npm run analyze` on real `better-sqlite3`; the shim number only sized the change.

## Remaining opportunity (deliberately NOT taken)

**Reuse the forward FFN intermediates in the backward pass.** The forward pass
(`#feedForwardBatch`) already computes, per token and layer, the gate and up
pre-activations and the SiLU activation. The backward pass
(`#accumulateGradients`, segment E) recomputes all of them from the stored layer
input, which is roughly 20–25% of the training step. Storing the forward values
and consuming them in the backward pass would remove that recomputation.

It was **rejected** because it is *not* bit-exact, and the asymmetry is subtle:
the forward applies `Math.fround` to the gate value before SiLU
(`const gv = Math.fround(gateAcc[j])`), while the backward recomputes the gate
without the `fround`. Reusing the forward values (or, conversely, making the
backward apply the same `fround`) changes the gradients and therefore the whole
training trajectory. This is arguably a *correctness* improvement (forward and
backward should differentiate the same function), but it changes the model's
behaviour, so it should only be done together with an accuracy benchmark that
shows no regression — not as a drop-in speedup. It is the single largest
remaining win if that tradeoff is acceptable.

**The consolidation merge sweep is inherently O(n²·d)** (`consolidation_logic.js`,
run in `consolidation_worker.js` over up to 1000 volatile / 750 core prototypes).
Each surviving prototype is compared against every later one, and the target's
mean changes between comparisons, so the order of merges is part of the
algorithm. Caching distances, spatially bucketing, or introducing early exits
would change *which* prototypes merge — i.e. the memory being consolidated —
so none of it is an optimization target. It already runs off the main thread.

Other rejected changes (all would alter results):
- reducing the hop count, the number of `Math.exp` calls, or approximating
  `exp` in `#contextAwareAttention` (the per-hop work is inherent — ~11.7 hops
  per call at ES=8, ~40M multiplies per step);
- any reordering of the multiply-add chains (e.g. hoisting `x·specWeight`)
  changes IEEE-754 rounding.
