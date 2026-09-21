// NeuLegion legion component: signal collection, influence propagation and aggregation
//
// Split out of the original monolithic src/mainController.js; the bodies are
// byte-identical apart from the shared mutable state being read/written as
// properties of the `state` holder (see ./state.js). src/mainController.js is
// now just the entry point that runs ./legion/runner.js.

import { state } from './state.js';
import { PriorityQueue } from './priorityQueue.js';
import { CONFIG } from './config.js';
import { updateLegionAccuracy } from './accuracy.js';
import { canonicalJSON } from './serialization.js';
import { sanitizeConsensus, finiteOr } from './sanitize.js';

export const getCurrentMarketContext = () => {
    if (state.cache.length === 0) {
        return { price: 1.0, atrProxy: 0.01, volatility: 0.005 };
    }
    const last = state.cache[state.cache.length - 1];
    const rawPrice = last.close ?? last.c ?? last[4] ?? 1.0;
    // A zero/negative/non-finite close must not turn the whole consensus into
    // Infinity/NaN downstream (it divides into every percentage). Fall back to
    // the neutral price, exactly like the empty-cache branch.
    const price = finiteOr(rawPrice, 1.0) > 0 ? finiteOr(rawPrice, 1.0) : 1.0;

    const window = Math.min(14, state.cache.length);
    let atrSum = 0;
    for (let i = state.cache.length - window; i < state.cache.length; i++) {
        const c = state.cache[i];
        const prevClose = i > 0 ? (state.cache[i - 1].close ?? state.cache[i - 1].c ?? state.cache[i - 1][4] ?? c.close) : c.close;
        atrSum += Math.max(
            c.high - c.low,
            Math.abs(c.high - prevClose),
            Math.abs(c.low - prevClose)
        );
    }
    const atrProxy = atrSum / window || 0.01;
    const volatility = atrProxy / price;
    return { price, atrProxy, volatility };
};

export const collectAndEnrichSignals = () => {
    const signals = [];
    state.structureMap.flat(3).forEach(ctrl => {
        const sig = ctrl.lastSignal || {};
        const mb = sig.memoryBroadcast || {};
        const dir = ctrl.type === 'positive' ? 'BUY' : 'SELL';
        const recentScores = (ctrl.scoreHistory || []).slice(-10);
        const recentPerf = recentScores.length
            ? recentScores.reduce((a, b) => a + b, 0) / recentScores.length
            : (sig.score ?? 0.5);

        signals.push({
            id: `${ctrl.group}-${ctrl.section}-${ctrl.layer}-${ctrl.id}`,
            direction: dir,
            polaritySign: dir === 'BUY' ? 1 : -1,
            prob: Math.max(0.01, Math.min(0.99, (sig.prob ?? 50) / 100)),
            score: (sig.score ?? 50) / 100,
            signalSpeed: ctrl.signalSpeed ?? 1000,
            tier : ctrl.tier ?? 1,
            memConnections: ctrl.memConnections ?? 0,
            childConnections : ctrl.childConnections ?? 0,
            vaultMemories: mb.vaultMemories ?? 0,
            entryPrice: sig.entryPrice ?? 0,
            exitPrice: sig.sellPrice ?? 0,
            stopLoss: sig.stopLoss ?? 0,
            group: ctrl.group,
            section: ctrl.section,
            layer: ctrl.layer,
            cluster : ctrl.id,
            recentPerf,
            compatibility: mb.compatibility ? canonicalJSON(mb.compatibility) : null
        });
    });
    return signals;
};

export const getHierarchyFactor = (group, section, layer) => {
    const revG = state.structureDims[0] - 1 - group;
    const revS = state.structureDims[1] - 1 - section;
    const revL = state.structureDims[2] - 1 - layer;

    return (1 + CONFIG.groupPopBoost * revG) * (1 + CONFIG.sectionPopBoost * revS) * (1 + CONFIG.layerPopBoost * revL);
};

