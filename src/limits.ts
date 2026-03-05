/**
 * Field Limit Map
 *
 * Maximum UTF-8 byte lengths per Section 17.6 of the Agent Telemetry
 * Specification v1. Used by the truncation engine in emit().
 */

/** Fields that MUST NOT be truncated (spec §4.7). */
export const NEVER_TRUNCATE = new Set(["trace_id", "span_id", "parent_span_id"]);

/**
 * Maximum UTF-8 byte lengths for known fields.
 * Keys use dot notation: `{kind}.{field}` for kind-specific limits,
 * or just `{field}` for universal limits.
 */
export const FIELD_LIMITS: Record<string, number> = {
	kind: 64,
	error_name: 120,
	"http.request.path": 1024,
	"http.request.route": 256,
	"external.call.service": 128,
	"external.call.operation": 256,
	"db.query.provider": 64,
	"db.query.operation": 128,
	"db.query.model": 128,
	"job.start.task_name": 128,
	"job.start.task_id": 128,
	"job.start.queue": 128,
	"job.end.task_name": 128,
	"job.end.task_id": 128,
	"job.end.queue": 128,
	"job.dispatch.task_name": 128,
	"job.dispatch.task_id": 128,
	"job.dispatch.queue": 128,
	"diagnostic.code": 96,
	"diagnostic.message": 256,
};

/** Default limit for unlisted string fields. */
export const DEFAULT_FIELD_LIMIT = 256;

/** Limits for entity/details map keys and values. */
export const ENTITY_KEY_LIMIT = 64;
export const ENTITY_VALUE_LIMIT = 256;
export const DETAILS_KEY_LIMIT = 64;
export const DETAILS_VALUE_LIMIT = 256;

/**
 * Resolve the byte limit for a given field on an event of a given kind.
 * Checks kind-specific limit first, then field-level, then default.
 */
export function getFieldLimit(kind: string, field: string): number | undefined {
	if (NEVER_TRUNCATE.has(field)) return undefined;
	return FIELD_LIMITS[`${kind}.${field}`] ?? FIELD_LIMITS[field] ?? DEFAULT_FIELD_LIMIT;
}
