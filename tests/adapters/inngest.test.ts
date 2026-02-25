import { describe, expect, it } from "bun:test";
import { Inngest } from "inngest";
import { createInngestTrace } from "../../src/adapters/inngest.ts";
import type { JobEvents, Telemetry } from "../../src/types.ts";

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

const createTelemetryMock = (): { emitted: JobEvents[]; telemetry: Telemetry<JobEvents> } => {
	const emitted: JobEvents[] = [];
	const telemetry: Telemetry<JobEvents> = {
		emit(event) {
			emitted.push(event);
		},
	};
	return { emitted, telemetry };
};

const buildFunction = (id: string): RunArgs["fn"] => {
	const client = new Inngest({ id: `test-client-${id}` });
	return client.createFunction({ id }, { event: "app/test" }, async () => null);
};

const buildRunArgs = (data: Record<string, unknown>, runId: string, fn: RunArgs["fn"]): RunArgs => {
	return {
		ctx: { event: { name: "app/test", data }, runId },
		fn,
		reqArgs: [],
		steps: [],
	};
};

const buildFinishedArgs = (error?: unknown): RunFinishedArgs => {
	return { result: { data: undefined, error } };
};

const buildSendInputArgs = (payloads: SendInputArgs["payloads"]): SendInputArgs => {
	return { payloads };
};

describe("createInngestTrace", () => {
	it("returns an InngestMiddleware instance", () => {
		const { telemetry } = createTelemetryMock();

		const middleware = createInngestTrace({ telemetry });

		expect(middleware).toBeDefined();
		expect(middleware.name).toBe("agent-telemetry/trace");
	});

	it("accepts custom middleware name", () => {
		const { telemetry } = createTelemetryMock();

		const middleware = createInngestTrace({
			telemetry,
			name: "my-app/trace",
		});

		expect(middleware.name).toBe("my-app/trace");
	});

	it("emits job.start and job.end through onFunctionRun lifecycle", async () => {
		const { emitted, telemetry } = createTelemetryMock();
		const middleware = createInngestTrace({
			telemetry,
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
				buildFunction("my-app/process-order"),
			),
		);

		expect(emitted).toHaveLength(1);
		const startEvent = emitted[0];
		expect(startEvent.kind).toBe("job.start");
		if (startEvent.kind !== "job.start") throw new Error("Expected job.start event");
		expect(startEvent.traceId).toBe("trace-abc");
		expect(startEvent.functionId).toBe("my-app/process-order");
		expect(startEvent.runId).toBe("run-123");
		expect(startEvent.entities).toEqual({ userId: "user-1" });

		await fnRunResult?.finished?.(buildFinishedArgs());

		expect(emitted).toHaveLength(2);
		const endEvent = emitted[1];
		expect(endEvent.kind).toBe("job.end");
		if (endEvent.kind !== "job.end") throw new Error("Expected job.end event");
		expect(endEvent.traceId).toBe("trace-abc");
		expect(endEvent.status).toBe("success");
		expect(typeof endEvent.duration_ms).toBe("number");
	});

	it("emits job.end with sanitized error label on failure", async () => {
		const { emitted, telemetry } = createTelemetryMock();
		const middleware = createInngestTrace({ telemetry });
		const hooks = await getHooks(middleware);
		const onFunctionRun = hooks.onFunctionRun;
		expect(onFunctionRun).toBeDefined();
		if (!onFunctionRun) throw new Error("Expected onFunctionRun hook");

		const fnRunResult = await onFunctionRun(
			buildRunArgs({}, "run-456", buildFunction("my-app/failing-fn")),
		);

		await fnRunResult?.finished?.(buildFinishedArgs(new Error("something broke")));

		const endEvent = emitted[1];
		expect(endEvent.kind).toBe("job.end");
		if (endEvent.kind !== "job.end") throw new Error("Expected job.end event");
		expect(endEvent.status).toBe("error");
		expect(endEvent.error).toBe("Error");
	});

	it("emits job.dispatch for outgoing events with _trace", async () => {
		const { emitted, telemetry } = createTelemetryMock();
		const middleware = createInngestTrace({ telemetry });
		const hooks = await getHooks(middleware);
		const onSendEvent = hooks.onSendEvent;
		expect(onSendEvent).toBeDefined();
		if (!onSendEvent) throw new Error("Expected onSendEvent hook");

		const sendEventResult = await onSendEvent();
		await sendEventResult.transformInput?.(
			buildSendInputArgs([
				{
					name: "app/order.completed",
					data: { _trace: { traceId: "trace-xyz", parentSpanId: "span-abc" } },
				},
			]),
		);

		expect(emitted).toHaveLength(1);
		const event = emitted[0];
		expect(event.kind).toBe("job.dispatch");
		if (event.kind !== "job.dispatch") throw new Error("Expected job.dispatch event");
		expect(event.traceId).toBe("trace-xyz");
		expect(event.parentSpanId).toBe("span-abc");
		expect(event.eventName).toBe("app/order.completed");
	});

	it("skips dispatch events without _trace context", async () => {
		const { emitted, telemetry } = createTelemetryMock();
		const middleware = createInngestTrace({ telemetry });
		const hooks = await getHooks(middleware);
		const onSendEvent = hooks.onSendEvent;
		expect(onSendEvent).toBeDefined();
		if (!onSendEvent) throw new Error("Expected onSendEvent hook");

		const sendEventResult = await onSendEvent();
		await sendEventResult.transformInput?.(
			buildSendInputArgs([{ name: "app/no-trace", data: {} }]),
		);

		expect(emitted).toHaveLength(0);
	});

	it("generates new traceId when _trace is absent", async () => {
		const { emitted, telemetry } = createTelemetryMock();
		const middleware = createInngestTrace({ telemetry });
		const hooks = await getHooks(middleware);
		const onFunctionRun = hooks.onFunctionRun;
		expect(onFunctionRun).toBeDefined();
		if (!onFunctionRun) throw new Error("Expected onFunctionRun hook");

		await onFunctionRun(buildRunArgs({}, "run-789", buildFunction("my-app/no-trace-fn")));

		const event = emitted[0];
		expect(event.kind).toBe("job.start");
		if (event.kind !== "job.start") throw new Error("Expected job.start event");
		expect(typeof event.traceId).toBe("string");
		expect(event.traceId.length).toBe(32);
	});
});
