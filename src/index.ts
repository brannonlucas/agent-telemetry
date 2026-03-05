/**
 * agent-telemetry
 *
 * Lightweight JSONL telemetry for AI agent backends.
 * Zero runtime dependencies. Framework adapters for Hono, Express, Inngest, and more.
 *
 * @example
 * ```ts
 * import { createTelemetry, type PresetEvents } from 'agent-telemetry'
 *
 * const telemetry = await createTelemetry<PresetEvents>()
 * telemetry.emit({ kind: 'http.request', trace_id: '...', method: 'GET', path: '/', status_code: 200, outcome: 'success', duration_ms: 12 })
 * ```
 */

import {
	DETAILS_KEY_LIMIT,
	DETAILS_VALUE_LIMIT,
	ENTITY_KEY_LIMIT,
	ENTITY_VALUE_LIMIT,
	NEVER_TRUNCATE,
	getFieldLimit,
} from "./limits.ts";
import { truncateField } from "./truncate.ts";
import type { BaseTelemetryEvent, Telemetry, TelemetryConfig } from "./types.ts";
import { createWriter } from "./writer.ts";

/** Validates kind against the spec grammar: lowercase segments separated by dots. */
const KIND_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/**
 * Create a telemetry instance.
 *
 * Async because runtime detection (filesystem probe) happens once at startup.
 * The returned `emit()` function is synchronous and never throws.
 */
export async function createTelemetry<TEvent extends BaseTelemetryEvent = BaseTelemetryEvent>(
	config?: TelemetryConfig,
): Promise<Telemetry<TEvent>> {
	const isEnabled = config?.isEnabled ?? (() => true);
	let truncationCount = 0;

	const writer = await createWriter({
		logDir: config?.logDir,
		filename: config?.filename,
		maxSize: config?.maxSize,
		maxBackups: config?.maxBackups,
		maxRecordSize: config?.maxRecordSize,
		prefix: config?.prefix,
		sessionId: config?.sessionId,
		role: config?.role,
	});

	return {
		emit(event: TEvent): void {
			try {
				if (!isEnabled()) return;

				// Kind validation: invalid kinds are silently dropped with a diagnostic.
				if (event.kind && !KIND_RE.test(event.kind)) {
					writer.write(
						JSON.stringify({
							record_type: "diagnostic",
							spec_version: 1,
							timestamp: new Date().toISOString(),
							code: "invalid_kind_format",
							message: `event dropped: kind "${event.kind}" does not match spec grammar`,
							level: "warn",
							details: { kind: event.kind },
						}),
					);
					return;
				}

				// Spread event first, then force spec-required fields.
				// record_type and spec_version are immune to caller omission.
				const record = {
					...event,
					record_type: "event" as const,
					spec_version: 1 as const,
					timestamp: event.timestamp ?? new Date().toISOString(),
				} as unknown as Record<string, unknown>;

				// Apply field-level truncation (spec §4.7 / §17.6)
				const kind = typeof record.kind === "string" ? record.kind : "";
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
					}
				}

				const line = JSON.stringify(record);
				writer.write(line);
			} catch {
				// emit never throws — telemetry must not crash the host application
			}
		},
		flush(): Promise<void> {
			return writer.flush();
		},
	};
}

// Re-export all public types
export type {
	BaseRecord,
	BaseTelemetryEvent,
	DbEvents,
	DbQueryEvent,
	DiagnosticCode,
	DiagnosticLevel,
	DiagnosticRecord,
	EntityPattern,
	ExternalCallEvent,
	ExternalEvents,
	HttpEvents,
	HttpRequestEvent,
	JobDispatchEvent,
	JobEndEvent,
	JobEvents,
	JobStartEvent,
	PresetEvents,
	SupabaseEvents,
	Telemetry,
	TelemetryConfig,
	TraceContext,
	TraceContextCarrier,
	LegacyTraceContext,
} from "./types.ts";

// Re-export utilities
export { truncateField } from "./truncate.ts";
export { FIELD_LIMITS, NEVER_TRUNCATE, getFieldLimit } from "./limits.ts";
export { httpOutcome, toSafeErrorLabel } from "./error.ts";
export { generateSpanId, generateTraceId } from "./ids.ts";
export { extractEntities, extractEntitiesFromEvent } from "./entities.ts";
export { formatTraceparent, parseTraceparent } from "./traceparent.ts";
export type { Traceparent } from "./traceparent.ts";
