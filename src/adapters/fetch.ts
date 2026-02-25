/**
 * Traced Fetch Adapter
 *
 * Wraps fetch with telemetry for external service calls. Does NOT monkey-patch
 * the global — returns a new function with identical semantics.
 *
 * duration_ms measures time-to-headers (TTFB), not total transfer time.
 * The Response object is returned untouched — streaming bodies work correctly.
 *
 * @example
 * ```ts
 * import { createTelemetry, type ExternalEvents } from 'agent-telemetry'
 * import { createTracedFetch } from 'agent-telemetry/fetch'
 *
 * const telemetry = await createTelemetry<ExternalEvents>()
 * const fetch = createTracedFetch({ telemetry })
 *
 * const res = await fetch('https://api.example.com/users')
 * ```
 */

import { generateSpanId, generateTraceId } from "../ids.ts";
import type { ExternalCallEvent, Telemetry } from "../types.ts";

/** Callable fetch signature (without static properties like `preconnect`). */
export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Options for the traced fetch adapter. */
export interface TracedFetchOptions {
	/** Telemetry instance to emit events through. */
	telemetry: Telemetry<ExternalCallEvent>;
	/** Base fetch implementation. Default: globalThis.fetch. */
	baseFetch?: FetchFn;
	/** Provide trace context for correlating with a parent HTTP request. */
	getTraceContext?: () => { traceId: string; parentSpanId?: string } | undefined;
	/** Guard function — return false to skip tracing. */
	isEnabled?: () => boolean;
}

/**
 * Extract URL metadata from the three fetch input types.
 * This is metadata-only — the original input is never modified.
 */
function resolveInput(input: RequestInfo | URL): {
	url: string;
	method: string;
} {
	if (input instanceof Request) {
		return { url: input.url, method: input.method };
	}
	if (input instanceof URL) {
		return { url: input.href, method: "GET" };
	}
	// string — try absolute first, then relative with localhost fallback
	try {
		return { url: new URL(input).href, method: "GET" };
	} catch {
		return {
			url: new URL(input, "http://localhost").href,
			method: "GET",
		};
	}
}

/**
 * Create a traced fetch function that emits external.call telemetry events.
 *
 * The returned function has the same signature as globalThis.fetch.
 * The original input and init are passed through to baseFetch untouched.
 * Non-2xx responses are returned normally (not thrown). Network errors
 * are emitted as status "error" and re-thrown.
 */
export function createTracedFetch(options: TracedFetchOptions): FetchFn {
	const { telemetry, baseFetch = globalThis.fetch, getTraceContext, isEnabled } = options;

	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		if (isEnabled && !isEnabled()) {
			return baseFetch(input, init);
		}

		const { url, method: resolvedMethod } = resolveInput(input);
		const method = init?.method?.toUpperCase() ?? resolvedMethod;

		let service = "unknown";
		let pathname = "/";
		try {
			const parsed = new URL(url);
			service = parsed.hostname;
			pathname = parsed.pathname;
		} catch {
			// keep defaults
		}

		const operation = `${method} ${pathname}`;

		const ctx = getTraceContext?.();
		const traceId = ctx?.traceId ?? generateTraceId();
		const spanId = generateSpanId();

		const start = performance.now();

		try {
			const response = await baseFetch(input, init);
			const duration_ms = Math.round(performance.now() - start);

			telemetry.emit({
				kind: "external.call",
				traceId,
				spanId,
				service,
				operation,
				duration_ms,
				status: "success",
			});

			return response;
		} catch (err) {
			const duration_ms = Math.round(performance.now() - start);

			telemetry.emit({
				kind: "external.call",
				traceId,
				spanId,
				service,
				operation,
				duration_ms,
				status: "error",
			});

			throw err;
		}
	};
}
