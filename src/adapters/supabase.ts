/**
 * Supabase Adapter
 *
 * Creates a traced fetch function for Supabase's createClient({ global: { fetch } }).
 * Parses Supabase URL patterns to emit rich, service-aware telemetry:
 * - PostgREST calls -> db.query events with table/operation
 * - Auth/Storage/Functions calls -> external.call events with service context
 *
 * Each fetch invocation emits one event. Supabase's built-in retry logic
 * will generate separate events per retry — each is a real network call.
 *
 * duration_ms measures time-to-headers (TTFB). Response is returned untouched.
 *
 * @example
 * ```ts
 * import { createClient } from '@supabase/supabase-js'
 * import { createTelemetry, type SupabaseEvents } from 'agent-telemetry'
 * import { createSupabaseTrace } from 'agent-telemetry/supabase'
 *
 * const telemetry = await createTelemetry<SupabaseEvents>()
 * const tracedFetch = createSupabaseTrace({ telemetry })
 * const supabase = createClient(url, key, { global: { fetch: tracedFetch } })
 * ```
 */

import { httpOutcome, toSafeErrorLabel } from "../error.ts";
import { type FetchFn, resolveInput, resolveUrl } from "../fetch-utils.ts";
import { startSpan } from "../trace-context.ts";
import type {
	DbQueryEvent,
	ExternalCallEvent,
	LegacyTraceContext,
	SupabaseEvents,
	Telemetry,
} from "../types.ts";

export type { FetchFn } from "../fetch-utils.ts";

/** Options for the Supabase trace adapter. */
export interface SupabaseTraceOptions {
	/** Telemetry instance to emit events through. */
	telemetry: Telemetry<SupabaseEvents>;
	/** Base fetch implementation. Default: globalThis.fetch. */
	baseFetch?: FetchFn;
	/** Provide trace context for correlating with a parent HTTP request. */
	getTraceContext?: () => LegacyTraceContext | undefined;
	/** Guard function — return false to skip tracing. */
	isEnabled?: () => boolean;
}

/** Classification result for a Supabase URL. */
type Classification =
	| {
			kind: "db.query";
			provider: "supabase";
			model: string;
			operation: string;
	  }
	| { kind: "external.call"; service: string; operation: string };

/** HTTP method to PostgREST operation mapping. */
const METHOD_TO_OPERATION: Record<string, string> = {
	GET: "select",
	POST: "insert",
	PATCH: "update",
	PUT: "upsert",
	DELETE: "delete",
};

// URL pattern regexes
const REST_RE = /\/rest\/v\d+\/([^?/]+)/;
const AUTH_RE = /\/auth\/v\d+\/(.+)/;
const STORAGE_RE = /\/storage\/v\d+\/object\/([^/]+)/;
const FUNCTIONS_RE = /\/functions\/v\d+\/([^?/]+)/;

/**
 * Classify a Supabase request URL into the appropriate event type.
 */
function classifyRequest(url: URL, method: string): Classification {
	const pathname = url.pathname;

	const restMatch = REST_RE.exec(pathname);
	if (restMatch) {
		const table = restMatch[1] as string;
		const operation = METHOD_TO_OPERATION[method] ?? method.toLowerCase();
		return { kind: "db.query", provider: "supabase", model: table, operation };
	}

	const authMatch = AUTH_RE.exec(pathname);
	if (authMatch) {
		return { kind: "external.call", service: "supabase-auth", operation: authMatch[1] as string };
	}

	const storageMatch = STORAGE_RE.exec(pathname);
	if (storageMatch) {
		return {
			kind: "external.call",
			service: "supabase-storage",
			operation: `${method} ${storageMatch[1] as string}`,
		};
	}

	const functionsMatch = FUNCTIONS_RE.exec(pathname);
	if (functionsMatch) {
		return {
			kind: "external.call",
			service: "supabase-functions",
			operation: functionsMatch[1] as string,
		};
	}

	return { kind: "external.call", service: "supabase", operation: `${method} ${pathname}` };
}

/**
 * Create a traced fetch function for Supabase that emits telemetry events.
 */
export function createSupabaseTrace(options: SupabaseTraceOptions): FetchFn {
	const { telemetry, baseFetch = globalThis.fetch, getTraceContext, isEnabled } = options;

	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		if (isEnabled && !isEnabled()) {
			return baseFetch(input, init);
		}

		const { url, method: resolvedMethod } = resolveInput(input);
		const method = init?.method?.toUpperCase() ?? resolvedMethod.toUpperCase();

		const parsed = resolveUrl(url);

		const classification = classifyRequest(parsed, method);

		const ctx = getTraceContext?.();
		const span = startSpan({
			trace_id: ctx?.trace_id,
			parent_span_id: ctx?.parent_span_id,
			trace_flags: ctx?.trace_flags,
		});

		const start = performance.now();

		try {
			const response = await baseFetch(input, init);
			const duration_ms = Math.round(performance.now() - start);

			if (classification.kind === "db.query") {
				// PostgREST HTTP errors ARE query failures (constraint violations, missing tables, etc.)
				const event: DbQueryEvent = {
					record_type: "event",
					spec_version: 1,
					kind: "db.query",
					trace_id: span.trace_id,
					span_id: span.span_id,
					parent_span_id: span.parent_span_id,
					provider: classification.provider,
					model: classification.model,
					operation: classification.operation,
					duration_ms,
					outcome: response.ok ? "success" : "error",
				};
				telemetry.emit(event);
			} else {
				// Auth/Storage/Functions: use httpOutcome (5xx = error)
				const event: ExternalCallEvent = {
					record_type: "event",
					spec_version: 1,
					kind: "external.call",
					trace_id: span.trace_id,
					span_id: span.span_id,
					parent_span_id: span.parent_span_id,
					service: classification.service,
					operation: classification.operation,
					duration_ms,
					outcome: httpOutcome(response.status),
					status_code: response.status,
				};
				telemetry.emit(event);
			}

			return response;
		} catch (err) {
			const duration_ms = Math.round(performance.now() - start);

			if (classification.kind === "db.query") {
				const event: DbQueryEvent = {
					record_type: "event",
					spec_version: 1,
					kind: "db.query",
					trace_id: span.trace_id,
					span_id: span.span_id,
					parent_span_id: span.parent_span_id,
					provider: classification.provider,
					model: classification.model,
					operation: classification.operation,
					duration_ms,
					outcome: "error",
					error_name: toSafeErrorLabel(err),
				};
				telemetry.emit(event);
			} else {
				const event: ExternalCallEvent = {
					record_type: "event",
					spec_version: 1,
					kind: "external.call",
					trace_id: span.trace_id,
					span_id: span.span_id,
					parent_span_id: span.parent_span_id,
					service: classification.service,
					operation: classification.operation,
					duration_ms,
					outcome: "error",
					error_name: toSafeErrorLabel(err),
				};
				telemetry.emit(event);
			}

			throw err;
		}
	};
}
