import { describe, expect, it } from "bun:test";
import type { FetchFn } from "../../src/adapters/supabase.ts";
import { createSupabaseTrace } from "../../src/adapters/supabase.ts";
import type { SupabaseEvents } from "../../src/types.ts";

const SUPABASE_URL = "https://abc123.supabase.co";
const mockFetch: FetchFn = async () => new Response("ok", { status: 200 });

function createTestHarness(overrides?: {
	baseFetch?: FetchFn;
	isEnabled?: () => boolean;
	getTraceContext?: () =>
		| { traceId: string; parentSpanId: string; traceFlags?: string }
		| undefined;
}) {
	const emitted: unknown[] = [];
	const telemetry = { emit: (e: unknown) => emitted.push(e) };
	const tracedFetch = createSupabaseTrace({
		telemetry: telemetry as { emit: (e: SupabaseEvents) => void },
		baseFetch: overrides?.baseFetch ?? mockFetch,
		...overrides,
	});
	return { emitted, tracedFetch };
}

describe("createSupabaseTrace", () => {
	// ================================================================
	// PostgREST (db.query) tests
	// ================================================================

	describe("PostgREST classification", () => {
		it("emits db.query for GET /rest/v1/users", async () => {
			const { emitted, tracedFetch } = createTestHarness();

			await tracedFetch(`${SUPABASE_URL}/rest/v1/users`);

			expect(emitted).toHaveLength(1);
			const event = emitted[0] as Record<string, unknown>;
			expect(event.kind).toBe("db.query");
			expect(event.provider).toBe("supabase");
			expect(event.model).toBe("users");
			expect(event.operation).toBe("select");
			expect(event.status).toBe("success");
			expect(typeof event.duration_ms).toBe("number");
			expect(typeof event.traceId).toBe("string");
			expect(typeof event.spanId).toBe("string");
		});

		it("emits db.query for POST /rest/v1/posts", async () => {
			const { emitted, tracedFetch } = createTestHarness();

			await tracedFetch(`${SUPABASE_URL}/rest/v1/posts`, {
				method: "POST",
			});

			expect(emitted).toHaveLength(1);
			const event = emitted[0] as Record<string, unknown>;
			expect(event.kind).toBe("db.query");
			expect(event.provider).toBe("supabase");
			expect(event.model).toBe("posts");
			expect(event.operation).toBe("insert");
		});

		it("emits db.query for PATCH /rest/v1/users?id=eq.1", async () => {
			const { emitted, tracedFetch } = createTestHarness();

			await tracedFetch(`${SUPABASE_URL}/rest/v1/users?id=eq.1`, { method: "PATCH" });

			expect(emitted).toHaveLength(1);
			const event = emitted[0] as Record<string, unknown>;
			expect(event.kind).toBe("db.query");
			expect(event.operation).toBe("update");
			expect(event.model).toBe("users");
		});

		it("emits db.query for DELETE /rest/v1/comments", async () => {
			const { emitted, tracedFetch } = createTestHarness();

			await tracedFetch(`${SUPABASE_URL}/rest/v1/comments`, {
				method: "DELETE",
			});

			expect(emitted).toHaveLength(1);
			const event = emitted[0] as Record<string, unknown>;
			expect(event.kind).toBe("db.query");
			expect(event.operation).toBe("delete");
			expect(event.model).toBe("comments");
		});

		it("emits db.query for PUT /rest/v1/users", async () => {
			const { emitted, tracedFetch } = createTestHarness();

			await tracedFetch(`${SUPABASE_URL}/rest/v1/users`, {
				method: "PUT",
			});

			expect(emitted).toHaveLength(1);
			const event = emitted[0] as Record<string, unknown>;
			expect(event.kind).toBe("db.query");
			expect(event.operation).toBe("upsert");
		});

		it("handles /rest/v2/ future URL pattern", async () => {
			const { emitted, tracedFetch } = createTestHarness();

			await tracedFetch(`${SUPABASE_URL}/rest/v2/profiles`);

			expect(emitted).toHaveLength(1);
			const event = emitted[0] as Record<string, unknown>;
			expect(event.kind).toBe("db.query");
			expect(event.provider).toBe("supabase");
			expect(event.model).toBe("profiles");
			expect(event.operation).toBe("select");
		});
	});

	// ================================================================
	// Auth tests
	// ================================================================

	describe("Auth classification", () => {
		it("emits external.call for /auth/v1/token", async () => {
			const { emitted, tracedFetch } = createTestHarness();

			await tracedFetch(`${SUPABASE_URL}/auth/v1/token`, {
				method: "POST",
			});

			expect(emitted).toHaveLength(1);
			const event = emitted[0] as Record<string, unknown>;
			expect(event.kind).toBe("external.call");
			expect(event.service).toBe("supabase-auth");
			expect(event.operation).toBe("token");
			expect(event.status).toBe("success");
		});

		it("emits external.call for /auth/v1/signup", async () => {
			const { emitted, tracedFetch } = createTestHarness();

			await tracedFetch(`${SUPABASE_URL}/auth/v1/signup`, {
				method: "POST",
			});

			expect(emitted).toHaveLength(1);
			const event = emitted[0] as Record<string, unknown>;
			expect(event.kind).toBe("external.call");
			expect(event.service).toBe("supabase-auth");
			expect(event.operation).toBe("signup");
		});
	});

	// ================================================================
	// Storage tests
	// ================================================================

	describe("Storage classification", () => {
		it("emits external.call for storage upload", async () => {
			const { emitted, tracedFetch } = createTestHarness();

			await tracedFetch(`${SUPABASE_URL}/storage/v1/object/avatars/photo.png`, { method: "POST" });

			expect(emitted).toHaveLength(1);
			const event = emitted[0] as Record<string, unknown>;
			expect(event.kind).toBe("external.call");
			expect(event.service).toBe("supabase-storage");
			expect(event.operation).toBe("POST avatars");
		});

		it("emits external.call for storage download", async () => {
			const { emitted, tracedFetch } = createTestHarness();

			await tracedFetch(`${SUPABASE_URL}/storage/v1/object/avatars/photo.png`);

			expect(emitted).toHaveLength(1);
			const event = emitted[0] as Record<string, unknown>;
			expect(event.kind).toBe("external.call");
			expect(event.service).toBe("supabase-storage");
			expect(event.operation).toBe("GET avatars");
		});
	});

	// ================================================================
	// Functions tests
	// ================================================================

	describe("Functions classification", () => {
		it("emits external.call for /functions/v1/hello", async () => {
			const { emitted, tracedFetch } = createTestHarness();

			await tracedFetch(`${SUPABASE_URL}/functions/v1/hello`, {
				method: "POST",
			});

			expect(emitted).toHaveLength(1);
			const event = emitted[0] as Record<string, unknown>;
			expect(event.kind).toBe("external.call");
			expect(event.service).toBe("supabase-functions");
			expect(event.operation).toBe("hello");
		});
	});

	// ================================================================
	// Fallback tests
	// ================================================================

	describe("Fallback classification", () => {
		it("emits external.call for unknown paths", async () => {
			const { emitted, tracedFetch } = createTestHarness();

			await tracedFetch(`${SUPABASE_URL}/unknown/path`, {
				method: "GET",
			});

			expect(emitted).toHaveLength(1);
			const event = emitted[0] as Record<string, unknown>;
			expect(event.kind).toBe("external.call");
			expect(event.service).toBe("supabase");
			expect(event.operation).toBe("GET /unknown/path");
		});
	});

	// ================================================================
	// General behavior tests
	// ================================================================

	describe("general behavior", () => {
		it("returns Response untouched", async () => {
			const original = new Response("ok", { status: 200 });
			const baseFetch = async () => original;
			const { tracedFetch } = createTestHarness({
				baseFetch: baseFetch as FetchFn,
			});

			const result = await tracedFetch(`${SUPABASE_URL}/rest/v1/users`);

			expect(result).toBe(original);
		});

		it("emits error event on network failure", async () => {
			const networkError = new Error("ECONNREFUSED");
			const failingFetch = async () => {
				throw networkError;
			};
			const { emitted, tracedFetch } = createTestHarness({
				baseFetch: failingFetch as FetchFn,
			});

			let thrown: Error | undefined;
			try {
				await tracedFetch(`${SUPABASE_URL}/rest/v1/users`);
			} catch (err) {
				thrown = err as Error;
			}

			expect(thrown).toBe(networkError);
			expect(emitted).toHaveLength(1);
			const event = emitted[0] as Record<string, unknown>;
			expect(event.kind).toBe("db.query");
			expect(event.status).toBe("error");
			expect(event.error).toBe("Error");
			expect(typeof event.duration_ms).toBe("number");
		});

		it("skips tracing when isEnabled returns false", async () => {
			let fetchCalled = false;
			const baseFetch = async () => {
				fetchCalled = true;
				return new Response("ok", { status: 200 });
			};
			const { emitted, tracedFetch } = createTestHarness({
				baseFetch: baseFetch as FetchFn,
				isEnabled: () => false,
			});

			const res = await tracedFetch(`${SUPABASE_URL}/rest/v1/users`);

			expect(res.status).toBe(200);
			expect(fetchCalled).toBe(true);
			expect(emitted).toHaveLength(0);
		});

		it("uses trace context when provided", async () => {
			const { emitted, tracedFetch } = createTestHarness({
				getTraceContext: () => ({
					traceId: "a".repeat(32),
					parentSpanId: "b".repeat(16),
				}),
			});

			await tracedFetch(`${SUPABASE_URL}/rest/v1/users`);

			const event = emitted[0] as Record<string, unknown>;
			expect(event.traceId).toBe("a".repeat(32));
			expect(event.parentSpanId).toBe("b".repeat(16));
		});

		it("uses custom baseFetch", async () => {
			const calls: string[] = [];
			const customFetch = async (input: RequestInfo | URL) => {
				calls.push(String(input));
				return new Response("custom", { status: 201 });
			};
			const { emitted, tracedFetch } = createTestHarness({
				baseFetch: customFetch as FetchFn,
			});

			const res = await tracedFetch(`${SUPABASE_URL}/rest/v1/users`);

			expect(res.status).toBe(201);
			expect(calls).toEqual([`${SUPABASE_URL}/rest/v1/users`]);
			expect(emitted).toHaveLength(1);
		});

		it("handles Request object input", async () => {
			const { emitted, tracedFetch } = createTestHarness();

			const request = new Request(`${SUPABASE_URL}/rest/v1/users`, { method: "POST" });
			await tracedFetch(request);

			expect(emitted).toHaveLength(1);
			const event = emitted[0] as Record<string, unknown>;
			expect(event.kind).toBe("db.query");
			expect(event.provider).toBe("supabase");
			expect(event.model).toBe("users");
			expect(event.operation).toBe("insert");
		});
	});
});
