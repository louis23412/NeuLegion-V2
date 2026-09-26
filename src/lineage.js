// NeuLegion lineage register — the CODE CONTRACT of docs/LINEAGE.md.
//
// Established round 30 (PLAN-round30.md Workstream C). The human/machine register
// is docs/lineage.json; this module is the subset the code asserts against:
// every resolvable A/B variant must have a lineage entry here, and the
// PRE-REGISTERED default roster is read from this file, so a silent edit that
// re-adds a dropped branch fails a test (analyze.test.js) instead of inflating
// every deflated Sharpe.
//
// Naming scheme: NL-<LINEAGE>-<branch>@<version>
//   states: LIVE | KEEP | PARK | DROPPED | FROZEN | UNTESTED
//   (see docs/LINEAGE.md section 1; DROPPED reasons: docs/DROPPED.md)
//
// KEEP IN SYNC with docs/lineage.json (the two are written together).

export const LINEAGE_SCHEMA = {"id":"NL-<LINEAGE>-<branch>@<version>  (version = @rNN milestone or @rNN.n behavioural revision)","state":"LIVE | KEEP | PARK | DROPPED | FROZEN | UNTESTED","lineage":"CTRL | MECH | SIG | REV | BENCH | LABEL | EVAL | DATA | HARNESS | LEGION"};

export const LINEAGE_FAMILIES = Object.freeze({
    CTRL: { name: "HiveMind controller", question: "is the model skilful?" },
    MECH: { name: "controller/memory mechanism", question: "does this mechanism move the score?" },
    SIG: { name: "causal signal family", question: "is there a cross-sectional/price edge?" },
    REV: { name: "short-horizon reversal family", question: "is there a fast mean-reversion edge net of cost?" },
    BENCH: { name: "model-class benchmarks", question: "architecture or features the constraint?" },
    LABEL: { name: "trade-label policies", question: "does the training target matter?" },
    EVAL: { name: "walk-forward + significance + gate stack", question: "is a verdict honest?" },
    DATA: { name: "data sleeves", question: "what new information is there?" },
    HARNESS: { name: "test harness, goldens, lock registry", question: "is the code pinned?" },
    LEGION: { name: "outer evolutionary population", question: "can evolution breed a better controller?" },
});

