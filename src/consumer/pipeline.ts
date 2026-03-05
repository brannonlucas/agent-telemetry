/**
 * Consumer Pipeline (Section 17.2)
 *
 * Six-stage pipeline: parse → validate → normalize → reconstruct → uncertainty → summary
 *
 * Produces a canonical trace summary suitable for agent consumption.
 */

import {
	DEFAULT_FIELD_LIMIT,
	DETAILS_KEY_LIMIT,
	DETAILS_VALUE_LIMIT,
	ENTITY_KEY_LIMIT,
	ENTITY_VALUE_LIMIT,
	NEVER_TRUNCATE,
	getFieldLimit,
} from "../limits.ts";
import { truncateField } from "../truncate.ts";
import { buildEntityIndex } from "./entities.ts";
import {
	type ParseDiagnostics,
	type ParsedLine,
	parseContent,
	parseDirectory,
	parseFile,
} from "./parser.ts";
import { type ReconstructedTrace, reconstructTraces } from "./reconstructor.ts";

// ============================================================================
// Trust Classification (Section 17.5)
// ============================================================================

export type TrustClass = "system_asserted" | "untrusted_input" | "derived" | "unknown";

/** Default trust classification for known fields. */
const TRUST_MAP: Record<string, TrustClass> = {
	trace_id: "system_asserted",
	span_id: "system_asserted",
	parent_span_id: "system_asserted",
	timestamp: "system_asserted",
	record_type: "system_asserted",
	spec_version: "system_asserted",
	kind: "system_asserted",
	method: "system_asserted",
	status_code: "system_asserted",
	duration_ms: "system_asserted",
	outcome: "derived",
	path: "untrusted_input",
	route: "untrusted_input",
	error_name: "untrusted_input",
	entities: "untrusted_input",
	service: "untrusted_input",
	operation: "untrusted_input",
	provider: "untrusted_input",
	model: "untrusted_input",
	task_name: "untrusted_input",
	task_id: "untrusted_input",
	queue: "untrusted_input",
	attempt: "system_asserted",
	code: "system_asserted",
	message: "untrusted_input",
	level: "system_asserted",
	details: "untrusted_input",
};

export function classifyTrust(field: string): TrustClass {
	return TRUST_MAP[field] ?? "unknown";
}

// ============================================================================
// Uncertainty Model (Section 17.4)
// ============================================================================

export type UncertaintySeverity = "info" | "warn" | "error";

export interface UncertaintyEntry {
	code: string;
	severity: UncertaintySeverity;
	count: number;
	message: string;
}

/** Reserved uncertainty codes. */
export type UncertaintyCode =
	| "malformed_line_skipped"
	| "missing_parent_span"
	| "dropped_oversize_record"
	| "writer_fallback_active"
	| "projection_lossy_mapping"
	| "unknown_kind_ignored";

const UNCERTAINTY_SEVERITY: Record<UncertaintyCode, UncertaintySeverity> = {
	malformed_line_skipped: "warn",
	missing_parent_span: "warn",
	dropped_oversize_record: "warn",
	writer_fallback_active: "error",
	projection_lossy_mapping: "warn",
	unknown_kind_ignored: "info",
};

// ============================================================================
// Control Character Escaping (Section 17.8)
// ============================================================================

/** Escape control characters in string values for prompt-safe output. */
export function escapeControlChars(value: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — we need to match control chars to escape them
	return value.replace(/[\x00-\x1f\x7f]/g, (ch) => {
		const code = ch.charCodeAt(0);
		if (code === 0x09) return "\\t";
		if (code === 0x0a) return "\\n";
		if (code === 0x0d) return "\\r";
		return `\\u${code.toString(16).padStart(4, "0")}`;
	});
}

// ============================================================================
// Canonical Summary (Section 18)
// ============================================================================

export interface CanonicalEventEntry {
	event_index: number;
	kind: string;
	attributes: Record<string, unknown>;
	trust: Record<string, TrustClass>;
	source_file: string;
	source_line: number;
}

export interface CanonicalDiagnosticEntry {
	code: string;
	message: string;
	level?: string;
	source_file: string;
	source_line: number;
}

