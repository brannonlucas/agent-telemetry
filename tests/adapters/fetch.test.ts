import { describe, expect, it } from "bun:test";
import type { FetchFn } from "../../src/adapters/fetch.ts";
import { createTracedFetch } from "../../src/adapters/fetch.ts";
import type { ExternalCallEvent } from "../../src/types.ts";

const mockFetch: FetchFn = async () => new Response("ok", { status: 200 });

function readTraceparentHeader(input: RequestInfo | URL, init?: RequestInit): string | null {
	if (input instanceof Request) {
		return input.headers.get("traceparent");
	}
	return new Headers(init?.headers).get("traceparent");
}

describe("createTracedFetch", () => {
	it("emits external.call event for string URL", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e), flush: () => Promise.resolve() };
		const fetch = createTracedFetch({
			telemetry: telemetry as { emit: (e: ExternalCallEvent) => void; flush: () => Promise<void> },
			baseFetch: mockFetch,
		});

		await fetch("https://api.example.com/users");

		expect(emitted).toHaveLength(1);
		const event = emitted[0] as Record<string, unknown>;
		expect(event.kind).toBe("external.call");
		expect(event.service).toBe("api.example.com");
		expect(event.operation).toBe("GET /users");
		expect(event.outcome).toBe("success");
		expect(typeof event.duration_ms).toBe("number");
		expect(typeof event.trace_id).toBe("string");
		expect(typeof event.span_id).toBe("string");
	});

	it("emits external.call event for URL object", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e), flush: () => Promise.resolve() };
		const fetch = createTracedFetch({
			telemetry: telemetry as { emit: (e: ExternalCallEvent) => void; flush: () => Promise<void> },
			baseFetch: mockFetch,
		});

		await fetch(new URL("https://api.example.com/users"));

		expect(emitted).toHaveLength(1);
		const event = emitted[0] as Record<string, unknown>;
		expect(event.kind).toBe("external.call");
		expect(event.service).toBe("api.example.com");
		expect(event.operation).toBe("GET /users");
		expect(event.outcome).toBe("success");
	});

	it("emits external.call event for Request object", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e), flush: () => Promise.resolve() };
		const fetch = createTracedFetch({
			telemetry: telemetry as { emit: (e: ExternalCallEvent) => void; flush: () => Promise<void> },
			baseFetch: mockFetch,
		});

		await fetch(new Request("https://api.example.com/users", { method: "POST" }));

		expect(emitted).toHaveLength(1);
		const event = emitted[0] as Record<string, unknown>;
		expect(event.kind).toBe("external.call");
		expect(event.operation).toBe("POST /users");
		expect(event.outcome).toBe("success");
	});

	it("derives service from hostname", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e), flush: () => Promise.resolve() };
		const fetch = createTracedFetch({
			telemetry: telemetry as { emit: (e: ExternalCallEvent) => void; flush: () => Promise<void> },
			baseFetch: mockFetch,
		});

		await fetch("https://api.stripe.com/v1/charges");

		const event = emitted[0] as Record<string, unknown>;
		expect(event.service).toBe("api.stripe.com");
	});

	it("derives operation from method and pathname", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e), flush: () => Promise.resolve() };
		const fetch = createTracedFetch({
			telemetry: telemetry as { emit: (e: ExternalCallEvent) => void; flush: () => Promise<void> },
			baseFetch: mockFetch,
		});

		await fetch("https://api.example.com/users");
		expect((emitted[0] as Record<string, unknown>).operation).toBe("GET /users");

		await fetch("https://api.stripe.com/v1/charges", { method: "POST" });
		expect((emitted[1] as Record<string, unknown>).operation).toBe("POST /v1/charges");
	});

	it("handles relative URLs gracefully", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e), flush: () => Promise.resolve() };
		const fetch = createTracedFetch({
			telemetry: telemetry as { emit: (e: ExternalCallEvent) => void; flush: () => Promise<void> },
			baseFetch: mockFetch,
		});

		await fetch("/api/data");

		const event = emitted[0] as Record<string, unknown>;
		expect(event.service).toBe("localhost");
		expect(event.operation).toBe("GET /api/data");
	});

	it("returns Response untouched", async () => {
		const original = new Response("ok", { status: 200 });
		const baseFetch: FetchFn = async () => original;
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e), flush: () => Promise.resolve() };
		const fetch = createTracedFetch({
			telemetry: telemetry as { emit: (e: ExternalCallEvent) => void; flush: () => Promise<void> },
			baseFetch,
		});

		const result = await fetch("https://api.example.com/test");

		expect(result).toBe(original);
	});

	it("emits error event on network failure", async () => {
		const networkError = new Error("ECONNREFUSED");
		const failingFetch: FetchFn = async () => {
			throw networkError;
		};
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e), flush: () => Promise.resolve() };
		const fetch = createTracedFetch({
			telemetry: telemetry as { emit: (e: ExternalCallEvent) => void; flush: () => Promise<void> },
			baseFetch: failingFetch,
		});

		let thrown: Error | undefined;
		try {
			await fetch("https://api.example.com/fail");
		} catch (err) {
			thrown = err as Error;
		}

		expect(thrown).toBe(networkError);
		expect(emitted).toHaveLength(1);
		const event = emitted[0] as Record<string, unknown>;
		expect(event.kind).toBe("external.call");
		expect(event.outcome).toBe("error");
		expect(typeof event.duration_ms).toBe("number");
	});

	it("skips tracing when isEnabled returns false", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e), flush: () => Promise.resolve() };
		let fetchCalled = false;
		const baseFetch: FetchFn = async () => {
			fetchCalled = true;
			return new Response("ok", { status: 200 });
		};
		const fetch = createTracedFetch({
			telemetry: telemetry as { emit: (e: ExternalCallEvent) => void; flush: () => Promise<void> },
			baseFetch,
			isEnabled: () => false,
		});

		const res = await fetch("https://api.example.com/test");

		expect(res.status).toBe(200);
		expect(fetchCalled).toBe(true);
		expect(emitted).toHaveLength(0);
	});

	it("uses custom baseFetch", async () => {
		const calls: string[] = [];
		const customFetch: FetchFn = async (input) => {
			calls.push(String(input));
			return new Response("custom", { status: 201 });
		};
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e), flush: () => Promise.resolve() };
		const fetch = createTracedFetch({
			telemetry: telemetry as { emit: (e: ExternalCallEvent) => void; flush: () => Promise<void> },
			baseFetch: customFetch,
		});

		const res = await fetch("https://custom.api.com/data");

		expect(res.status).toBe(201);
		expect(calls).toEqual(["https://custom.api.com/data"]);
		expect(emitted).toHaveLength(1);
	});

	it("uses trace context when getTraceContext is provided", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e), flush: () => Promise.resolve() };
		const fetch = createTracedFetch({
			telemetry: telemetry as { emit: (e: ExternalCallEvent) => void; flush: () => Promise<void> },
			baseFetch: mockFetch,
			getTraceContext: () => ({
				trace_id: "a".repeat(32),
				parent_span_id: "b".repeat(16),
			}),
		});

		await fetch("https://api.example.com/users");

		const event = emitted[0] as Record<string, unknown>;
		expect(event.trace_id).toBe("a".repeat(32));
		expect(event.parent_span_id).toBe("b".repeat(16));
	});

	it("injects traceparent header when propagateTo allows URL", async () => {
		const emitted: unknown[] = [];
		let observedTraceparent: string | null = null;
		const telemetry = { emit: (e: unknown) => emitted.push(e), flush: () => Promise.resolve() };
		const baseFetch: FetchFn = async (input, init) => {
			observedTraceparent = readTraceparentHeader(input, init);
			return new Response("ok", { status: 200 });
		};
		const fetch = createTracedFetch({
			telemetry: telemetry as { emit: (e: ExternalCallEvent) => void; flush: () => Promise<void> },
			baseFetch,
			getTraceContext: () => ({
				trace_id: "a".repeat(32),
				parent_span_id: "b".repeat(16),
			}),
			propagateTo: () => true,
		});

		await fetch("https://api.example.com/users");

		expect(observedTraceparent).toMatch(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/);

		const event = emitted[0] as Record<string, unknown>;
		expect(observedTraceparent).not.toBeNull();
		if (observedTraceparent == null) {
			throw new Error("expected traceparent header to be present");
		}
		expect(String(observedTraceparent)).toBe(`00-${event.trace_id}-${event.span_id}-01`);
	});

	it("does not inject traceparent header by default for cross-origin requests", async () => {
		let observedTraceparent: string | null = "preset";
		const telemetry = { emit: () => {}, flush: () => Promise.resolve() };
		const baseFetch: FetchFn = async (input, init) => {
			observedTraceparent = readTraceparentHeader(input, init);
			return new Response("ok", { status: 200 });
		};
		const fetch = createTracedFetch({
			telemetry: telemetry as { emit: (e: ExternalCallEvent) => void; flush: () => Promise<void> },
			baseFetch,
			getTraceContext: () => ({
				trace_id: "a".repeat(32),
				parent_span_id: "b".repeat(16),
			}),
		});

		await fetch("https://api.example.com/users");

		expect(observedTraceparent).toBeNull();
	});

	it("exposes response traceparent via callback", async () => {
		const telemetry = { emit: () => {}, flush: () => Promise.resolve() };
		const responseTraceparent = `00-${"c".repeat(32)}-${"d".repeat(16)}-01`;
		let observed: string | undefined;
		const baseFetch: FetchFn = async () =>
			new Response("ok", {
				status: 200,
				headers: { traceparent: responseTraceparent },
			});
		const fetch = createTracedFetch({
			telemetry: telemetry as { emit: (e: ExternalCallEvent) => void; flush: () => Promise<void> },
			baseFetch,
			onResponseTraceparent: (traceparent) => {
				observed = traceparent;
			},
		});

		await fetch("https://api.example.com/users");

		expect(observed).toBe(responseTraceparent);
	});

	it("emits outcome error for 5xx responses", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e), flush: () => Promise.resolve() };
		const serverErrorFetch: FetchFn = async () =>
			new Response("Internal Server Error", { status: 500 });
		const fetch = createTracedFetch({
			telemetry: telemetry as { emit: (e: ExternalCallEvent) => void; flush: () => Promise<void> },
			baseFetch: serverErrorFetch,
		});

		const res = await fetch("https://api.example.com/fail");

		expect(res.status).toBe(500);
		expect(emitted).toHaveLength(1);
		const event = emitted[0] as Record<string, unknown>;
		expect(event.outcome).toBe("error");
		expect(event.status_code).toBe(500);
	});

	it("emits outcome success for 4xx responses", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e), flush: () => Promise.resolve() };
		const notFoundFetch: FetchFn = async () => new Response("Not Found", { status: 404 });
		const fetch = createTracedFetch({
			telemetry: telemetry as { emit: (e: ExternalCallEvent) => void; flush: () => Promise<void> },
			baseFetch: notFoundFetch,
		});

		const res = await fetch("https://api.example.com/missing");

		expect(res.status).toBe(404);
		expect(emitted).toHaveLength(1);
		const event = emitted[0] as Record<string, unknown>;
		expect(event.outcome).toBe("success");
	});
});
