/**
 * Hono Adapter
 *
 * Creates Hono middleware that generates trace IDs per request, emits
 * http.request telemetry events, and provides getTraceContext() for
 * injecting trace context into downstream dispatches.
 *
 * Uses the W3C `traceparent` header for trace propagation.
 *
 * @example
 * ```ts
 * import { createTelemetry, type HttpEvents } from 'agent-telemetry'
 * import { createHonoTrace, getTraceContext } from 'agent-telemetry/hono'
 *
 * const telemetry = await createTelemetry<HttpEvents>()
 * const trace = createHonoTrace({ telemetry })
 *
 * app.use('*', trace)
 * ```
 */

import type { Context, MiddlewareHandler } from "hono";
import { extractEntities } from "../entities.ts";
import { toSafeErrorLabel } from "../error.ts";
import { generateSpanId } from "../ids.ts";
import { startSpanFromTraceparent } from "../trace-context.ts";
import { formatTraceparent } from "../traceparent.ts";
import type { EntityPattern, HttpRequestEvent, Telemetry } from "../types.ts";

/** Options for Hono trace middleware. */
export interface HonoTraceOptions {
	/** Telemetry instance to emit events through. */
	telemetry: Telemetry<HttpRequestEvent>;
	/** Entity patterns for extracting IDs from URL paths. */
	entityPatterns?: EntityPattern[];
	/** Guard function — return false to skip tracing for a request. */
	isEnabled?: () => boolean;
}

/** Hono variable keys for trace storage. */
const TRACE_ID_VAR = "traceId" as const;
const SPAN_ID_VAR = "spanId" as const;
const TRACE_FLAGS_VAR = "traceFlags" as const;

/**
 * Create Hono middleware that traces HTTP requests.
 *
 * Generates a traceId per request (or propagates a valid incoming `traceparent`),
 * stores it on the Hono context, sets the `traceparent` response header, and emits
 * an http.request event on completion.
 */
export function createHonoTrace(options: HonoTraceOptions): MiddlewareHandler {
	const { telemetry, entityPatterns, isEnabled } = options;

	return async (c, next) => {
		if (isEnabled && !isEnabled()) {
			return next();
		}

		const span = startSpanFromTraceparent(c.req.header("traceparent"));

		c.set(TRACE_ID_VAR, span.traceId);
		c.set(SPAN_ID_VAR, span.spanId);
		c.set(TRACE_FLAGS_VAR, span.traceFlags);

		const start = performance.now();
		let error: string | undefined;

		try {
			await next();
		} catch (err) {
			error = toSafeErrorLabel(err);
			throw err;
		} finally {
			const status = error && c.res.status < 400 ? 500 : c.res.status;
			const duration_ms = Math.round(performance.now() - start);
			const path = c.req.path;

			c.header("traceparent", formatTraceparent(span.traceId, span.spanId, span.traceFlags));

			const event: HttpRequestEvent = {
				kind: "http.request",
				traceId: span.traceId,
				spanId: span.spanId,
				parentSpanId: span.parentSpanId,
				method: c.req.method,
				path,
				status,
				duration_ms,
			};

			if (entityPatterns) {
				const entities = extractEntities(path, entityPatterns);
				if (entities) event.entities = entities;
			}

			if (error) {
				event.error = status >= 500 ? `HTTP ${status}` : error;
			} else if (status >= 500) {
				event.error = `HTTP ${status}`;
			}

			telemetry.emit(event);
		}
	};
}

/**
 * Get trace context from a Hono request context.
 *
 * Returns an object with `_trace` suitable for spreading into event dispatch
 * payloads to propagate the trace across async boundaries.
 *
 * @example
 * ```ts
 * app.post('/api/process', async (c) => {
 *   await queue.send({ ...payload, ...getTraceContext(c) })
 * })
 * ```
 */
export function getTraceContext(
	c: Context,
):
	| { _trace: { traceId: string; parentSpanId: string; traceFlags?: string } }
	| Record<string, never> {
	const traceId = c.get(TRACE_ID_VAR) as string | undefined;
	const spanId = c.get(SPAN_ID_VAR) as string | undefined;
	const traceFlags = c.get(TRACE_FLAGS_VAR) as string | undefined;
	if (!traceId) return {};
	return { _trace: { traceId, parentSpanId: spanId ?? generateSpanId(), traceFlags } };
}