export const LINEAGE_BRANCHES = Object.freeze([
    { id: "NL-CTRL-hivemind@r29", lineage: "CTRL", branch: "hivemind", state: "LIVE", variant: "baseline" },
    { id: "NL-MECH-surprise@r2", lineage: "MECH", branch: "surprise", state: "DROPPED", variant: "surprise" },
    { id: "NL-MECH-homeostasis@r2", lineage: "MECH", branch: "homeostasis", state: "DROPPED", variant: "homeostasis" },
    { id: "NL-MECH-pca-hash@r13", lineage: "MECH", branch: "pca-hash", state: "DROPPED", variant: "pca-hash" },
    { id: "NL-MECH-multiprobe@r16", lineage: "MECH", branch: "multiprobe", state: "PARK", variant: "multiprobe" },
    { id: "NL-MECH-querymod@r17", lineage: "MECH", branch: "querymod", state: "PARK", variant: "querymod" },
    { id: "NL-MECH-sample-weights@r28", lineage: "MECH", branch: "sample-weights", state: "PARK", variant: "sample-weights" },
    { id: "NL-MECH-sample-weights-scale-control@r28", lineage: "MECH", branch: "sample-weights-scale-control", state: "PARK", variant: "sample-weights-scale-control" },
    { id: "NL-MECH-memory@r29", lineage: "MECH", branch: "memory-subsystem", state: "FROZEN" },
    { id: "NL-SIG-momentum@r23", lineage: "SIG", branch: "momentum", state: "KEEP", variant: "sig-momentum" },
    { id: "NL-SIG-accel@r27", lineage: "SIG", branch: "accel", state: "KEEP", variant: "sig-accel" },
    { id: "NL-SIG-range@r23", lineage: "SIG", branch: "range", state: "PARK", variant: "sig-range" },
    { id: "NL-SIG-agreement@r23", lineage: "SIG", branch: "agreement", state: "PARK", variant: "sig-agreement" },
    { id: "NL-SIG-volume@r23", lineage: "SIG", branch: "volume", state: "DROPPED", variant: "sig-volume" },
    { id: "NL-SIG-autocorr@r23", lineage: "SIG", branch: "autocorr", state: "DROPPED", variant: "sig-autocorr" },
    { id: "NL-SIG-vol-regime@r23", lineage: "SIG", branch: "vol-regime", state: "DROPPED", variant: "sig-vol-regime" },
    { id: "NL-SIG-frac-momentum@r23", lineage: "SIG", branch: "frac-momentum", state: "DROPPED", variant: "sig-frac-momentum" },
    { id: "NL-SIG-vol-momentum@r30", lineage: "SIG", branch: "vol-momentum", state: "UNTESTED", variant: "sig-vol-momentum" },
    { id: "NL-SIG-blend-momentum@r30", lineage: "SIG", branch: "blend-momentum", state: "UNTESTED", variant: "sig-blend-momentum" },
    { id: "NL-SIG-network-momentum@r30", lineage: "SIG", branch: "network-momentum", state: "UNTESTED", variant: "sig-network-momentum" },
    { id: "NL-SIG-regime-momentum@r30", lineage: "SIG", branch: "regime-momentum", state: "UNTESTED", variant: "sig-regime-momentum" },
    { id: "NL-REV-reversal@r29", lineage: "REV", branch: "reversal", state: "PARK", variant: "sig-reversal" },
    { id: "NL-REV-reversal-4@r29", lineage: "REV", branch: "reversal-4", state: "PARK", variant: "sig-reversal-4" },
    { id: "NL-REV-reversal-vol@r29", lineage: "REV", branch: "reversal-vol", state: "PARK", variant: "sig-reversal-vol" },
    { id: "NL-REV-reversal-xs@r29", lineage: "REV", branch: "reversal-xs", state: "PARK", variant: "sig-reversal-xs" },
    { id: "NL-BENCH-base-rate@r29", lineage: "BENCH", branch: "base-rate", state: "PARK", variant: "bench-base-rate" },
    { id: "NL-BENCH-linear@r29", lineage: "BENCH", branch: "linear", state: "PARK", variant: "bench-linear" },
    { id: "NL-BENCH-mlp@r29", lineage: "BENCH", branch: "mlp", state: "DROPPED", variant: "bench-mlp" },
    { id: "NL-LABEL-conservative@r26", lineage: "LABEL", branch: "conservative", state: "PARK", variant: "label-conservative" },
    { id: "NL-LABEL-triple@r26", lineage: "LABEL", branch: "triple", state: "PARK", variant: "label-triple" },
    { id: "NL-EVAL-gate@r26", lineage: "EVAL", branch: "dependence-gate", state: "FROZEN" },
    { id: "NL-EVAL-significance@r25", lineage: "EVAL", branch: "significance-stack", state: "FROZEN" },
    { id: "NL-DATA-1h-8@r22", lineage: "DATA", branch: "candles-1h", state: "LIVE" },
    { id: "NL-DATA-15m-8@r29", lineage: "DATA", branch: "candles-15m", state: "LIVE" },
    { id: "NL-DATA-funding-8@r29", lineage: "DATA", branch: "funding-8h", state: "LIVE" },
    { id: "NL-HARNESS-golden@r29", lineage: "HARNESS", branch: "golden+lock-registry", state: "FROZEN" },
    { id: "NL-LEGION-evolve@r22", lineage: "LEGION", branch: "evolve", state: "UNTESTED" },
]);

export const LINEAGE_IDS = Object.freeze(LINEAGE_BRANCHES.map((b) => b.id));

// Round 30 (PLAN-round30.md sections 2/3.1): the pre-registered default A/B
// roster. The searched-K lever is only honest *ex ante* — you may pre-register a
// smaller roster for a future run; you may NOT re-report an old run at a smaller K.
export const DEFAULT_ROSTER_IDS = Object.freeze(['baseline', 'sig-momentum', 'sig-accel']);

// The A/B variant id a lineage entry governs (a family entry such as the memory
// subsystem has no variant), or null.
export const lineageForVariant = (variantId) =>
    LINEAGE_BRANCHES.find((b) => b.variant === variantId) || null;

// The lineage id for a variant, or null.
export const lineageIdForVariant = (variantId) => {
    const b = lineageForVariant(variantId);
    return b ? b.id : null;
};

// Every A/B-resolvable variant id that has no register entry (empty when complete).
export const uncoveredVariantIds = (variantIds) =>
    variantIds.filter((id) => !lineageForVariant(id));

// The register's DROPPED variant ids (must never appear in the default roster).
export const DROPPED_VARIANT_IDS = Object.freeze(
    LINEAGE_BRANCHES.filter((b) => b.state === 'DROPPED' && b.variant).map((b) => b.variant),
);
