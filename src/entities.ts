/**
 * Entity Extraction
 *
 * Configurable extraction of entity IDs from URL paths and event payloads.
 * Users provide their own patterns — no framework-specific defaults.
 */

import type { EntityPattern } from "./types.ts";

const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/**
 * Extract entity IDs from a URL path using the provided patterns.
 *
 * Scans path segments for pattern matches. When a segment matches a pattern's
 * `segment` value, the following segment is tested against UUID format and
 * captured under the pattern's `key`.
 *
 * @example
 * ```ts
 * const patterns = [
 *   { segment: 'users', key: 'userId' },
 *   { segment: 'posts', key: 'postId' },
 * ]
 * extractEntities('/api/users/abc-123/posts/def-456', patterns)
 * // → { userId: 'abc-123', postId: 'def-456' }
 * ```
 */
export function extractEntities(
	path: string,
	patterns: EntityPattern[],
): Record<string, string> | undefined {
	const segments = path.split("/");
	const entities: Record<string, string> = {};
	let found = false;

	for (let i = 0; i < segments.length - 1; i++) {
		for (const pattern of patterns) {
			if (segments[i] === pattern.segment) {
				const next = segments[i + 1];
				if (next && UUID_RE.test(next)) {
					entities[pattern.key] = next;
					found = true;
				}
			}
		}
	}

	return found ? entities : undefined;
}

/**
 * Extract entity IDs from an event data payload.
 *
 * Scans the data object for string values at the specified keys.
 *
 * @example
 * ```ts
 * extractEntitiesFromEvent({ userId: 'abc', count: 5 }, ['userId', 'postId'])
 * // → { userId: 'abc' }
 * ```
 */
export function extractEntitiesFromEvent(
	data: Record<string, unknown> | undefined,
	keys: string[],
): Record<string, string> | undefined {
	if (!data) return undefined;

	const entities: Record<string, string> = {};
	let found = false;

	for (const key of keys) {
		const val = data[key];
		if (typeof val === "string") {
			entities[key] = val;
			found = true;
		}
	}

	return found ? entities : undefined;
}
