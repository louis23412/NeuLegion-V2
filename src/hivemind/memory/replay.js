// HiveMind component: replay
//
// Extracted verbatim from the original monolithic hiveMind.js. This module
// exports a bag of methods that hiveMind.js installs onto HiveMind.prototype
// (see internal/mixins.js), so every method still runs with a HiveMind
// instance as `this` and reads/writes the underscore-prefixed state declared
// in the class body. Splitting by concern keeps each file reviewable; the
// golden suite (test/browser/entries/golden.test.js) pins the numerics.
export const replayMethods = {
    _replayOldMemory (transformerIdx) {
        const attMem = this._attentionMemory[transformerIdx];

        const minMemLengthForReplay = Math.max(8, Math.round(this._contextWindow * 0.08));
        if (attMem.length < minMemLengthForReplay) return;

        const perf = this._performanceScores[transformerIdx] ?? 0.5;
        const stagnationFactor = this._isStagnating(transformerIdx) ? 1.2 : 1.0;
        const dropBoost = this._detectSuddenDrop(transformerIdx);
        let totalBoost = stagnationFactor * Math.min(dropBoost, 1.5) * (1 + 0.5 * (1 - perf));

        const avgProtoVar = this._getAvgProtoVariance(transformerIdx);
        const lowProtoVariance = avgProtoVar < this._maxVariancePerDim * 0.12;
        if (lowProtoVariance) {
            totalBoost *= 1.2;
        }

        let numSamples = Math.round(this._replaySamples * (1 + 0.5 * (1 - perf)) * totalBoost);
        const minSamples = Math.max(4, Math.round(this._baseProtoCapacity * 0.166));
        numSamples = Math.max(numSamples, minSamples);

        const sampledProtos = [];
        const divisor = Math.max(numSamples + 4, Math.round(numSamples * 1.5));
        const step = Math.max(1, Math.floor(attMem.length / divisor));

        const agreement = this._agreementScores[transformerIdx] ?? 0.5;
        const overconfidence = perf * agreement;
        const forgetPressure = (1 - perf) * 0.8 + (1 - agreement) * 0.2;
        let effectivePressure = forgetPressure + 0.3 * overconfidence;

        const maxGenerated = Math.round(this._baseProtoCapacity * (1.5 + 0.5 * effectivePressure + 0.5 * totalBoost) * this._protoCapacityFactor);

        for (let i = 1; i <= numSamples; i++) {
            const idx = attMem.length - i * step - 1;
            if (idx < 0) break;
            const entry = attMem[idx];
            if (!entry || entry.protos.length === 0) continue;

            for (const p of entry.protos) {
                if (sampledProtos.length >= maxGenerated) break;

                const newMean = new Float32Array(p.mean);
                const newVariance = new Float32Array(p.variance);
                for (let j = 0; j < this._hiddenSize; j++) newVariance[j] = Math.min(newVariance[j], this._maxVariancePerDim);

                const newProto = this._createNewProto(newMean, newVariance, p.size * this._replaySizeScale, false);
                this._reinforceProto(newProto, this._baseAccessInc * totalBoost * 0.8, this._replaySizeScale * p.size * totalBoost, this._baseImpInc * totalBoost * 0.6, totalBoost);
                this._finalizeSemanticProto(newProto, null);
                sampledProtos.push(newProto);
            }
        }

        const coreEp = this._coreEpisodic[transformerIdx];
        if (coreEp.length > 0) {
            let coreNumSamples = Math.round(numSamples * 1.2 * totalBoost);
            const minCoreSamples = Math.round(this._coreMaxProtos * 0.2);
            coreNumSamples = Math.max(coreNumSamples, minCoreSamples);

            let noiseFactor = 0.15 + 0.3 * (1 - perf) * totalBoost;
            if (lowProtoVariance) noiseFactor += 0.5;

            for (let i = 0; i < coreNumSamples; i++) {
                if (sampledProtos.length >= maxGenerated) break;

                const entry = coreEp[Math.floor(Math.random() * coreEp.length)];
                if (!entry || entry.protos.length === 0) continue;

                const p = entry.protos[Math.floor(Math.random() * entry.protos.length)];

                const newMean = new Float32Array(this._hiddenSize);
                const newVariance = new Float32Array(this._hiddenSize);

                for (let j = 0; j < this._hiddenSize; j++) {
                    const std = Math.sqrt(Math.max(p.variance[j], 1e-6)) * noiseFactor;
                    newMean[j] = this._randomNormal(p.mean[j], std);
                    newVariance[j] = Math.min(p.variance[j] * (1 + 0.2 * noiseFactor), this._maxVariancePerDim);
                }

                const newProto = this._createNewProto(newMean, newVariance, p.size * this._replaySizeScale, true);
                this._reinforceProto(newProto, this._baseAccessInc * totalBoost, this._replaySizeScale * p.size * totalBoost * 1.2, this._baseImpInc * totalBoost * 1.2, totalBoost * this._coreBoostMultiplier);
                this._finalizeSemanticProto(newProto, null);
                sampledProtos.push(newProto);
            }
        }

        if (dropBoost > 1.5) {
            const faithfulNum = Math.round(this._replaySamples * 0.5 * Math.min(dropBoost, 2));
            const faithStep = Math.max(1, Math.floor(attMem.length / (faithfulNum + 5)));

            for (let i = 1; i <= faithfulNum; i++) {
                const idx = attMem.length - i * faithStep - 1;
                if (idx < 0) break;
                const entry = attMem[idx];
                if (!entry || entry.protos.length === 0) continue;

                for (const p of entry.protos) {
                    if (sampledProtos.length >= maxGenerated) break;

                    const newMean = new Float32Array(p.mean);
                    const newProto = this._createNewProto(newMean, new Float32Array(p.variance), p.size * this._replaySizeScale * 1.5, p.isCore);
                    this._reinforceProto(newProto, this._baseAccessInc * totalBoost * 1.5, this._replaySizeScale * p.size * totalBoost, this._baseImpInc * totalBoost * 1.2, totalBoost);
                    this._finalizeSemanticProto(newProto, null);
                    sampledProtos.push(newProto);
                }
            }

            if (coreEp.length > 0) {
                const coreFaithNum = Math.round(faithfulNum * 1.2);
                for (let i = 0; i < coreFaithNum; i++) {
                    if (sampledProtos.length >= maxGenerated) break;

                    const entry = coreEp[Math.floor(Math.random() * coreEp.length)];
                    if (!entry || entry.protos.length === 0) continue;
                    const p = entry.protos[Math.floor(Math.random() * entry.protos.length)];

                    const newMean = new Float32Array(p.mean);
                    const newProto = this._createNewProto(newMean, new Float32Array(p.variance), p.size * this._replaySizeScale * 1.5, p.isCore);
                    this._reinforceProto(newProto, this._baseAccessInc * totalBoost * 1.5, this._replaySizeScale * p.size * totalBoost, this._baseImpInc * totalBoost * 1.2, totalBoost * this._coreBoostMultiplier);
                    this._finalizeSemanticProto(newProto, null);
                    sampledProtos.push(newProto);
                }
            }
        }

        if (sampledProtos.length > 0) {
            const effectiveMax = Math.round(this._effectiveSemanticMax * this._tempOverloadFactor);
            if (sampledProtos.length > effectiveMax) {
                this._sortByUtilityDescInPlace(sampledProtos);
                sampledProtos.length = effectiveMax;
            }
            this._updateSemanticProtos(transformerIdx, sampledProtos);
            this._updateSemanticStats(transformerIdx);
        }
    },

    _generativeReplay (transformerIdx) {
        const sem = this._semanticProtos[transformerIdx];
        if (sem.length === 0) return;

        const pcf = this._protoCapacityFactor;
        const perf = this._performanceScores[transformerIdx] ?? 0.5;
        const agreement = this._agreementScores[transformerIdx] ?? 0.5;
        const overconfidence = perf * agreement;
        const forgetPressure = (1 - perf) * 0.8 + (1 - agreement) * 0.2;
        let effectivePressure = forgetPressure + 0.3 * overconfidence;

        const stagnation = this._isStagnating(transformerIdx);
        const dropBoost = this._detectSuddenDrop(transformerIdx);
        let totalBoost = stagnation ? 1.3 : 1.0 * Math.min(dropBoost, 1.5) * (1 + 0.5 * (1 - perf));
        let extraNoiseStag = stagnation ? 0.5 : 0.0;

        const avgProtoVar = this._getAvgProtoVariance(transformerIdx);
        const lowProtoVariance = avgProtoVar < this._maxVariancePerDim * 0.12;
        if (lowProtoVariance) {
            totalBoost *= 1.2;
            extraNoiseStag += 0.8;
            effectivePressure += 0.5;
        }

        const maxGenerated = Math.round(this._baseProtoCapacity * (1.8 + 0.8 * effectivePressure + 0.5 * totalBoost) * this._protoCapacityFactor);
            
        const generatedProtos = [];

        const cores = sem.filter(p => p.isCore);
        if (cores.length > 0) {
            const coreReplayPressure = effectivePressure + (1 - perf) * 0.5;
            const numCoreSamples = Math.round((this._coreMaxProtos / 4 + this._coreMaxProtos * coreReplayPressure) * totalBoost * 0.8);
            let coreNoiseFactor = 0.10 + 0.25 * effectivePressure + extraNoiseStag * 0.5;
            if (lowProtoVariance) coreNoiseFactor += 0.6;

            for (let s = 0; s < numCoreSamples; s++) {
                if (generatedProtos.length >= maxGenerated) break;

                const coreP = cores[Math.floor(Math.random() * cores.length)];
                const newMean = new Float32Array(this._hiddenSize);
                for (let j = 0; j < this._hiddenSize; j++) {
                    const std = Math.sqrt(Math.max(coreP.variance[j], 1e-6)) * coreNoiseFactor;
                    newMean[j] = this._randomNormal(coreP.mean[j], std);
                }
                const newVariance = new Float32Array(this._hiddenSize);
                for (let j = 0; j < this._hiddenSize; j++) {
                    newVariance[j] = Math.min(Math.max(coreP.variance[j] * (1 + 0.2 * coreNoiseFactor), 1e-6), this._maxVariancePerDim);
                }

                const newProto = this._createNewProto(newMean, newVariance, coreP.size * this._replaySizeScale * 2, false);
                this._reinforceProto(newProto, this._baseAccessInc * totalBoost * 0.8, this._replaySizeScale * coreP.size * totalBoost, this._baseImpInc * totalBoost * 0.8, totalBoost);
                this._finalizeSemanticProto(newProto, null);
                generatedProtos.push(newProto);
            }
        }

        if (lowProtoVariance || stagnation) {
            const numDiversity = Math.round(this._baseProtoCapacity * (1.5 + 3 * effectivePressure) * totalBoost * 0.7);
            const highVar = this._maxVariancePerDim * (0.75 + 0.25 * Math.random());

            for (let s = 0; s < numDiversity; s++) {
                if (generatedProtos.length >= maxGenerated) break;

                const baseP = cores.length > 0 && Math.random() < 0.8 
                    ? cores[Math.floor(Math.random() * cores.length)] 
                    : (sem.length > 0 ? sem[Math.floor(Math.random() * sem.length)] : null);

                const newMean = new Float32Array(this._hiddenSize);
                const divNoise = 2.0 + 5.0 * effectivePressure + (lowProtoVariance ? 5.0 : 0.0);

                if (baseP) {
                    for (let j = 0; j < this._hiddenSize; j++) {
                        const std = Math.sqrt(Math.max(baseP.variance[j], 1e-6)) * divNoise;
                        newMean[j] = this._randomNormal(baseP.mean[j], std);
                    }
                } else {
                    for (let j = 0; j < this._hiddenSize; j++) {
                        newMean[j] = this._randomNormal(0, divNoise);
                    }
                }

                const newVariance = new Float32Array(this._hiddenSize).fill(highVar);

                const newProto = this._createNewProto(newMean, newVariance, (baseP ? baseP.size : 5) * this._replaySizeScale * 1.5, false);
                this._reinforceProto(newProto, this._baseAccessInc * totalBoost * 0.4, this._replaySizeScale * (baseP ? baseP.size : 5) * totalBoost, this._baseImpInc * totalBoost * 0.6, totalBoost);
                this._finalizeSemanticProto(newProto, null);
                generatedProtos.push(newProto);
            }
        }

        const baseNum = Math.round((this._longTermMaxProtos * 0.6 + this._semanticMaxProtos / 5 * effectivePressure) * totalBoost);
        let candidates = [];
        if (baseNum > 0) {
            const enriched = sem.map(p => ({
                proto: p,
                access: p.accessCount / (p.size + 1),
                utility: this._computeProtoUtility(p)
            }));

            enriched.sort((a, b) => a.access - b.access || b.utility - a.utility);

            const numCandidates = Math.min(Math.round(this._baseProtoCapacity * 5 * (1 + effectivePressure)), enriched.length);
            candidates = enriched.slice(0, numCandidates);

            const noiseFactor = 0.8 + 1.2 * effectivePressure + extraNoiseStag * 0.8;
            const samplesPerProto = Math.round((2 + 4 * effectivePressure) * pcf * 0.6);

            let generatedCount = 0;
            for (const item of candidates) {
                if (generatedCount >= baseNum * samplesPerProto) break;
                const p = item.proto;

                for (let s = 0; s < samplesPerProto && generatedCount < baseNum * samplesPerProto; s++) {
                    if (generatedProtos.length >= maxGenerated) break;

                    const newMean = new Float32Array(this._hiddenSize);
                    for (let j = 0; j < this._hiddenSize; j++) {
                        const std = Math.sqrt(Math.max(p.variance[j], 1e-6)) * noiseFactor;
                        newMean[j] = this._randomNormal(p.mean[j], std);
                    }

                    const newVariance = new Float32Array(this._hiddenSize);
                    for (let j = 0; j < this._hiddenSize; j++) {
                        newVariance[j] = Math.min(Math.max(p.variance[j] * (1 + 0.4 * noiseFactor), 1e-6), this._maxVariancePerDim);
                    }

                    const newProto = this._createNewProto(newMean, newVariance, p.size * this._replaySizeScale * 1.5, false);
                    this._reinforceProto(newProto, this._baseAccessInc * totalBoost * 0.4, this._replaySizeScale * p.size * totalBoost, this._baseImpInc * totalBoost * 0.6, totalBoost);
                    this._finalizeSemanticProto(newProto, null);
                    generatedProtos.push(newProto);
                    generatedCount++;
                }
            }
        }

        const numInterp = Math.round(baseNum * 0.8 * (1 + 0.8 * effectivePressure) * totalBoost);
        if (numInterp > 0 && candidates.length > 1) {
            const shuffled = candidates.slice();
            for (let i = shuffled.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }

            let interpCount = 0;
            for (let c = 0; c + 1 < shuffled.length && interpCount < numInterp; c += 2) {
                if (generatedProtos.length >= maxGenerated) break;

                const p1 = shuffled[c].proto;
                const p2 = shuffled[c + 1].proto;

                let alpha = 0.25 + Math.random() * 0.5;
                const extrapProb = stagnation ? 0.6 : 0.3;
                if (Math.random() < extrapProb) {
                    alpha = Math.random() < 0.5 ? -0.2 + Math.random() * 0.4 : 1.0 + Math.random() * 0.4;
                }

                const newMean = new Float32Array(this._hiddenSize);
                const newVariance = new Float32Array(this._hiddenSize);
                for (let j = 0; j < this._hiddenSize; j++) {
                    newMean[j] = alpha * p1.mean[j] + (1 - alpha) * p2.mean[j];
                    const diff = p1.mean[j] - p2.mean[j];
                    newVariance[j] = Math.max(p1.variance[j], p2.variance[j]) + alpha * (1 - alpha) * diff * diff * 1.5;
                    if (alpha < 0 || alpha > 1) {
                        newVariance[j] += Math.abs(alpha - 0.5) * 1 * diff * diff * 2.0;
                    }
                    newVariance[j] = Math.min(Math.max(newVariance[j], 1e-6), this._maxVariancePerDim);
                }

                const newProto = this._createNewProto(newMean, newVariance, (p1.size + p2.size) / 2 * this._replaySizeScale * 1.5, false);
                this._reinforceProto(newProto, this._baseAccessInc * totalBoost * 0.4, this._replaySizeScale * ((p1.size + p2.size) / 2) * totalBoost, this._baseImpInc * totalBoost * 0.6, totalBoost);
                this._finalizeSemanticProto(newProto, null);
                generatedProtos.push(newProto);
                interpCount++;
            }
        }

        const numCrossover = Math.round(baseNum * (0.4 + 0.6 * effectivePressure) * totalBoost);
        if (numCrossover > 0 && candidates.length > 1) {
            const shuffled = candidates.slice();
            for (let i = shuffled.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }

            let crossoverCount = 0;
            for (let c = 0; c + 1 < shuffled.length && crossoverCount < numCrossover; c += 2) {
                if (generatedProtos.length >= maxGenerated) break;

                const p1 = shuffled[c].proto;
                const p2 = shuffled[c + 1].proto;

                const newMean = new Float32Array(this._hiddenSize);
                for (let j = 0; j < this._hiddenSize; j++) {
                    newMean[j] = Math.random() < 0.5 ? p1.mean[j] : p2.mean[j];
                }

                const mutationNoise = (0.2 + 0.4 * effectivePressure + extraNoiseStag) * 0.6;
                for (let j = 0; j < this._hiddenSize; j++) {
                    newMean[j] += this._randomNormal(0, mutationNoise);
                }

                const newVariance = new Float32Array(this._hiddenSize);
                for (let j = 0; j < this._hiddenSize; j++) {
                    newVariance[j] = Math.max(p1.variance[j], p2.variance[j]) * (1 + 0.3 * effectivePressure);
                    newVariance[j] = Math.min(newVariance[j], this._maxVariancePerDim);
                }

                const newProto = this._createNewProto(newMean, newVariance, (p1.size + p2.size) / 2 * this._replaySizeScale * 1.5, false);
                this._reinforceProto(newProto, this._baseAccessInc * totalBoost * 0.4, this._replaySizeScale * ((p1.size + p2.size) / 2) * totalBoost, this._baseImpInc * totalBoost * 0.6, totalBoost);
                this._finalizeSemanticProto(newProto, null);
                generatedProtos.push(newProto);
                crossoverCount++;
            }
        }

        const minClusterSize = Math.max(3, Math.round(4 * this._protoCapacityFactor));
        const mixPressure = effectivePressure + (stagnation ? 0.5 : 0) + (dropBoost - 1) * 0.5;
        if (mixPressure > 0.2 && sem.length >= minClusterSize) {
            const numMixSamples = Math.round(this._baseProtoCapacity * (2 + 4 * mixPressure) * totalBoost * 0.8);
            for (let s = 0; s < numMixSamples; s++) {
                if (generatedProtos.length >= maxGenerated) break;

                let m = Math.round((minClusterSize + Math.random() * minClusterSize) * this._protoCapacityFactor * 0.8);
                if (stagnation) m += Math.round(1 * pcf);
                m = Math.max(minClusterSize, m);
                if (sem.length < m) continue;

                const shuffled = sem.slice();
                for (let i = shuffled.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
                }
                const selected = shuffled.slice(0, m);

                const alphas = this._sampleDirichlet(m);

                const newMean = new Float32Array(this._hiddenSize);
                const newVariance = new Float32Array(this._hiddenSize);

                let totalSelectedSize = 0;
                for (const pp of selected) totalSelectedSize += pp.size;

                for (let k = 0; k < m; k++) {
                    const alpha = alphas[k];
                    const pp = selected[k];
                    for (let j = 0; j < this._hiddenSize; j++) {
                        newMean[j] += alpha * pp.mean[j];
                        const diff = pp.mean[j] - newMean[j];
                        newVariance[j] += alpha * (pp.variance[j] + diff * diff * 1.0);
                    }
                }

                const mixNoise = (0.3 + 0.6 * effectivePressure + extraNoiseStag * 1) * 2.0;
                for (let j = 0; j < this._hiddenSize; j++) {
                    newVariance[j] += mixNoise;
                    newVariance[j] = Math.min(newVariance[j], this._maxVariancePerDim);
                }

                const newProto = this._createNewProto(newMean, newVariance, totalSelectedSize / m * this._replaySizeScale * 1.5, false);
                this._reinforceProto(newProto, this._baseAccessInc * totalBoost * 0.4, this._replaySizeScale * (totalSelectedSize / m) * totalBoost, this._baseImpInc * totalBoost * 0.6, totalBoost);
                this._finalizeSemanticProto(newProto, null);
                generatedProtos.push(newProto);
            }
        }

        const needExploration = stagnation || perf < 0.7;
        if (needExploration) {
            const numRandom = Math.round(this._baseProtoCapacity * (0.3 + 0.8 * (1 - perf)) * totalBoost);
            const randomVar = Math.min(this._maxVariancePerDim, 4.0 + 8.0 * (1 - perf));
            for (let s = 0; s < numRandom; s++) {
                if (generatedProtos.length >= maxGenerated) break;

                const newMean = new Float32Array(this._hiddenSize);
                for (let j = 0; j < this._hiddenSize; j++) {
                    newMean[j] = this._randomNormal(0, 1.0);
                }
                const newVariance = new Float32Array(this._hiddenSize).fill(randomVar);

                const newProto = this._createNewProto(newMean, newVariance, 5 * this._replaySizeScale, false);
                this._reinforceProto(newProto, this._baseAccessInc * totalBoost * 0.4, this._replaySizeScale * 5 * totalBoost, this._baseImpInc * totalBoost * 0.6, totalBoost);
                this._finalizeSemanticProto(newProto, null);
                generatedProtos.push(newProto);
            }
        }

        if (generatedProtos.length > 0) {
            const effectiveMax = Math.round(this._effectiveSemanticMax * this._tempOverloadFactor);
            if (generatedProtos.length > effectiveMax) {
                this._sortByUtilityDescInPlace(generatedProtos);
                generatedProtos.length = effectiveMax;
            }
            this._updateSemanticProtos(transformerIdx, generatedProtos);
            this._updateSemanticStats(transformerIdx);
        }
    },

    _poolMultiPrototype (entry, maxAdditionalProtos, thresholdFactor) {
        if (
            !Array.isArray(entry) ||
            entry.length === 0 ||
            !entry[0] ||
            !Array.isArray(entry[0]) ||
            entry[0].length !== this._hiddenSize
        ) {
            return [];
        }
        const seqLen = entry.length;
        const hidden = this._hiddenSize;

        const total = new Float32Array(hidden);
        for (let i = 0; i < seqLen; i++) {
            const row = entry[i];
            if (row.length !== hidden) continue;
            for (let j = 0; j < hidden; j++) total[j] = total[j] + row[j];
        }
        const globalMean = this._fastVectorScale(total, 1 / seqLen);

        const globalVariance = new Float32Array(hidden);
        for (let i = 0; i < seqLen; i++) {
            const row = entry[i];
            for (let j = 0; j < hidden; j++) {
                // float32-rounded difference, matching the Float32Array
                // round-trip the old `_vectorSub(...)` allocation performed.
                const diff = Math.fround(row[j] - globalMean[j]);
                globalVariance[j] += diff * diff;
            }
        }
        for (let j = 0; j < hidden; j++) globalVariance[j] /= seqLen;

        let avgVarSum = 0;
        for (let j = 0; j < hidden; j++) avgVarSum += globalVariance[j];
        const avgVar = avgVarSum / hidden;
        const thresholdSq = avgVar * hidden * thresholdFactor;

        const protos = [];

        const initialMean = new Float32Array(globalMean);
        const initialVariance = new Float32Array(hidden);
        for (let j = 0; j < hidden; j++) {
            initialVariance[j] = Math.max(globalVariance[j], 1e-6);
        }

        const initialProto = this._createNewProto(initialMean, initialVariance, seqLen, false);
        this._finalizeSemanticProto(initialProto, null);
        protos.push(initialProto);

        if (seqLen <= 1) {
            initialProto.projNorms = this._computeProjNorms(initialMean);
            return protos;
        }

        const deltaBuf = new Float32Array(hidden);
        for (let i = 0; i < seqLen; i++) {
            const point = entry[i];
            let minDistSq = Infinity;
            let bestProtoIdx = 0;
            // Squared distance to each pooled proto, computed without
            // allocating a diff vector per candidate (the old `_vectorSub` here
            // was the single largest source of short-lived Float32Arrays in
            // the engine). The per-component float32 rounding is preserved.
            for (let c = 0; c < protos.length; c++) {
                const meanC = protos[c].mean;
                let d = 0;
                for (let j = 0; j < hidden; j++) {
                    const diff = Math.fround(point[j] - meanC[j]);
                    d += diff * diff;
                }
                if (d < minDistSq) {
                    minDistSq = d;
                    bestProtoIdx = c;
                }
            }

            if (protos.length < 1 + maxAdditionalProtos && minDistSq > thresholdSq) {
                const newMean = new Float32Array(point);
                const newVariance = new Float32Array(hidden).fill(1e-6);
                const newProto = this._createNewProto(newMean, newVariance, 1, false);
                this._finalizeSemanticProto(newProto, null);
                protos.push(newProto);
            } else {
                const proto = protos[bestProtoIdx];
                proto.size++;
                const oldMean = new Float32Array(proto.mean);
                const delta = deltaBuf;
                for (let j = 0; j < hidden; j++) delta[j] = point[j] - oldMean[j];
                const size = proto.size;
                this._fastVectorAdd(proto.mean, delta, 1, 1 / size, proto.mean);
                for (let j = 0; j < hidden; j++) {
                    const newDiff = Math.fround(point[j] - proto.mean[j]);
                    proto.variance[j] += delta[j] * newDiff;
                }
                this._invalidateProjCache(proto.mean);
                proto.contentHash = this._computeContentHash(proto.mean);
                this._reinforceProto(proto, this._baseAccessInc, 0, this._baseImpInc * 0.4);
            }
        }

        for (const proto of protos) {
            if (!proto.projNorms) {
                proto.projNorms = this._computeProjNorms(proto.mean);
            }
            if (proto.size > 1) {
                for (let j = 0; j < hidden; j++) {
                    proto.variance[j] /= (proto.size - 1);
                    proto.variance[j] = Math.max(proto.variance[j], 1e-6);
                }
            }
        }
        return protos;
    }

};
