# Observability, calibration & run integrity

This note grounds the two layers added in ROADMAP P0/P1 that sit *beside* the
locked hot path: the **run-integrity guards** (`src/legion/sanitize.js`,
`src/legion/rng.js`) and the **observer** (`src/observer/*`). Neither imports
from, nor is imported by, the hivemind arithmetic, so neither can move one of
the 11 golden fingerprints — that separation is the whole point, and it is why
every module here is `LOCKED-invariant` rather than `LOCKED-bit-exact`.

## 1. Run integrity (P0-1)

The original design let one bad datum, one corrupt SQLite TEXT cell, one
malformed candle line or one worker that never posted a message abort an entire
run. The guards make every *boundary* value-safe:

* `finiteOr` / `finiteOrNull` normalise a value the way the DB would have bound
  it, and fall back rather than emit `NaN`/`Infinity` (which `better-sqlite3`
  rejects on a `NOT NULL` column).
* `safeParseJSON` never throws on a corrupt/truncated cell.
* `sanitizeSignal` / `sanitizeConsensus` make the broadcast/persistence payloads
  finite without touching a valid value (so a clean signal is byte-identical).
* `resolveFailureBudget` / `failureBudgetExceeded` isolate per-controller
  failures and stop only on a *budget* breach, so one dead slot degrades the
  batch instead of killing the run.
* `assertControllerArgs` fails a malformed config fast, inside the worker, where
  the batch can isolate it.
* `stableHash` / `configFingerprint` detect a structure-affecting config change
  so a resumed `state/` directory can warn (or refuse) instead of silently
  mixing two different models.

## 2. Determinism (P0-2)

A finite `seed` derives a per-worker seed (`deriveSeed` + `mulberry32`) and
installs it as `Math.random` inside the worker, so a run is reproducible without
changing the default (`seed = null` → native randomness, goldens unchanged).

## 3. Calibration & diversity (P1-2)

The observer scores the **legion's own health**, not a strategy's returns (that
is `src/analysis/*`). The metrics are standard and exact:

* **Calibration.** The Brier score (Brier 1950) is the proper quadratic scoring
  rule; the Murphy (1973) partition splits it into reliability, resolution,
  uncertainty and a within-bin term, and `brierDecomposition` keeps the full
  identity `Brier = REL - RES + UNC + WITHIN` so it is exact at any bin count.
* **Diversity.** Shannon entropy of the influence/member-probability weights,
  the Herfindahl-Hirschman index (Hirschman 1945) and its Laakso-Taagepera
  reciprocal `1/HHI` (effective voters), the Gini coefficient (Gini 1912), and
  mean pairwise Cohen's kappa (Cohen 1960) as the ensemble-agreement readout
  (Kuncheva & Whitaker 2003).
* **Drift.** An EWMA series and a two-sided CUSUM control statistic (Page 1954;
  the sequential-testing precursor is Wald 1945) over the mean controller score,
  plus the consensus→BUY probability mapping used for calibration.

## 4. Alerts

`alerts.js` is a pure rule engine: rules are plain data, and `evaluateAlerts` is
a function of `(metrics, rules, previouslyFiring)`. Hysteresis is the caller
passing the previous firing set back, which is what lets the engine report both
the alerts that are firing *now* and those that have *resolved*.

## 5. Wiring

`collector.js` subscribes to the canonical per-batch snapshot
(`state.onBatchSnapshot`, produced by `legion/broadcast.js`), maintains the
rolling windows and publishes the firing alerts back onto `state.alerts`. It is
read-only with respect to the run; the snapshot hook is attached only by the CLI
/ dry-run / analyze drivers, so a plain run pays nothing for it.

## References

* Brier, *Verification of Forecasts Expressed in Terms of Probability*, 1950.
* Murphy, *A New Vector Partition of the Probability Score*, 1973.
* Wald, *Sequential Tests of Statistical Hypotheses*, 1945.
* Page, *Continuous Inspection Schemes*, 1954.
* Cohen, *A Coefficient of Agreement for Nominal Scales*, 1960.
* Kuncheva & Whitaker, *Measures of Diversity in Classifier Ensembles*, 2003.
* Gini, *Variabilita e mutabilita*, 1912.
* Hirschman, *National Power and the Structure of Foreign Trade*, 1945.
