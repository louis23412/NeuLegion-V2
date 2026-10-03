// HiveMind component: scores
//
// Extracted verbatim from the original monolithic hiveMind.js. This module
// exports a bag of methods that hiveMind.js installs onto HiveMind.prototype
// (see internal/mixins.js), so every method still runs with a HiveMind
// instance as `this` and reads/writes the underscore-prefixed state declared
// in the class body. Splitting by concern keeps each file reviewable; the
// ordinary suites (sanity determinism, controller invariants, walk-forward) pin the behavior.
import { isValidNumber } from '../utils.js';
import { DEFAULT_HOMEOSTASIS_CONFIG, homeostaticScale, updateActivity } from './homeostasis.js';

export const scoreMethods = {
    _computeSpecializationScores (inputs, outputs) {
        if (
            !Array.isArray(inputs) ||
            inputs.length !== this._inputSize ||
            !inputs.every(isValidNumber) ||
            !Array.isArray(outputs) ||
            outputs.length !== this._ensembleSize ||
            !outputs.every(isValidNumber)
        ) {
            return;
        }

        const outputMean = outputs.reduce((sum, v) => sum + v, 0) / outputs.length;
        const outputStd = Math.sqrt(
            outputs.reduce((sum, v) => sum + (v - outputMean) ** 2, 0) / outputs.length
        ) || 1e-6;

        const zScores = outputs.map(out => (out - outputMean) / outputStd);

        this._specializationScores = zScores.map((z, i) => {
            const performance = isValidNumber(this._performanceScores[i]) ? this._performanceScores[i] : 0.5;
            const magnitude = Math.abs(z);
            const bounded = 1 / (1 + Math.exp(-magnitude));
            return bounded * (0.5 + 0.5 * performance);
        });
        this._specWeightCache.length = 0;
    },

    _updatePerformanceScores (linearOutputs, target) {
        this._performanceScores = this._performanceScores.map((score, idx) => {
            const individualProbability = this._sigmoid(linearOutputs[idx]);
            const brierScore = Math.pow(individualProbability - target, 2);
            const performance = 1 - brierScore;
            const newScore = 0.9 * score + 0.1 * (isValidNumber(performance) ? performance : 0);
            
            this._historicalPerformance[idx].push(isValidNumber(newScore) ? newScore : 0);
            if (this._historicalPerformance[idx].length > this._maxPerformanceHistory) {
                this._historicalPerformance[idx].shift();
            }
            
            return isValidNumber(newScore) ? newScore : 0;
        });
    },

    _updateAgreementScores (linearOutputs, finalProbability) {
        this._agreementScores = this._agreementScores.map((score, idx) => {
            const individualProbability = this._sigmoid(linearOutputs[idx]);
            const absDiff = Math.abs(individualProbability - finalProbability);
            let agreement = 1 - absDiff;
            
            const avgHistoricalPerformance = this._historicalPerformance[idx].length > 0
                ? this._historicalPerformance[idx].reduce((sum, val) => sum + val, 0) / this._historicalPerformance[idx].length
                : 0;
            const weightedAgreement = agreement * (0.5 + 0.5 * avgHistoricalPerformance);
            
            const newScore = 0.9 * score + 0.1 * (isValidNumber(weightedAgreement) ? weightedAgreement : 0);
            
            return isValidNumber(newScore) ? newScore : 0;
        });
    },

    _updateTrustScores () {
        const performanceMean = this._performanceScores.reduce((sum, score) => sum + (isValidNumber(score) ? score : 0), 0) / this._ensembleSize || 1;
        const performanceStd = Math.sqrt(
            this._performanceScores.reduce((sum, score) => sum + ((isValidNumber(score) ? score : 0) - performanceMean) ** 2, 0) / this._ensembleSize
        ) || 1;

        this._trustScoresHistory = this._trustScoresHistory.map((history, idx) => {
            const normalizedScore = isValidNumber(this._performanceScores[idx]) && performanceStd > 0
                ? (this._performanceScores[idx] - performanceMean) / performanceStd
                : 0;
            const agreementFactor = isValidNumber(this._agreementScores[idx]) ? this._agreementScores[idx] : 0.5;
            const historicalTrend = this._historicalPerformance[idx].length > 1
                ? (this._historicalPerformance[idx][this._historicalPerformance[idx].length - 1] - this._historicalPerformance[idx][0]) /
                this._historicalPerformance[idx].length
                : 0;
            const specializationBoost = 1 + this._specializationScores[idx] * this._swarmIntelligenceFactor;
            const trustScore = this._sigmoid(normalizedScore * (0.6 + 0.2 * agreementFactor + 0.1 * historicalTrend + 0.1 * specializationBoost));
            history.push(isValidNumber(trustScore) ? trustScore : 0.5);
            if (history.length > this._maxTrustHistory) history.shift();
            return history;
        });
    },

    _adjustPerformanceScores () {
        const trustMomentum = 0.6;
        this._performanceScores = this._performanceScores.map((score, idx) => {
            const recentTrust = this._trustScoresHistory[idx].slice(-5);
            const avgTrust = recentTrust.length > 0
                ? recentTrust.reduce((sum, val) => sum + (isValidNumber(val) ? val : 0), 0) / recentTrust.length
                : 0.5;
            const historicalWeight = this._trustScoresHistory[idx].length / this._maxTrustHistory;
            const specializationFactor = 1 + this._specializationScores[idx] * this._swarmIntelligenceFactor;
            return trustMomentum * (isValidNumber(score) ? score : 0) +
                (1 - trustMomentum) * avgTrust * (0.7 + 0.2 * historicalWeight + 0.1 * specializationFactor);
        });
    },

    _updateEnsembleWeights () {
        this._ensembleWeights = this._trustScoresHistory.map((history, idx) => {
            const recentTrust = history.slice(-5);
            const avgTrust = recentTrust.length > 0
                ? recentTrust.reduce((sum, val) => sum + (isValidNumber(val) ? val : 0), 0) / recentTrust.length
                : 1 / this._ensembleSize;
            const specializationFactor = 1 + this._specializationScores[idx] * this._swarmIntelligenceFactor;
            return avgTrust * (0.8 + 0.2 * specializationFactor);
        });

        this._normalizeEnsembleWeights();
    },

    _normalizeEnsembleWeights () {
        const sum = this._ensembleWeights.reduce((s, w) => s + (isValidNumber(w) && w >= 0 ? w : 0), 0);

        if (sum <= 1e-6) {
            this._ensembleWeights = Array(this._ensembleSize).fill(1 / this._ensembleSize);
            return;
        }

        this._ensembleWeights = this._ensembleWeights.map(w => 
            isValidNumber(w) && w >= 0 ? w / sum : 0
        );

        const finalSum = this._ensembleWeights.reduce((s, w) => s + w, 0);
        if (Math.abs(finalSum - 1) > 1e-6) {
            const maxIndex = this._ensembleWeights.indexOf(Math.max(...this._ensembleWeights));
            this._ensembleWeights[maxIndex] += 1 - finalSum;
        }
    },

    // C2 verdict: the rank-based LR controller had no measurable effect
    // (lab CYCLE-198/200), so rates stay frozen at `_learningRate`. The
    // opt-in homeostatic hook below is preserved (homeostasis.test.js C).
    _updateAdaptiveLearningRates (outputs = null) {
        const min_lr = this._learningRate * 0.5;
        const max_lr = this._learningRate * 1.5;

        this._adaptiveLearningRate = this._adaptiveLearningRate.map((lr, idx) => {
            let newLr = this._learningRate;

            if (this._homeostasisEnabled) {
                const cfg = this._homeostasisConfig || DEFAULT_HOMEOSTASIS_CONFIG;
                const activity = updateActivity(
                    this._activityEma[idx],
                    Array.isArray(outputs) ? outputs[idx] : null,
                    cfg
                );
                this._activityEma[idx] = activity;
                newLr = Math.max(min_lr, Math.min(newLr * homeostaticScale(activity, cfg), max_lr));
            }

            return newLr;
        });
    },

    _updateMetrics (inputs, outputs, target, prob) {
        this._updatePerformanceScores(outputs, target);
        this._updateAgreementScores(outputs, prob);
        this._computeSpecializationScores(inputs, outputs);
        this._updateTrustScores();
        this._adjustPerformanceScores();
        this._updateEnsembleWeights();
        this._updateAdaptiveLearningRates(outputs);
    }

};
