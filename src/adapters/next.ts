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
import { toSafeErrorLabel } from "../error.ts";
import { startSpan, startSpanFromTraceparent } from "../trace-context.ts";
import { formatTraceparent, parseTraceparent } from "../traceparent.ts";
import type { EntityPattern, HttpRequestEvent, Telemetry } from "../types.ts";

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

function stripQueryAndFragment(url: string): string {
	const queryIdx = url.indexOf("?");
	const hashIdx = url.indexOf("#");
	const cutIdx =
		queryIdx === -1 ? hashIdx : hashIdx === -1 ? queryIdx : Math.min(queryIdx, hashIdx);
	const clean = cutIdx === -1 ? url : url.slice(0, cutIdx);
	return clean || "/";
}

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
		const span = startSpanFromTraceparent(incoming);
		const headers = cloneHeaders(request.headers);
		headers.set("traceparent", formatTraceparent(span.traceId, span.spanId, span.traceFlags));

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
	const { telemetry, entityPatterns, isEnabled } = options;

	return (request, context) => {
		if (isEnabled && !isEnabled()) {
			return handler(request, context);
		}

		const incoming = request.headers.get("traceparent");
		const span = startSpanFromTraceparent(incoming);
		const path = resolvePath(request);
		const start = performance.now();

		const emit = (status: number, error?: string) => {
			const event: HttpRequestEvent = {
				kind: "http.request",
				traceId: span.traceId,
				spanId: span.spanId,
				parentSpanId: span.parentSpanId,
				method: request.method,
				path,
				status,
				duration_ms: Math.round(performance.now() - start),
			};

			if (entityPatterns) {
				const entities = extractEntities(path, entityPatterns);
				if (entities) event.entities = entities;
			}

			if (error) {
				event.error = error;
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
				kind: "http.request",
				traceId: span.traceId,
				spanId: span.spanId,
				parentSpanId: span.parentSpanId,
				method: "ACTION",
				path: name,
				status: 200,
				duration_ms: Math.round(performance.now() - start),
			});
			return result;
		} catch (err) {
			telemetry.emit({
				kind: "http.request",
				traceId: span.traceId,
				spanId: span.spanId,
				parentSpanId: span.parentSpanId,
				method: "ACTION",
				path: name,
				status: 500,
				duration_ms: Math.round(performance.now() - start),
				error: toSafeErrorLabel(err),
			});
			throw err;
		}
	};
}

// ---------------------------------------------------------------------------
// Header-based trace context accessor
// ---------------------------------------------------------------------------

export function getTraceContext(
	request: NextLikeRequest,
):
	| { _trace: { traceId: string; parentSpanId: string; traceFlags?: string } }
	| Record<string, never> {
	const parsed = parseTraceparent(request.headers.get("traceparent"));
	if (!parsed) return {};
	return {
		_trace: {
			traceId: parsed.traceId,
			parentSpanId: parsed.parentId,
			traceFlags: parsed.traceFlags,
		},
	};
}