export const computeDynamicWeights = (signals) => {
    const maxMem = Math.max(...signals.map(s => s.memConnections), 1);
    const maxChild = Math.max(...signals.map(s => s.childConnections), 1);
    const maxTier = Math.max(...signals.map(s => s.tier), 1);

    return signals.map(s => {
        const hier = getHierarchyFactor(s.group, s.section, s.layer);
        const memNorm = 1 + (s.memConnections / maxMem) * 0.3;
        const childNorm = 1 + (s.childConnections / maxChild) * 0.3;
        const tierNorm = 1 + (s.tier / maxTier) * CONFIG.tierWeightMultiplier;

        const vaultBoost = 1 + s.vaultMemories * CONFIG.broadcastRatio * 2;
        const perfBoost = 1 + (s.recentPerf - 0.5) * 2;
        const base = s.prob * s.score * perfBoost;

        const weight = base * memNorm * childNorm * tierNorm * vaultBoost * hier * CONFIG.performanceBoostFactor;
        return { ...s, weight: Math.max(0.01, weight) };
    });
};

export const propagateInfluence = (weightedSignals) => {
    const pq = new PriorityQueue();
    const visited = new Map();

    const sorted = [...weightedSignals].sort((a, b) => b.weight - a.weight);
    const seedCount = Math.ceil(sorted.length * 0.3);
    for (let i = 0; i < seedCount; i++) {
        const s = sorted[i];
        pq.push({ ...s, accumDist: -s.weight, depth: 0 });
    }

    while (pq.size > 0) {
        const curr = pq.pop();
        const key = curr.id;
        const currBoost = -curr.accumDist;

        if (visited.has(key) && visited.get(key) >= currBoost) continue;
        visited.set(key, currBoost);

        weightedSignals.forEach(neigh => {
            if (neigh.id === key) return;

            const sameLevel = neigh.section === curr.section && neigh.layer === curr.layer;
            const sameCompat = curr.compatibility && neigh.compatibility && curr.compatibility === neigh.compatibility;
            const proximity = Math.abs(neigh.group - curr.group) + Math.abs(neigh.section - curr.section) + Math.abs(neigh.layer - curr.layer);
            const tierDiff = Math.abs(neigh.tier - curr.tier);
            const tierBonus = tierDiff === 0 ? (curr.tier === CONFIG.maxTier ? 1.4 : 1) : (curr.tier > neigh.tier ? 1.4 : 0.6);

            if (sameLevel || sameCompat || proximity <= 2) {
                const edgeDist = sameCompat ? 0.5 : (proximity * 0.3) + (tierDiff * 0.2);
                const newBoost = currBoost * tierBonus * Math.exp(-edgeDist * CONFIG.volatileHierarchyThreshold);

                const newAccumDist = -newBoost;

                const existing = visited.get(neigh.id) || 0;
                if (newBoost > existing) {
                    visited.set(neigh.id, newBoost);
                    pq.push({ ...neigh, accumDist: newAccumDist, depth: curr.depth + 1 });
                }
            }
        });
    }

    return weightedSignals.map(s => {
        const boosted = visited.get(s.id) || s.weight;
        return {
            ...s,
            finalWeight: s.weight * 0.7 + boosted * 0.3
        };
    });
};

