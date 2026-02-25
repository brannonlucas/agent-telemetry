import { describe, expect, it } from "bun:test";
import { type PrismaTraceExtension, createPrismaTrace } from "../../src/adapters/prisma.ts";
import type { DbQueryEvent } from "../../src/types.ts";

/** Helper to call the adapter's $allOperations directly — no Prisma client needed. */
function callAdapter(
	extension: PrismaTraceExtension,
	params: {
		model: string;
		operation: string;
		args: unknown;
		query: (args: unknown) => Promise<unknown>;
	},
) {
	return extension.query.$allModels.$allOperations(params);
}

describe("createPrismaTrace", () => {
	it("emits db.query event on successful query", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };

		const extension = createPrismaTrace({
			telemetry: telemetry as { emit: (e: DbQueryEvent) => void },
		});

		await callAdapter(extension, {
			model: "User",
			operation: "findMany",
			args: { where: { active: true } },
			query: async () => [{ id: 1 }],
		});

		expect(emitted).toHaveLength(1);
		const event = emitted[0] as Record<string, unknown>;
		expect(event.kind).toBe("db.query");
		expect(event.provider).toBe("prisma");
		expect(event.model).toBe("User");
		expect(event.operation).toBe("findMany");
		expect(event.status).toBe("success");
		expect(typeof event.duration_ms).toBe("number");
		expect(typeof event.spanId).toBe("string");
		expect((event.spanId as string).length).toBe(16);
	});

	it("returns the query result unchanged", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };

		const extension = createPrismaTrace({
			telemetry: telemetry as { emit: (e: DbQueryEvent) => void },
		});

		const expected = [{ id: 1, name: "Alice" }];
		const result = await callAdapter(extension, {
			model: "User",
			operation: "findMany",
			args: {},
			query: async () => expected,
		});

		expect(result).toEqual(expected);
	});

	it("emits error event and re-throws on query failure", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };

		const extension = createPrismaTrace({
			telemetry: telemetry as { emit: (e: DbQueryEvent) => void },
		});

		const queryError = new Error("connection refused");

		let thrown: Error | undefined;
		try {
			await callAdapter(extension, {
				model: "Post",
				operation: "create",
				args: { data: { title: "test" } },
				query: async () => {
					throw queryError;
				},
			});
		} catch (err) {
			thrown = err as Error;
		}

		// Error is re-thrown
		expect(thrown).toBe(queryError);

		// Error event is emitted
		expect(emitted).toHaveLength(1);
		const event = emitted[0] as Record<string, unknown>;
		expect(event.kind).toBe("db.query");
		expect(event.status).toBe("error");
		expect(event.error).toBe("Error");
		expect(typeof event.duration_ms).toBe("number");
	});

	it("sets provider to prisma", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };

		const extension = createPrismaTrace({
			telemetry: telemetry as { emit: (e: DbQueryEvent) => void },
		});

		await callAdapter(extension, {
			model: "Comment",
			operation: "count",
			args: {},
			query: async () => 42,
		});

		const event = emitted[0] as Record<string, unknown>;
		expect(event.provider).toBe("prisma");
	});

	it("passes model and operation from params", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };

		const extension = createPrismaTrace({
			telemetry: telemetry as { emit: (e: DbQueryEvent) => void },
		});

		await callAdapter(extension, {
			model: "User",
			operation: "findMany",
			args: {},
			query: async () => [],
		});

		const event = emitted[0] as Record<string, unknown>;
		expect(event.model).toBe("User");
		expect(event.operation).toBe("findMany");
	});

	it("skips tracing when isEnabled returns false", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };

		let queryCalled = false;
		const extension = createPrismaTrace({
			telemetry: telemetry as { emit: (e: DbQueryEvent) => void },
			isEnabled: () => false,
		});

		const result = await callAdapter(extension, {
			model: "User",
			operation: "findFirst",
			args: { where: { id: 1 } },
			query: async (args) => {
				queryCalled = true;
				return { id: 1 };
			},
		});

		// No event emitted
		expect(emitted).toHaveLength(0);
		// Query still executed
		expect(queryCalled).toBe(true);
		expect(result).toEqual({ id: 1 });
	});

	it("uses trace context when getTraceContext is provided", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };

		const parentTraceId = "a".repeat(32);
		const parentSpanId = "b".repeat(16);
		const extension = createPrismaTrace({
			telemetry: telemetry as { emit: (e: DbQueryEvent) => void },
			getTraceContext: () => ({ traceId: parentTraceId, parentSpanId, traceFlags: "01" }),
		});

		await callAdapter(extension, {
			model: "User",
			operation: "findUnique",
			args: { where: { id: 1 } },
			query: async () => ({ id: 1 }),
		});

		const event = emitted[0] as Record<string, unknown>;
		expect(event.traceId).toBe(parentTraceId);
		expect(event.parentSpanId).toBe(parentSpanId);
	});

	it("generates fresh traceId when no context", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };

		const extension = createPrismaTrace({
			telemetry: telemetry as { emit: (e: DbQueryEvent) => void },
		});

		await callAdapter(extension, {
			model: "User",
			operation: "findMany",
			args: {},
			query: async () => [],
		});

		const event = emitted[0] as Record<string, unknown>;
		expect(typeof event.traceId).toBe("string");
		expect((event.traceId as string).length).toBe(32);
		expect(event.traceId).toMatch(/^[\da-f]{32}$/);
	});
});
