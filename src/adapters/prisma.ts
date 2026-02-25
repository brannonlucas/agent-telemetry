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
import type { DbQueryEvent, Telemetry, TraceContext } from "../types.ts";

/** Options for the Prisma trace extension. */
export interface PrismaTraceOptions {
	/** Telemetry instance to emit events through. */
	telemetry: Telemetry<DbQueryEvent>;
	/** Guard function — return false to skip tracing. */
	isEnabled?: () => boolean;
	/** Provide parent trace context for correlating with an incoming request. */
	getTraceContext?: () => TraceContext | undefined;
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
 * status, and optional trace context correlation.
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
						traceId: ctx?.traceId,
						parentSpanId: ctx?.parentSpanId,
						traceFlags: ctx?.traceFlags,
					});

					try {
						const result = await query(args);
						const duration_ms = Math.round(performance.now() - start);

						const event: DbQueryEvent = {
							kind: "db.query",
							traceId: span.traceId,
							spanId: span.spanId,
							parentSpanId: span.parentSpanId,
							provider: "prisma",
							model,
							operation,
							duration_ms,
							status: "success",
						};
						telemetry.emit(event);

						return result;
					} catch (err) {
						const duration_ms = Math.round(performance.now() - start);

						const event: DbQueryEvent = {
							kind: "db.query",
							traceId: span.traceId,
							spanId: span.spanId,
							parentSpanId: span.parentSpanId,
							provider: "prisma",
							model,
							operation,
							duration_ms,
							status: "error",
							error: toSafeErrorLabel(err),
						};
						telemetry.emit(event);

						throw err;
					}
				},
			},
		},
	};
}
