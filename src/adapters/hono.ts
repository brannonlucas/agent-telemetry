/**
 * Hono Adapter
 *
 * Creates Hono middleware that generates trace IDs per request, emits
 * http.request telemetry events, and provides getTraceContext() for
 * injecting trace context into downstream dispatches.
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
import { generateSpanId, generateTraceId } from "../ids.ts";
import { DEFAULT_TRACE_HEADER } from "../middleware/http.ts";
import type { EntityPattern, HttpRequestEvent, Telemetry } from "../types.ts";

/** Options for Hono trace middleware. */
export interface HonoTraceOptions {
	/** Telemetry instance to emit events through. */
	telemetry: Telemetry<HttpRequestEvent>;
	/** Entity patterns for extracting IDs from URL paths. */
	entityPatterns?: EntityPattern[];
	/** Request header name for incoming trace IDs. Default: "X-Trace-Id". */
	traceHeader?: string;
	/** Guard function — return false to skip tracing for a request. */
	isEnabled?: () => boolean;
}

/** Hono variable key for trace ID storage. */
const TRACE_VAR = "traceId" as const;
const TRACE_ID_RE = /^[\da-f]{32}$/i;

/**
 * Create Hono middleware that traces HTTP requests.
 *
 * Generates a traceId per request (or propagates a valid incoming header value),
 * stores it on the Hono context, sets the response header, and emits
 * an http.request event on completion.
 */
export function createHonoTrace(options: HonoTraceOptions): MiddlewareHandler {
	const { telemetry, entityPatterns, traceHeader = DEFAULT_TRACE_HEADER, isEnabled } = options;

	return async (c, next) => {
		if (isEnabled && !isEnabled()) {
			return next();
		}

		const incomingTraceId = c.req.header(traceHeader)?.trim();
		const traceId =
			incomingTraceId && TRACE_ID_RE.test(incomingTraceId) ? incomingTraceId : generateTraceId();

		c.set(TRACE_VAR, traceId);

		const start = performance.now();
		let error: string | undefined;

		try {
			await next();
		} catch (err) {
			error = err instanceof Error ? err.message : "Unknown error";
			throw err;
		} finally {
			const status = error && c.res.status < 400 ? 500 : c.res.status;
			const duration_ms = Math.round(performance.now() - start);
			const path = c.req.path;

			c.header(traceHeader, traceId);

			const event: HttpRequestEvent = {
				kind: "http.request",
				traceId,
				method: c.req.method,
				path,
				status,
				duration_ms,
			};

			if (entityPatterns) {
				const entities = extractEntities(path, entityPatterns);
				if (entities) event.entities = entities;
			}

			if (error) event.error = error;

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
): { _trace: { traceId: string; parentSpanId: string } } | Record<string, never> {
	const traceId = c.get(TRACE_VAR) as string | undefined;
	if (!traceId) return {};
	return { _trace: { traceId, parentSpanId: generateSpanId() } };
}
