import {
	type FetchFn,
	defaultPropagateTo,
	injectTraceparent,
	resolveInput,
	resolveUrl,
} from "./fetch-utils.ts";
import { generateSpanId, generateTraceId } from "./ids.ts";
import { normalizeTraceFlags, startSpan } from "./trace-context.ts";
import { formatTraceparent, parseTraceparent } from "./traceparent.ts";
import type { LegacyTraceContext } from "./types.ts";

export type { FetchFn } from "./fetch-utils.ts";

/** Browser trace state — decomposed for internal manipulation. */
type BrowserTraceState = Required<LegacyTraceContext>;

function readMetaContent(metaName: string): string | undefined {
	if (typeof document === "undefined") return undefined;
	const value = document.querySelector(`meta[name="${metaName}"]`)?.getAttribute("content");
	return value ?? undefined;
}

/** Browser trace context manager for request propagation. */
export interface BrowserTraceContext {
	/** Get the current trace context for child operations. */
	getTraceContext(): LegacyTraceContext;
	/** Get a serialized `traceparent` for the current context. */
	getTraceparent(): string;
	/** Replace the current trace context. */
	setTraceContext(context: LegacyTraceContext): void;
	/** Parse and adopt an incoming `traceparent` header value. */
	updateFromTraceparent(traceparent: string | null | undefined): boolean;
	/**
	 * Run work under a child span.
	 * The callback receives a context whose `parent_span_id` is the created span ID.
	 */
	withSpan<T>(
		name: string,
		run: (context: LegacyTraceContext & { span_id: string; name: string }) => Promise<T> | T,
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
	const metaName = options.metaName ?? "agent-telemetry-traceparent";
	const bootstrap = options.initialTraceparent ?? readMetaContent(metaName);
	const parsed = parseTraceparent(bootstrap);

	const state: BrowserTraceState = {
		trace_id: parsed?.traceId ?? generateTraceId(),
		parent_span_id: parsed?.parentId ?? generateSpanId(),
		trace_flags: normalizeTraceFlags(parsed?.traceFlags),
	};

	const api: BrowserTraceContext = {
		getTraceContext() {
			return { ...state };
		},
		getTraceparent() {
			return formatTraceparent(state.trace_id, state.parent_span_id, state.trace_flags);
		},
		setTraceContext(context) {
			state.trace_id = context.trace_id;
			state.parent_span_id = context.parent_span_id;
			state.trace_flags = normalizeTraceFlags(context.trace_flags);
		},
		updateFromTraceparent(traceparent) {
			const incoming = parseTraceparent(traceparent);
			if (!incoming) return false;
			state.trace_id = incoming.traceId;
			state.parent_span_id = incoming.parentId;
			state.trace_flags = normalizeTraceFlags(incoming.traceFlags);
			return true;
		},
		async withSpan(name, run) {
			const currentParent = state.parent_span_id;
			const span = startSpan({
				trace_id: state.trace_id,
				parent_span_id: currentParent,
				trace_flags: state.trace_flags,
			});

			state.parent_span_id = span.span_id;
			try {
				return await run({
					trace_id: span.trace_id,
					parent_span_id: span.span_id,
					trace_flags: span.trace_flags,
					span_id: span.span_id,
					name,
				});
			} finally {
				state.parent_span_id = currentParent;
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
		updateContextFromResponse = false,
	} = options;

	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const { url } = resolveInput(input);
		const parsedUrl = resolveUrl(url);

		const ctx = trace.getTraceContext();
		const span = startSpan({
			trace_id: ctx.trace_id,
			parent_span_id: ctx.parent_span_id,
			trace_flags: ctx.trace_flags,
		});
		const traceparent = formatTraceparent(span.trace_id, span.span_id, span.trace_flags);

		const outbound = propagateTo(parsedUrl)
			? injectTraceparent(input, init, traceparent)
			: { input, init };

		const response = await baseFetch(outbound.input, outbound.init);

		if (updateContextFromResponse) {
			const responseTraceparent = response.headers.get("traceparent");
			if (!responseTraceparent || !trace.updateFromTraceparent(responseTraceparent)) {
				trace.setTraceContext({
					trace_id: span.trace_id,
					parent_span_id: span.span_id,
					trace_flags: span.trace_flags,
				});
			}
		}

		return response;
	};
}
