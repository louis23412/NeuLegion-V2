# The V2 core contracts — modularity as a checked property

Grounding for the V2.0/V2.1/V2.2 layer (`src/core/**`, `src/plugins/**`), the register
section `CORE_REGISTRY`/`PLUGIN_REGISTRY` in `test/lock-registry.js`, and the plan
[`../ARCHITECTURE-v2.md`](../ARCHITECTURE-v2.md) §4 + [`../MIGRATION-V2.md`](../MIGRATION-V2.md).
The question this note answers: *why is a contract layer the fix for this repo's actual
modularity defect, and what makes the layer trustworthy rather than ceremonial?*

## 1. The defect being fixed

The architecture audit (`../ARCHITECTURE-v2.md` §3) measured modularity on four axes —
separable, injectable, substitutable, isolation-testable — and found that the whole model
core (memory banks, transformer, ensemble, controller) is **separable but not
substitutable**: the 22 method bags run against one `HiveMind` instance's `_`-prefixed
state, and the 17 bit-exact bags are frozen by the 11 golden fingerprints. So the single
experiment the design exists for — swap the memory or the ensemble and re-measure — is a
whole-engine re-freeze. `docs/COMPONENTS.md` rule 4 ("don't touch the hot math") is the
right rule for the engine and the wrong rule for the *system*, because it makes the
question the project needs to ask uneconomical to ask.

Parnas (1972) is the anchor: a module boundary should hide a *decision that may change*.
The repo's file split hides nothing that may change — it hides navigation. A contract
hides the decision (which learner, which bank, which retrieval policy, which sleeve, which
risk policy), and a registry makes the decision a value.

## 2. The four mechanisms, and what each one buys

| mechanism | what it fixes | where it lives | why it is checkable |
| --- | --- | --- | --- |
| **A contract** (`defineContract`) | the missing interface: which methods a swappable thing must expose | `src/core/contracts/*.js` | `validatePlugin`/`validateInstance` return every gap in one pass; a bad plugin cannot register |
| **A capability tag** (mandatory) | arms that are off the scored path being scored as nulls | `src/core/contracts/base.js` | `not-applicable` is a first-class claim (the R27-2 lesson, `BUGS.md` #44) |
| **A registry** (`registerPlugin`/`resolve`/`activeRoster`) | the silent roster edit that inflates every deflated Sharpe | `src/core/registry.js` | `rosterSnapshot()`/`stackSnapshot()` are 8-hex content hashes, registration-order independent |
| **An import law** | the layering quietly re-coupling (core → engine, plugin → plugin) | `test/browser/entries/contracts.test.js` §H | every `.js` under `src/core`/`src/plugins` is read; a violation names the file and target |

Two lock classes (audit A14) replace the whole-engine freeze for the new layer: a **model**
plugin is pinned by a fingerprint (the legacy adapter is pinned by the engine's own
`golden.test.js`), an **analytic** plugin is pinned by exact reference vectors
(`contracts.test.js`). Adding a NON-DEFAULT plugin therefore moves no existing proof — the
registry's `stackSnapshot()` changes only when the default stack changes.

## 3. The stateful/stateless split

A learner, a memory bank, a retriever and a data source own per-instance state, so their
registered object is a **factory** (`create(options)`) and the contract is asserted against
the returned instance. A feature, a labeler, a sleeve, a book, a risk policy and an
evaluator are pure functions of a view, so their methods live on the plugin object. One
mechanism (`stateful: true`) covers both, which is why the two shapes cannot drift apart.

## 4. What the port actually reproduces

The sleeve layer is not new research — it is the lab's already-validated arithmetic, moved
so the repo and the lab run the same code:

| lab artefact | moved to | proof |
| --- | --- | --- |
| `e17#buildBook` (the funding-book shell) | `primitives/books.js#buildFundingBook` | hand-computed fixture incl. a flip that pins the previous-period target |
| `e21#xsBookImpl` / `e22#buildMasked` (identical formulas) | `primitives/books.js#buildCrossSectionalBook` | hand-computed 3-symbol fixture, sign flip, partial-cross-section flatness |
| `prototypes/port.js` (cap/band chain, `MIN_TRAIN_PERIODS`) | `primitives/weights.js` | exact vectors + the cap-then-band order fixture |
| `SLEEVE_SPECS` (R8/R7/OI) | each sleeve's `spec` + `risk/cap-band.js#CAP_BAND_SPECS` | the specs are data, and a test asserts the risk layer's copy matches the sleeves' |
| `e52_port_artefact.js` (5/5 stored books) | `src/NeuLegion-lab/experiments/e73_port_verify.js` | the lab re-derives the books from the REAL data through the repo modules and compares to `e52`'s stored numbers — **10/10 checks pass** (the three books plus a 250-trial seeded differential fuzz): R8 `6.18 / 10× / 46.04` = `e30`, R7 `1.07 / 8× / 182.59` = `e32`, OI `0.92 / 198× / 15.22` = `e50`, rows and returns bit-for-bit, and the repo `cleanBook` fingerprint-identical to `prototypes/port.js` (lab F-81) |

The one deliberate difference is *packaging*: the lab's functions take loose arrays; the
repo's take a `view`. The arithmetic is unchanged, which is what makes the lab's F-17/F-21/
F-39/F-41/F-60 numbers a statement about the repo's code.

**The book grid is an explicit input** (`buildFundingBook`/`buildCrossSectionalBook` take
`n`). The port verification found why it has to be: the lab's `e12#buildXsSeries` returns
**two** time arrays on the same object (the outer `times`, length `n−1`, and `legs.times`,
length `n`) and the lab's two construction shells read **different** ones — `e17#buildBook`
reads `legs.times.length` (6558 → 6557 book rows) while `e21#xsBookImpl` is handed
`times.length` (6557 → 6556 rows). Both published books are internally consistent, but they
sit on grids one period apart by which array the experiment happened to read, so a single
hard-coded rule cannot reproduce all three and a bit-level cross-check cannot line them up.
The repo makes the caller state the grid; the lab's `e73` passes `times.length` for the OI
view only (registered as lab row **L10-ct**).

## 5. What is deliberately NOT here

* **No engine rewrite.** `src/hivemind/**` is untouched; the adapter delegates. V2.3 will
  rebuild the model as plugins, and only after W4b picks a target.
* **No promotion.** The sleeves land `UNTESTED` and `defaultStack: false`; the lab's number
  says "worth porting", the repo's gate says "promoted". Scoring every registered arm is
  how `K` gets inflated.
* **No second lock registry.** `PLUGIN_REGISTRY` (the plugin ids, states and proofs) is
  drift-checked against `DEFAULT_STACK` in both directions, so the register cannot become
  a parallel, unreviewed registry.
