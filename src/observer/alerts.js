// NeuLegion observer component: pure alert rule engine (ROADMAP P1-2).
//
// The observer *watches*; it never mutates the run. Rules are plain data
// (metric + comparison + threshold + severity), so they are trivially testable
// and configurable, and `evaluateAlerts` is a pure function of
// (metrics, rules, previously-firing). Hysteresis is handled by the caller
// passing the previous firing set, which is what lets a rule report `resolved`.

export const SEVERITIES = Object.freeze({ info: 'info', warning: 'warning', critical: 'critical' });

export const DEFAULT_ALERT_RULES = Object.freeze([
    {
        id: 'brier-near-chance',
        metric: 'brier',
        op: '>',
        threshold: 0.30,
        severity: SEVERITIES.warning,
        message: (v) => `Consensus Brier ${v.toFixed(3)} is at/near chance (0.25 = a constant 0.5 forecast).`,
    },
    {
        id: 'brier-worse-than-chance',
        metric: 'brier',
        op: '>',
        threshold: 0.40,
        severity: SEVERITIES.critical,
        message: (v) => `Consensus Brier ${v.toFixed(3)} is worse than a constant 0.5 forecast.`,
    },
    {
        id: 'influence-concentrated',
        metric: 'influenceHhi',
        op: '>',
        threshold: 0.35,
        severity: SEVERITIES.warning,
        message: (v) => `Influence HHI ${v.toFixed(3)}: the consensus is dominated by a few controllers.`,
    },
    {
        id: 'few-effective-voters',
        metric: 'effectiveVoters',
        op: '<',
        threshold: 3,
        severity: SEVERITIES.warning,
        message: (v) => `Only ${v.toFixed(2)} effective voters contribute to the consensus.`,
    },
    {
        id: 'ensemble-diversity-collapse',
        metric: 'memberProbStd',
        op: '<',
        threshold: 0.02,
        severity: SEVERITIES.warning,
        message: (v) => `Member probability std ${v.toFixed(4)}: the ensemble has collapsed to one opinion.`,
    },
    {
        id: 'worker-errors',
        metric: 'workerErrorRate',
        op: '>',
        threshold: 0,
        severity: SEVERITIES.warning,
        message: (v) => `${(v * 100).toFixed(2)}% of controller slots failed in the last batch.`,
    },
    {
        id: 'quarantined-rows',
        metric: 'quarantinedRows',
        op: '>',
        threshold: 0,
        severity: SEVERITIES.warning,
        message: (v) => `${v} corrupt row(s) quarantined.`,
    },
    {
        id: 'vault-growth',
        metric: 'vaultGrowthPerBatch',
        op: '>',
        threshold: 5000,
        severity: SEVERITIES.info,
        message: (v) => `Memory vault grew ${Math.round(v)} prototypes/batch.`,
    },
]);

export const compare = (value, op, threshold) => {
    if (!Number.isFinite(value)) return false;
    switch (op) {
        case '>': return value > threshold;
        case '>=': return value >= threshold;
        case '<': return value < threshold;
        case '<=': return value <= threshold;
        case '===': return value === threshold;
        case '!==': return value !== threshold;
        default: return false;
    }
};

// Pure evaluation. Returns the alerts that are now firing and the ids that were
// firing before but are not any more (so the dashboard can show a recovery).
export const evaluateAlerts = (metrics, rules = DEFAULT_ALERT_RULES, previouslyFiring = []) => {
    const prev = previouslyFiring instanceof Set ? previouslyFiring : new Set(previouslyFiring || []);
    const firing = [];
    const nowFiring = new Set();

    for (const rule of rules) {
        const value = Number(metrics?.[rule.metric]);
        if (!compare(value, rule.op, rule.threshold)) continue;
        nowFiring.add(rule.id);
        firing.push({
            id: rule.id,
            severity: rule.severity,
            metric: rule.metric,
            value,
            threshold: rule.threshold,
            op: rule.op,
            message: typeof rule.message === 'function' ? rule.message(value) : `${rule.metric} ${rule.op} ${rule.threshold}`,
            recovered: false,
        });
    }

    const resolved = [...prev].filter((id) => !nowFiring.has(id));
    return { firing, resolved, firingIds: nowFiring };
};

export const highestSeverity = (firing) => {
    if (!firing || firing.length === 0) return null;
    if (firing.some((a) => a.severity === SEVERITIES.critical)) return SEVERITIES.critical;
    if (firing.some((a) => a.severity === SEVERITIES.warning)) return SEVERITIES.warning;
    return SEVERITIES.info;
};