export const hierarchicalAggregate = (propagated) => {
    const layerAgg = new Map();

    propagated.forEach(s => {
        const key = `${s.group}-${s.section}-${s.layer}-${s.direction}`;
        s.tempId = `G${s.group}S${s.section}L${s.layer}C${s.cluster}`;

        if (!layerAgg.has(key)) {
            layerAgg.set(key, {
                strength: 0,
                weightSum: 0,
                entrySum: 0,
                exitSum: 0,
                stopSum: 0,
                count: 0
            });
        }
        const agg = layerAgg.get(key);
        agg.strength += s.polaritySign * s.prob * s.finalWeight;
        agg.weightSum += s.finalWeight;
        if (s.entryPrice > 0) {
            agg.entrySum += s.entryPrice * s.finalWeight;
            agg.count++;
        }
        if (s.exitPrice > 0) {
            agg.exitSum += s.exitPrice * s.finalWeight;
        }
        if (s.stopLoss > 0) {
            agg.stopSum += s.stopLoss * s.finalWeight;
        }
    });

    const influencelist = propagated.map((x) => { 
        return { id : x.tempId, weight : x.finalWeight };
    });

    let totalPosStrength = 0;
    let totalNegStrength = 0;
    let posWeightSum = 0;
    let negWeightSum = 0;
    let posEntrySum = 0;
    let posExitSum = 0;
    let posStopSum = 0;
    let negEntrySum = 0;
    let negExitSum = 0;
    let negStopSum = 0;
    let posCount = 0;
    let negCount = 0;

    layerAgg.forEach(agg => {
        const w = agg.weightSum;
        if (agg.strength > 0) {
            totalPosStrength += agg.strength;
            posWeightSum += w;
            posEntrySum += agg.entrySum;
            posExitSum += agg.exitSum;
            posStopSum += agg.stopSum;
            posCount += agg.count;
        } else {
            totalNegStrength += Math.abs(agg.strength);
            negWeightSum += w;
            negEntrySum += agg.entrySum;
            negExitSum += agg.exitSum;
            negStopSum += agg.stopSum;
            negCount += agg.count;
        }
    });

    return {
        totalPos: totalPosStrength,
        totalNeg: totalNegStrength,
        posW: posWeightSum,
        negW: negWeightSum,
        posPrices: { entry: posEntrySum, exit: posExitSum, stop: posStopSum },
        negPrices: { entry: negEntrySum, exit: negExitSum, stop: negStopSum },
        posCount,
        negCount,
        influencelist
    };
};

export const resolveConsensus = (agg, market) => {
    const net = agg.totalPos - agg.totalNeg;
    const totalAbs = agg.totalPos + agg.totalNeg || 1;
    const direction = net > 0 ? 'BUY' : 'SELL';

    const majority = Math.max(agg.totalPos, agg.totalNeg);
    let confidence = (majority / totalAbs) * 100;

    confidence *= (1 + market.volatility * 1.5);

    confidence = Math.max(50, Math.min(100, confidence));

    const winningPrices = direction === 'BUY' ? agg.posPrices : agg.negPrices;
    const wSum = direction === 'BUY' ? agg.posW : agg.negW;
    let entry = (wSum > 0 ? winningPrices.entry / wSum : market.price);
    let exit = (wSum > 0 ? winningPrices.exit / wSum : 0);
    let stop = (wSum > 0 ? winningPrices.stop / wSum : 0);

    if (exit === 0) {
        exit = direction === 'BUY'
            ? entry * (1 + market.atrProxy * 5)
            : entry * (1 - market.atrProxy * 5);
    }
    if (stop === 0) {
        stop = direction === 'BUY'
            ? entry * (1 - market.atrProxy * 2)
            : entry * (1 + market.atrProxy * 2);
    }

    // Guard the division: a non-finite/zero entry would otherwise turn every
    // percentage into Infinity/NaN and flow on to the persisted simulation.
    const safeEntry = finiteOr(entry, 0) > 0 ? finiteOr(entry, 0) : finiteOr(market.price, 1.0);
    entry = safeEntry;

    const entryPrice = Number(entry.toFixed(4));
    const exitPrice = Number(finiteOr(exit, 0).toFixed(4));
    const stopLoss = Number(finiteOr(stop, 0).toFixed(4));
    const profitPct = entryPrice !== 0 ? Math.abs(Number((((exitPrice - entryPrice) / entryPrice) * 100).toFixed(3))) : 0;
    const stopLossPct = entryPrice !== 0 ? Math.abs(Number((((stopLoss - entryPrice) / entryPrice) * 100).toFixed(3))) : 0;

    return {
        direction,
        confidence: Number(confidence.toFixed(3)),
        entryPrice,
        exitPrice,
        profitPct,
        stopLoss,
        stopLossPct
    };
};

export const getLegionConsensus = (candle) => {
    const market = getCurrentMarketContext();

    let signals = collectAndEnrichSignals();
    signals = computeDynamicWeights(signals);
    signals = propagateInfluence(signals);

    const agg = hierarchicalAggregate(signals);

    const rawAnswer = sanitizeConsensus(resolveConsensus(agg, market));
    const finalAnswer = updateLegionAccuracy(candle, rawAnswer);

    return { 
        consensus : sanitizeConsensus(finalAnswer),
        influenceList : agg.influencelist
    };
};
