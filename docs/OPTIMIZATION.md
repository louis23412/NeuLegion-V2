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

## Round 23 — the evaluation is now *shipped-model* fidelity (no hot-path change; N3 verdict delivered by attempt 3 — nothing promotes)

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
gate itself is now on the work list** (round 25 — see `TODO.md` items 31-36 and
`ROADMAP.md` round 25).

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
clean. The regression suites (`sanity.test.js` 59 checks, `core.test.js` 20,
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
run:** a single controller fit costs **~10.7 s**, so a run costs
`time ≈ 10.7 s × mechanismVariants × folds × (1 + probes)`. Round 25 makes the
corrected MDE (hence the honest required sample) computable *before* spending it,
so the next run can be sized from the model rather than from a guess. No change to
the fit itself is implied or taken — the O(n²) similarity sweep and the
recomputation-vs-storage tradeoff below remain the only known hot-path
opportunities, and both are still rejected for bit-exactness.

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
