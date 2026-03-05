/**
 * Type definitions for agent-telemetry.
 *
 * Field names use snake_case to match the Agent Telemetry Specification v1 wire format.
 * Provides base record types, preset event families, diagnostic records,
 * configuration interfaces, and the Telemetry handle type.
 */

// ============================================================================
// Base Record
// ============================================================================

/** Fields present on every telemetry record. */
export interface BaseRecord {
	record_type: "event" | "diagnostic";
	spec_version: 1;
	timestamp?: string;
}

// ============================================================================
// Base Event
// ============================================================================

/** Fields present on every telemetry event after emission. */
export interface BaseTelemetryEvent extends BaseRecord {
	record_type: "event";
	kind: string;
	trace_id: string;
}

// ============================================================================
// Preset Event Families
// ============================================================================

export interface HttpRequestEvent extends BaseTelemetryEvent {
	kind: "http.request";
	span_id?: string;
	parent_span_id?: string;
	outcome: "success" | "error";
	method: string;
	path: string;
	route?: string;
	status_code: number;
	duration_ms: number;
	entities?: Record<string, string>;
	error_name?: string;
}

/** All HTTP-related events. */
export type HttpEvents = HttpRequestEvent;

export interface JobStartEvent extends BaseTelemetryEvent {
	kind: "job.start";
	span_id: string;
	parent_span_id?: string;
	task_name: string;
	task_id?: string;
	queue?: string;
	attempt?: number;
	entities?: Record<string, string>;
}

export interface JobEndEvent extends BaseTelemetryEvent {
	kind: "job.end";
	span_id: string;
	parent_span_id?: string;
	task_name: string;
	task_id?: string;
	queue?: string;
	attempt?: number;
	duration_ms: number;
	outcome: "success" | "error";
	error_name?: string;
}

export interface JobDispatchEvent extends BaseTelemetryEvent {
	kind: "job.dispatch";
	span_id: string;
	parent_span_id: string;
	task_name: string;
	task_id?: string;
	queue?: string;
	attempt?: number;
	entities?: Record<string, string>;
	outcome: "success" | "error";
	error_name?: string;
}

/** All background job events. */
export type JobEvents = JobStartEvent | JobEndEvent | JobDispatchEvent;

export interface ExternalCallEvent extends BaseTelemetryEvent {
	kind: "external.call";
	span_id: string;
	parent_span_id?: string;
	service: string;
	operation: string;
	duration_ms: number;
	outcome: "success" | "error";
	status_code?: number;
	error_name?: string;
}

/** All external service call events. */
export type ExternalEvents = ExternalCallEvent;

export interface DbQueryEvent extends BaseTelemetryEvent {
	kind: "db.query";
	span_id: string;
	parent_span_id?: string;
	/** Provider identifier (e.g. "prisma", "supabase", "drizzle"). */
	provider: string;
	/** The data entity being operated on — ORM model name or database table. */
	model?: string;
	/** Operation name (e.g. "findMany", "create", "select", "insert"). */
	operation: string;
	duration_ms: number;
	outcome: "success" | "error";
	error_name?: string;
}

/** All database query events. */
export type DbEvents = DbQueryEvent;

/** Events emitted by the Supabase adapter (db.query for PostgREST, external.call for auth/storage/functions). */
export type SupabaseEvents = DbQueryEvent | ExternalCallEvent;

/** Union of all preset event types. */
export type PresetEvents = HttpEvents | JobEvents | ExternalEvents | DbEvents;

// ============================================================================
// Diagnostic Record
// ============================================================================

/** Severity level for diagnostic records. */
export type DiagnosticLevel = "debug" | "info" | "warn" | "error";

/** Diagnostic record for writer health and telemetry fidelity. */
export interface DiagnosticRecord extends BaseRecord {
	record_type: "diagnostic";
	code: string;
	message: string;
	level?: DiagnosticLevel;
	details?: Record<string, string | number | boolean | null>;
	related_kind?: string;
	related_trace_id?: string;
}

/** Reserved diagnostic codes. */
export type DiagnosticCode =
	| "event_dropped_oversize"
	| "writer_fallback_activated"
	| "writer_append_failed"
	| "writer_rotation_failed"
	| "projection_mapping_failed";

// ============================================================================
// Entity Extraction
// ============================================================================

/** A pattern for extracting entity IDs from URL path segments. */
export interface EntityPattern {
	/** The URL path segment that precedes the entity ID (e.g. "users"). */
	segment: string;
	/** The key name for the extracted ID (e.g. "userId"). */
	key: string;
}

// ============================================================================
// Configuration
// ============================================================================

/** Configuration for the telemetry writer. */
export interface TelemetryConfig {
	/** Directory for log files. Default: auto-discovered session directory. */
	logDir?: string;
	/** Log filename (without directory). Default: "{role}-{pid}.jsonl". */
	filename?: string;
	/** Max file size in bytes before rotation. Default: 5_000_000 (5MB). */
	maxSize?: number;
	/** Number of rotated backup files to keep. Default: 3. */
	maxBackups?: number;
	/** Max record size in bytes before dropping. Default: 1_048_576 (1MB). */
	maxRecordSize?: number;
	/** Prefix for console.log fallback lines. Default: "[TEL]". */
	prefix?: string;
	/** Guard function — return false to disable emission. Default: () => true. */
	isEnabled?: () => boolean;
	/** Session ID for directory structure. Default: Date.now().toString(36). */
	sessionId?: string;
	/** Role identifier for filename. Default: "server". */
	role?: string;
	/** Optional path sanitizer. Receives raw path, returns sanitized path. */
	sanitizePath?: (path: string) => string;
}

/** The telemetry handle returned by createTelemetry(). */
export interface Telemetry<TEvent extends BaseTelemetryEvent = PresetEvents> {
	/** Emit a telemetry event. Synchronous. Never throws. */
	emit: (event: TEvent) => void;
	/** Flush all buffered events to disk. */
	flush: () => Promise<void>;
}

// ============================================================================
// Trace Context
// ============================================================================

/** Trace context for the _trace continuation envelope (wire format). */
export interface TraceContext {
	traceparent: string;
	tracestate?: string;
}

/** Return type for adapter `getTraceContext()` functions. */
export type TraceContextCarrier = { _trace: TraceContext } | Record<string, never>;

/**
 * Legacy decomposed trace context (pre-0.6.0).
 * @deprecated Use TraceContext with traceparent string instead.
 */
export interface LegacyTraceContext {
	trace_id: string;
	parent_span_id: string;
	trace_flags?: string;
}
