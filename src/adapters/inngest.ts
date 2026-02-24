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
import { generateSpanId, generateTraceId } from "../ids.ts";
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
					const trace = eventData._trace as { traceId: string; parentSpanId: string } | undefined;

					const traceId = trace?.traceId ?? generateTraceId();
					const spanId = generateSpanId();
					const runId = ctx.runId;
					const functionId = fn.id("");
					const entities =
						entityKeys.length > 0 ? extractEntitiesFromEvent(eventData, entityKeys) : undefined;
					const start = Date.now();

					const startEvent: JobStartEvent = {
						kind: "job.start",
						traceId,
						spanId,
						functionId,
						runId,
						entities,
					};
					telemetry.emit(startEvent);

					return {
						finished({ result }) {
							const duration_ms = Date.now() - start;
							const hasError = result.error != null;

							const endEvent: JobEndEvent = {
								kind: "job.end",
								traceId,
								spanId,
								functionId,
								runId,
								duration_ms,
								status: hasError ? "error" : "success",
								error: hasError
									? ((result.error as Error)?.message ?? String(result.error))
									: undefined,
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
								const trace = data._trace as { traceId: string; parentSpanId: string } | undefined;

								if (trace) {
									const dispatchEvent: JobDispatchEvent = {
										kind: "job.dispatch",
										traceId: trace.traceId,
										parentSpanId: trace.parentSpanId,
										eventName: (payload as { name: string }).name,
										entities:
											entityKeys.length > 0
												? extractEntitiesFromEvent(data, entityKeys)
												: undefined,
									};
									telemetry.emit(dispatchEvent);
								}
							}
						},
					};
				},
			};
		},
	});
}
