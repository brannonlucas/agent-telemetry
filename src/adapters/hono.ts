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
import { httpOutcome, toSafeErrorLabel } from "../error.ts";
import { generateSpanId } from "../ids.ts";
import { startSpanFromTraceparent } from "../trace-context.ts";
import { formatTraceparent } from "../traceparent.ts";
import type { EntityPattern, HttpRequestEvent, Telemetry, TraceContextCarrier } from "../types.ts";

/** Options for Hono trace middleware. */
export interface HonoTraceOptions {
	/** Telemetry instance to emit events through. */
	telemetry: Telemetry<HttpRequestEvent>;
	/** Entity patterns for extracting IDs from URL paths. */
	entityPatterns?: EntityPattern[];
	/** Guard function — return false to skip tracing for a request. */
	isEnabled?: () => boolean;
	/** Optional path sanitizer. Receives raw path, returns sanitized path. */
	sanitizePath?: (path: string) => string;
}

/** Hono variable keys for trace storage. */
const TRACE_ID_VAR = "traceId" as const;
const SPAN_ID_VAR = "spanId" as const;
const TRACE_FLAGS_VAR = "traceFlags" as const;
const TRACESTATE_VAR = "tracestate" as const;

/**
 * Create Hono middleware that traces HTTP requests.
 *
 * Generates a traceId per request (or propagates a valid incoming `traceparent`),
 * stores it on the Hono context, sets the `traceparent` response header, and emits
 * an http.request event on completion.
 */
export function createHonoTrace(options: HonoTraceOptions): MiddlewareHandler {
	const { telemetry, entityPatterns, isEnabled, sanitizePath } = options;

	return async (c, next) => {
		if (isEnabled && !isEnabled()) {
			return next();
		}

		const span = startSpanFromTraceparent(c.req.header("traceparent"), c.req.header("tracestate"));

		c.set(TRACE_ID_VAR, span.trace_id);
		c.set(SPAN_ID_VAR, span.span_id);
		c.set(TRACE_FLAGS_VAR, span.trace_flags);
		if (span.tracestate) c.set(TRACESTATE_VAR, span.tracestate);

		const start = performance.now();
		let error_name: string | undefined;

		try {
			await next();
		} catch (err) {
			error_name = toSafeErrorLabel(err);
			throw err;
		} finally {
			const status_code = error_name && c.res.status < 400 ? 500 : c.res.status;
			const duration_ms = Math.round(performance.now() - start);
			const rawPath = c.req.path;
			const path = sanitizePath ? sanitizePath(rawPath) : rawPath;

			c.header("traceparent", formatTraceparent(span.trace_id, span.span_id, span.trace_flags));
			if (span.tracestate) c.header("tracestate", span.tracestate);

			const event: HttpRequestEvent = {
				record_type: "event",
				spec_version: 1,
				kind: "http.request",
				trace_id: span.trace_id,
				span_id: span.span_id,
				parent_span_id: span.parent_span_id,
				outcome: httpOutcome(status_code),
				method: c.req.method,
				path,
				status_code,
				duration_ms,
			};

			if (entityPatterns) {
				const entities = extractEntities(path, entityPatterns);
				if (entities) event.entities = entities;
			}

			if (error_name) {
				event.error_name = status_code >= 500 ? error_name : undefined;
			} else if (status_code >= 500) {
				event.error_name = `HTTP ${status_code}`;
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
export function getTraceContext(c: Context): TraceContextCarrier {
	const traceId = c.get(TRACE_ID_VAR) as string | undefined;
	const spanId = c.get(SPAN_ID_VAR) as string | undefined;
	const traceFlags = c.get(TRACE_FLAGS_VAR) as string | undefined;
	const tracestate = c.get(TRACESTATE_VAR) as string | undefined;
	if (!traceId) return {};
	const carrier: TraceContextCarrier = {
		_trace: { traceparent: formatTraceparent(traceId, spanId ?? generateSpanId(), traceFlags) },
	};
	if (tracestate)
		(carrier as { _trace: { traceparent: string; tracestate?: string } })._trace.tracestate =
			tracestate;
	return carrier;
}
