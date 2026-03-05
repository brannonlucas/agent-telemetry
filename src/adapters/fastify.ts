/**
 * Fastify Adapter
 *
 * Creates a Fastify plugin that traces HTTP requests via onRequest/onResponse
 * hooks. Uses reply.elapsedTime for high-resolution duration measurement.
 *
 * No runtime import of fastify -- uses inline types and Symbol.for("skip-override")
 * instead of the fastify-plugin package.
 *
 * @example
 * ```ts
 * import { createTelemetry, type HttpEvents } from 'agent-telemetry'
 * import { createFastifyTrace, getTraceContext } from 'agent-telemetry/fastify'
 *
 * const telemetry = await createTelemetry<HttpEvents>()
 * app.register(createFastifyTrace({ telemetry }))
 * ```
 */

import { extractEntities } from "../entities.ts";
import { httpOutcome } from "../error.ts";
import { stripQueryAndFragment } from "../fetch-utils.ts";
import { startSpanFromTraceparent } from "../trace-context.ts";
import { formatTraceparent } from "../traceparent.ts";
import type { EntityPattern, HttpRequestEvent, Telemetry, TraceContextCarrier } from "../types.ts";

// ---------------------------------------------------------------------------
// Inline Fastify types (no runtime import)
// ---------------------------------------------------------------------------

interface FastifyRequest {
	method: string;
	url: string;
	headers: Record<string, string | string[] | undefined>;
	routeOptions?: { url?: string };
}

interface FastifyReply {
	statusCode: number;
	elapsedTime: number;
	header(name: string, value: string): FastifyReply;
}

interface FastifyInstance {
	addHook(
		name: "onRequest",
		hook: (request: FastifyRequest, reply: FastifyReply, done: () => void) => void,
	): void;
	addHook(
		name: "onResponse",
		hook: (request: FastifyRequest, reply: FastifyReply, done: () => void) => void,
	): void;
}

type FastifyPluginCallback = ((
	instance: FastifyInstance,
	opts: Record<string, unknown>,
	done: () => void,
) => void) & {
	[key: symbol]: unknown;
};

// ---------------------------------------------------------------------------
// Trace storage (keyed on Fastify request wrapper, not request.raw)
// ---------------------------------------------------------------------------

const traceStore = new WeakMap<
	object,
	{
		trace_id: string;
		span_id: string;
		parent_span_id?: string;
		trace_flags: string;
		tracestate?: string;
	}
>();

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for the Fastify trace plugin. */
export interface FastifyTraceOptions {
	/** Telemetry instance to emit events through. */
	telemetry: Telemetry<HttpRequestEvent>;
	/** Entity patterns for extracting IDs from URL paths. */
	entityPatterns?: EntityPattern[];
	/** Guard function -- return false to skip tracing for a request. */
	isEnabled?: () => boolean;
	/** Optional path sanitizer. Receives raw path, returns sanitized path. */
	sanitizePath?: (path: string) => string;
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

/**
 * Create a Fastify plugin that traces HTTP requests.
 *
 * Registers onRequest and onResponse hooks. The onRequest hook generates
 * a trace_id (or propagates a valid incoming `traceparent`), stores it in
 * a WeakMap keyed on the Fastify request object, and sets the response
 * `traceparent` header. The onResponse hook emits an http.request event
 * using `reply.elapsedTime` for high-resolution duration.
 */
export function createFastifyTrace(options: FastifyTraceOptions): FastifyPluginCallback {
	const { telemetry, entityPatterns, isEnabled, sanitizePath } = options;

	const plugin = (instance: FastifyInstance, _opts: Record<string, unknown>, done: () => void) => {
		instance.addHook("onRequest", (request, reply, hookDone) => {
			if (isEnabled && !isEnabled()) {
				hookDone();
				return;
			}

			const incoming = Array.isArray(request.headers.traceparent)
				? request.headers.traceparent[0]
				: request.headers.traceparent;
			const incomingTracestate = Array.isArray(request.headers.tracestate)
				? request.headers.tracestate[0]
				: request.headers.tracestate;
			const span = startSpanFromTraceparent(incoming, incomingTracestate);

			traceStore.set(request, {
				trace_id: span.trace_id,
				span_id: span.span_id,
				parent_span_id: span.parent_span_id,
				trace_flags: span.trace_flags,
				tracestate: span.tracestate,
			});
			reply.header("traceparent", formatTraceparent(span.trace_id, span.span_id, span.trace_flags));
			if (span.tracestate) reply.header("tracestate", span.tracestate);
			hookDone();
		});

		instance.addHook("onResponse", (request, reply, hookDone) => {
			const trace = traceStore.get(request);
			if (!trace) {
				hookDone();
				return;
			}

			const rawPath = stripQueryAndFragment(request.url);
			const requestPath = sanitizePath ? sanitizePath(rawPath) : rawPath;
			const route = request.routeOptions?.url;
			const duration_ms = Math.round(reply.elapsedTime);

			const event: HttpRequestEvent = {
				record_type: "event",
				spec_version: 1,
				kind: "http.request",
				trace_id: trace.trace_id,
				span_id: trace.span_id,
				parent_span_id: trace.parent_span_id,
				outcome: httpOutcome(reply.statusCode),
				method: request.method,
				path: requestPath,
				route,
				status_code: reply.statusCode,
				duration_ms,
			};

			if (entityPatterns) {
				const entities = extractEntities(requestPath, entityPatterns);
				if (entities) event.entities = entities;
			}

			telemetry.emit(event);
			hookDone();
		});

		done();
	};

	// Fastify encapsulation decorators (replaces fastify-plugin dependency)
	const decorated = plugin as FastifyPluginCallback;
	decorated[Symbol.for("skip-override")] = true;
	decorated[Symbol.for("fastify.display-name")] = "agent-telemetry";

	return decorated;
}

// ---------------------------------------------------------------------------
// Trace context accessor
// ---------------------------------------------------------------------------

/**
 * Get trace context from a Fastify request object.
 *
 * Returns an object with `_trace` suitable for spreading into event
 * dispatch payloads to propagate the trace across async boundaries.
 *
 * @example
 * ```ts
 * app.post('/api/process', async (request, reply) => {
 *   await queue.send({ ...payload, ...getTraceContext(request) })
 * })
 * ```
 */
export function getTraceContext(request: unknown): TraceContextCarrier {
	if (!request || typeof request !== "object") return {};
	const trace = traceStore.get(request);
	if (!trace) return {};
	const carrier: { traceparent: string; tracestate?: string } = {
		traceparent: formatTraceparent(trace.trace_id, trace.span_id, trace.trace_flags),
	};
	if (trace.tracestate) carrier.tracestate = trace.tracestate;
	return { _trace: carrier };
}
