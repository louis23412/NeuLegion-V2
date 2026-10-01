// A/B CLI driver — candle/funding I/O, runAnalysis, replicateAnalysis, usage, main.
//
// Round-95 foundations split: the implementation lives in src/analyze/cli/ (four
// parts); this file carries the exact registered contract so every importer
// keeps working.
export { readCloses, readCandles, resolveSymbolFiles, probesPerFold, auditBlock } from './cli/io.js';
export { makeNodeFoldDispatcher, runSleeveAnalysis, runAnalysis } from './cli/run.js';
export { replicateAnalysis, ANALYZE_USAGE, analyzeMain } from './cli/main.js';
