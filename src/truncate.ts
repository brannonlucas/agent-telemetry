/**
 * UTF-8 Safe Truncation Engine
 *
 * Implements Section 4.7 of the Agent Telemetry Specification v1.
 * Deterministic, UTF-8 safe truncation with the exact suffix `...[truncated]`.
 */

const TRUNCATION_SUFFIX = '...[truncated]'
const SUFFIX_BYTES = Buffer.byteLength(TRUNCATION_SUFFIX) // 14

/**
 * Find the largest valid UTF-8 boundary at or before `maxBytes`.
 *
 * Walks backward from the cut point past any continuation bytes (10xxxxxx),
 * then checks whether the lead byte's full sequence fits. If not, excludes
 * the partial sequence entirely.
 */
function findUtf8Boundary(bytes: Uint8Array, maxBytes: number): number {
	if (maxBytes >= bytes.length) return bytes.length
	let i = maxBytes
	// Walk backward past continuation bytes (10xxxxxx pattern)
	while (i > 0 && ((bytes[i] ?? 0) & 0xc0) === 0x80) i--
	// i is now at a lead byte (or 0). Determine sequence length.
	const first = bytes[0] ?? 0
	if (i > 0 || (first & 0x80) === 0) {
		const lead = bytes[i] ?? 0
		let seqLen = 1
		if ((lead & 0xe0) === 0xc0) seqLen = 2
		else if ((lead & 0xf0) === 0xe0) seqLen = 3
		else if ((lead & 0xf8) === 0xf0) seqLen = 4
		// If the full sequence doesn't fit, exclude it
		if (i + seqLen > maxBytes) return i
		return i + seqLen
	}
	return 0
}

/**
 * Truncate a string field to `maxBytes` UTF-8 bytes.
 *
 * If the value fits within `maxBytes`, it is returned unchanged.
 * Otherwise, the longest valid UTF-8 prefix is kept and the suffix
 * `...[truncated]` is appended, with total byte length <= maxBytes.
 */
export function truncateField(value: string, maxBytes: number): string {
	// Fast path: string length <= maxBytes guarantees fit only for ASCII
	// (multi-byte chars have string.length < byte length, so this is safe
	// only when string.length <= maxBytes AND the string is ASCII-only)
	// We use the encoded length as the true check.
	const encoded = Buffer.from(value, 'utf8')
	if (encoded.length <= maxBytes) return value

	if (maxBytes <= SUFFIX_BYTES) {
		return TRUNCATION_SUFFIX.slice(0, maxBytes)
	}

	const keepBytes = maxBytes - SUFFIX_BYTES
	const boundary = findUtf8Boundary(encoded, keepBytes)
	return encoded.slice(0, boundary).toString('utf8') + TRUNCATION_SUFFIX
}
