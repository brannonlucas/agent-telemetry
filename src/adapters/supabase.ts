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

import { toSafeErrorLabel } from "../error.ts";
import { generateSpanId, generateTraceId } from "../ids.ts";
import type { DbQueryEvent, ExternalCallEvent, SupabaseEvents, Telemetry } from "../types.ts";

/** Callable fetch signature (without static properties like `preconnect`). */
export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Options for the Supabase trace adapter. */
export interface SupabaseTraceOptions {
	/** Telemetry instance to emit events through. */
	telemetry: Telemetry<SupabaseEvents>;
	/** Base fetch implementation. Default: globalThis.fetch. */
	baseFetch?: FetchFn;
	/** Provide trace context for correlating with a parent HTTP request. */
	getTraceContext?: () => { traceId: string; parentSpanId?: string } | undefined;
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

// URL pattern regexes — use /v\d+/ to handle future API versions (I5).
const REST_RE = /\/rest\/v\d+\/([^?/]+)/;
const AUTH_RE = /\/auth\/v\d+\/(.+)/;
const STORAGE_RE = /\/storage\/v\d+\/object\/([^/]+)/;
const FUNCTIONS_RE = /\/functions\/v\d+\/([^?/]+)/;

/**
 * Extract URL metadata from the three fetch input types.
 * This is metadata-only — the original input is never modified (C3/C4).
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
	// string
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
 * Classify a Supabase request URL into the appropriate event type.
 * Uses the URL pathname to determine if it's a PostgREST, Auth,
 * Storage, Functions, or fallback request.
 */
function classifyRequest(url: URL, method: string): Classification {
	const pathname = url.pathname;

	// PostgREST: /rest/v{N}/{table}
	const restMatch = REST_RE.exec(pathname);
	if (restMatch) {
		const table = restMatch[1];
		const operation = METHOD_TO_OPERATION[method] ?? method.toLowerCase();
		return {
			kind: "db.query",
			provider: "supabase",
			model: table,
			operation,
		};
	}

	// Auth: /auth/v{N}/{endpoint}
	const authMatch = AUTH_RE.exec(pathname);
	if (authMatch) {
		return {
			kind: "external.call",
			service: "supabase-auth",
			operation: authMatch[1],
		};
	}

	// Storage: /storage/v{N}/object/{bucket}/...
	const storageMatch = STORAGE_RE.exec(pathname);
	if (storageMatch) {
		return {
			kind: "external.call",
			service: "supabase-storage",
			operation: `${method} ${storageMatch[1]}`,
		};
	}

	// Functions: /functions/v{N}/{name}
	const functionsMatch = FUNCTIONS_RE.exec(pathname);
	if (functionsMatch) {
		return {
			kind: "external.call",
			service: "supabase-functions",
			operation: functionsMatch[1],
		};
	}

	// Fallback: unknown path
	return {
		kind: "external.call",
		service: "supabase",
		operation: `${method} ${pathname}`,
	};
}

/**
 * Create a traced fetch function for Supabase that emits telemetry events.
 *
 * The returned function has the same signature as globalThis.fetch.
 * The original input and init are passed through to baseFetch untouched.
 * The Response object is returned as-is — streaming bodies work correctly.
 */
export function createSupabaseTrace(options: SupabaseTraceOptions): FetchFn {
	const { telemetry, baseFetch = globalThis.fetch, getTraceContext, isEnabled } = options;

	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		if (isEnabled && !isEnabled()) {
			return baseFetch(input, init);
		}

		// Extract metadata only — original input is never modified.
		const { url, method: resolvedMethod } = resolveInput(input);
		const method = init?.method?.toUpperCase() ?? resolvedMethod.toUpperCase();

		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			parsed = new URL(url, "http://localhost");
		}

		const classification = classifyRequest(parsed, method);

		const ctx = getTraceContext?.();
		const traceId = ctx?.traceId ?? generateTraceId();
		const spanId = generateSpanId();

		const start = performance.now();

		try {
			// Pass ORIGINAL input/init to baseFetch unchanged.
			const response = await baseFetch(input, init);
			const duration_ms = Math.round(performance.now() - start);

			if (classification.kind === "db.query") {
				const event: DbQueryEvent = {
					kind: "db.query",
					traceId,
					spanId,
					provider: classification.provider,
					model: classification.model,
					operation: classification.operation,
					duration_ms,
					status: "success",
				};
				telemetry.emit(event);
			} else {
				const event: ExternalCallEvent = {
					kind: "external.call",
					traceId,
					spanId,
					service: classification.service,
					operation: classification.operation,
					duration_ms,
					status: "success",
				};
				telemetry.emit(event);
			}

			return response;
		} catch (err) {
			const duration_ms = Math.round(performance.now() - start);

			if (classification.kind === "db.query") {
				const event: DbQueryEvent = {
					kind: "db.query",
					traceId,
					spanId,
					provider: classification.provider,
					model: classification.model,
					operation: classification.operation,
					duration_ms,
					status: "error",
					error: toSafeErrorLabel(err),
				};
				telemetry.emit(event);
			} else {
				const event: ExternalCallEvent = {
					kind: "external.call",
					traceId,
					spanId,
					service: classification.service,
					operation: classification.operation,
					duration_ms,
					status: "error",
				};
				telemetry.emit(event);
			}

			throw err;
		}
	};
}
