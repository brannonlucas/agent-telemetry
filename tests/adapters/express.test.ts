import { describe, expect, it } from "bun:test";
import {
	type ExpressMiddleware,
	createExpressTrace,
	getTraceContext,
} from "../../src/adapters/express.ts";

const TRACEPARENT_RE = /^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/;

// ============================================================================
// Mock Helpers
// ============================================================================

interface MockRequest {
	method: string;
	originalUrl: string;
	url: string;
	headers: Record<string, string | string[] | undefined>;
	route?: { path?: string };
}

interface MockResponse {
	statusCode: number;
	_listeners: Record<string, (() => void)[]>;
	_headers: Record<string, string>;
	setHeader(name: string, value: string): void;
	on(event: string, listener: () => void): void;
}

function createMockReq(overrides: Partial<MockRequest> = {}): MockRequest {
	return {
		method: "GET",
		originalUrl: "/test",
		url: "/test",
		headers: {},
		...overrides,
	};
}

function createMockRes(overrides: Partial<Pick<MockResponse, "statusCode">> = {}): MockResponse {
	const listeners: Record<string, (() => void)[]> = {};
	const headers: Record<string, string> = {};
	return {
		statusCode: overrides.statusCode ?? 200,
		_listeners: listeners,
		_headers: headers,
		setHeader(name: string, value: string) {
			headers[name] = value;
		},
		on(event: string, listener: () => void) {
			if (!listeners[event]) {
				listeners[event] = [];
			}
			listeners[event].push(listener);
		},
	};
}

function triggerEvent(res: MockResponse, event: string) {
	const fns = res._listeners[event];
	if (fns) {
		for (const fn of fns) fn();
	}
}

// ============================================================================
// Tests
// ============================================================================

