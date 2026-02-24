/**
 * ID Generation
 *
 * Trace and span ID generators using crypto.randomUUID().
 * Compatible with Node.js, Bun, and Cloudflare Workers.
 */

/** Generate a 32-char hex trace ID (UUID v4 without dashes). */
export function generateTraceId(): string {
	return crypto.randomUUID().replaceAll("-", "");
}

/** Generate a 16-char hex span ID (first half of a trace ID). */
export function generateSpanId(): string {
	return crypto.randomUUID().replaceAll("-", "").slice(0, 16);
}
