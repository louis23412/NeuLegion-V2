// Shared mutable state for the legion orchestration modules.
//
// The original monolithic src/mainController.js kept five module-level `let`
// bindings that nearly every function read and reassigned. ES module imports
// are read-only live bindings (a function in another module cannot assign to an
// imported `let`), so those five values now live here as properties of a single
// exported object, and every consumer reads/writes `state.<name>`. This keeps
// one identity for each value across modules instead of five per-module copies.
//
// Run-integrity counters (ROADMAP P0) live here too so the batch isolation, the
// persistence layer and the observer all read one source of truth.

export const state = {
    cache: [],
    structureDims: [],
    structureMap: undefined,
    candleCounter: 0,
    httpWorker: null,
    httpHost: null,
    httpPort: null,
    httpListening: false,
    candleRepairs: 0,

    // --- Run integrity (ROADMAP P0) -----------------------------------------
    // Failures in the most recent batch, cumulative failures, and a bounded
    // record of the most recent failures (for the observer / run report).
    controllerFailures: 0,
    totalControllerFailures: 0,
    lastControllerFailures: [],
    consolidationFailures: 0,
    totalConsolidationFailures: 0,
    failedBatches: 0,
    // Controller-quarantined rows (corrupt TEXT cells) and malformed candle
    // lines, so a bad row is counted and surfaced rather than silently dropped.
    quarantinedRows: 0,
    malformedCandleLines: 0,
    // Worker-pool timing for the current run (ms).
    lastBatchDurationMs: null,
    totalBatchDurationMs: 0,
    // Observer hook: `(snapshot) => void`, called once per completed batch with
    // the same payload the dashboard renders. Read-only; errors are swallowed.
    onBatchSnapshot: null,
    // Latest observer alerts, shown on the dashboard (one batch behind).
    alerts: [],
    // Set by initLegion when the persisted state's config fingerprint differs
    // from the live config (see CONFIG.refuseOnConfigChange).
    configMismatch: null,
};