describe("createExpressTrace", () => {
	it("emits http.request event on finish", () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };
		const middleware = createExpressTrace({
			telemetry: telemetry as { emit: (e: unknown) => void },
		});

		const req = createMockReq({ originalUrl: "/api/test" });
		const res = createMockRes();
		let nextCalled = false;

		middleware(req, res, () => {
			nextCalled = true;
		});

		expect(nextCalled).toBe(true);
		expect(emitted).toHaveLength(0);

		triggerEvent(res, "finish");

		expect(emitted).toHaveLength(1);
		const event = emitted[0] as Record<string, unknown>;
		expect(event.kind).toBe("http.request");
		expect(event.method).toBe("GET");
		expect(event.path).toBe("/api/test");
		expect(event.status).toBe(200);
		expect(typeof event.duration_ms).toBe("number");
	});

	it("sets traceparent response header", () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };
		const middleware = createExpressTrace({
			telemetry: telemetry as { emit: (e: unknown) => void },
		});

		const req = createMockReq();
		const res = createMockRes();

		middleware(req, res, () => {});

		expect(res._headers.traceparent).toMatch(TRACEPARENT_RE);
	});

	it("propagates incoming traceparent header", () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };
		const middleware = createExpressTrace({
			telemetry: telemetry as { emit: (e: unknown) => void },
		});

		const incomingTraceId = "a".repeat(32);
		const incomingParentId = "b".repeat(16);
		const incoming = `00-${incomingTraceId}-${incomingParentId}-01`;

		const req = createMockReq({
			headers: { traceparent: incoming },
		});
		const res = createMockRes();

		middleware(req, res, () => {});

		const outgoing = res._headers.traceparent;
		expect(outgoing).toMatch(TRACEPARENT_RE);
		// trace-id is preserved from incoming
		expect(outgoing).toContain(incomingTraceId);
		// parent-id is a new span, not the incoming parent
		expect(outgoing).not.toContain(incomingParentId);

		triggerEvent(res, "finish");

		const event = emitted[0] as Record<string, unknown>;
		expect(event.traceId).toBe(incomingTraceId);
	});

	it("uses req.originalUrl for path", () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };
		const middleware = createExpressTrace({
			telemetry: telemetry as { emit: (e: unknown) => void },
		});

		const req = createMockReq({
			originalUrl: "/api/test",
			url: "/test",
		});
		const res = createMockRes();

		middleware(req, res, () => {});
		triggerEvent(res, "finish");

		const event = emitted[0] as Record<string, unknown>;
		expect(event.path).toBe("/api/test");
	});

	it("strips query string from emitted path", () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };
		const middleware = createExpressTrace({
			telemetry: telemetry as { emit: (e: unknown) => void },
		});

		const req = createMockReq({
			originalUrl: "/api/test?token=secret",
		});
		const res = createMockRes();

		middleware(req, res, () => {});
		triggerEvent(res, "finish");

		const event = emitted[0] as Record<string, unknown>;
		expect(event.path).toBe("/api/test");
	});

	it("prefers req.route.path when available", () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };
		const middleware = createExpressTrace({
			telemetry: telemetry as { emit: (e: unknown) => void },
		});

		const req = createMockReq({
			originalUrl: "/api/users/123",
			route: { path: "/api/users/:id" },
		});
		const res = createMockRes();

		middleware(req, res, () => {});
		triggerEvent(res, "finish");

		const event = emitted[0] as Record<string, unknown>;
		expect(event.path).toBe("/api/users/:id");
	});

	it("extracts entities when patterns provided", () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };
		const middleware = createExpressTrace({
			telemetry: telemetry as { emit: (e: unknown) => void },
			entityPatterns: [{ segment: "users", key: "userId" }],
		});

		const uuid = "10000000-0000-4000-a000-000000000001";
		const req = createMockReq({
			originalUrl: `/api/users/${uuid}?token=secret`,
		});
		const res = createMockRes();

		middleware(req, res, () => {});
		triggerEvent(res, "finish");

		const event = emitted[0] as Record<string, unknown>;
		expect(event.path).toBe(`/api/users/${uuid}`);
		expect(event.entities).toEqual({ userId: uuid });
	});

	it("skips tracing when isEnabled returns false", () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };
		const middleware = createExpressTrace({
			telemetry: telemetry as { emit: (e: unknown) => void },
			isEnabled: () => false,
		});

		const req = createMockReq();
		const res = createMockRes();
		let nextCalled = false;

		middleware(req, res, () => {
			nextCalled = true;
		});

		expect(nextCalled).toBe(true);
		triggerEvent(res, "finish");
		expect(emitted).toHaveLength(0);
	});

	it("emits event on close when finish doesn't fire", () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };
		const middleware = createExpressTrace({
			telemetry: telemetry as { emit: (e: unknown) => void },
		});

		const req = createMockReq();
		const res = createMockRes();

		middleware(req, res, () => {});
		triggerEvent(res, "close");

		expect(emitted).toHaveLength(1);
		const event = emitted[0] as Record<string, unknown>;
		expect(event.kind).toBe("http.request");
	});

	it("does not double-emit on both finish and close", () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };
		const middleware = createExpressTrace({
			telemetry: telemetry as { emit: (e: unknown) => void },
		});

		const req = createMockReq();
		const res = createMockRes();

		middleware(req, res, () => {});
		triggerEvent(res, "finish");
		triggerEvent(res, "close");

		expect(emitted).toHaveLength(1);
	});

	it("captures error status", () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };
		const middleware = createExpressTrace({
			telemetry: telemetry as { emit: (e: unknown) => void },
		});

		const req = createMockReq();
		const res = createMockRes({ statusCode: 500 });

		middleware(req, res, () => {});
		triggerEvent(res, "finish");

		expect(emitted).toHaveLength(1);
		const event = emitted[0] as Record<string, unknown>;
		expect(event.status).toBe(500);
		expect(event.error).toBe("HTTP 500");
	});
});

describe("getTraceContext", () => {
	it("returns trace context from middleware", () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };
		const middleware = createExpressTrace({
			telemetry: telemetry as { emit: (e: unknown) => void },
		});

		const req = createMockReq();
		const res = createMockRes();

		middleware(req, res, () => {});

		const ctx = getTraceContext(req);
		const traceCtx = ctx as {
			_trace: { traceId: string; parentSpanId: string };
		};
		expect(traceCtx._trace).toBeDefined();
		expect(traceCtx._trace.traceId).toMatch(/^[\da-f]{32}$/);
		expect(traceCtx._trace.parentSpanId).toMatch(/^[\da-f]{16}$/);
	});

	it("returns empty object when no middleware ran", () => {
		const req = createMockReq();
		const ctx = getTraceContext(req);
		expect(ctx).toEqual({});
	});
});
