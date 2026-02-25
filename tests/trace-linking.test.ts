import { describe, expect, it } from "bun:test";
import { createExpressTrace, getTraceContext } from "../src/adapters/express.ts";
import type { FetchFn } from "../src/adapters/fetch.ts";
import { createTracedFetch } from "../src/adapters/fetch.ts";
import { type PrismaTraceExtension, createPrismaTrace } from "../src/adapters/prisma.ts";
import type { DbQueryEvent, ExternalCallEvent, HttpRequestEvent } from "../src/types.ts";

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
		originalUrl: "/api/users",
		url: "/api/users",
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
			if (!listeners[event]) listeners[event] = [];
			listeners[event].push(listener);
		},
	};
}

function triggerEvent(res: MockResponse, event: string) {
	const fns = res._listeners[event];
	if (!fns) return;
	for (const fn of fns) fn();
}

function callAdapter(
	extension: PrismaTraceExtension,
	params: {
		model: string;
		operation: string;
		args: unknown;
		query: (args: unknown) => Promise<unknown>;
	},
) {
	return extension.query.$allModels.$allOperations(params);
}

function readTraceparentHeader(input: RequestInfo | URL, init?: RequestInit): string | undefined {
	if (input instanceof Request) return input.headers.get("traceparent") ?? undefined;
	return new Headers(init?.headers).get("traceparent") ?? undefined;
}

describe("trace linking", () => {
	it("links fetch -> http.request -> db.query via span parentage", async () => {
		const externalEvents: ExternalCallEvent[] = [];
		const httpEvents: HttpRequestEvent[] = [];
		const dbEvents: DbQueryEvent[] = [];

		const httpTelemetry = { emit: (event: HttpRequestEvent) => httpEvents.push(event) };
		const dbTelemetry = { emit: (event: DbQueryEvent) => dbEvents.push(event) };

		const middleware = createExpressTrace({ telemetry: httpTelemetry });

		const baseFetch: FetchFn = async (input, init) => {
			const incomingTraceparent = readTraceparentHeader(input, init);
			const req = createMockReq({
				headers: { traceparent: incomingTraceparent },
				originalUrl: "/api/users/10000000-0000-4000-a000-000000000001",
			});
			const res = createMockRes();

			const prismaExtension = createPrismaTrace({
				telemetry: dbTelemetry,
				getTraceContext: () => {
					const ctx = getTraceContext(req);
					return "_trace" in ctx ? ctx._trace : undefined;
				},
			});

			await new Promise<void>((resolve, reject) => {
				middleware(req, res, () => {
					void (async () => {
						try {
							await callAdapter(prismaExtension, {
								model: "User",
								operation: "findUnique",
								args: { where: { id: 1 } },
								query: async () => ({ id: 1 }),
							});
							triggerEvent(res, "finish");
							resolve();
						} catch (err) {
							reject(err);
						}
					})();
				});
			});

			return new Response("ok", {
				status: 200,
				headers: {
					traceparent: res._headers.traceparent,
				},
			});
		};

		const externalTelemetry = { emit: (event: ExternalCallEvent) => externalEvents.push(event) };
		const fetch = createTracedFetch({
			telemetry: externalTelemetry,
			baseFetch,
			getTraceContext: () => ({
				traceId: "a".repeat(32),
				parentSpanId: "b".repeat(16),
				traceFlags: "01",
			}),
			propagateTo: () => true,
		});

		await fetch("https://app.example.com/api/users");

		expect(externalEvents).toHaveLength(1);
		expect(httpEvents).toHaveLength(1);
		expect(dbEvents).toHaveLength(1);

		const external = externalEvents[0];
		const http = httpEvents[0];
		const db = dbEvents[0];

		expect(external.traceId).toBe(http.traceId);
		expect(http.traceId).toBe(db.traceId);
		expect(http.parentSpanId).toBe(external.spanId);
		expect(db.parentSpanId).toBe(http.spanId);
	});
});
