import { describe, expect, it } from "bun:test";
import {
	type NextLikeRequest,
	createNextMiddleware,
	getTraceContext,
	withActionTrace,
	withNextTrace,
} from "../../src/adapters/next.ts";
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
	};
	return { emitted, telemetry };
}

function createMockRequest(overrides: Partial<NextLikeRequest> = {}): NextLikeRequest {
	return {
		method: "GET",
		headers: new Headers(),
		url: "http://localhost/api/test",
		nextUrl: { pathname: "/api/test" },
		...overrides,
	};
}

async function withMockNextResponse(
	run: (calls: ({ request?: { headers?: Headers } } | undefined)[]) => Promise<void> | void,
): Promise<void> {
	const globalScope = globalThis as Record<string, unknown>;
	const previous = globalScope.NextResponse;
	const calls: ({ request?: { headers?: Headers } } | undefined)[] = [];

	globalScope.NextResponse = {
		next(init?: { request?: { headers?: Headers } }) {
			calls.push(init);
			return new Response(null, {
				status: 200,
				headers: init?.request?.headers,
			});
		},
	};

	try {
		await run(calls);
	} finally {
		if (previous === undefined) {
			Reflect.deleteProperty(globalScope, "NextResponse");
		} else {
			globalScope.NextResponse = previous;
		}
	}
}

describe("createNextMiddleware", () => {
	it("injects traceparent into forwarded request headers", async () => {
		await withMockNextResponse((calls) => {
			const middleware = createNextMiddleware();
			const request = createMockRequest();

			const result = middleware(request);
			const forwarded = calls[0]?.request?.headers?.get("traceparent");

			expect(result.status).toBe(200);
			expect(calls).toHaveLength(1);
			expect(forwarded).toMatch(TRACEPARENT_RE);
		});
	});

	it("preserves incoming trace id and creates a child span", async () => {
		await withMockNextResponse((calls) => {
			const middleware = createNextMiddleware();
			const incomingTraceId = "a".repeat(32);
			const incomingParentId = "b".repeat(16);
			const incoming = `00-${incomingTraceId}-${incomingParentId}-01`;

			const request = createMockRequest({
				headers: new Headers({ traceparent: incoming }),
			});
			middleware(request);

			const forwarded = calls[0]?.request?.headers?.get("traceparent");
			expect(forwarded).toMatch(TRACEPARENT_RE);
			expect(forwarded).toContain(incomingTraceId);
			expect(forwarded).not.toContain(incomingParentId);
		});
	});

	it("skips injection when disabled", async () => {
		await withMockNextResponse((calls) => {
			const middleware = createNextMiddleware({ isEnabled: () => false });
			const request = createMockRequest();

			const result = middleware(request);

			expect(result.status).toBe(200);
			expect(calls).toHaveLength(1);
			expect(calls[0]).toBeUndefined();
			expect((result as Response).headers.get("traceparent")).toBeNull();
		});
	});
});

