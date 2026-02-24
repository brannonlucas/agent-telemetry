import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createHonoTrace, getTraceContext } from "../../src/adapters/hono.ts";
import { createTelemetry } from "../../src/index.ts";
import type { HttpEvents } from "../../src/types.ts";

describe("createHonoTrace", () => {
	it("sets X-Trace-Id response header", async () => {
		const telemetry = await createTelemetry<HttpEvents>({ isEnabled: () => false });
		const trace = createHonoTrace({ telemetry });

		const app = new Hono();
		app.use("*", trace);
		app.get("/test", (c) => c.text("ok"));

		const res = await app.request("/test");
		expect(res.status).toBe(200);
		expect(res.headers.get("X-Trace-Id")).toMatch(/^[\da-f]{32}$/);
	});

	it("propagates incoming X-Trace-Id header", async () => {
		const telemetry = await createTelemetry<HttpEvents>({ isEnabled: () => false });
		const trace = createHonoTrace({ telemetry });

		const app = new Hono();
		app.use("*", trace);
		app.get("/test", (c) => c.text("ok"));

		const incomingId = "a".repeat(32);
		const res = await app.request("/test", {
			headers: { "X-Trace-Id": incomingId },
		});
		expect(res.headers.get("X-Trace-Id")).toBe(incomingId);
	});

	it("ignores invalid incoming X-Trace-Id header", async () => {
		const telemetry = await createTelemetry<HttpEvents>({ isEnabled: () => false });
		const trace = createHonoTrace({ telemetry });

		const app = new Hono();
		app.use("*", trace);
		app.get("/test", (c) => c.text("ok"));

		const incomingId = "invalid-trace-id";
		const res = await app.request("/test", {
			headers: { "X-Trace-Id": incomingId },
		});
		const responseTraceId = res.headers.get("X-Trace-Id");
		expect(responseTraceId).toMatch(/^[\da-f]{32}$/);
		expect(responseTraceId).not.toBe(incomingId);
	});

	it("emits http.request event", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };
		const trace = createHonoTrace({
			telemetry: telemetry as { emit: (e: unknown) => void },
		});

		const app = new Hono();
		app.use("*", trace);
		app.get("/api/test", (c) => c.text("ok"));

		await app.request("/api/test");

		expect(emitted).toHaveLength(1);
		const event = emitted[0] as Record<string, unknown>;
		expect(event.kind).toBe("http.request");
		expect(event.method).toBe("GET");
		expect(event.path).toBe("/api/test");
		expect(event.status).toBe(200);
		expect(typeof event.duration_ms).toBe("number");
	});

	it("extracts entities when patterns are provided", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };
		const trace = createHonoTrace({
			telemetry: telemetry as { emit: (e: unknown) => void },
			entityPatterns: [{ segment: "users", key: "userId" }],
		});

		const app = new Hono();
		app.use("*", trace);
		app.get("/api/users/:id", (c) => c.text("ok"));

		await app.request("/api/users/10000000-0000-4000-a000-000000000001");

		const event = emitted[0] as Record<string, unknown>;
		expect(event.entities).toEqual({ userId: "10000000-0000-4000-a000-000000000001" });
	});

	it("skips tracing when isEnabled returns false", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };
		const trace = createHonoTrace({
			telemetry: telemetry as { emit: (e: unknown) => void },
			isEnabled: () => false,
		});

		const app = new Hono();
		app.use("*", trace);
		app.get("/test", (c) => c.text("ok"));

		const res = await app.request("/test");
		expect(res.status).toBe(200);
		expect(emitted).toHaveLength(0);
	});

	it("emits event with 500 status when handler throws", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };
		const trace = createHonoTrace({
			telemetry: telemetry as { emit: (e: unknown) => void },
		});

		const app = new Hono();
		app.use("*", trace);
		app.get("/fail", () => {
			throw new Error("boom");
		});

		const res = await app.request("/fail");
		expect(res.status).toBe(500);

		expect(emitted).toHaveLength(1);
		const event = emitted[0] as Record<string, unknown>;
		expect(event.kind).toBe("http.request");
		expect(event.status).toBe(500);
		expect(event.path).toBe("/fail");
	});
});

describe("getTraceContext", () => {
	it("returns trace context from middleware-set variable", async () => {
		const telemetry = await createTelemetry<HttpEvents>({ isEnabled: () => false });
		const trace = createHonoTrace({ telemetry });

		let ctx: ReturnType<typeof getTraceContext> | undefined;

		const app = new Hono();
		app.use("*", trace);
		app.get("/test", (c) => {
			ctx = getTraceContext(c);
			return c.text("ok");
		});

		await app.request("/test");

		expect(ctx).toBeDefined();
		const traceCtx = ctx as { _trace: { traceId: string; parentSpanId: string } };
		expect(traceCtx._trace).toBeDefined();
		expect(traceCtx._trace.traceId).toMatch(/^[\da-f]{32}$/);
		expect(traceCtx._trace.parentSpanId).toMatch(/^[\da-f]{16}$/);
	});

	it("returns empty object when no trace middleware", async () => {
		let ctx: ReturnType<typeof getTraceContext> | undefined;

		const app = new Hono();
		app.get("/test", (c) => {
			ctx = getTraceContext(c);
			return c.text("ok");
		});

		await app.request("/test");
		expect(ctx).toEqual({});
	});
});
