import { generateSpanId, generateTraceId } from "./ids.ts";
import { startSpan } from "./trace-context.ts";
import { formatTraceparent, parseTraceparent } from "./traceparent.ts";
import type { TraceContext } from "./types.ts";

const TRACE_FLAGS_RE = /^[\da-f]{2}$/;

/** Callable fetch signature (without static properties like `preconnect`). */
export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface BrowserTraceState {
	traceId: string;
	parentSpanId: string;
	traceFlags: string;
}

function normalizeTraceFlags(traceFlags: string | undefined): string {
	if (!traceFlags) return "01";
	const normalized = traceFlags.toLowerCase();
	return TRACE_FLAGS_RE.test(normalized) ? normalized : "01";
}

function getLocationOrigin(): string | undefined {
	const globalWithLocation = globalThis as { location?: { origin?: string } };
	return globalWithLocation.location?.origin;
}

function resolveInput(input: RequestInfo | URL): {
	url: string;
} {
	if (input instanceof Request) {
		return { url: input.url };
	}
	if (input instanceof URL) {
		return { url: input.href };
	}
	try {
		return { url: new URL(input).href };
	} catch {
		return {
			url: new URL(input, getLocationOrigin() ?? "http://localhost").href,
		};
	}
}

function resolveUrl(url: string): URL {
	const base = getLocationOrigin() ?? "http://localhost";
	return new URL(url, base);
}

function injectTraceparent(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	traceparent: string,
): { input: RequestInfo | URL; init: RequestInit | undefined } {
	if (input instanceof Request) {
		const request = new Request(input, init);
		const headers = new Headers(request.headers);
		headers.set("traceparent", traceparent);
		return { input: new Request(request, { headers }), init: undefined };
	}

	const headers = new Headers(init?.headers);
	headers.set("traceparent", traceparent);
	return { input, init: { ...init, headers } };
}

function defaultPropagateTo(url: URL): boolean {
	const origin = getLocationOrigin();
	return origin != null && url.origin === origin;
}

function readMetaTraceparent(metaName: string): string | undefined {
	if (typeof document === "undefined") return undefined;
	const value = document.querySelector(`meta[name="${metaName}"]`)?.getAttribute("content");
	return value ?? undefined;
}

function toTraceContext(state: BrowserTraceState): TraceContext {
	return {
		traceId: state.traceId,
		parentSpanId: state.parentSpanId,
		traceFlags: state.traceFlags,
	};
}

/** Browser trace context manager for request propagation. */
export interface BrowserTraceContext {
	/** Get the current trace context for child operations. */
	getTraceContext(): TraceContext;
	/** Get a serialized `traceparent` for the current context. */
	getTraceparent(): string;
	/** Replace the current trace context. */
	setTraceContext(context: TraceContext): void;
	/** Parse and adopt an incoming `traceparent` header value. */
	updateFromTraceparent(traceparent: string | null | undefined): boolean;
	/**
	 * Run work under a child span.
	 * The callback receives a context whose `parentSpanId` is the created span ID.
	 */
	withSpan<T>(
		name: string,
		run: (context: TraceContext & { spanId: string; name: string }) => Promise<T> | T,
	): Promise<T>;
}

export interface BrowserTraceContextOptions {
	/** Optional bootstrap header value (e.g. from SSR). */
	initialTraceparent?: string | null;
	/** Meta tag name used for bootstrap lookup. Default: "traceparent". */
	metaName?: string;
}

/**
 * Create browser trace context.
 *
 * Bootstrap order:
 * 1) options.initialTraceparent
 * 2) <meta name="traceparent" content="...">
 * 3) fresh trace/span IDs
 */
export function createBrowserTraceContext(
	options: BrowserTraceContextOptions = {},
): BrowserTraceContext {
	const metaName = options.metaName ?? "traceparent";
	const bootstrap = options.initialTraceparent ?? readMetaTraceparent(metaName);
	const parsed = parseTraceparent(bootstrap);

	const state: BrowserTraceState = {
		traceId: parsed?.traceId ?? generateTraceId(),
		parentSpanId: parsed?.parentId ?? generateSpanId(),
		traceFlags: normalizeTraceFlags(parsed?.traceFlags),
	};

	const api: BrowserTraceContext = {
		getTraceContext() {
			return toTraceContext(state);
		},
		getTraceparent() {
			return formatTraceparent(state.traceId, state.parentSpanId, state.traceFlags);
		},
		setTraceContext(context) {
			state.traceId = context.traceId;
			state.parentSpanId = context.parentSpanId;
			state.traceFlags = normalizeTraceFlags(context.traceFlags);
		},
		updateFromTraceparent(traceparent) {
			const incoming = parseTraceparent(traceparent);
			if (!incoming) return false;
			state.traceId = incoming.traceId;
			state.parentSpanId = incoming.parentId;
			state.traceFlags = normalizeTraceFlags(incoming.traceFlags);
			return true;
		},
		async withSpan(name, run) {
			const currentParent = state.parentSpanId;
			const span = startSpan({
				traceId: state.traceId,
				parentSpanId: currentParent,
				traceFlags: state.traceFlags,
			});

			state.parentSpanId = span.spanId;
			try {
				return await run({
					traceId: span.traceId,
					parentSpanId: span.spanId,
					traceFlags: span.traceFlags,
					spanId: span.spanId,
					name,
				});
			} finally {
				state.parentSpanId = currentParent;
			}
		},
	};

	return api;
}

export interface BrowserTracedFetchOptions {
	/** Base fetch implementation. Default: globalThis.fetch. */
	baseFetch?: FetchFn;
	/** Shared trace context manager. If omitted, a new one is created. */
	trace?: BrowserTraceContext;
	/** Predicate controlling where to forward `traceparent`. Default: same-origin only. */
	propagateTo?: (url: URL) => boolean;
	/** Whether to adopt response `traceparent` headers. Default: true. */
	updateContextFromResponse?: boolean;
}

/**
 * Create a browser fetch wrapper that injects W3C `traceparent`.
 *
 * By default it only propagates headers to same-origin URLs.
 */
export function createBrowserTracedFetch(options: BrowserTracedFetchOptions = {}): FetchFn {
	const {
		baseFetch = globalThis.fetch,
		trace = createBrowserTraceContext(),
		propagateTo = defaultPropagateTo,
		updateContextFromResponse = true,
	} = options;

	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const { url } = resolveInput(input);
		const parsedUrl = resolveUrl(url);

		const ctx = trace.getTraceContext();
		const span = startSpan({
			traceId: ctx.traceId,
			parentSpanId: ctx.parentSpanId,
			traceFlags: ctx.traceFlags,
		});
		const traceparent = formatTraceparent(span.traceId, span.spanId, span.traceFlags);

		const outbound = propagateTo(parsedUrl)
			? injectTraceparent(input, init, traceparent)
			: { input, init };

		const response = await baseFetch(outbound.input, outbound.init);

		if (updateContextFromResponse) {
			const responseTraceparent = response.headers.get("traceparent");
			if (!responseTraceparent || !trace.updateFromTraceparent(responseTraceparent)) {
				trace.setTraceContext({
					traceId: span.traceId,
					parentSpanId: span.spanId,
					traceFlags: span.traceFlags,
				});
			}
		}

		return response;
	};
}
