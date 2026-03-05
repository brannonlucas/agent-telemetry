import { describe, expect, it } from "bun:test";
import Fastify from "fastify";
import { createFastifyTrace, getTraceContext } from "../../src/adapters/fastify.ts";
import type { HttpRequestEvent, Telemetry } from "../../src/types.ts";

const TRACEPARENT_RE = /^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/;

function createTelemetryMock(): {
	emitted: HttpRequestEvent[];
	telemetry: Telemetry<HttpRequestEvent>;
} {
	const emitted: HttpRequestEvent[] = [];
	const telemetry: Telemetry<HttpRequestEvent> = {
		emit(event) {
			emitted.push(event);
		},
		flush: () => Promise.resolve(),
	};
	return { emitted, telemetry };
}

describe("createFastifyTrace", () => {
	it("emits http.request event", async () => {
		const app = Fastify();
		const { emitted, telemetry } = createTelemetryMock();

		await app.register(createFastifyTrace({ telemetry }));
		app.get("/test", async () => ({ ok: true }));

		const res = await app.inject({ method: "GET", url: "/test" });

		expect(res.statusCode).toBe(200);
		expect(emitted).toHaveLength(1);

		const event = emitted[0];
		expect(event.kind).toBe("http.request");
		expect(event.method).toBe("GET");
		expect(event.path).toBe("/test");
		expect(event.status_code).toBe(200);
		expect(typeof event.duration_ms).toBe("number");
		expect(typeof event.trace_id).toBe("string");
	});

	it("sets traceparent response header", async () => {
		const app = Fastify();
		const { telemetry } = createTelemetryMock();

		await app.register(createFastifyTrace({ telemetry }));
		app.get("/test", async () => ({ ok: true }));

		const res = await app.inject({ method: "GET", url: "/test" });

		expect(res.headers.traceparent).toMatch(TRACEPARENT_RE);
	});

	it("propagates incoming traceparent", async () => {
		const app = Fastify();
		const { emitted, telemetry } = createTelemetryMock();

		await app.register(createFastifyTrace({ telemetry }));
		app.get("/test", async () => ({ ok: true }));

		const incomingTraceId = "a".repeat(32);
		const incomingParentId = "b".repeat(16);
		const incoming = `00-${incomingTraceId}-${incomingParentId}-01`;

		const res = await app.inject({
			method: "GET",
			url: "/test",
			headers: { traceparent: incoming },
		});

		const outgoing = res.headers.traceparent as string;
		expect(outgoing).toMatch(TRACEPARENT_RE);
		// trace-id is preserved from incoming
		expect(outgoing).toContain(incomingTraceId);
		// parent-id is a new span, not the incoming parent
		expect(outgoing).not.toContain(incomingParentId);

		const event = emitted[0];
		expect(event.trace_id).toBe(incomingTraceId);
		expect(event.parent_span_id).toBe(incomingParentId);
		expect(typeof event.span_id).toBe("string");
		expect(event.span_id?.length).toBe(16);
	});

	it("strips query string from emitted path", async () => {
		const app = Fastify();
		const { emitted, telemetry } = createTelemetryMock();

		await app.register(createFastifyTrace({ telemetry }));
		app.get("/search", async () => ({ ok: true }));

		const res = await app.inject({
			method: "GET",
			url: "/search?q=secret",
		});

		expect(res.statusCode).toBe(200);
		const event = emitted[0];
		expect(event.path).toBe("/search");
	});

	it("emits concrete path and parameterized route separately", async () => {
		const app = Fastify();
		const { emitted, telemetry } = createTelemetryMock();

		await app.register(createFastifyTrace({ telemetry }));
		app.get("/users/:id", async () => ({ ok: true }));

		const res = await app.inject({
			method: "GET",
			url: "/users/123",
		});

		expect(res.statusCode).toBe(200);
		const event = emitted[0];
		// path is always the concrete request path (spec §5.2)
		expect(event.path).toBe("/users/123");
		// route is the optional parameterized pattern
		expect(event.route).toBe("/users/:id");
	});

	it("measures duration via reply.elapsedTime", async () => {
		const app = Fastify();
		const { emitted, telemetry } = createTelemetryMock();

		await app.register(createFastifyTrace({ telemetry }));
		app.get("/test", async () => ({ ok: true }));

		await app.inject({ method: "GET", url: "/test" });

		const event = emitted[0];
		expect(typeof event.duration_ms).toBe("number");
		expect(event.duration_ms).toBeGreaterThanOrEqual(0);
	});

	it("extracts entities when patterns provided", async () => {
		const app = Fastify();
		const { emitted, telemetry } = createTelemetryMock();

		await app.register(
			createFastifyTrace({
				telemetry,
				entityPatterns: [{ segment: "users", key: "userId" }],
			}),
		);
		app.get("/api/users/:id", async () => ({ ok: true }));

		await app.inject({
			method: "GET",
			url: "/api/users/10000000-0000-4000-a000-000000000001?token=secret",
		});

		const event = emitted[0];
		expect(event.entities).toEqual({
			userId: "10000000-0000-4000-a000-000000000001",
		});
	});

	it("skips tracing when isEnabled returns false", async () => {
		const app = Fastify();
		const { emitted, telemetry } = createTelemetryMock();

		await app.register(
			createFastifyTrace({
				telemetry,
				isEnabled: () => false,
			}),
		);
		app.get("/test", async () => ({ ok: true }));

		const res = await app.inject({ method: "GET", url: "/test" });

		expect(res.statusCode).toBe(200);
		expect(emitted).toHaveLength(0);
	});

	it("has skip-override and display-name symbols", () => {
		const { telemetry } = createTelemetryMock();
		const plugin = createFastifyTrace({
			telemetry,
		});

		expect(plugin[Symbol.for("skip-override")]).toBe(true);
		expect(plugin[Symbol.for("fastify.display-name")]).toBe("agent-telemetry");
	});
});

describe("getTraceContext", () => {
	it("returns trace context from hook", async () => {
		const app = Fastify();
		const { telemetry } = createTelemetryMock();

		await app.register(createFastifyTrace({ telemetry }));

		let ctx: { _trace: { traceparent: string } } | Record<string, never> | undefined;

		app.get("/test", async (request) => {
			ctx = getTraceContext(request);
			return { ok: true };
		});

		await app.inject({ method: "GET", url: "/test" });

		expect(ctx).toBeDefined();
		const traceCtx = ctx as {
			_trace: { traceparent: string };
		};
		expect(traceCtx._trace).toBeDefined();
		expect(traceCtx._trace.traceparent).toMatch(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/);
	});

	it("returns empty object when no plugin registered", async () => {
		const app = Fastify();

		let ctx: { _trace: { traceparent: string } } | Record<string, never> | undefined;

		app.get("/test", async (request) => {
			ctx = getTraceContext(request);
			return { ok: true };
		});

		await app.inject({ method: "GET", url: "/test" });

		expect(ctx).toEqual({});
	});
});
