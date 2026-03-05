/**
 * Prisma Adapter
 *
 * Creates a Prisma client extension that emits db.query telemetry events
 * for all model operations. Uses $extends({ query }) — no $use() middleware.
 *
 * No runtime import of @prisma/client — the extension object is structurally
 * compatible with PrismaClient.$extends().
 *
 * @example
 * ```ts
 * import { createTelemetry, type DbEvents } from 'agent-telemetry'
 * import { createPrismaTrace } from 'agent-telemetry/prisma'
 *
 * const telemetry = await createTelemetry<DbEvents>()
 * const prisma = new PrismaClient().$extends(createPrismaTrace({ telemetry }))
 * ```
 */

import { toSafeErrorLabel } from "../error.ts";
import { startSpan } from "../trace-context.ts";
import type { DbQueryEvent, LegacyTraceContext, Telemetry } from "../types.ts";

/** Options for the Prisma trace extension. */
export interface PrismaTraceOptions {
	/** Telemetry instance to emit events through. */
	telemetry: Telemetry<DbQueryEvent>;
	/** Guard function — return false to skip tracing. */
	isEnabled?: () => boolean;
	/** Provide parent trace context for correlating with an incoming request. */
	getTraceContext?: () => LegacyTraceContext | undefined;
}

/** Callback params passed by Prisma's $allOperations hook. */
interface AllOperationsParams {
	model: string;
	operation: string;
	args: unknown;
	query: (args: unknown) => Promise<unknown>;
}

/** Shape returned by createPrismaTrace, compatible with PrismaClient.$extends(). */
export interface PrismaTraceExtension {
	query: {
		$allModels: {
			$allOperations(params: AllOperationsParams): Promise<unknown>;
		};
	};
}

/**
 * Create a Prisma client extension that traces all model queries.
 *
 * Returns a plain object compatible with `PrismaClient.$extends()`.
 * Emits a db.query event for every model operation with timing,
 * outcome, and optional trace context correlation.
 */
export function createPrismaTrace(options: PrismaTraceOptions): PrismaTraceExtension {
	const { telemetry, isEnabled, getTraceContext } = options;

	return {
		query: {
			$allModels: {
				async $allOperations({ model, operation, args, query }) {
					if (isEnabled && !isEnabled()) {
						return query(args);
					}

					const start = performance.now();
					const ctx = getTraceContext?.();
					const span = startSpan({
						trace_id: ctx?.trace_id,
						parent_span_id: ctx?.parent_span_id,
						trace_flags: ctx?.trace_flags,
					});

					try {
						const result = await query(args);
						const duration_ms = Math.round(performance.now() - start);

						const event: DbQueryEvent = {
							record_type: "event",
							spec_version: 1,
							kind: "db.query",
							trace_id: span.trace_id,
							span_id: span.span_id,
							parent_span_id: span.parent_span_id,
							provider: "prisma",
							model,
							operation,
							duration_ms,
							outcome: "success",
						};
						telemetry.emit(event);

						return result;
					} catch (err) {
						const duration_ms = Math.round(performance.now() - start);

						const event: DbQueryEvent = {
							record_type: "event",
							spec_version: 1,
							kind: "db.query",
							trace_id: span.trace_id,
							span_id: span.span_id,
							parent_span_id: span.parent_span_id,
							provider: "prisma",
							model,
							operation,
							duration_ms,
							outcome: "error",
							error_name: toSafeErrorLabel(err),
						};
						telemetry.emit(event);

						throw err;
					}
				},
			},
		},
	};
}
