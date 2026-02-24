import { describe, expect, it } from "bun:test";
import { Inngest } from "inngest";
import { createInngestTrace } from "../../src/adapters/inngest.ts";
import type { JobEvents } from "../../src/types.ts";

type TraceMiddleware = ReturnType<typeof createInngestTrace>;
type TraceHooks = Awaited<ReturnType<TraceMiddleware["init"]>>;
type RunArgs = Parameters<NonNullable<TraceHooks["onFunctionRun"]>>[0];
type RunFinishedArgs = Parameters<
	NonNullable<Awaited<ReturnType<NonNullable<TraceHooks["onFunctionRun"]>>>["finished"]>
>[0];
type SendInputArgs = Parameters<
	NonNullable<Awaited<ReturnType<NonNullable<TraceHooks["onSendEvent"]>>>["transformInput"]>
>[0];

const getHooks = async (middleware: TraceMiddleware): Promise<TraceHooks> => {
	return middleware.init({ client: new Inngest({ id: "test-client" }) });
};

const buildRunArgs = (
	data: Record<string, unknown>,
	runId: string,
	functionId: string,
): RunArgs => {
	return {
		ctx: { event: { data }, runId },
		fn: { id: () => functionId },
		reqArgs: [],
		steps: [],
	} as unknown as RunArgs;
};

describe("createInngestTrace", () => {
	it("returns an InngestMiddleware instance", () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };

		const middleware = createInngestTrace({
			telemetry: telemetry as { emit: (e: JobEvents) => void },
		});

		expect(middleware).toBeDefined();
		expect(middleware.name).toBe("agent-telemetry/trace");
	});

	it("accepts custom middleware name", () => {
		const telemetry = { emit: () => {} };
		const middleware = createInngestTrace({
			telemetry: telemetry as { emit: (e: JobEvents) => void },
			name: "my-app/trace",
		});

		expect(middleware.name).toBe("my-app/trace");
	});

	it("emits job.start and job.end through onFunctionRun lifecycle", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };

		const middleware = createInngestTrace({
			telemetry: telemetry as { emit: (e: JobEvents) => void },
			entityKeys: ["userId"],
		});
		const hooks = await getHooks(middleware);
		const onFunctionRun = hooks.onFunctionRun;
		expect(onFunctionRun).toBeDefined();
		if (!onFunctionRun) throw new Error("Expected onFunctionRun hook");

		const fnRunResult = await onFunctionRun(
			buildRunArgs(
				{ userId: "user-1", _trace: { traceId: "trace-abc", parentSpanId: "span-1" } },
				"run-123",
				"my-app/process-order",
			),
		);

		expect(emitted).toHaveLength(1);
		const startEvent = emitted[0] as Record<string, unknown>;
		expect(startEvent.kind).toBe("job.start");
		expect(startEvent.traceId).toBe("trace-abc");
		expect(startEvent.functionId).toBe("my-app/process-order");
		expect(startEvent.runId).toBe("run-123");
		expect(startEvent.entities).toEqual({ userId: "user-1" });

		await fnRunResult?.finished?.({
			result: { data: undefined, error: undefined },
		} as RunFinishedArgs);

		expect(emitted).toHaveLength(2);
		const endEvent = emitted[1] as Record<string, unknown>;
		expect(endEvent.kind).toBe("job.end");
		expect(endEvent.traceId).toBe("trace-abc");
		expect(endEvent.status).toBe("success");
		expect(typeof endEvent.duration_ms).toBe("number");
	});

	it("emits job.end with error status on failure", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };

		const middleware = createInngestTrace({
			telemetry: telemetry as { emit: (e: JobEvents) => void },
		});
		const hooks = await getHooks(middleware);
		const onFunctionRun = hooks.onFunctionRun;
		expect(onFunctionRun).toBeDefined();
		if (!onFunctionRun) throw new Error("Expected onFunctionRun hook");

		const fnRunResult = await onFunctionRun(buildRunArgs({}, "run-456", "my-app/failing-fn"));

		await fnRunResult?.finished?.({
			result: { data: undefined, error: new Error("something broke") },
		} as RunFinishedArgs);

		const endEvent = emitted[1] as Record<string, unknown>;
		expect(endEvent.kind).toBe("job.end");
		expect(endEvent.status).toBe("error");
		expect(endEvent.error).toBe("something broke");
	});

	it("emits job.dispatch for outgoing events with _trace", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };

		const middleware = createInngestTrace({
			telemetry: telemetry as { emit: (e: JobEvents) => void },
		});
		const hooks = await getHooks(middleware);
		const onSendEvent = hooks.onSendEvent;
		expect(onSendEvent).toBeDefined();
		if (!onSendEvent) throw new Error("Expected onSendEvent hook");

		const sendEventResult = await onSendEvent();
		await sendEventResult.transformInput?.({
			payloads: [
				{
					name: "app/order.completed",
					data: { _trace: { traceId: "trace-xyz", parentSpanId: "span-abc" } },
				},
			],
		} as SendInputArgs);

		expect(emitted).toHaveLength(1);
		const event = emitted[0] as Record<string, unknown>;
		expect(event.kind).toBe("job.dispatch");
		expect(event.traceId).toBe("trace-xyz");
		expect(event.parentSpanId).toBe("span-abc");
		expect(event.eventName).toBe("app/order.completed");
	});

	it("skips dispatch events without _trace context", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };

		const middleware = createInngestTrace({
			telemetry: telemetry as { emit: (e: JobEvents) => void },
		});
		const hooks = await getHooks(middleware);
		const onSendEvent = hooks.onSendEvent;
		expect(onSendEvent).toBeDefined();
		if (!onSendEvent) throw new Error("Expected onSendEvent hook");

		const sendEventResult = await onSendEvent();
		await sendEventResult.transformInput?.({
			payloads: [{ name: "app/no-trace", data: {} }],
		} as SendInputArgs);

		expect(emitted).toHaveLength(0);
	});

	it("generates new traceId when _trace is absent", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };

		const middleware = createInngestTrace({
			telemetry: telemetry as { emit: (e: JobEvents) => void },
		});
		const hooks = await getHooks(middleware);
		const onFunctionRun = hooks.onFunctionRun;
		expect(onFunctionRun).toBeDefined();
		if (!onFunctionRun) throw new Error("Expected onFunctionRun hook");

		await onFunctionRun(buildRunArgs({}, "run-789", "my-app/no-trace-fn"));

		const event = emitted[0] as Record<string, unknown>;
		expect(event.kind).toBe("job.start");
		expect(typeof event.traceId).toBe("string");
		expect((event.traceId as string).length).toBe(32);
	});
});
