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

import {
	type FetchFn,
	defaultPropagateTo,
	injectTraceparent,
	resolveInput,
	resolveUrl,
} from "../fetch-utils.ts";
import { startSpan } from "../trace-context.ts";
import { formatTraceparent } from "../traceparent.ts";
import type { ExternalCallEvent, Telemetry, TraceContext } from "../types.ts";

export type { FetchFn } from "../fetch-utils.ts";

/** Options for the traced fetch adapter. */
export interface TracedFetchOptions {
	/** Telemetry instance to emit events through. */
	telemetry: Telemetry<ExternalCallEvent>;
	/** Base fetch implementation. Default: globalThis.fetch. */
	baseFetch?: FetchFn;
	/** Provide trace context for correlating with a parent HTTP request. */
	getTraceContext?: () => TraceContext | undefined;
	/** Predicate controlling where to forward `traceparent` headers. */
	propagateTo?: (url: URL) => boolean;
	/** Optional callback invoked when responses include `traceparent`. */
	onResponseTraceparent?: (traceparent: string) => void;
	/** Guard function — return false to skip tracing. */
	isEnabled?: () => boolean;
}

/**
 * Create a traced fetch function that emits external.call telemetry events.
 *
 * The returned function has the same signature as globalThis.fetch.
 * Request inputs are only cloned when header propagation is enabled.
 * Non-2xx responses are returned normally (not thrown). Network errors
 * are emitted as status "error" and re-thrown.
 */
export function createTracedFetch(options: TracedFetchOptions): FetchFn {
	const {
		telemetry,
		baseFetch = globalThis.fetch,
		getTraceContext,
		propagateTo,
		onResponseTraceparent,
		isEnabled,
	} = options;

	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		if (isEnabled && !isEnabled()) {
			return baseFetch(input, init);
		}

		const { url, method: resolvedMethod } = resolveInput(input);
		const method = init?.method?.toUpperCase() ?? resolvedMethod.toUpperCase();
		const parsedUrl = resolveUrl(url);

		const service = parsedUrl.hostname;
		const pathname = parsedUrl.pathname;

		const operation = `${method} ${pathname}`;

		const ctx = getTraceContext?.();
		const span = startSpan({
			traceId: ctx?.traceId,
			parentSpanId: ctx?.parentSpanId,
			traceFlags: ctx?.traceFlags,
		});
		const traceparent = formatTraceparent(span.traceId, span.spanId, span.traceFlags);

		const shouldPropagate = (propagateTo ?? defaultPropagateTo)(parsedUrl);
		const outbound = shouldPropagate
			? injectTraceparent(input, init, traceparent)
			: { input, init };

		const start = performance.now();

		try {
			const response = await baseFetch(outbound.input, outbound.init);
			const duration_ms = Math.round(performance.now() - start);
			const responseTraceparent = response.headers.get("traceparent");
			if (responseTraceparent) {
				onResponseTraceparent?.(responseTraceparent);
			}

			telemetry.emit({
				kind: "external.call",
				traceId: span.traceId,
				spanId: span.spanId,
				parentSpanId: span.parentSpanId,
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
				traceId: span.traceId,
				spanId: span.spanId,
				parentSpanId: span.parentSpanId,
				service,
				operation,
				duration_ms,
				status: "error",
			});

			throw err;
		}
	};
}
