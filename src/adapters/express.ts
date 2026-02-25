/**
 * Express Adapter
 *
 * Creates Express middleware that traces HTTP requests. Emits http.request
 * telemetry events with method, path, status, duration, and extracted entities.
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
import { startSpanFromTraceparent } from "../trace-context.ts";
import { formatTraceparent } from "../traceparent.ts";
import type { EntityPattern, HttpRequestEvent, Telemetry } from "../types.ts";

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

const traceStore = new WeakMap<object, { traceId: string; spanId: string; traceFlags: string }>();

function stripQueryAndFragment(url: string): string {
	const queryIdx = url.indexOf("?");
	const hashIdx = url.indexOf("#");
	const cutIdx =
		queryIdx === -1 ? hashIdx : hashIdx === -1 ? queryIdx : Math.min(queryIdx, hashIdx);
	const clean = cutIdx === -1 ? url : url.slice(0, cutIdx);
	return clean || "/";
}

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
}

// ============================================================================
// Middleware Factory
// ============================================================================

/**
 * Create Express middleware that traces HTTP requests.
 *
 * Generates a traceId per request (or propagates a valid incoming
 * `traceparent`), stores it on a WeakMap keyed by the request object,
 * sets the `traceparent` response header, and emits an http.request
 * event on completion.
 *
 * Listens on both `"finish"` and `"close"` response events with an
 * emit-once guard to handle aborted requests without double-emission.
 */
export function createExpressTrace(options: ExpressTraceOptions): ExpressMiddleware {
	const { telemetry, entityPatterns, isEnabled } = options;

	return (req, res, next) => {
		if (isEnabled && !isEnabled()) {
			next();
			return;
		}

		const incoming = Array.isArray(req.headers.traceparent)
			? req.headers.traceparent[0]
			: req.headers.traceparent;
		const span = startSpanFromTraceparent(incoming);

		traceStore.set(req, {
			traceId: span.traceId,
			spanId: span.spanId,
			traceFlags: span.traceFlags,
		});
		res.setHeader("traceparent", formatTraceparent(span.traceId, span.spanId, span.traceFlags));

		const start = performance.now();
		let emitted = false;

		const emitOnce = () => {
			if (emitted) return;
			emitted = true;

			const duration_ms = Math.round(performance.now() - start);
			const requestPath = stripQueryAndFragment(req.originalUrl || req.url || "/");
			const path = req.route?.path ?? requestPath;

			const event: HttpRequestEvent = {
				kind: "http.request",
				traceId: span.traceId,
				spanId: span.spanId,
				parentSpanId: span.parentSpanId,
				method: req.method,
				path,
				status: res.statusCode,
				duration_ms,
			};

			if (entityPatterns) {
				const entities = extractEntities(requestPath, entityPatterns);
				if (entities) event.entities = entities;
			}

			if (res.statusCode >= 500) {
				event.error = `HTTP ${res.statusCode}`;
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
export function getTraceContext(
	req: object,
):
	| { _trace: { traceId: string; parentSpanId: string; traceFlags?: string } }
	| Record<string, never> {
	const stored = traceStore.get(req);
	if (!stored) return {};
	return {
		_trace: {
			traceId: stored.traceId,
			parentSpanId: stored.spanId,
			traceFlags: stored.traceFlags,
		},
	};
}