describe("withNextTrace", () => {
	it("measures duration and emits http.request", async () => {
		const { emitted, telemetry } = createTelemetryMock();
		const handler = withNextTrace(
			async () => {
				await Bun.sleep(1);
				return new Response("ok", { status: 201 });
			},
			{ telemetry },
		);

		const response = await handler(
			createMockRequest({
				method: "POST",
				nextUrl: { pathname: "/api/users" },
			}),
		);

		expect(response.status).toBe(201);
		expect(emitted).toHaveLength(1);

		const event = emitted[0];
		expect(event.kind).toBe("http.request");
		expect(event.method).toBe("POST");
		expect(event.path).toBe("/api/users");
		expect(event.status).toBe(201);
		expect(typeof event.duration_ms).toBe("number");
		expect(event.duration_ms).toBeGreaterThanOrEqual(0);
	});

	it("uses incoming traceparent as parent context", async () => {
		const { emitted, telemetry } = createTelemetryMock();
		const incomingTraceId = "a".repeat(32);
		const incomingParentId = "b".repeat(16);
		const incoming = `00-${incomingTraceId}-${incomingParentId}-01`;

		const handler = withNextTrace(async () => new Response("ok", { status: 200 }), {
			telemetry,
		});

		await Promise.resolve(
			handler(
				createMockRequest({
					headers: new Headers({ traceparent: incoming }),
				}),
			),
		);

		expect(emitted).toHaveLength(1);
		const event = emitted[0];
		expect(event.traceId).toBe(incomingTraceId);
		expect(event.parentSpanId).toBe(incomingParentId);
		expect(event.spanId).toMatch(/^[\da-f]{16}$/);
	});

	it("emits status 500 and rethrows on handler error", async () => {
		const { emitted, telemetry } = createTelemetryMock();
		const error = new TypeError("boom");
		const handler = withNextTrace(
			async () => {
				throw error;
			},
			{ telemetry },
		);

		await expect(handler(createMockRequest())).rejects.toBe(error);
		expect(emitted).toHaveLength(1);

		const event = emitted[0];
		expect(event.status).toBe(500);
		expect(event.error).toBe("TypeError");
	});

	it("extracts entities from resolved request path", async () => {
		const { emitted, telemetry } = createTelemetryMock();
		const uuid = "10000000-0000-4000-a000-000000000001";
		const handler = withNextTrace(async () => new Response("ok", { status: 200 }), {
			telemetry,
			entityPatterns: [{ segment: "users", key: "userId" }],
		});

		await Promise.resolve(
			handler(
				createMockRequest({
					url: `http://localhost/api/users/${uuid}?token=secret`,
					nextUrl: undefined,
				}),
			),
		);

		expect(emitted).toHaveLength(1);
		const event = emitted[0];
		expect(event.path).toBe(`/api/users/${uuid}`);
		expect(event.entities).toEqual({ userId: uuid });
	});
});

describe("withActionTrace", () => {
	it("measures duration and emits ACTION event", async () => {
		const { emitted, telemetry } = createTelemetryMock();
		const action = withActionTrace(
			async (value: string) => {
				await Bun.sleep(1);
				return value.toUpperCase();
			},
			{ telemetry, name: "createPost" },
		);

		const result = await action("ok");

		expect(result).toBe("OK");
		expect(emitted).toHaveLength(1);
		const event = emitted[0];
		expect(event.method).toBe("ACTION");
		expect(event.path).toBe("createPost");
		expect(event.status).toBe(200);
		expect(typeof event.duration_ms).toBe("number");
		expect(event.duration_ms).toBeGreaterThanOrEqual(0);
	});

	it("emits status 500 and rethrows on action error", async () => {
		const { emitted, telemetry } = createTelemetryMock();
		const error = new RangeError("nope");
		const action = withActionTrace(
			async () => {
				throw error;
			},
			{ telemetry, name: "createPost" },
		);

		await expect(action()).rejects.toBe(error);
		expect(emitted).toHaveLength(1);
		const event = emitted[0];
		expect(event.method).toBe("ACTION");
		expect(event.status).toBe(500);
		expect(event.error).toBe("RangeError");
	});
});

describe("getTraceContext", () => {
	it("parses traceparent into _trace context", () => {
		const traceId = "a".repeat(32);
		const parentSpanId = "b".repeat(16);
		const request = createMockRequest({
			headers: new Headers({ traceparent: `00-${traceId}-${parentSpanId}-01` }),
		});

		expect(getTraceContext(request)).toEqual({
			_trace: {
				traceId,
				parentSpanId,
				traceFlags: "01",
			},
		});
	});

	it("returns empty object for missing or invalid traceparent", () => {
		expect(getTraceContext(createMockRequest({ headers: new Headers() }))).toEqual({});
		expect(
			getTraceContext(
				createMockRequest({
					headers: new Headers({ traceparent: "invalid-traceparent" }),
				}),
			),
		).toEqual({});
	});
});

describe("next adapter source", () => {
	it("contains no static runtime imports from next", async () => {
		const sourcePath = new URL("../../src/adapters/next.ts", import.meta.url);
		const source = await Bun.file(sourcePath).text();

		expect(source).not.toContain('from "next');
		expect(source).not.toContain("from 'next");
	});
});
