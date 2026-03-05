/**
 * Inngest Adapter
 *
 * Creates Inngest middleware that emits job.start/job.end lifecycle events
 * and job.dispatch events for outgoing event sends.
 *
 * @example
 * ```ts
 * import { createTelemetry, type JobEvents } from 'agent-telemetry'
 * import { createInngestTrace } from 'agent-telemetry/inngest'
 *
 * const telemetry = await createTelemetry<JobEvents>()
 * const trace = createInngestTrace({ telemetry })
 *
 * const inngest = new Inngest({ id: 'my-app', middleware: [trace] })
 * ```
 */

import { InngestMiddleware } from "inngest";
import { extractEntitiesFromEvent } from "../entities.ts";
import { toSafeErrorLabel } from "../error.ts";
import { generateSpanId, generateTraceId } from "../ids.ts";
import { formatTraceparent, parseTraceparent } from "../traceparent.ts";
import type {
	JobDispatchEvent,
	JobEndEvent,
	JobEvents,
	JobStartEvent,
	Telemetry,
} from "../types.ts";

/** Options for the Inngest trace middleware. */
export interface InngestTraceOptions {
	/** Telemetry instance to emit events through. */
	telemetry: Telemetry<JobEvents>;
	/** Middleware name. Default: "agent-telemetry/trace". */
	name?: string;
	/** Keys to extract as entities from event data. Default: []. */
	entityKeys?: string[];
}

/**
 * Parse trace context from the _trace envelope.
 * Only accepts the traceparent string format. Legacy decomposed format
 * ({ trace_id, parent_span_id }) is ignored as of 0.7.0.
 */
function parseTraceEnvelope(rawTrace: Record<string, unknown> | undefined): {
	trace_id: string;
	parent_span_id?: string;
} {
	if (!rawTrace) {
		return { trace_id: generateTraceId() };
	}

	// New format: { traceparent: "00-{trace_id}-{parent_id}-{flags}" }
	if (typeof rawTrace.traceparent === "string") {
		const parsed = parseTraceparent(rawTrace.traceparent);
		if (parsed) {
			return { trace_id: parsed.traceId, parent_span_id: parsed.parentId };
		}
	}

	return { trace_id: generateTraceId() };
}

/**
 * Create Inngest middleware that traces function runs and event dispatches.
 *
 * Hooks:
 * - onFunctionRun: emits job.start on entry, job.end on completion
 * - onSendEvent: emits job.dispatch for outgoing events with _trace context
 */
export function createInngestTrace(options: InngestTraceOptions): InngestMiddleware.Any {
	const { telemetry, name = "agent-telemetry/trace", entityKeys = [] } = options;

	return new InngestMiddleware({
		name,
		init() {
			return {
				onFunctionRun({ ctx, fn }) {
					const eventData = (ctx.event.data ?? {}) as Record<string, unknown>;
					const rawTrace = eventData._trace as Record<string, unknown> | undefined;
					const { trace_id, parent_span_id } = parseTraceEnvelope(rawTrace);

					const span_id = generateSpanId();
					const task_id = ctx.runId;
					const task_name = fn.id("");
					const entities =
						entityKeys.length > 0 ? extractEntitiesFromEvent(eventData, entityKeys) : undefined;
					const start = performance.now();

					const startEvent: JobStartEvent = {
						record_type: "event",
						spec_version: 1,
						kind: "job.start",
						trace_id,
						span_id,
						parent_span_id,
						task_name,
						task_id,
						entities,
					};
					telemetry.emit(startEvent);

					return {
						finished({ result }) {
							const duration_ms = Math.round(performance.now() - start);
							const hasError = result.error != null;

							const endEvent: JobEndEvent = {
								record_type: "event",
								spec_version: 1,
								kind: "job.end",
								trace_id,
								span_id,
								parent_span_id,
								task_name,
								task_id,
								duration_ms,
								outcome: hasError ? "error" : "success",
								error_name: hasError ? toSafeErrorLabel(result.error) : undefined,
							};
							telemetry.emit(endEvent);
						},
					};
				},

				onSendEvent() {
					return {
						transformInput({ payloads }) {
							for (const payload of payloads) {
								const data = ((payload as { data?: unknown }).data ?? {}) as Record<
									string,
									unknown
								>;
								const rawTrace = data._trace as Record<string, unknown> | undefined;
								const { trace_id, parent_span_id } = parseTraceEnvelope(rawTrace);

								if (rawTrace) {
									// Generate a unique span_id for this dispatch (spec §7.9).
									const dispatch_span_id = generateSpanId();

									const dispatchEvent: JobDispatchEvent = {
										record_type: "event",
										spec_version: 1,
										kind: "job.dispatch",
										trace_id,
										span_id: dispatch_span_id,
										parent_span_id: parent_span_id ?? dispatch_span_id,
										task_name: (payload as { name: string }).name,
										outcome: "success",
										entities:
											entityKeys.length > 0
												? extractEntitiesFromEvent(data, entityKeys)
												: undefined,
									};
									telemetry.emit(dispatchEvent);

									// Update _trace with new traceparent format for downstream receiver
									(data as Record<string, unknown>)._trace = {
										traceparent: formatTraceparent(trace_id, dispatch_span_id, "01"),
									};
								}
							}
						},
					};
				},
			};
		},
	});
}