export interface TraceSummary {
	spec_version: 1;
	trace_id: string;
	event_count: number;
	diagnostic_count: number;
	truncation_count: number;
	root_span_ids: string[];
	events: CanonicalEventEntry[];
	diagnostics: CanonicalDiagnosticEntry[];
	uncertainties: UncertaintyEntry[];
	entities: Record<string, string[]>;
}

export interface PipelineResult {
	summaries: TraceSummary[];
	parse_diagnostics: ParseDiagnostics;
}

// ============================================================================
// Pipeline
// ============================================================================

/** Known event kinds from the spec. */
const KNOWN_KINDS = new Set([
	"http.request",
	"db.query",
	"external.call",
	"job.start",
	"job.end",
	"job.dispatch",
]);

/**
 * Run the full consumer pipeline on parsed records.
 *
 * Stages: validate → normalize (truncate) → reconstruct → uncertainty → summary
 */
export function processRecords(
	records: ParsedLine[],
	parseDiagnostics: ParseDiagnostics,
): PipelineResult {
	const uncertainties = new Map<UncertaintyCode, UncertaintyEntry>();

	const addUncertainty = (code: UncertaintyCode, message: string) => {
		const existing = uncertainties.get(code);
		if (existing) {
			existing.count++;
		} else {
			uncertainties.set(code, {
				code,
				severity: UNCERTAINTY_SEVERITY[code],
				count: 1,
				message,
			});
		}
	};

	// Track malformed lines from parse stage
	if (parseDiagnostics.malformed_lines > 0) {
		const entry: UncertaintyEntry = {
			code: "malformed_line_skipped",
			severity: "warn",
			count: parseDiagnostics.malformed_lines,
			message: `${parseDiagnostics.malformed_lines} malformed line(s) skipped during parsing`,
		};
		uncertainties.set("malformed_line_skipped", entry);
	}

	// Stage 2: Validate — separate events and diagnostics, track unknown kinds
	const events: ParsedLine[] = [];
	const diagnosticRecords: ParsedLine[] = [];
	let truncationCount = 0;

	for (const parsed of records) {
		if (parsed.record.record_type === "diagnostic") {
			// Check for writer_fallback_active diagnostic
			if (parsed.record.code === "writer_fallback_activated") {
				addUncertainty("writer_fallback_active", "Writer fell back to console output");
			}
			if (parsed.record.code === "event_dropped_oversize") {
				addUncertainty("dropped_oversize_record", "Oversize record was dropped");
			}
			diagnosticRecords.push(parsed);
			continue;
		}

		const kind = parsed.record.kind as string | undefined;
		if (kind && !KNOWN_KINDS.has(kind) && !kind.startsWith("custom.")) {
			addUncertainty("unknown_kind_ignored", `Unknown event kind: ${kind}`);
		}

		events.push(parsed);
	}

	// Stage 3: Normalize — apply field truncation
	for (const parsed of events) {
		const record = parsed.record;
		const kind = (record.kind as string) ?? "";

		for (const [key, value] of Object.entries(record)) {
			if (NEVER_TRUNCATE.has(key)) continue;

			if (typeof value === "string") {
				const limit = getFieldLimit(kind, key);
				if (limit !== undefined) {
					const truncated = truncateField(value, limit);
					if (truncated !== value) {
						record[key] = truncated;
						truncationCount++;
					}
				}
			} else if (key === "entities" && typeof value === "object" && value !== null) {
				const entities = value as Record<string, string>;
				const truncatedEntities: Record<string, string> = {};
				for (const [ek, ev] of Object.entries(entities)) {
					const tk = truncateField(ek, ENTITY_KEY_LIMIT);
					const tv = truncateField(ev, ENTITY_VALUE_LIMIT);
					if (tk !== ek || tv !== ev) truncationCount++;
					truncatedEntities[tk] = tv;
				}
				record[key] = truncatedEntities;
			} else if (key === "details" && typeof value === "object" && value !== null) {
				const details = value as Record<string, unknown>;
				const truncatedDetails: Record<string, unknown> = {};
				for (const [dk, dv] of Object.entries(details)) {
					const tk = truncateField(dk, DETAILS_KEY_LIMIT);
					if (typeof dv === "string") {
						const tv = truncateField(dv, DETAILS_VALUE_LIMIT);
						if (tk !== dk || tv !== dv) truncationCount++;
						truncatedDetails[tk] = tv;
					} else {
						if (tk !== dk) truncationCount++;
						truncatedDetails[tk] = dv;
					}
				}
				record[key] = truncatedDetails;
			}
		}
	}

	// Stage 4: Reconstruct traces
	const traces = reconstructTraces(events);

	// Check for missing parent spans
	for (const trace of traces.values()) {
		for (const node of trace.all_spans.values()) {
			if (node.parent_span_id && !trace.all_spans.has(node.parent_span_id)) {
				addUncertainty(
					"missing_parent_span",
					`Span ${node.span_id} references missing parent ${node.parent_span_id}`,
				);
			}
		}
	}

	// Stage 5+6: Build summaries
	const summaries: TraceSummary[] = [];

	for (const trace of traces.values()) {
		// Build entity aggregation
		const entityIndex = buildEntityIndex(trace.events);
		const entityAgg: Record<string, string[]> = {};
		for (const key of entityIndex.keys) {
			const valMap = entityIndex.index.get(key);
			if (valMap) {
				entityAgg[key] = Array.from(valMap.keys()).sort();
			}
		}

		// Build canonical event entries
		const canonicalEvents: CanonicalEventEntry[] = trace.events.map((parsed, idx) => {
			const { record } = parsed;
			const attributes: Record<string, unknown> = {};
			const trust: Record<string, TrustClass> = {};

			// Sort keys lexicographically for determinism
			const sortedKeys = Object.keys(record).sort();
			for (const key of sortedKeys) {
				if (key === "record_type" || key === "spec_version") continue;
				const value = record[key];
				// Escape string values for prompt safety
				attributes[key] = typeof value === "string" ? escapeControlChars(value) : value;
				trust[key] = classifyTrust(key);
			}

			return {
				event_index: idx,
				kind: (record.kind as string) ?? "unknown",
				attributes,
				trust,
				source_file: parsed.source_file,
				source_line: parsed.source_line,
			};
		});

		// Build canonical diagnostic entries
		const canonicalDiagnostics: CanonicalDiagnosticEntry[] = diagnosticRecords
			.filter((d) => {
				// Include diagnostics that reference this trace
				const relatedTraceId = d.record.related_trace_id as string | undefined;
				return !relatedTraceId || relatedTraceId === trace.trace_id;
			})
			.map((parsed) => ({
				code: (parsed.record.code as string) ?? "",
				message: escapeControlChars((parsed.record.message as string) ?? ""),
				level: parsed.record.level as string | undefined,
				source_file: parsed.source_file,
				source_line: parsed.source_line,
			}));

		summaries.push({
			spec_version: 1,
			trace_id: trace.trace_id,
			event_count: trace.events.length,
			diagnostic_count: canonicalDiagnostics.length,
			truncation_count: truncationCount,
			root_span_ids: trace.root_spans.map((s) => s.span_id).sort(),
			events: canonicalEvents,
			diagnostics: canonicalDiagnostics,
			uncertainties: Array.from(uncertainties.values()),
			entities: entityAgg,
		});
	}

	// Sort summaries by trace_id for determinism
	summaries.sort((a, b) => a.trace_id.localeCompare(b.trace_id));

	return { summaries, parse_diagnostics: parseDiagnostics };
}

/**
 * Run the full pipeline on a JSONL string.
 */
export function processTelemetry(content: string, sourceFile = "<inline>"): PipelineResult {
	const { records, diagnostics } = parseContent(content, sourceFile);
	return processRecords(records, diagnostics);
}

/**
 * Run the full pipeline on a directory of JSONL files.
 */
export async function processTelemetryDir(dirPath: string): Promise<PipelineResult> {
	const { records, diagnostics } = await parseDirectory(dirPath);
	return processRecords(records, diagnostics);
}
