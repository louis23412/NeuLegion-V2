// src/analysis/backtest/primitives.js (round-103 split of src/analysis/backtest.js).
// Signal-to-position primitives: no imports, no I/O, no RNG.
// Position held during bar t is the signal decided at bar t-lag (no lookahead).
export function positionsFromSignals(signals, { lag = 1 } = {}) {
    const out = new Array(signals.length).fill(0);
    for (let t = lag; t < signals.length; t++) out[t] = signals[t - lag];
    return out;
}

// Turnover = total absolute position change, counting the initial entry from 0.
export function turnover(positions) {
    let sum = 0;
    let prev = 0;
    for (const p of positions) { sum += Math.abs(p - prev); prev = p; }
    return sum;
}

// Strategy returns with transaction costs.
//   strRet[t] = position[t] * returns[t] - |position[t] - position[t-1]| * costBps/1e4
// Returns { returns, gross, cost, turnover }.
export function strategyReturns({ returns, signals, positions = null, costBps = 0 }) {
    const pos = positions || positionsFromSignals(signals, { lag: 1 });
    const fee = costBps / 1e4;
    const gross = new Array(returns.length).fill(0);
    const net = new Array(returns.length).fill(0);
    const cost = new Array(returns.length).fill(0);
    let prev = 0;
    for (let t = 0; t < returns.length; t++) {
        gross[t] = pos[t] * returns[t];
        cost[t] = Math.abs(pos[t] - prev) * fee;
        net[t] = gross[t] - cost[t];
        prev = pos[t];
    }
    return { returns: net, gross, cost, turnover: turnover(pos) };
}

export function equityCurve(returns, { start = 1 } = {}) {
    const out = new Array(returns.length + 1);
    out[0] = start;
    for (let t = 0; t < returns.length; t++) out[t + 1] = out[t] * (1 + returns[t]);
    return out;
}

// Maximum peak-to-trough drawdown as a fraction of the running peak.
export function maxDrawdown(equityOrReturns, { fromReturns = null } = {}) {
    const eq = fromReturns ? equityCurve(equityOrReturns) : equityOrReturns;
    let peak = eq[0];
    let mdd = 0;
    for (const v of eq) {
        if (v > peak) peak = v;
        if (peak > 0) mdd = Math.max(mdd, (peak - v) / peak);
    }
    return mdd;
}

// Fraction of in-market bars with a positive net return. With a positions
// series, bars with no position are excluded (they are neither hits nor
// misses) — even when their net return is nonzero (fees) or zero while
// in-market. Without positions the legacy zero-return skip applies.
export function hitRate(strategyReturnSeries, positions = null) {
    if (Array.isArray(positions) && positions.length === strategyReturnSeries.length) {
        let n = 0; let hits = 0;
        for (let i = 0; i < strategyReturnSeries.length; i++) {
            if (positions[i] === 0) continue;
            n++;
            if (strategyReturnSeries[i] > 0) hits++;
        }
        return n === 0 ? NaN : hits / n;
    }
    let n = 0; let hits = 0;
    for (const r of strategyReturnSeries) {
        if (r === 0) continue;
        n++;
        if (r > 0) hits++;
    }
    return n === 0 ? NaN : hits / n;
}

export function tradeCount(positions) {
    let count = 0;
    let prev = 0;
    for (const p of positions) { if (p !== prev) count++; prev = p; }
    return count;
}
