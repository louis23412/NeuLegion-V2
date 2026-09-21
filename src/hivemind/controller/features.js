// HiveMindController component: controller feature extraction and dimension choice
//
// Split out of the monolithic src/hivemind/hiveMindController.js; the method
// bodies are byte-identical. Installed onto HiveMindController.prototype by
// ../internal/mixins.js. The controller keeps only its fields, constructor and
// the public getSignal() in the class body.

import { truncateToDecimals, isValidNumber } from './../utils.js';

export const controllerFeatureMethods = {
    _robustNormalize (data, count = 1, lowerPercentile = 0.05, upperPercentile = 0.95) {
        const series = Array.isArray(data)
            ? data
            : (ArrayBuffer.isView(data) ? Array.from(data) : null);
        if (!series || series.length < 2) return Array(count).fill(0);

        const actualCount = Math.min(count, series.length);
        const valuesToNormalize = series.slice(-actualCount);

        if (!valuesToNormalize.every(isValidNumber)) return Array(actualCount).fill(0);

        const sortedData = [...series].sort((a, b) => a - b);
        const lowerIdx = Math.floor(lowerPercentile * sortedData.length);
        const upperIdx = Math.ceil(upperPercentile * sortedData.length) - 1;
        let min_h = sortedData[lowerIdx];
        let max_h = sortedData[upperIdx];
        
        const recentMin = Math.min(...valuesToNormalize);
        const recentMax = Math.max(...valuesToNormalize);
        let min = Math.min(min_h, recentMin);
        let max = Math.max(max_h, recentMax);
        
        if (max === min) {
            const median = sortedData[Math.floor(sortedData.length / 2)];
            const mad = sortedData.reduce((sum, val) => {
                return sum + Math.abs(val - median);
            }, 0) / sortedData.length;
            
            const scale = mad > 0 ? mad : Number.EPSILON * 1e6;
            min = median - scale;
            max = median + scale;
        }
        
        const range = max - min;
        const epsilon = Number.EPSILON * Math.max(Math.abs(min), Math.abs(max));
        if (range < epsilon) {
            min -= epsilon;
            max += epsilon;
        }
        
        return valuesToNormalize.map(value => {
            const normalized = (value - min) / (max - min);
            return truncateToDecimals(Math.min(1, Math.max(0, normalized)), 4);
        });
    },

    _computeProtoQuality(mem) {
        if (!mem || typeof mem !== 'object') return 0;

        const importance = mem.importance ?? 1.0;
        const size = mem.size ?? 1.0;
        const accessCount = mem.accessCount ?? 1.0;

        // Same TypedArray tolerance as _robustNormalize: prototype vectors are
        // Float32Array internally, so a bare Array.isArray guard would score
        // every prototype's mean/variance as 0.
        const meanArr = Array.isArray(mem.mean) ? mem.mean : (ArrayBuffer.isView(mem.mean) ? mem.mean : []);
        const varArr  = Array.isArray(mem.variance) ? mem.variance : (ArrayBuffer.isView(mem.variance) ? mem.variance : []);

        const avgMean = meanArr.length > 0
            ? meanArr.reduce((sum, val) => sum + (isValidNumber(val) ? val : 0), 0) / meanArr.length
            : 0;

        const avgVar = varArr.length > 0
            ? varArr.reduce((sum, val) => sum + (isValidNumber(val) ? val : 0), 0) / varArr.length
            : 0;

        let logArg = 1 + accessCount + 1e-8;
        if (logArg <= 0) logArg = 1e-8;

        let sizeBase = size + 1;
        if (sizeBase <= 0) sizeBase = 1e-8;

        let meanBase = 1 + avgMean;
        if (meanBase <= 0) meanBase = 1e-8;

        let varBase = 1 + avgVar;
        if (varBase <= 0) varBase = 1e-8;

        const q = importance
            * Math.log(logArg)
            * Math.pow(sizeBase, -1.5)
            * Math.pow(meanBase, 0.8)
            * Math.pow(varBase, -1.2);

        return isValidNumber(q) ? q : 0;
    },

    // Interleave arr1 into arr2 as [a1_0, a2_0, a1_1, a2_1, ...], then append
    // any left-over tail. The previous implementation used `.reduce` + `splice`,
    // which is O(n^2) because every splice shifts the remainder of the growing
    // array; this single pass emits the identical sequence in O(n). This runs
    // once per memory in the tier>1 feature path, so the quadratic behaviour
    // scaled with the square of the hidden size.
    _interleave (arr1, arr2) {
        const n = arr1.length;
        const m = arr2.length;
        const out = [];
        for (let i = 0; i < n; i++) {
            out.push(arr1[i]);
            if (i < m) out.push(arr2[i]);
        }
        for (let i = n; i < m; i++) out.push(arr2[i]);
        return out;
    },

    _extractFeatures (data, childMemories) {
        if (this._tier === 1) {
            const indicators = [
                'rsi',
                'macdDiff',
                'atr',
                'ema100',
                'stochasticDiff',
                'bollingerPercentB',
                'obv',
                'adx',
                'cci',
                'williamsR'
            ];

            const count = Math.max(0, Math.min(this._trainingIndicators, indicators.length));

            const normalized = [];
            for (let i = 0; i < count; i++) {
                const key = indicators[i];
                normalized.push(this._robustNormalize(data[key], this._trainingCandleSize));
            }

            const result = Array.from({ length: this._trainingCandleSize }, (_, i) => {
                const row = [];
                for (let j = 0; j < count; j++) {
                    const value = normalized[j][i];
                    row.push(isValidNumber(value) ? value : 0.5);
                }
                return row;
            });

            return result.flat();
        }

        else {
            const rawInputs = [];
            for (const ctrl of childMemories) {
                for (const mem of ctrl.memories) {
                    rawInputs.push(mem);
                }
            }

            const sortedRawInputs = rawInputs
                .map(mem => ({
                    mem: mem,
                    quality: this._computeProtoQuality(mem)
                }))
                .sort((a, b) => b.quality - a.quality)
                .map(item => item.mem);

            const processedInputs = sortedRawInputs.map((mem) => {
                const normMean = this._robustNormalize(mem.mean, mem.mean.length);
                const normVariance = this._robustNormalize(mem.variance, mem.variance.length);

                return this._interleave(normMean, normVariance);
            });

            const finalInputs = processedInputs.flat().slice(0, this._inputSize)

            if (finalInputs.length < this._inputSize) {
                while (finalInputs.length < this._inputSize) {
                    finalInputs.push(0.5);
                }
            }

            return finalInputs;
        }
    },

    _chooseDimension () {
        const MIN_SIZE = 10;
        const MAX_SIZE = Math.floor(this._cacheSize * 0.25);
        let desiredSize = Math.max(MIN_SIZE, MAX_SIZE);

        if (this._tier > 1) {
            this._inputSize = desiredSize;
            this._trainingCandleSize = 0;
            this._trainingIndicators = 0;

            return;
        }

        const searchRange = 2;
        const maxIndCap = 10;
        const preferMoreIndicators = (this._ensembleSize % 2 === 0);

        let bestMinv = -1;
        let bestDiff = Infinity;
        let bestBalanceDiff = Infinity;
        let bestTarget = desiredSize;
        let bestInd = 1;
        let bestCand = desiredSize;

        for (let offset = -searchRange; offset <= searchRange; offset++) {
            const candidate = desiredSize + offset;
            if (candidate < MIN_SIZE || candidate > MAX_SIZE) continue;

            let localMinv = 1;
            let localBalanceDiff = Infinity;
            let localInd = 1;
            let localCand = candidate;

            for (let i = 2; i <= Math.min(maxIndCap, Math.floor(candidate / 2)); i++) {
                if (candidate % i === 0) {
                    const thisInd = i;
                    const thisCand = candidate / i;
                    const thisMinv = Math.min(thisInd, thisCand);
                    const thisBalanceDiff = Math.abs(thisInd - thisCand);

                    let update = false;
                    if (thisMinv > localMinv) {
                        update = true;
                    } else if (thisMinv === localMinv) {
                        if (thisBalanceDiff < localBalanceDiff) {
                            update = true;
                        } else if (thisBalanceDiff === localBalanceDiff) {
                            if (preferMoreIndicators && thisInd > localInd) {
                                update = true;
                            } else if (!preferMoreIndicators && thisInd < localInd) {
                                update = true;
                            }
                        }
                    }

                    if (update) {
                        localMinv = thisMinv;
                        localBalanceDiff = thisBalanceDiff;
                        localInd = thisInd;
                        localCand = thisCand;
                    }
                }
            }

            const minv = localMinv;
            const currentBalanceDiff = localBalanceDiff;
            const ind = localInd;
            const cand = localCand;
            const currentDiff = Math.abs(offset);

            let update = false;
            if (minv > bestMinv) {
                update = true;
            } else if (minv === bestMinv) {
                if (currentDiff < bestDiff) {
                    update = true;
                } else if (currentDiff === bestDiff) {
                    if (currentBalanceDiff < bestBalanceDiff) {
                        update = true;
                    } else if (currentBalanceDiff === bestBalanceDiff) {
                        if (candidate > bestTarget) {
                            update = true;
                        }
                    }
                }
            }

            if (update) {
                bestMinv = minv;
                bestDiff = currentDiff;
                bestBalanceDiff = currentBalanceDiff;
                bestTarget = candidate;
                bestInd = ind;
                bestCand = cand;
            }
        }

        this._inputSize = bestTarget;
        this._trainingCandleSize = bestCand;
        this._trainingIndicators = bestInd;
    }

};
