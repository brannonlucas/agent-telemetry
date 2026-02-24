/**
 * W3C Trace Context — traceparent header parsing and formatting.
 *
 * Implements the `traceparent` header format defined in
 * https://www.w3.org/TR/trace-context/#traceparent-header
 *
 * Format: {version}-{trace-id}-{parent-id}-{trace-flags}
 * Example: 00-4bf92f3577b86cd56163f2543210c4a0-00f067aa0ba902b7-01
 */

/** Parsed representation of a `traceparent` header. */
export interface Traceparent {
	version: string
	traceId: string
	parentId: string
	traceFlags: string
}

const TRACEPARENT_RE = /^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/
const ALL_ZEROS_32 = '0'.repeat(32)
const ALL_ZEROS_16 = '0'.repeat(16)

/**
 * Parse a `traceparent` header value.
 *
 * Returns the parsed components, or `null` if the header is missing,
 * malformed, or violates the W3C spec (e.g. all-zero trace-id/parent-id).
 */
export function parseTraceparent(header: string | undefined | null): Traceparent | null {
	if (!header) return null

	const match = TRACEPARENT_RE.exec(header.trim().toLowerCase())
	if (!match) return null

	// Captures are guaranteed by the regex match above
	const version = match[1] as string
	const traceId = match[2] as string
	const parentId = match[3] as string
	const traceFlags = match[4] as string

	// W3C spec: all-zero trace-id and parent-id are invalid
	if (traceId === ALL_ZEROS_32 || parentId === ALL_ZEROS_16) return null

	return { version, traceId, parentId, traceFlags }
}

/**
 * Format a `traceparent` header value from components.
 *
 * @param traceId  32-char lowercase hex trace ID
 * @param parentId 16-char lowercase hex parent/span ID
 * @param flags    2-char hex trace flags (default: "01" = sampled)
 */
export function formatTraceparent(traceId: string, parentId: string, flags = '01'): string {
	return `00-${traceId}-${parentId}-${flags}`
}
