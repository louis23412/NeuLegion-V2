# NeuLegion — component architecture

How the two large classes are assembled from component modules, and the rules
for editing them. The per-file map (which module holds which method, and what
each technique is) lives in [`../src/README.md`](../src/README.md); this
document explains the mechanism and the verification that makes it safe.

## The problem

`HiveMind` is a single tightly-coupled simulation object: ~100 methods that all
read and write the same `_`-prefixed instance state. `HiveMindController` is a
smaller instance of the same problem (~11 helpers). Both grew past the size
where a single file is easy to navigate, diff, or review.

## The approach: prototype mixins, not composition

Splitting them into collaborating *objects* was rejected: every method touches
`this._hiddenSize`, `this._transformers`, `this._semanticProtos`, … and passing
a state bag around would rewrite every field access and risk changing evaluation
order. Instead each domain becomes a **method bag** — a plain object literal of
methods — and `installMethods` copies the methods onto the class prototype.

```js
// hivemind/kernels/activations.js
export const activationMethods = {
    _silu (x) { … },
    _siluDerivative (x) { … },
    …
};

// hivemind/hiveMind.js
import { installMethods } from './internal/mixins.js';
import { activationMethods } from './kernels/activations.js';
…
for (const methods of [activationMethods, …]) installMethods(HiveMind, methods);
```

`installMethods` (`hivemind/internal/mixins.js`) uses
`Object.getOwnPropertyDescriptors` + `Object.defineProperty` with
`enumerable: false`, so the resulting prototype is **shape-identical to a normal
class body** (class methods are non-enumerable). It throws if a key is already
defined (no silent shadowing) or if a bag entry is not a plain method. The
optional `assertCount` makes a bag's size part of its contract.

## The manifest is the single source of truth

`../test/component-manifest.js` lists, for each class, the bag label → exact
method names in file order, the methods that stay in the class body, and the
total installed count. `modules.test.js` asserts:

1. every bag exports exactly the manifest's methods, in order;
2. every manifest method is installed on the prototype as a non-enumerable own
   property **holding the exact function reference from its bag**;
3. the prototype's own-property set is exactly `constructor` + class API +
   installed methods — nothing extra, nothing missing;
4. the class body keeps the public API and no bag provides it;
5. the `installMethods` guard rails actually throw.

So dropping, renaming, or double-installing a method is a hard test failure,
not a runtime `undefined is not a function`.

## Classification and locks

The manifest says *which bag owns which method*; [`LOCKED.md`](LOCKED.md) and
[`../test/lock-registry.js`](../test/lock-registry.js) say *how much each bag is
trusted, why, and what proves it*. Every bag in the manifest must have exactly
one registry entry — `locks.test.js` fails otherwise — with one of: LOCKED-bit-exact
(golden fingerprint), LOCKED-invariant (a proven property), LOCKED-structural
(the assembly itself), NEEDS-LOCAL-RUN (native dependency), or EXPERIMENTAL
(additive, must not be imported by locked code). The analysis supercharges under
`src/analysis/` are registered separately (they are not part of either class),
as LOCKED-invariant backed by `analysis.test.js`.

## Why this is safe: byte-exact extraction + golden fingerprints

The extraction was mechanical and verified two ways:

- **Assembly** — `modules.test.js` (50 checks) pins the wiring itself.
- **Behaviour** — the method bodies are byte-identical to the originals, and
  `golden.test.js` fingerprints the exact floating-point trajectory of a
  deterministic, seeded workload (`hiveMind.js` is chaotic: one reordered
  multiply-add ripples into completely different weights). The 11 fingerprints
  (`hm:diagnostics`, `hm:predictions`, `ctl:finalSignal`, …) are unchanged by
  the split.
- **Legion** — `legion.test.js` (57 checks) covers the `mainController.js`
  split, including the fact that `legion/database.js` opens its DBs at
  module-eval time (tests must `await __ensureSql()` and then dynamically
  `import()` the modules).

## Rules for editing

1. **One home per method.** A method lives in exactly one bag. Moving it means
   editing the bag, the manifest, and the class shell's install list together.
2. **Bags are object literals** — methods need **commas** between them (class
   syntax does not). A missing comma is a parse error the bundler reports.
3. **Each bag imports what its own methods use.** The monolith's module-level
   imports are not inherited; a bag that calls `isValidNumber` or `crypto`
   must import it (relative paths like `./../utils.js` from
   `hivemind/controller/`). A missing import surfaces as `X is not defined`.
4. **Don't touch the hot math.** Everything under `hivemind/` is locked to the
   golden fingerprints (see `OPTIMIZATION.md` for the A/B method). Pure
   additions (a new `diagnostics`-style reader) are fine; anything that changes
   arithmetic needs an intentional re-freeze with a documented reason.
5. **Keep the shell a shell.** Fields, constructor, and the public API only.
6. **No leading-underscore path segments** under `src/` (e.g. `src/_probe.js`);
   the workspace file API rejects them.
