// HiveMind component: transfer
//
// Extracted verbatim from the original monolithic hiveMind.js. This module
// exports a bag of methods that hiveMind.js installs onto HiveMind.prototype
// (see internal/mixins.js), so every method still runs with a HiveMind
// instance as `this` and reads/writes the underscore-prefixed state declared
// in the class body. Splitting by concern keeps each file reviewable; the
// golden suite (test/browser/entries/golden.test.js) pins the numerics.
export const transferMethods = {
    broadcastMemory (inputs, broadcastRatio = 0.025) {
        if (this._ensembleSize < 2) return { memories: [], totalBroadcast: 0 };

        let queryMean = null;
        let queryProjs = null;
        let hasContext = false;

        const useContext = Array.isArray(inputs) && inputs.length === this._inputSize && inputs.every(v => typeof v === 'number' && isFinite(v));

        if (useContext) {
            const inputProjection = Array.from({ length: this._inputSize }, () => new Float32Array(this._hiddenSize));
            for (let i = 0; i < this._inputSize; i++) {
                const scaled = inputs[i] * (1 + this._swarmIntelligenceFactor);
                for (let j = 0; j < this._hiddenSize; j++) inputProjection[i][j] = scaled;
            }
            const currentProtos = this._poolMultiPrototype(inputProjection,
                Math.round(this._rawMaxProtos * 1.8), 3.8);

            if (currentProtos.length > 0) {
                queryMean = this._weightedMean(currentProtos);
                queryProjs = this._computeProjNorms(queryMean);
                hasContext = true;
            }
        }

        const totalEstimate = this._semanticProtos.reduce((sum, arr) => sum + (arr?.length || 0), 0);

        if (totalEstimate === 0) return { memories: [], totalBroadcast: 0 };

        const target = Math.max(4, Math.ceil(totalEstimate * broadcastRatio));

        const candidates = new Set();

        const candidatesPerEnsembleBase = Math.max(12, Math.ceil(target * 5.5 / this._ensembleSize));

        for (let t = 0; t < this._ensembleSize; t++) {
            const sem = this._semanticProtos[t];
            if (!sem || sem.length === 0) continue;

            const prioIdxs = this._priorityIndices[t] || [];
            const numPrio = Math.min(Math.ceil(candidatesPerEnsembleBase * 0.55), prioIdxs.length);
            for (let i = 0; i < numPrio; i++) {
                const idx = prioIdxs[i];
                if (idx >= 0 && idx < sem.length) candidates.add(sem[idx]);
            }

            for (const p of sem) {
                if (p.isCore) candidates.add(p);
            }

            const sampleRate = 0.065 + (hasContext ? 0.03 : 0);
            let numSample = Math.min(Math.ceil(sem.length * sampleRate),
                                   Math.ceil(candidatesPerEnsembleBase * 0.35));
            numSample = Math.max(3, numSample);

            if (sem.length > numSample * 2) {
                const step = Math.max(1, Math.floor(sem.length / numSample));
                for (let i = 0; i < sem.length; i += step) candidates.add(sem[i]);
            } else {
                sem.forEach(p => candidates.add(p));
            }
        }

        if (hasContext && queryMean && queryProjs) {
            const lshExtra = this._getGlobalLSHCandidates(queryMean, queryProjs,
                Math.ceil(target * 3.5));
            lshExtra.forEach(p => candidates.add(p));
        }

        let candidateArray = Array.from(candidates);

        const scored = candidateArray.map(proto => {
            let matchScore = 0.5;
            if (hasContext && queryMean) {
                matchScore = this._kernelSimilarity(
                    { mean: queryMean, variance: new Float32Array(this._hiddenSize).fill(this._maxVariancePerDim * 0.28) },
                    proto
                );
            }
            const util = this._computeProtoUtility(proto);
            return { proto, score: matchScore * 0.71 + util * 0.29 };
        });

        scored.sort((a, b) => b.score - a.score);

        const seenHashes = new Set();
        const selectedProtos = [];

        for (const item of scored) {
            const hash = item.proto.contentHash;
            if (hash && !seenHashes.has(hash)) {
                seenHashes.add(hash);
                selectedProtos.push(item.proto);
                if (selectedProtos.length >= target) break;
            }
        }

        if (selectedProtos.length < Math.min(target, 6) && totalEstimate > 0) {
            const allHighUtil = [];
            for (let t = 0; t < this._ensembleSize; t++) {
                const sem = this._semanticProtos[t];
                if (sem && sem.length) {
                    const sortedLocal = this._sortedByUtilityDesc(sem);
                    allHighUtil.push(...sortedLocal.slice(0, 5));
                }
            }
            this._sortByUtilityDescInPlace(allHighUtil);

            for (const p of allHighUtil) {
                const hash = p.contentHash;
                if (hash && !seenHashes.has(hash)) {
                    seenHashes.add(hash);
                    selectedProtos.push(p);
                    if (selectedProtos.length >= target) break;
                }
            }
        }

        const broadcastMemories = selectedProtos.map(p => ({
            mean: Array.from(p.mean),
            variance: Array.from(p.variance),
            size: p.size,
            accessCount: p.accessCount,
            importance: p.importance || 0,
            isCore: p.isCore,
            protoId: p.protoId,
            contentHash: p.contentHash
        }));

        return {
            memories: broadcastMemories,
            totalBroadcast: broadcastMemories.length,
            compatibility: {
                ensembleSize: this._ensembleSize,
                inputSize: this._inputSize,
                hiddenSize: this._hiddenSize,
                lowDim: this._lowDim,
                numProjections: this._numProjections
            }
        };
    },

    translateMemory (received, currentInputs = null, injectionRatio = 0.025) {
        const currTotalMemories = this._semanticProtos.reduce((acc, arr) => acc + arr.length, 0);
        if (!received || !Array.isArray(received)) {
            return { memoriesInjected: 0, totalMemories: currTotalMemories, injectedRatio: 0 };
        }

        let neutralized = [];

        const compatObj = {
            ensembleSize: this._ensembleSize,
            inputSize: this._inputSize,
            hiddenSize: this._hiddenSize,
            lowDim: this._lowDim,
            numProjections: this._numProjections
        };

        for (const peerHiveMem of received) {
            if (JSON.stringify(peerHiveMem.compatibility) !== JSON.stringify(compatObj)) continue;

            if (Array.isArray(peerHiveMem.memories)) {
                for (const m of peerHiveMem.memories) {
                    if (!m.mean || !m.variance) continue;
                    const mean = new Float32Array(m.mean);
                    const variance = new Float32Array(m.variance);
                    const newProto = this._createNewProto(mean, variance, 1, false);
                    newProto.contentHash = m.contentHash || this._computeContentHash(mean);
                    neutralized.push(newProto);
                }
            }

            if (Array.isArray(peerHiveMem.vaultAccess)) {
                for (const m of peerHiveMem.vaultAccess) {
                    if (!m.mean || !m.variance) continue;
                    const mean = new Float32Array(m.mean);
                    const variance = new Float32Array(m.variance);
                    const newProto = this._createNewProto(mean, variance, 1, false);
                    newProto.contentHash = m.contentHash || this._computeContentHash(newProto.mean);
                    neutralized.push(newProto);
                }
            }
        }

        if (neutralized.length === 0) {
            return { memoriesInjected: 0, totalMemories: currTotalMemories, injectedRatio: 0 };
        }

        const bestByHash = new Map();
        for (const p of neutralized) {
            if (!p.contentHash) p.contentHash = this._computeContentHash(p.mean);
            const existing = bestByHash.get(p.contentHash);
            if (!existing) {
                bestByHash.set(p.contentHash, p);
            } else {
                const utilP = this._computeProtoUtility(p);
                if (utilP > this._computeProtoUtility(existing)) bestByHash.set(p.contentHash, p);
            }
        }
        let candidates = Array.from(bestByHash.values());

        let queryMean = null;
        let queryProjs = null;
        if (currentInputs && Array.isArray(currentInputs) && currentInputs.length === this._inputSize) {
            const proj = Array.from({ length: this._inputSize }, () => new Float32Array(this._hiddenSize));
            for (let i = 0; i < this._inputSize; i++) {
                const scaled = currentInputs[i] * (1 + this._swarmIntelligenceFactor);
                for (let j = 0; j < this._hiddenSize; j++) proj[i][j] = scaled;
            }
            const tempProtos = this._poolMultiPrototype(proj, 8, 3.5);
            if (tempProtos.length > 0) {
                queryMean = this._weightedMean(tempProtos);
                queryProjs = this._computeProjNorms(queryMean);
            }
        }

        const scored = candidates.map(proto => {
            let relevance = 0.5;
            if (queryMean && queryProjs) {
                relevance = this._kernelSimilarity(
                    { mean: queryMean, variance: new Float32Array(this._hiddenSize).fill(this._maxVariancePerDim * 0.25) },
                    proto
                );
            }
            const util = this._computeProtoUtility(proto);
            return { proto, score: 0.65 * relevance + 0.35 * util };
        });

        scored.sort((a, b) => b.score - a.score);
        candidates = scored.map(s => s.proto);

        const avgLen = Math.max(8, currTotalMemories / this._ensembleSize);
        const maxInjectTotal = Math.max(1, Math.round(avgLen * injectionRatio * 0.8));

        const coreCount = Math.max(1, Math.round(maxInjectTotal * 0.4));
        const personalPerMember = Math.round((maxInjectTotal * 0.6) / this._ensembleSize);

        const sharedCores = candidates.slice(0, coreCount).map(base => {
            const noisy = new Float32Array(base.mean);
            for (let j = 0; j < this._hiddenSize; j++) noisy[j] += (Math.random() - 0.5) * 0.012;
            const np = this._createNewProto(noisy, base.variance, 1, false);
            this._reinforceProto(np, 0.8, 0, 0.7);
            this._finalizeSemanticProto(np, null);
            return np;
        });

        const beforeHashes = new Set();
        for (let i = 0; i < this._ensembleSize; i++) {
            this._semanticProtos[i].forEach(p => beforeHashes.add(p.contentHash));
        }

        let totalInjected = 0;

        for (let idx = 0; idx < this._ensembleSize; idx++) {
            const before = this._semanticProtos[idx].length;

            const remaining = candidates.slice(coreCount);
            const affinityScored = remaining.map(p => ({
                proto: p,
                score: this._computeMemberAffinity(p, idx)
            })).sort((a, b) => b.score - a.score);

            const personalProtos = [];
            const selected = [];
            const diversityThresh = 0.62 + 0.15 * (this._specializationScores[idx] ?? 0.5);
            const minBypass = Math.max(2, Math.floor(personalPerMember * 0.35));

            for (let i = 0; i < affinityScored.length && personalProtos.length < personalPerMember; i++) {
                let cand = affinityScored[i].proto;
                if (!cand.projNorms || cand.projNorms.length !== this._numProjections) {
                    cand.projNorms = this._computeProjNorms(cand.mean);
                }

                let maxSim = -1;
                for (const s of selected) maxSim = Math.max(maxSim, this._projSimilarity(cand.projNorms, s.projNorms));
                for (const core of sharedCores) maxSim = Math.max(maxSim, this._projSimilarity(cand.projNorms, core.projNorms));

                if (maxSim < diversityThresh || selected.length < minBypass) {
                    selected.push(cand);

                    const noisy = new Float32Array(cand.mean);
                    const noiseScale = 0.016 * (1.4 - (this._specializationScores[idx] ?? 0.5));
                    for (let j = 0; j < this._hiddenSize; j++) noisy[j] += (Math.random() - 0.5) * noiseScale;

                    const np = this._createNewProto(noisy, cand.variance, 1, false);
                    this._reinforceProto(np, 0.75, 0, 0.6);
                    this._finalizeSemanticProto(np, null);
                    personalProtos.push(np);
                }
            }

            const toInject = [...sharedCores, ...personalProtos];
            if (toInject.length > 0) {
                this._updateSemanticProtos(idx, toInject);
                this._updateSemanticStats(idx);
            }

            totalInjected += Math.max(0, this._semanticProtos[idx].length - before);
        }

        const finalTotal = this._semanticProtos.reduce((acc, arr) => acc + arr.length, 0);

        return {
            memoriesInjected: totalInjected,
            totalMemories: finalTotal,
            injectedRatio: Number(((totalInjected / finalTotal) * 100).toFixed(3)),
            protosPerMember: Number((totalInjected / this._ensembleSize).toFixed(3))
        };
    }

};
