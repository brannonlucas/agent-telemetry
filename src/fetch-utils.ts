/**
 * Shared fetch utilities for adapters that wrap fetch.
 *
 * Used by the traced fetch adapter, Supabase adapter, and browser module
 * to avoid duplicating URL resolution, traceparent injection, and
 * origin detection logic.
 */

/** Callable fetch signature (without static properties like `preconnect`). */
export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function getLocationOrigin(): string | undefined {
	const globalWithLocation = globalThis as { location?: { origin?: string } };
	const origin = globalWithLocation.location?.origin;
	// about:blank pages (and test environments like happy-dom) set origin to the string "null"
	if (!origin || origin === "null") return undefined;
	return origin;
}

export function resolveUrl(url: string): URL {
	const base = getLocationOrigin() ?? "http://localhost";
	return new URL(url, base);
}

export function defaultPropagateTo(url: URL): boolean {
	const origin = getLocationOrigin();
	return origin != null && url.origin === origin;
}

/**
 * Extract URL metadata from the three fetch input types.
 * This is metadata-only — the original input is never modified.
 */
export function resolveInput(input: RequestInfo | URL): {
	url: string;
	method: string;
} {
	if (input instanceof Request) {
		return { url: input.url, method: input.method };
	}
	if (input instanceof URL) {
		return { url: input.href, method: "GET" };
	}
	// string — try absolute first, then relative with location-aware fallback
	try {
		return { url: new URL(input).href, method: "GET" };
	} catch {
		return {
			url: resolveUrl(input).href,
			method: "GET",
		};
	}
}

export function injectTraceparent(
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
