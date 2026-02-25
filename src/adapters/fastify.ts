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
import { generateSpanId, generateTraceId } from "../ids.ts";
import { formatTraceparent, parseTraceparent } from "../traceparent.ts";
import type { EntityPattern, HttpRequestEvent, Telemetry } from "../types.ts";

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

const traceStore = new WeakMap<object, { traceId: string; spanId: string }>();

function stripQueryAndFragment(url: string): string {
	const queryIdx = url.indexOf("?");
	const hashIdx = url.indexOf("#");
	const cutIdx =
		queryIdx === -1 ? hashIdx : hashIdx === -1 ? queryIdx : Math.min(queryIdx, hashIdx);
	const clean = cutIdx === -1 ? url : url.slice(0, cutIdx);
	return clean || "/";
}

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
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

/**
 * Create a Fastify plugin that traces HTTP requests.
 *
 * Registers onRequest and onResponse hooks. The onRequest hook generates
 * a traceId (or propagates a valid incoming `traceparent`), stores it in
 * a WeakMap keyed on the Fastify request object, and sets the response
 * `traceparent` header. The onResponse hook emits an http.request event
 * using `reply.elapsedTime` for high-resolution duration.
 */
export function createFastifyTrace(options: FastifyTraceOptions): FastifyPluginCallback {
	const { telemetry, entityPatterns, isEnabled } = options;

	const plugin = (instance: FastifyInstance, _opts: Record<string, unknown>, done: () => void) => {
		instance.addHook("onRequest", (request, reply, hookDone) => {
			if (isEnabled && !isEnabled()) {
				hookDone();
				return;
			}

			const incoming = Array.isArray(request.headers.traceparent)
				? request.headers.traceparent[0]
				: request.headers.traceparent;
			const parsed = parseTraceparent(incoming);
			const traceId = parsed?.traceId ?? generateTraceId();
			const spanId = generateSpanId();

			traceStore.set(request, { traceId, spanId });
			reply.header("traceparent", formatTraceparent(traceId, spanId));
			hookDone();
		});

		instance.addHook("onResponse", (request, reply, hookDone) => {
			const trace = traceStore.get(request);
			if (!trace) {
				hookDone();
				return;
			}

			const requestPath = stripQueryAndFragment(request.url);
			const path = request.routeOptions?.url ?? requestPath;
			const duration_ms = Math.round(reply.elapsedTime);

			const event: HttpRequestEvent = {
				kind: "http.request",
				traceId: trace.traceId,
				method: request.method,
				path,
				status: reply.statusCode,
				duration_ms,
			};

			if (entityPatterns) {
				// Extract entities from the actual URL (with real IDs),
				// not the parameterized route pattern
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
export function getTraceContext(
	request: unknown,
): { _trace: { traceId: string; parentSpanId: string } } | Record<string, never> {
	if (!request || typeof request !== "object") return {};
	const trace = traceStore.get(request);
	if (!trace) return {};
	return { _trace: { traceId: trace.traceId, parentSpanId: trace.spanId } };
}
