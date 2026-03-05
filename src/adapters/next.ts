/**
 * Next.js Adapter
 *
 * Next.js middleware and route handlers run in separate execution contexts, so
 * tracing is split into:
 * 1) middleware trace propagation (`createNextMiddleware`)
 * 2) route handler tracing (`withNextTrace`)
 * 3) server action tracing (`withActionTrace`)
 */

import { extractEntities } from "../entities.ts";
import { httpOutcome, toSafeErrorLabel } from "../error.ts";
import { stripQueryAndFragment } from "../fetch-utils.ts";
import { startSpan, startSpanFromTraceparent } from "../trace-context.ts";
import { formatTraceparent, parseTraceparent } from "../traceparent.ts";
import type { EntityPattern, HttpRequestEvent, Telemetry, TraceContextCarrier } from "../types.ts";

// ---------------------------------------------------------------------------
// Inline Next-like types (no runtime import of next/next/server)
// ---------------------------------------------------------------------------

export interface NextLikeRequest {
	method: string;
	headers: { get(name: string): string | null };
	url: string;
	nextUrl?: { pathname: string };
}

export interface NextLikeResponse {
	status: number;
}

export interface NextResponseInitLike {
	request?: { headers?: Headers };
}

export type RouteHandler<TContext = unknown> = (
	request: NextLikeRequest,
	context?: TContext,
) => Response | Promise<Response>;

