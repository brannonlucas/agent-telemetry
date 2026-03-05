/**
 * Express Adapter
 *
 * Creates Express middleware that traces HTTP requests. Emits http.request
 * telemetry events with method, path, status_code, duration, and extracted entities.
 *
 * No runtime import of express — uses inline types for req/res/next.
 *
 * @example
 * ```ts
 * import { createTelemetry, type HttpEvents } from 'agent-telemetry'
 * import { createExpressTrace, getTraceContext } from 'agent-telemetry/express'
 *
 * const telemetry = await createTelemetry<HttpEvents>()
 * app.use(createExpressTrace({ telemetry }))
 * ```
 */

import { extractEntities } from "../entities.ts";
import { httpOutcome } from "../error.ts";
import { stripQueryAndFragment } from "../fetch-utils.ts";
import { startSpanFromTraceparent } from "../trace-context.ts";
import { formatTraceparent } from "../traceparent.ts";
import type { EntityPattern, HttpRequestEvent, Telemetry, TraceContextCarrier } from "../types.ts";

// ============================================================================
// Inline Express Types (no runtime import of express)
// ============================================================================

interface ExpressRequest {
	method: string;
	originalUrl: string;
	url: string;
	headers: Record<string, string | string[] | undefined>;
	route?: { path?: string };
}

interface ExpressResponse {
	statusCode: number;
	setHeader(name: string, value: string): void;
	on(event: string, listener: () => void): void;
}

type ExpressNextFunction = (err?: unknown) => void;

/** Express middleware function signature. */
export type ExpressMiddleware = (
	req: ExpressRequest,
	res: ExpressResponse,
	next: ExpressNextFunction,
) => void;

// ============================================================================
// Request-Scoped Trace Storage
// ============================================================================

const traceStore = new WeakMap<
	object,
	{ trace_id: string; span_id: string; trace_flags: string; tracestate?: string }
>();

// ============================================================================
// Options
// ============================================================================

/** Options for Express trace middleware. */
export interface ExpressTraceOptions {
	/** Telemetry instance to emit events through. */
	telemetry: Telemetry<HttpRequestEvent>;
	/** Entity patterns for extracting IDs from URL paths. */
	entityPatterns?: EntityPattern[];
	/** Guard function — return false to skip tracing for a request. */
	isEnabled?: () => boolean;
	/** Optional path sanitizer. Receives raw path, returns sanitized path. */
	sanitizePath?: (path: string) => string;
}

// ============================================================================
// Middleware Factory
// ============================================================================

/**
 * Create Express middleware that traces HTTP requests.
 *
 * Generates a trace_id per request (or propagates a valid incoming
 * `traceparent`), stores it on a WeakMap keyed by the request object,
 * sets the `traceparent` response header, and emits an http.request
 * event on completion.
 *
 * Listens on both `"finish"` and `"close"` response events with an
 * emit-once guard to handle aborted requests without double-emission.
 */
export function createExpressTrace(options: ExpressTraceOptions): ExpressMiddleware {
	const { telemetry, entityPatterns, isEnabled, sanitizePath } = options;

	return (req, res, next) => {
		if (isEnabled && !isEnabled()) {
			next();
			return;
		}

		const incoming = Array.isArray(req.headers.traceparent)
			? req.headers.traceparent[0]
			: req.headers.traceparent;
		const incomingTracestate = Array.isArray(req.headers.tracestate)
			? req.headers.tracestate[0]
			: req.headers.tracestate;
		const span = startSpanFromTraceparent(incoming, incomingTracestate);

		traceStore.set(req, {
			trace_id: span.trace_id,
			span_id: span.span_id,
			trace_flags: span.trace_flags,
			tracestate: span.tracestate,
		});

		const start = performance.now();
		let emitted = false;

		const emitOnce = () => {
			if (emitted) return;
			emitted = true;

			const duration_ms = Math.round(performance.now() - start);
			const rawPath = stripQueryAndFragment(req.originalUrl || req.url || "/");
			const requestPath = sanitizePath ? sanitizePath(rawPath) : rawPath;
			const route = req.route?.path;

			// Set traceparent in cleanup (spec §5.2: after handler execution)
			res.setHeader(
				"traceparent",
				formatTraceparent(span.trace_id, span.span_id, span.trace_flags),
			);
			if (span.tracestate) res.setHeader("tracestate", span.tracestate);

			const event: HttpRequestEvent = {
				record_type: "event",
				spec_version: 1,
				kind: "http.request",
				trace_id: span.trace_id,
				span_id: span.span_id,
				parent_span_id: span.parent_span_id,
				outcome: httpOutcome(res.statusCode),
				method: req.method,
				path: requestPath,
				route,
				status_code: res.statusCode,
				duration_ms,
			};

			if (entityPatterns) {
				const entities = extractEntities(requestPath, entityPatterns);
				if (entities) event.entities = entities;
			}

			if (res.statusCode >= 500) {
				event.error_name = `HTTP ${res.statusCode}`;
			}

			telemetry.emit(event);
		};

		res.on("finish", emitOnce);
		res.on("close", emitOnce);

		next();
	};
}

// ============================================================================
// Trace Context Accessor
// ============================================================================

/**
 * Get trace context from an Express request object.
 *
 * Returns an object with `_trace` suitable for spreading into event
 * dispatch payloads to propagate the trace across async boundaries.
 *
 * @example
 * ```ts
 * app.post('/api/process', (req, res) => {
 *   await queue.send({ ...payload, ...getTraceContext(req) })
 * })
 * ```
 */
export function getTraceContext(req: object): TraceContextCarrier {
	const stored = traceStore.get(req);
	if (!stored) return {};
	const trace: { traceparent: string; tracestate?: string } = {
		traceparent: formatTraceparent(stored.trace_id, stored.span_id, stored.trace_flags),
	};
	if (stored.tracestate) trace.tracestate = stored.tracestate;
	return { _trace: trace };
}
