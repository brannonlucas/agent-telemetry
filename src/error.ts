/**
 * Error helpers.
 *
 * Keeps telemetry error fields low-sensitivity by using stable labels
 * (error names) instead of raw exception messages.
 */

const DEFAULT_ERROR_LABEL = "Error";
const MAX_ERROR_LABEL_LENGTH = 80;

export function toSafeErrorLabel(err: unknown): string {
	if (!(err instanceof Error)) return DEFAULT_ERROR_LABEL;
	const name = err.name.trim();
	if (!name) return DEFAULT_ERROR_LABEL;
	return name.slice(0, MAX_ERROR_LABEL_LENGTH);
}
