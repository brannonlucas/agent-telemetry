import { describe, expect, it } from "bun:test";
import { Inngest } from "inngest";
import { createInngestTrace } from "../../src/adapters/inngest.ts";
import { formatTraceparent } from "../../src/traceparent.ts";
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
		flush: () => Promise.resolve(),
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

		const traceId = "a".repeat(32);
		const parentId = "b".repeat(16);
		const traceparent = formatTraceparent(traceId, parentId, "01");

		const fnRunResult = await onFunctionRun(
			buildRunArgs(
				{ userId: "user-1", _trace: { traceparent } },
				"run-123",
				buildFunction("my-app/process-order"),
			),
		);

		expect(emitted).toHaveLength(1);
		const startEvent = emitted[0];
		expect(startEvent.kind).toBe("job.start");
		if (startEvent.kind !== "job.start") throw new Error("Expected job.start event");
		expect(startEvent.trace_id).toBe(traceId);
		expect(startEvent.task_name).toBe("my-app/process-order");
		expect(startEvent.task_id).toBe("run-123");
		expect(startEvent.entities).toEqual({ userId: "user-1" });

		await fnRunResult?.finished?.(buildFinishedArgs());

		expect(emitted).toHaveLength(2);
		const endEvent = emitted[1];
		expect(endEvent.kind).toBe("job.end");
		if (endEvent.kind !== "job.end") throw new Error("Expected job.end event");
		expect(endEvent.trace_id).toBe(traceId);
		expect(endEvent.outcome).toBe("success");
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
		expect(endEvent.outcome).toBe("error");
		expect(endEvent.error_name).toBe("Error");
	});

	it("emits job.dispatch for outgoing events with _trace", async () => {
		const { emitted, telemetry } = createTelemetryMock();
		const middleware = createInngestTrace({ telemetry });
		const hooks = await getHooks(middleware);
		const onSendEvent = hooks.onSendEvent;
		expect(onSendEvent).toBeDefined();
		if (!onSendEvent) throw new Error("Expected onSendEvent hook");

		const traceId = "c".repeat(32);
		const parentId = "d".repeat(16);

		const sendEventResult = await onSendEvent();
		await sendEventResult.transformInput?.(
			buildSendInputArgs([
				{
					name: "app/order.completed",
					data: { _trace: { traceparent: formatTraceparent(traceId, parentId, "01") } },
				},
			]),
		);

		expect(emitted).toHaveLength(1);
		const event = emitted[0];
		expect(event.kind).toBe("job.dispatch");
		if (event.kind !== "job.dispatch") throw new Error("Expected job.dispatch event");
		expect(event.trace_id).toBe(traceId);
		expect(event.parent_span_id).toBe(parentId);
		expect(event.task_name).toBe("app/order.completed");
		expect(event.outcome).toBe("success");
	});

	it("updates _trace to new traceparent format on dispatch", async () => {
		const { telemetry } = createTelemetryMock();
		const middleware = createInngestTrace({ telemetry });
		const hooks = await getHooks(middleware);
		const onSendEvent = hooks.onSendEvent;
		if (!onSendEvent) throw new Error("Expected onSendEvent hook");

		const traceId = "e".repeat(32);
		const parentId = "f".repeat(16);
		const data: Record<string, unknown> = {
			_trace: { traceparent: formatTraceparent(traceId, parentId, "01") },
		};

		const sendEventResult = await onSendEvent();
		await sendEventResult.transformInput?.(buildSendInputArgs([{ name: "app/test", data }]));

		// _trace should now be updated with new traceparent containing dispatch span_id
		const updatedTrace = data._trace as { traceparent: string };
		expect(updatedTrace.traceparent).toMatch(/^00-[\da-f]{32}-[\da-f]{16}-01$/);
		expect(updatedTrace.traceparent).toContain(traceId);
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
		expect(typeof event.trace_id).toBe("string");
		expect(event.trace_id.length).toBe(32);
	});

	it("ignores legacy decomposed _trace format (removed in 0.7.0)", async () => {
		const { emitted, telemetry } = createTelemetryMock();
		const middleware = createInngestTrace({ telemetry });
		const hooks = await getHooks(middleware);
		const onFunctionRun = hooks.onFunctionRun;
		if (!onFunctionRun) throw new Error("Expected onFunctionRun hook");

		await onFunctionRun(
			buildRunArgs(
				{ _trace: { trace_id: "a".repeat(32), parent_span_id: "b".repeat(16) } },
				"run-legacy",
				buildFunction("my-app/legacy-fn"),
			),
		);

		// Old decomposed format is treated as no context — new trace_id generated
		const startEvent = emitted[0];
		if (startEvent.kind !== "job.start") throw new Error("Expected job.start event");
		expect(startEvent.trace_id).not.toBe("a".repeat(32));
		expect(startEvent.trace_id.length).toBe(32);
	});

	it("round-trip: dispatch traceparent -> receive traceparent preserves linkage", async () => {
		const { emitted, telemetry } = createTelemetryMock();
		const middleware = createInngestTrace({ telemetry });
		const hooks = await getHooks(middleware);

		// Simulate dispatch: onSendEvent writes _trace.traceparent
		const traceId = "a".repeat(32);
		const parentId = "b".repeat(16);
		const data: Record<string, unknown> = {
			_trace: { traceparent: formatTraceparent(traceId, parentId, "01") },
		};

		const sendEventResult = await (hooks.onSendEvent as NonNullable<typeof hooks.onSendEvent>)();
		await sendEventResult.transformInput?.(buildSendInputArgs([{ name: "app/test", data }]));

		expect(emitted).toHaveLength(1);
		const dispatchEvent = emitted[0];
		if (dispatchEvent.kind !== "job.dispatch") throw new Error("Expected job.dispatch");

		// Simulate receive: onFunctionRun reads the updated _trace.traceparent
		const onFunctionRun = hooks.onFunctionRun as NonNullable<typeof hooks.onFunctionRun>;
		await onFunctionRun(buildRunArgs(data, "run-downstream", buildFunction("my-app/downstream")));

		const startEvent = emitted[emitted.length - 1];
		if (startEvent.kind !== "job.start") throw new Error("Expected job.start");

		// The downstream start should share the same trace_id
		expect(startEvent.trace_id).toBe(traceId);
		// And its parent_span_id should be the dispatch's span_id
		expect(startEvent.parent_span_id).toBe(dispatchEvent.span_id);
	});
});
