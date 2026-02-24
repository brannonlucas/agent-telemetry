import { describe, expect, it } from "bun:test";
import { createInngestTrace } from "../../src/adapters/inngest.ts";
import type { JobEvents } from "../../src/types.ts";

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

		// Access the middleware internals through the init lifecycle
		// InngestMiddleware wraps the init function — we invoke it via the
		// middleware's internal structure to test the hooks directly.
		const initResult = (middleware as unknown as { init: () => unknown }).init();
		const hooks = initResult as {
			onFunctionRun: (args: unknown) => unknown;
			onSendEvent: () => unknown;
		};

		const fnRunResult = hooks.onFunctionRun({
			ctx: {
				event: {
					data: { userId: "user-1", _trace: { traceId: "trace-abc", parentSpanId: "span-1" } },
				},
				runId: "run-123",
			},
			fn: { id: () => "my-app/process-order" },
		}) as { finished: (args: { result: { error?: unknown } }) => void };

		// Should have emitted job.start
		expect(emitted).toHaveLength(1);
		const startEvent = emitted[0] as Record<string, unknown>;
		expect(startEvent.kind).toBe("job.start");
		expect(startEvent.traceId).toBe("trace-abc");
		expect(startEvent.functionId).toBe("my-app/process-order");
		expect(startEvent.runId).toBe("run-123");
		expect(startEvent.entities).toEqual({ userId: "user-1" });

		// Simulate function completion
		fnRunResult.finished({ result: {} });

		// Should have emitted job.end
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

		const initResult = (middleware as unknown as { init: () => unknown }).init();
		const hooks = initResult as { onFunctionRun: (args: unknown) => unknown };

		const fnRunResult = hooks.onFunctionRun({
			ctx: { event: { data: {} }, runId: "run-456" },
			fn: { id: () => "my-app/failing-fn" },
		}) as { finished: (args: { result: { error?: unknown } }) => void };

		fnRunResult.finished({ result: { error: new Error("something broke") } });

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

		const initResult = (middleware as unknown as { init: () => unknown }).init();
		const hooks = initResult as { onSendEvent: () => unknown };

		const sendEventResult = hooks.onSendEvent() as {
			transformInput: (args: { payloads: unknown[] }) => void;
		};

		sendEventResult.transformInput({
			payloads: [
				{
					name: "app/order.completed",
					data: {
						_trace: { traceId: "trace-xyz", parentSpanId: "span-abc" },
					},
				},
			],
		});

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

		const initResult = (middleware as unknown as { init: () => unknown }).init();
		const hooks = initResult as { onSendEvent: () => unknown };

		const sendEventResult = hooks.onSendEvent() as {
			transformInput: (args: { payloads: unknown[] }) => void;
		};

		sendEventResult.transformInput({
			payloads: [{ name: "app/no-trace", data: {} }],
		});

		expect(emitted).toHaveLength(0);
	});

	it("generates new traceId when _trace is absent", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };

		const middleware = createInngestTrace({
			telemetry: telemetry as { emit: (e: JobEvents) => void },
		});

		const initResult = (middleware as unknown as { init: () => unknown }).init();
		const hooks = initResult as { onFunctionRun: (args: unknown) => unknown };

		hooks.onFunctionRun({
			ctx: { event: { data: {} }, runId: "run-789" },
			fn: { id: () => "my-app/no-trace-fn" },
		});

		const event = emitted[0] as Record<string, unknown>;
		expect(event.kind).toBe("job.start");
		expect(typeof event.traceId).toBe("string");
		expect((event.traceId as string).length).toBe(32);
	});
});
