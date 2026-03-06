/**
 * Runtime Schema Introspection
 *
 * Provides programmatic access to the Agent Telemetry v1 contract pack.
 * All data is embedded at build time — no filesystem access required.
 */

// ============================================================================
// Embedded Contract Data
// ============================================================================

const LIMITS: Record<string, number> = {
	kind: 64,
	error_name: 120,
	"http.request.path": 1024,
	"http.request.route": 256,
	"external.call.service": 128,
	"external.call.operation": 256,
	"db.query.provider": 64,
	"db.query.operation": 128,
	"db.query.model": 128,
	"job.start.task_name": 128,
	"job.start.task_id": 128,
	"job.start.queue": 128,
	"job.end.task_name": 128,
	"job.end.task_id": 128,
	"job.end.queue": 128,
	"job.dispatch.task_name": 128,
	"job.dispatch.task_id": 128,
	"job.dispatch.queue": 128,
	"diagnostic.code": 96,
	"diagnostic.message": 256,
	"entities.key": 64,
	"entities.value": 256,
	"details.key": 64,
	"details.string_value": 256,
	_default: 256,
};

const ENUMS: Record<string, string[]> = {
	outcome: ["success", "error"],
	diagnostic_level: ["debug", "info", "warn", "error"],
	trust_class: ["system_asserted", "untrusted_input", "derived", "unknown"],
	record_type: ["event", "diagnostic"],
	uncertainty_severity: ["info", "warn", "error"],
};

const PATTERNS: Record<string, string> = {
	kind: "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$",
	trace_id: "^[0-9a-f]{32}$",
	span_id: "^[0-9a-f]{16}$",
	traceparent: "^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$",
	diagnostic_code: "^[a-z][a-z0-9_]*$",
};

const GLOSSARY: Record<string, { description: string; inference_constraint: string }> = {
	trace_id: {
		description: "W3C Trace Context trace identifier, 32 lowercase hex characters",
		inference_constraint: "Opaque identifier. Do not interpret as meaningful data.",
	},
	span_id: {
		description: "W3C Trace Context span identifier, 16 lowercase hex characters",
		inference_constraint: "Opaque identifier. Do not interpret as meaningful data.",
	},
	parent_span_id: {
		description: "The span_id of the parent span in the trace tree",
		inference_constraint: "Absence means root span. Value may reference a span not in the dataset.",
	},
	kind: {
		description: "Dot-separated event type identifier (e.g., http.request, db.query)",
		inference_constraint: "Must match spec grammar. Unknown kinds should be acknowledged, not discarded.",
	},
	outcome: {
		description: "Whether the operation succeeded or failed",
		inference_constraint: "Derived from status_code for HTTP events. Binary classification only.",
	},
	path: {
		description: "URL path without query string or fragment. May contain PII.",
		inference_constraint: "Untrusted input. May be user-controlled. Sanitize before display.",
	},
	error_name: {
		description: "Safe label for the error (class name, HTTP status). Never contains stack traces.",
		inference_constraint: "Untrusted input. Attacker-controlled error messages may appear here.",
	},
	entities: {
		description: "Key-value map of extracted entity identifiers from the request path",
		inference_constraint: "Untrusted input. Values are from URL segments and may be user-controlled.",
	},
	duration_ms: {
		description: "Operation duration in milliseconds, rounded to nearest integer",
		inference_constraint: "System-asserted. Clock precision varies by runtime.",
	},
	timestamp: {
		description: "ISO 8601 timestamp when the event was emitted",
		inference_constraint: "System-asserted. Not authoritative for ordering (use trace tree structure).",
	},
};

interface KindProperty {
	type: string;
	maxLength?: number;
	minimum?: number;
	maximum?: number;
	enum?: string[];
	const?: string;
}

interface KindSchema {
	title: string;
	required: string[];
	properties: Record<string, KindProperty>;
}

