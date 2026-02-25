import { describe, expect, it } from "bun:test";
import {
	type FetchFn,
	createBrowserTraceContext,
	createBrowserTracedFetch,
} from "../src/browser.ts";

function readTraceparentHeader(input: RequestInfo | URL, init?: RequestInit): string | null {
	if (input instanceof Request) {
		return input.headers.get("traceparent");
	}
	return new Headers(init?.headers).get("traceparent");
}

describe("createBrowserTraceContext", () => {
	it("bootstraps from initial traceparent", () => {
		const incomingTraceId = "a".repeat(32);
		const incomingParentId = "b".repeat(16);
		const trace = createBrowserTraceContext({
			initialTraceparent: `00-${incomingTraceId}-${incomingParentId}-01`,
		});

		expect(trace.getTraceContext()).toEqual({
			traceId: incomingTraceId,
			parentSpanId: incomingParentId,
			traceFlags: "01",
		});
	});

	it("generates fresh context when initial traceparent is invalid", () => {
		const trace = createBrowserTraceContext({ initialTraceparent: "invalid" });
		const ctx = trace.getTraceContext();

		expect(ctx.traceId).toMatch(/^[\da-f]{32}$/);
		expect(ctx.parentSpanId).toMatch(/^[\da-f]{16}$/);
		expect(ctx.traceFlags).toBe("01");
	});

	it("withSpan uses child span and restores parent span afterward", async () => {
		const trace = createBrowserTraceContext({
			initialTraceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
		});

		const before = trace.getTraceContext().parentSpanId;
		let insideParent: string | undefined;
		let insideSpan: string | undefined;

		await trace.withSpan("ui.click", async (ctx) => {
			insideParent = ctx.parentSpanId;
			insideSpan = ctx.spanId;
		});

		expect(insideParent).toMatch(/^[\da-f]{16}$/);
		expect(insideSpan).toMatch(/^[\da-f]{16}$/);
		expect(insideParent).toBe(insideSpan);
		expect(trace.getTraceContext().parentSpanId).toBe(before);
	});
});

describe("createBrowserTracedFetch", () => {
	it("injects traceparent when propagation predicate allows URL", async () => {
		let observedTraceparent: string | null = null;
		const baseFetch: FetchFn = async (input, init) => {
			observedTraceparent = readTraceparentHeader(input, init);
			return new Response("ok", { status: 200 });
		};
		const trace = createBrowserTraceContext({
			initialTraceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
		});
		const fetch = createBrowserTracedFetch({
			baseFetch,
			trace,
			propagateTo: () => true,
		});

		await fetch("https://api.example.com/users");

		expect(observedTraceparent).toMatch(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/);
	});

	it("does not inject traceparent for cross-origin URL with default policy", async () => {
		const globalWithLocation = globalThis as { location?: { origin?: string } };
		const previousLocation = globalWithLocation.location;
		globalWithLocation.location = { origin: "https://app.example.com" };

		try {
			let observedTraceparent: string | null = "preset";
			const baseFetch: FetchFn = async (input, init) => {
				observedTraceparent = readTraceparentHeader(input, init);
				return new Response("ok", { status: 200 });
			};
			const trace = createBrowserTraceContext({
				initialTraceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
			});
			const fetch = createBrowserTracedFetch({
				baseFetch,
				trace,
			});

			await fetch("https://third-party.example.com/users");

			expect(observedTraceparent).toBeNull();
		} finally {
			globalWithLocation.location = previousLocation;
		}
	});

	it("updates context from response traceparent", async () => {
		const responseTraceId = "c".repeat(32);
		const responseSpanId = "d".repeat(16);
		const baseFetch: FetchFn = async () =>
			new Response("ok", {
				status: 200,
				headers: {
					traceparent: `00-${responseTraceId}-${responseSpanId}-01`,
				},
			});
		const trace = createBrowserTraceContext({
			initialTraceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
		});
		const fetch = createBrowserTracedFetch({
			baseFetch,
			trace,
			propagateTo: () => true,
		});

		await fetch("https://api.example.com/users");

		expect(trace.getTraceContext()).toEqual({
			traceId: responseTraceId,
			parentSpanId: responseSpanId,
			traceFlags: "01",
		});
	});
});
