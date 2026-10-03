// NeuLegion legion component: signal collection, score-only weighting and aggregation
//
// Split out of the original monolithic src/mainController.js; the bodies are
// byte-identical apart from the shared mutable state being read/written as
// properties of the `state` holder (see ./state.js). src/mainController.js is
// now just the entry point that runs ./legion/runner.js.

import { state } from './state.js';
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

export const computeDynamicWeights = (signals) => {
    return signals.map(s => ({
        ...s,
        finalWeight: Math.max(0.01, s.prob * s.score),
    }));
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
    const agg = hierarchicalAggregate(signals);

    const rawAnswer = sanitizeConsensus(resolveConsensus(agg, market));
    const finalAnswer = updateLegionAccuracy(candle, rawAnswer);

    return { 
        consensus : sanitizeConsensus(finalAnswer),
        influenceList : agg.influencelist
    };
};
