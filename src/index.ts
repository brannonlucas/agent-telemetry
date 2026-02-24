/**
 * agent-telemetry
 *
 * Lightweight JSONL telemetry for AI agent backends.
 * Zero runtime dependencies. Framework adapters for Hono and Inngest.
 *
 * @example
 * ```ts
 * import { createTelemetry, type PresetEvents } from 'agent-telemetry'
 *
 * const telemetry = await createTelemetry<PresetEvents>()
 * telemetry.emit({ kind: 'http.request', traceId: '...', method: 'GET', path: '/', status: 200, duration_ms: 12 })
 * ```
 */

import type { BaseTelemetryEvent, Telemetry, TelemetryConfig } from "./types.ts";
import { createWriter } from "./writer.ts";

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

	const writer = await createWriter({
		logDir: config?.logDir,
		filename: config?.filename,
		maxSize: config?.maxSize,
		maxBackups: config?.maxBackups,
		prefix: config?.prefix,
	});

	return {
		emit(event: TEvent): void {
			try {
				if (!isEnabled()) return;
				const line = JSON.stringify({ ...event, timestamp: new Date().toISOString() });
				writer.write(line);
			} catch {
				// emit never throws — telemetry must not crash the host application
			}
		},
	};
}

// Re-export all public types
export type {
	BaseTelemetryEvent,
	EntityPattern,
	ExternalCallEvent,
	ExternalEvents,
	HttpEvents,
	HttpRequestEvent,
	JobDispatchEvent,
	JobEndEvent,
	JobEvents,
	JobStartEvent,
	JobStepEvent,
	PresetEvents,
	Telemetry,
	TelemetryConfig,
	TraceContext,
} from "./types.ts";

// Re-export utilities
export { generateSpanId, generateTraceId } from "./ids.ts";
export { extractEntities, extractEntitiesFromEvent } from "./entities.ts";
