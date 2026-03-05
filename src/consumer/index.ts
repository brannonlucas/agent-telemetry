/**
 * Consumer Module
 *
 * Provides JSONL parsing, trace reconstruction, entity pivoting,
 * and the full agent consumption pipeline.
 */

export { parseContent, parseDirectory, parseFile, parseLine } from "./parser.ts";
export type { ParseDiagnostics, ParsedLine } from "./parser.ts";

export { reconstructTraces } from "./reconstructor.ts";
export type { ReconstructedTrace, SpanNode } from "./reconstructor.ts";

export { buildEntityIndex, getEntityValues, lookupEntity } from "./entities.ts";
export type { EntityIndex } from "./entities.ts";

export {
	classifyTrust,
	escapeControlChars,
	processRecords,
	processTelemetry,
	processTelemetryDir,
} from "./pipeline.ts";
export type {
	CanonicalDiagnosticEntry,
	CanonicalEventEntry,
	PipelineResult,
	TraceSummary,
	TrustClass,
	UncertaintyCode,
	UncertaintyEntry,
	UncertaintySeverity,
} from "./pipeline.ts";
