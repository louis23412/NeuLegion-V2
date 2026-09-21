// NeuLegion legion component: persist legion state to SQLite
//
// Split out of the original monolithic src/mainController.js; the bodies are
// byte-identical apart from the shared mutable state being read/written as
// properties of the `state` holder (see ./state.js). src/mainController.js is
// now just the entry point that runs ./legion/runner.js.

import { state } from './state.js';
import { legionAccuracy } from './accuracy.js';
import { db } from './database.js';
import { updateControllerStmt, upsertCounterStmt, upsertAccValue } from './statements.js';
import { finiteOr } from './sanitize.js';

export const saveLegionState = () => {
    db.transaction(() => {
        const controllers = state.structureMap.flat(3);

        for (const ctrl of controllers) {
            updateControllerStmt.run(
                finiteOr(ctrl.signalSpeed, 0),
                finiteOr(ctrl.memConnections, 0),
                finiteOr(ctrl.childConnections, 0),
                JSON.stringify(ctrl.lastSignal ?? {}),
                JSON.stringify(Array.isArray(ctrl.signalHistory) ? ctrl.signalHistory : []),
                JSON.stringify(Array.isArray(ctrl.probHistory) ? ctrl.probHistory : []),
                JSON.stringify(Array.isArray(ctrl.scoreHistory) ? ctrl.scoreHistory : []),
                finiteOr(ctrl.lifetimeMinScore, 100),
                finiteOr(ctrl.lifetimeMaxScore, 0),
                finiteOr(ctrl.lifetimeMinProb, 100),
                finiteOr(ctrl.lifetimeMaxProb, 0),
                finiteOr(ctrl.tier, 1),
                ctrl.group,
                ctrl.section,
                ctrl.layer,
                ctrl.id
            );
        }

        upsertCounterStmt.run(state.candleCounter);

        upsertAccValue.run('long_win', JSON.stringify(legionAccuracy.longWin));
        upsertAccValue.run('long_loss', JSON.stringify(legionAccuracy.longLoss));
        upsertAccValue.run('long_points', JSON.stringify(legionAccuracy.longPoints));
        upsertAccValue.run('long_total_points', JSON.stringify(legionAccuracy.longTotalPoints));

        upsertAccValue.run('short_win', JSON.stringify(legionAccuracy.shortWin));
        upsertAccValue.run('short_loss', JSON.stringify(legionAccuracy.shortLoss));
        upsertAccValue.run('short_points', JSON.stringify(legionAccuracy.shortPoints));
        upsertAccValue.run('short_total_points', JSON.stringify(legionAccuracy.shortTotalPoints));

        upsertAccValue.run('max_buy_score', JSON.stringify(legionAccuracy.maxBuyScore));
        upsertAccValue.run('max_sell_score', JSON.stringify(legionAccuracy.maxSellScore));
        upsertAccValue.run('max_final_score', JSON.stringify(legionAccuracy.maxFinalScore));

        upsertAccValue.run('min_buy_score', JSON.stringify(legionAccuracy.minBuyScore));
        upsertAccValue.run('min_sell_score', JSON.stringify(legionAccuracy.minSellScore));
        upsertAccValue.run('min_final_score', JSON.stringify(legionAccuracy.minFinalScore));

        upsertAccValue.run('buy_score_history', JSON.stringify(legionAccuracy.buyScoreHistory));
        upsertAccValue.run('sell_score_history', JSON.stringify(legionAccuracy.sellScoreHistory));
        upsertAccValue.run('final_score_history', JSON.stringify(legionAccuracy.finalScoreHistory));
    })();
};
