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

import { httpOutcome } from "../error.ts";
import {
	type FetchFn,
	defaultPropagateTo,
	injectTraceparent,
	resolveInput,
	resolveUrl,
} from "../fetch-utils.ts";
import { startSpan } from "../trace-context.ts";
import { formatTraceparent } from "../traceparent.ts";
import type { ExternalCallEvent, LegacyTraceContext, Telemetry } from "../types.ts";

export type { FetchFn } from "../fetch-utils.ts";

/** Options for the traced fetch adapter. */
export interface TracedFetchOptions {
	/** Telemetry instance to emit events through. */
	telemetry: Telemetry<ExternalCallEvent>;
	/** Base fetch implementation. Default: globalThis.fetch. */
	baseFetch?: FetchFn;
	/** Provide trace context for correlating with a parent HTTP request. */
	getTraceContext?: () => LegacyTraceContext | undefined;
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
 * are emitted as outcome "error" and re-thrown.
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
			trace_id: ctx?.trace_id,
			parent_span_id: ctx?.parent_span_id,
			trace_flags: ctx?.trace_flags,
		});
		const traceparent = formatTraceparent(span.trace_id, span.span_id, span.trace_flags);

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

			// Spec §7.8: 5xx = outcome "error", everything else = "success".
			telemetry.emit({
				record_type: "event",
				spec_version: 1,
				kind: "external.call",
				trace_id: span.trace_id,
				span_id: span.span_id,
				parent_span_id: span.parent_span_id,
				service,
				operation,
				duration_ms,
				outcome: httpOutcome(response.status),
				status_code: response.status,
			});

			return response;
		} catch (err) {
			const duration_ms = Math.round(performance.now() - start);

			// Spec §7.8: network-level failure = outcome "error".
			telemetry.emit({
				record_type: "event",
				spec_version: 1,
				kind: "external.call",
				trace_id: span.trace_id,
				span_id: span.span_id,
				parent_span_id: span.parent_span_id,
				service,
				operation,
				duration_ms,
				outcome: "error",
			});

			throw err;
		}
	};
}
