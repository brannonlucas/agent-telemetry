/**
 * Type definitions for agent-telemetry.
 *
 * Provides base event types, preset event families (HttpEvents, JobEvents,
 * ExternalEvents), configuration interfaces, and the Telemetry handle type.
 */

// ============================================================================
// Base Event
// ============================================================================

/** Fields present on every telemetry event after emission. */
export interface BaseTelemetryEvent {
	kind: string;
	traceId: string;
	timestamp?: string;
}

// ============================================================================
// Preset Event Families
// ============================================================================

export interface HttpRequestEvent extends BaseTelemetryEvent {
	kind: "http.request";
	method: string;
	path: string;
	status: number;
	duration_ms: number;
	entities?: Record<string, string>;
	error?: string;
}

/** All HTTP-related events. */
export type HttpEvents = HttpRequestEvent;

export interface JobStartEvent extends BaseTelemetryEvent {
	kind: "job.start";
	spanId: string;
	functionId: string;
	runId?: string;
	entities?: Record<string, string>;
}

export interface JobEndEvent extends BaseTelemetryEvent {
	kind: "job.end";
	spanId: string;
	functionId: string;
	runId?: string;
	duration_ms: number;
	status: "success" | "error";
	error?: string;
}

export interface JobDispatchEvent extends BaseTelemetryEvent {
	kind: "job.dispatch";
	parentSpanId: string;
	eventName: string;
	entities?: Record<string, string>;
}

export interface JobStepEvent extends BaseTelemetryEvent {
	kind: "job.step";
	spanId: string;
	stepId: string;
	duration_ms: number;
	status: "success" | "error";
}

/** All background job events. */
export type JobEvents = JobStartEvent | JobEndEvent | JobDispatchEvent | JobStepEvent;

export interface ExternalCallEvent extends BaseTelemetryEvent {
	kind: "external.call";
	spanId: string;
	service: string;
	operation: string;
	duration_ms: number;
	status: "success" | "error";
}

/** All external service call events. */
export type ExternalEvents = ExternalCallEvent;

/** Union of all preset event types. */
export type PresetEvents = HttpEvents | JobEvents | ExternalEvents;

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
	/** Directory for log files. Default: "logs" relative to cwd. */
	logDir?: string;
	/** Log filename (without directory). Default: "telemetry.jsonl". */
	filename?: string;
	/** Max file size in bytes before rotation. Default: 5_000_000 (5MB). */
	maxSize?: number;
	/** Number of rotated backup files to keep. Default: 3. */
	maxBackups?: number;
	/** Prefix for console.log fallback lines. Default: "[TEL]". */
	prefix?: string;
	/** Guard function — return false to disable emission. Default: () => true. */
	isEnabled?: () => boolean;
}

/** The telemetry handle returned by createTelemetry(). */
export interface Telemetry<TEvent extends BaseTelemetryEvent = PresetEvents> {
	/** Emit a telemetry event. Synchronous. Never throws. */
	emit: (event: TEvent) => void;
}

// ============================================================================
// Trace Context
// ============================================================================

/** Trace context passed between HTTP requests and background jobs. */
export interface TraceContext {
	traceId: string;
	parentSpanId: string;
	traceFlags?: string;
}
