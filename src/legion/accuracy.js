// NeuLegion legion component: legion accuracy accounting
//
// Split out of the original monolithic src/mainController.js; the bodies are
// byte-identical apart from the shared mutable state being read/written as
// properties of the `state` holder (see ./state.js). src/mainController.js is
// now just the entry point that runs ./legion/runner.js.

import { insertSimStmt, selectAllSims, deleteOpenSim } from './statements.js';

export const legionAccuracy = {
    longWin : 0,
    longLoss : 0,
    longPoints : 0,

    shortWin : 0,
    shortLoss : 0,
    shortPoints : 0,

    longTotalPoints : 0,
    shortTotalPoints : 0,

    maxBuyScore : 0,
    minBuyScore : 100,
    buyScoreHistory : [],

    maxSellScore : 0,
    minSellScore : 100,
    sellScoreHistory : [],

    maxFinalScore : 0,
    minFinalScore : 100,
    finalScoreHistory : []
};

export const updateAccValues = (updateH = false) => {
    const longTradeAcc = legionAccuracy.longTotalPoints > 0 ? Number(((legionAccuracy.longWin / (legionAccuracy.longWin + legionAccuracy.longLoss)) * 100).toFixed(3)) : 0;
    const longTrueAcc = legionAccuracy.longTotalPoints > 0 ? Number(((legionAccuracy.longPoints / legionAccuracy.longTotalPoints) * 100).toFixed(3)) : 0;
    const longAccuracyScore = Number(((longTradeAcc + longTrueAcc) / 2).toFixed(3));

    if (legionAccuracy.longTotalPoints > 0) {
        if (longAccuracyScore > legionAccuracy.maxBuyScore) legionAccuracy.maxBuyScore = longAccuracyScore;
        else if (longAccuracyScore < legionAccuracy.minBuyScore) legionAccuracy.minBuyScore = longAccuracyScore;
    }

    const shortTradeAcc = legionAccuracy.shortTotalPoints > 0 ? Number(((legionAccuracy.shortWin / (legionAccuracy.shortWin + legionAccuracy.shortLoss)) * 100).toFixed(3)) : 0;
    const shortTrueAcc = legionAccuracy.shortTotalPoints > 0 ? Number(((legionAccuracy.shortPoints / legionAccuracy.shortTotalPoints) * 100).toFixed(3)) : 0;
    const shortAccuracyScore = Number(((shortTradeAcc + shortTrueAcc) / 2).toFixed(3));

    if (legionAccuracy.shortTotalPoints > 0) {
        if (shortAccuracyScore > legionAccuracy.maxSellScore) legionAccuracy.maxSellScore = shortAccuracyScore;
        else if (shortAccuracyScore < legionAccuracy.minSellScore) legionAccuracy.minSellScore = shortAccuracyScore;
    }

    const finalConsensusAccuracyScore = Number(((longAccuracyScore + shortAccuracyScore) / 2).toFixed(3));

    if (legionAccuracy.longTotalPoints > 0 || legionAccuracy.shortTotalPoints > 0) {
        if (finalConsensusAccuracyScore > legionAccuracy.maxFinalScore) legionAccuracy.maxFinalScore = finalConsensusAccuracyScore;
        else if (finalConsensusAccuracyScore < legionAccuracy.minFinalScore) legionAccuracy.minFinalScore = finalConsensusAccuracyScore;

        if (updateH) {
            legionAccuracy.buyScoreHistory.push(longAccuracyScore);
            if (legionAccuracy.buyScoreHistory.length > 100) legionAccuracy.buyScoreHistory.shift();

            legionAccuracy.sellScoreHistory.push(shortAccuracyScore);
            if (legionAccuracy.sellScoreHistory.length > 100) legionAccuracy.sellScoreHistory.shift();

            legionAccuracy.finalScoreHistory.push(finalConsensusAccuracyScore);
            if (legionAccuracy.finalScoreHistory.length > 100) legionAccuracy.finalScoreHistory.shift();
        }
    }

    const finalScoreArray = legionAccuracy.finalScoreHistory.map((score, i) => ({
        buyScore: legionAccuracy.buyScoreHistory[i],
        sellScore: legionAccuracy.sellScoreHistory[i],
        finalScore : score
    }));

    return {
        buyAccuracyScore : longAccuracyScore,
        minBuyAccuracyScore : legionAccuracy.minBuyScore,
        maxBuyAccuracyScore : legionAccuracy.maxBuyScore,

        sellAccuracyScore : shortAccuracyScore,
        minSellAccuracyScore : legionAccuracy.minSellScore,
        maxSellAccuracyScore : legionAccuracy.maxSellScore,

        finalAccuracyScore : finalConsensusAccuracyScore,
        minFinalAccuracy : legionAccuracy.minFinalScore,
        maxFinalAccuracy : legionAccuracy.maxFinalScore,

        scoreHistories : finalScoreArray
    }
};

export const updateLegionAccuracy = (candle, consensus) => {
    // No candle -> nothing can be settled or timestamped. Returning the
    // consensus as-is keeps the caller well-formed instead of throwing inside
    // the broadcast path (ROADMAP P0-1).
    if (!candle || typeof candle !== 'object') return consensus;

    const currentOpenSimulations = selectAllSims.all();

    let finalObject;

    for (const trade of currentOpenSimulations) {
        const isLong = trade.exitPrice > trade.entryPrice;

        const hitTakeProfit = isLong
            ? Number(candle.high) >= trade.exitPrice
            : Number(candle.low) <= trade.exitPrice;

        const hitStopLoss = isLong
            ? Number(candle.low) <= trade.stopLoss
            : Number(candle.high) >= trade.stopLoss;

        if (hitTakeProfit || hitStopLoss) {
            const outcome = hitTakeProfit ? 1 : 0;

            if (trade.direction === 'BUY') {
                legionAccuracy.longTotalPoints += 100;

                if (outcome === 1) {
                    legionAccuracy.longWin++;
                    legionAccuracy.longPoints += trade.confidence;
                } else {
                    legionAccuracy.longLoss++;
                    legionAccuracy.longPoints += 100 - trade.confidence;
                }
            }
            
            else {
                legionAccuracy.shortTotalPoints += 100;

                if (outcome === 1) {
                    legionAccuracy.shortWin++;
                    legionAccuracy.shortPoints += trade.confidence;
                } else {
                    legionAccuracy.shortLoss++;
                    legionAccuracy.shortPoints += 100 - trade.confidence;
                }
            }

            deleteOpenSim.run(trade.id);
            finalObject = updateAccValues(true);
        }
    }

    if (!finalObject) finalObject = updateAccValues(false);

    insertSimStmt.run(
        candle.timestamp,
        consensus.direction,
        consensus.entryPrice,
        consensus.exitPrice,
        consensus.stopLoss,
        consensus.confidence
    );

    consensus.record = finalObject;

    return consensus;
};

export const updateInfluenceValues = (controllers, influenceList) => {
    const totalWeight = influenceList.reduce((acc, val) => acc + (Number.isFinite(val.weight) ? val.weight : 0), 0);

    // No usable weight -> no influence to distribute. Avoids a 0/0 that would
    // write NaN into every controller's influence field.
    if (!(totalWeight > 0)) return;

    for (const c of controllers.positive.voters) {
        for (const w of influenceList) {
            if (c.id === w.id) {
                c.influence = Number(((w.weight / totalWeight) * 100).toFixed(4))
            }
        }
    }

    for (const c of controllers.negative.voters) {
        for (const w of influenceList) {
            if (c.id === w.id) {
                c.influence = Number(((w.weight / totalWeight) * 100).toFixed(4))
            }
        }
    }
};
