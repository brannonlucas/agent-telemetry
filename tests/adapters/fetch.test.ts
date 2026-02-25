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
		const telemetry = { emit: (e: unknown) => emitted.push(e) };
		const fetch = createTracedFetch({
			telemetry: telemetry as { emit: (e: ExternalCallEvent) => void },
			baseFetch: mockFetch,
		});

		await fetch("https://api.example.com/users");

		expect(emitted).toHaveLength(1);
		const event = emitted[0] as Record<string, unknown>;
		expect(event.kind).toBe("external.call");
		expect(event.service).toBe("api.example.com");
		expect(event.operation).toBe("GET /users");
		expect(event.status).toBe("success");
		expect(typeof event.duration_ms).toBe("number");
		expect(typeof event.traceId).toBe("string");
		expect(typeof event.spanId).toBe("string");
	});

	it("emits external.call event for URL object", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };
		const fetch = createTracedFetch({
			telemetry: telemetry as { emit: (e: ExternalCallEvent) => void },
			baseFetch: mockFetch,
		});

		await fetch(new URL("https://api.example.com/users"));

		expect(emitted).toHaveLength(1);
		const event = emitted[0] as Record<string, unknown>;
		expect(event.kind).toBe("external.call");
		expect(event.service).toBe("api.example.com");
		expect(event.operation).toBe("GET /users");
		expect(event.status).toBe("success");
	});

	it("emits external.call event for Request object", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };
		const fetch = createTracedFetch({
			telemetry: telemetry as { emit: (e: ExternalCallEvent) => void },
			baseFetch: mockFetch,
		});

		await fetch(new Request("https://api.example.com/users", { method: "POST" }));

		expect(emitted).toHaveLength(1);
		const event = emitted[0] as Record<string, unknown>;
		expect(event.kind).toBe("external.call");
		expect(event.operation).toBe("POST /users");
		expect(event.status).toBe("success");
	});

	it("derives service from hostname", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };
		const fetch = createTracedFetch({
			telemetry: telemetry as { emit: (e: ExternalCallEvent) => void },
			baseFetch: mockFetch,
		});

		await fetch("https://api.stripe.com/v1/charges");

		const event = emitted[0] as Record<string, unknown>;
		expect(event.service).toBe("api.stripe.com");
	});

	it("derives operation from method and pathname", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };
		const fetch = createTracedFetch({
			telemetry: telemetry as { emit: (e: ExternalCallEvent) => void },
			baseFetch: mockFetch,
		});

		await fetch("https://api.example.com/users");
		expect((emitted[0] as Record<string, unknown>).operation).toBe("GET /users");

		await fetch("https://api.stripe.com/v1/charges", { method: "POST" });
		expect((emitted[1] as Record<string, unknown>).operation).toBe("POST /v1/charges");
	});

	it("handles relative URLs gracefully", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };
		const fetch = createTracedFetch({
			telemetry: telemetry as { emit: (e: ExternalCallEvent) => void },
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
		const telemetry = { emit: (e: unknown) => emitted.push(e) };
		const fetch = createTracedFetch({
			telemetry: telemetry as { emit: (e: ExternalCallEvent) => void },
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
		const telemetry = { emit: (e: unknown) => emitted.push(e) };
		const fetch = createTracedFetch({
			telemetry: telemetry as { emit: (e: ExternalCallEvent) => void },
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
		expect(event.status).toBe("error");
		expect(typeof event.duration_ms).toBe("number");
	});

	it("skips tracing when isEnabled returns false", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };
		let fetchCalled = false;
		const baseFetch: FetchFn = async () => {
			fetchCalled = true;
			return new Response("ok", { status: 200 });
		};
		const fetch = createTracedFetch({
			telemetry: telemetry as { emit: (e: ExternalCallEvent) => void },
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
		const telemetry = { emit: (e: unknown) => emitted.push(e) };
		const fetch = createTracedFetch({
			telemetry: telemetry as { emit: (e: ExternalCallEvent) => void },
			baseFetch: customFetch,
		});

		const res = await fetch("https://custom.api.com/data");

		expect(res.status).toBe(201);
		expect(calls).toEqual(["https://custom.api.com/data"]);
		expect(emitted).toHaveLength(1);
	});

	it("uses trace context when getTraceContext is provided", async () => {
		const emitted: unknown[] = [];
		const telemetry = { emit: (e: unknown) => emitted.push(e) };
		const fetch = createTracedFetch({
			telemetry: telemetry as { emit: (e: ExternalCallEvent) => void },
			baseFetch: mockFetch,
			getTraceContext: () => ({
				traceId: "a".repeat(32),
				parentSpanId: "b".repeat(16),
			}),
		});

		await fetch("https://api.example.com/users");

		const event = emitted[0] as Record<string, unknown>;
		expect(event.traceId).toBe("a".repeat(32));
		expect(event.parentSpanId).toBe("b".repeat(16));
	});

	it("injects traceparent header when propagateTo allows URL", async () => {
		const emitted: unknown[] = [];
		let observedTraceparent: string | null = null;
		const telemetry = { emit: (e: unknown) => emitted.push(e) };
		const baseFetch: FetchFn = async (input, init) => {
			observedTraceparent = readTraceparentHeader(input, init);
			return new Response("ok", { status: 200 });
		};
		const fetch = createTracedFetch({
			telemetry: telemetry as { emit: (e: ExternalCallEvent) => void },
			baseFetch,
			getTraceContext: () => ({
				traceId: "a".repeat(32),
				parentSpanId: "b".repeat(16),
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
		expect(String(observedTraceparent)).toBe(`00-${event.traceId}-${event.spanId}-01`);
	});

	it("does not inject traceparent header by default for cross-origin requests", async () => {
		let observedTraceparent: string | null = "preset";
		const telemetry = { emit: () => {} };
		const baseFetch: FetchFn = async (input, init) => {
			observedTraceparent = readTraceparentHeader(input, init);
			return new Response("ok", { status: 200 });
		};
		const fetch = createTracedFetch({
			telemetry: telemetry as { emit: (e: ExternalCallEvent) => void },
			baseFetch,
			getTraceContext: () => ({
				traceId: "a".repeat(32),
				parentSpanId: "b".repeat(16),
			}),
		});

		await fetch("https://api.example.com/users");

		expect(observedTraceparent).toBeNull();
	});

	it("exposes response traceparent via callback", async () => {
		const telemetry = { emit: () => {} };
		const responseTraceparent = `00-${"c".repeat(32)}-${"d".repeat(16)}-01`;
		let observed: string | undefined;
		const baseFetch: FetchFn = async () =>
			new Response("ok", {
				status: 200,
				headers: { traceparent: responseTraceparent },
			});
		const fetch = createTracedFetch({
			telemetry: telemetry as { emit: (e: ExternalCallEvent) => void },
			baseFetch,
			onResponseTraceparent: (traceparent) => {
				observed = traceparent;
			},
		});

		await fetch("https://api.example.com/users");

		expect(observed).toBe(responseTraceparent);
	});
});
