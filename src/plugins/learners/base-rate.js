import { CAPABILITIES } from '../../core/contracts/base.js';
import { isLearnerPlugin } from '../../core/contracts/learner.js';

export const BASE_RATE_DEFAULTS = Object.freeze({});

export const baseRateLearner = {
    id: 'base-rate',
    capability: CAPABILITIES.MODEL,
    legacy: false,
    defaults: BASE_RATE_DEFAULTS,

    create(options = {}) {
        let weight = 0;
        let positives = 0;
        return {
            fit: (input, target, sampleWeight = 1) => {
                const t = Number(target);
                const w = Number(sampleWeight);
                if (!Number.isFinite(t) || !Number.isFinite(w) || !(w > 0)) return weight;
                weight += w;
                positives += t * w;
                return weight;
            },
            predict: (input) => {
                const p = weight > 0 ? positives / weight : 0.5;
                return 2 * p - 1;
            },
            diagnostics: () => ({
                n: weight,
                positives,
                p: weight > 0 ? positives / weight : 0.5,
            }),
        };
    },
};

export const isBaseRate = (impl) => isLearnerPlugin(impl) && impl.id === baseRateLearner.id;