type NextResponseLike = {
	next: (init?: NextResponseInitLike) => NextLikeResponse;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface NextMiddlewareOptions {
	/** Guard function -- return false to skip trace injection. */
	isEnabled?: () => boolean;
}

export interface NextTraceOptions {
	/** Telemetry instance to emit events through. */
	telemetry: Telemetry<HttpRequestEvent>;
	/** Entity patterns for extracting IDs from URL paths. */
	entityPatterns?: EntityPattern[];
	/** Guard function -- return false to skip tracing. */
	isEnabled?: () => boolean;
	/** Optional path sanitizer. Receives raw path, returns sanitized path. */
	sanitizePath?: (path: string) => string;
}

export interface ActionTraceOptions {
	/** Telemetry instance to emit events through. */
	telemetry: Telemetry<HttpRequestEvent>;
	/** Logical action name emitted as event path. */
	name: string;
	/** Guard function -- return false to skip tracing. */
	isEnabled?: () => boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolvePath(request: NextLikeRequest): string {
	if (request.nextUrl?.pathname) {
		return stripQueryAndFragment(request.nextUrl.pathname);
	}
	try {
		const parsed = new URL(request.url, "http://localhost");
		return stripQueryAndFragment(parsed.pathname);
	} catch {
		return stripQueryAndFragment(request.url || "/");
	}
}

function cloneHeaders(headers: { get(name: string): string | null }): Headers {
	try {
		return new Headers(headers as HeadersInit);
	} catch {
		const fallback = new Headers();
		const traceparent = headers.get("traceparent");
		if (traceparent) fallback.set("traceparent", traceparent);
		return fallback;
	}
}

function resolveNextResponse(): NextResponseLike {
	const maybeNextResponse = (globalThis as { NextResponse?: NextResponseLike }).NextResponse;
	if (!maybeNextResponse || typeof maybeNextResponse.next !== "function") {
		throw new Error("NextResponse.next is not available in this runtime");
	}
	return maybeNextResponse;
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
	return typeof (value as Promise<T>)?.then === "function";
}

// ---------------------------------------------------------------------------
// Middleware trace propagation
// ---------------------------------------------------------------------------

export type NextMiddleware = (request: NextLikeRequest) => NextLikeResponse;

/**
 * Create Next.js middleware that injects a child `traceparent` header for the
 * downstream route handler.
 *
 * This middleware does not emit events because it cannot measure route handler
 * duration in the same execution context.
 */
export function createNextMiddleware(options: NextMiddlewareOptions = {}): NextMiddleware {
	const { isEnabled } = options;

	return (request) => {
		const nextResponse = resolveNextResponse();
		if (isEnabled && !isEnabled()) {
			return nextResponse.next();
		}

		const incoming = request.headers.get("traceparent");
		const incomingTracestate = request.headers.get("tracestate");
		const span = startSpanFromTraceparent(incoming, incomingTracestate);
		const headers = cloneHeaders(request.headers);
		headers.set("traceparent", formatTraceparent(span.trace_id, span.span_id, span.trace_flags));
		if (span.tracestate) headers.set("tracestate", span.tracestate);

		return nextResponse.next({ request: { headers } });
	};
}

// ---------------------------------------------------------------------------
// Route handler tracing
// ---------------------------------------------------------------------------

/**
 * Wrap a Next.js App Router route handler with tracing and http.request emit.
 */
export function withNextTrace<TContext>(
	handler: RouteHandler<TContext>,
	options: NextTraceOptions,
): RouteHandler<TContext> {
	const { telemetry, entityPatterns, isEnabled, sanitizePath } = options;

	return (request, context) => {
		if (isEnabled && !isEnabled()) {
			return handler(request, context);
		}

		const incoming = request.headers.get("traceparent");
		const span = startSpanFromTraceparent(incoming);
		const rawPath = resolvePath(request);
		const path = sanitizePath ? sanitizePath(rawPath) : rawPath;
		const start = performance.now();

		const emit = (status_code: number, error_name?: string) => {
			const event: HttpRequestEvent = {
				record_type: "event",
				spec_version: 1,
				kind: "http.request",
				trace_id: span.trace_id,
				span_id: span.span_id,
				parent_span_id: span.parent_span_id,
				outcome: httpOutcome(status_code),
				method: request.method,
				path,
				status_code,
				duration_ms: Math.round(performance.now() - start),
			};

			if (entityPatterns) {
				const entities = extractEntities(path, entityPatterns);
				if (entities) event.entities = entities;
			}

			if (error_name) {
				event.error_name = error_name;
			}

			telemetry.emit(event);
		};

		try {
			const result = handler(request, context);
			if (isPromise(result)) {
				return result
					.then((response) => {
						emit(response.status);
						return response;
					})
					.catch((err) => {
						emit(500, toSafeErrorLabel(err));
						throw err;
					});
			}

			emit(result.status);
			return result;
		} catch (err) {
			emit(500, toSafeErrorLabel(err));
			throw err;
		}
	};
}

// ---------------------------------------------------------------------------
// Server action tracing
// ---------------------------------------------------------------------------

/**
 * Wrap a Next.js Server Action with tracing and http.request emit.
 */
export function withActionTrace<TArgs extends unknown[], TResult>(
	action: (...args: TArgs) => TResult | Promise<TResult>,
	options: ActionTraceOptions,
): (...args: TArgs) => Promise<TResult> {
	const { telemetry, name, isEnabled } = options;

	return async (...args: TArgs): Promise<TResult> => {
		if (isEnabled && !isEnabled()) {
			return action(...args);
		}

		const span = startSpan();
		const start = performance.now();

		try {
			const result = await action(...args);
			telemetry.emit({
				record_type: "event",
				spec_version: 1,
				kind: "http.request",
				trace_id: span.trace_id,
				span_id: span.span_id,
				parent_span_id: span.parent_span_id,
				outcome: "success",
				method: "ACTION",
				path: name,
				status_code: 200,
				duration_ms: Math.round(performance.now() - start),
			});
			return result;
		} catch (err) {
			telemetry.emit({
				record_type: "event",
				spec_version: 1,
				kind: "http.request",
				trace_id: span.trace_id,
				span_id: span.span_id,
				parent_span_id: span.parent_span_id,
				outcome: "error",
				method: "ACTION",
				path: name,
				status_code: 500,
				duration_ms: Math.round(performance.now() - start),
				error_name: toSafeErrorLabel(err),
			});
			throw err;
		}
	};
}

// ---------------------------------------------------------------------------
// Header-based trace context accessor
// ---------------------------------------------------------------------------

export function getTraceContext(request: NextLikeRequest): TraceContextCarrier {
	const parsed = parseTraceparent(request.headers.get("traceparent"));
	if (!parsed) return {};
	const trace: { traceparent: string; tracestate?: string } = {
		traceparent: formatTraceparent(parsed.traceId, parsed.parentId, parsed.traceFlags),
	};
	const tracestate = request.headers.get("tracestate");
	if (tracestate) trace.tracestate = tracestate;
	return { _trace: trace };
}