const KIND_SCHEMAS: Record<string, KindSchema> = {
	"http.request": {
		title: "HTTP Request Event",
		required: ["kind", "method", "path", "status_code", "outcome", "duration_ms"],
		properties: {
			kind: { type: "string", const: "http.request" },
			method: { type: "string" },
			path: { type: "string", maxLength: 1024 },
			route: { type: "string", maxLength: 256 },
			status_code: { type: "integer", minimum: 100, maximum: 599 },
			outcome: { type: "string", enum: ["success", "error"] },
			duration_ms: { type: "integer", minimum: 0 },
		},
	},
	"db.query": {
		title: "Database Query Event",
		required: ["kind", "provider", "operation", "duration_ms", "outcome"],
		properties: {
			kind: { type: "string", const: "db.query" },
			provider: { type: "string", maxLength: 64 },
			model: { type: "string", maxLength: 128 },
			operation: { type: "string", maxLength: 128 },
			duration_ms: { type: "integer", minimum: 0 },
			outcome: { type: "string", enum: ["success", "error"] },
		},
	},
	"external.call": {
		title: "External Service Call Event",
		required: ["kind", "service", "operation", "duration_ms", "outcome"],
		properties: {
			kind: { type: "string", const: "external.call" },
			service: { type: "string", maxLength: 128 },
			operation: { type: "string", maxLength: 256 },
			duration_ms: { type: "integer", minimum: 0 },
			outcome: { type: "string", enum: ["success", "error"] },
			status_code: { type: "integer" },
		},
	},
	"job.start": {
		title: "Job Start Event",
		required: ["kind", "span_id", "task_name"],
		properties: {
			kind: { type: "string", const: "job.start" },
			task_name: { type: "string", maxLength: 128 },
			task_id: { type: "string", maxLength: 128 },
			queue: { type: "string", maxLength: 128 },
			attempt: { type: "integer", minimum: 0 },
		},
	},
	"job.end": {
		title: "Job End Event",
		required: ["kind", "span_id", "task_name", "duration_ms", "outcome"],
		properties: {
			kind: { type: "string", const: "job.end" },
			task_name: { type: "string", maxLength: 128 },
			task_id: { type: "string", maxLength: 128 },
			queue: { type: "string", maxLength: 128 },
			attempt: { type: "integer", minimum: 0 },
			duration_ms: { type: "integer", minimum: 0 },
			outcome: { type: "string", enum: ["success", "error"] },
		},
	},
	"job.dispatch": {
		title: "Job Dispatch Event",
		required: ["kind", "span_id", "parent_span_id", "task_name", "outcome"],
		properties: {
			kind: { type: "string", const: "job.dispatch" },
			task_name: { type: "string", maxLength: 128 },
			task_id: { type: "string", maxLength: 128 },
			queue: { type: "string", maxLength: 128 },
			attempt: { type: "integer", minimum: 0 },
			outcome: { type: "string", enum: ["success", "error"] },
		},
	},
};

// Base fields present on all events (from event.base.schema.json)
const BASE_PROPERTIES: Record<string, KindProperty> = {
	record_type: { type: "string", const: "event" },
	spec_version: { type: "integer", const: "1" },
	kind: { type: "string", maxLength: 64 },
	trace_id: { type: "string" },
	span_id: { type: "string" },
	parent_span_id: { type: "string" },
	timestamp: { type: "string" },
	outcome: { type: "string", enum: ["success", "error"] },
	duration_ms: { type: "integer", minimum: 0 },
	error_name: { type: "string", maxLength: 120 },
	entities: { type: "object" },
};

const BASE_REQUIRED = ["record_type", "spec_version", "kind", "trace_id"];

// ============================================================================
// Public API
// ============================================================================

/** Description of a single event kind's schema. */
export interface KindDescription {
	kind: string;
	title: string;
	required: string[];
	properties: Record<string, KindProperty>;
	limits: Record<string, number>;
}

/** Description of a single field from the glossary. */
export interface FieldDescription {
	field: string;
	description: string;
	inference_constraint: string;
}

/** Return all known event kinds. */
export function listKinds(): string[] {
	return Object.keys(KIND_SCHEMAS).sort();
}

/**
 * Describe a specific event kind.
 * Returns the kind's schema with resolved base properties and field limits.
 * Returns `undefined` for unknown kinds.
 */
export function describeKind(kind: string): KindDescription | undefined {
	const schema = KIND_SCHEMAS[kind];
	if (!schema) return undefined;

	// Merge base properties with kind-specific properties (kind-specific wins)
	const properties = { ...BASE_PROPERTIES, ...schema.properties };

	// Deduplicate required fields
	const required = Array.from(new Set([...BASE_REQUIRED, ...schema.required])).sort();

	// Collect limits relevant to this kind
	const limits: Record<string, number> = {};
	for (const field of Object.keys(properties)) {
		const kindSpecific = LIMITS[`${kind}.${field}`];
		const universal = LIMITS[field];
		if (kindSpecific !== undefined) {
			limits[field] = kindSpecific;
		} else if (universal !== undefined) {
			limits[field] = universal;
		}
	}

	return { kind, title: schema.title, required, properties, limits };
}

/**
 * Describe a field from the glossary.
 * Returns the field's description and inference constraint.
 * Returns `undefined` for fields not in the glossary.
 */
export function describeField(field: string): FieldDescription | undefined {
	const entry = GLOSSARY[field];
	if (!entry) return undefined;
	return { field, ...entry };
}

/** Return all field byte limits from the contract pack. */
export function getLimits(): Record<string, number> {
	return { ...LIMITS };
}

/** Return all enum definitions from the contract pack. */
export function getEnums(): Record<string, string[]> {
	return Object.fromEntries(Object.entries(ENUMS).map(([k, v]) => [k, [...v]]));
}

/** Return all validation patterns from the contract pack. */
export function getPatterns(): Record<string, string> {
	return { ...PATTERNS };
}

/** Return the full glossary with descriptions and inference constraints. */
export function getGlossary(): Record<string, { description: string; inference_constraint: string }> {
	return Object.fromEntries(
		Object.entries(GLOSSARY).map(([k, v]) => [k, { ...v }]),
	);
}
