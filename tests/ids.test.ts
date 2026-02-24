import { describe, expect, it } from "bun:test";
import { generateSpanId, generateTraceId } from "../src/ids.ts";

describe("generateTraceId", () => {
	it("returns a 32-char hex string", () => {
		const id = generateTraceId();
		expect(id).toHaveLength(32);
		expect(id).toMatch(/^[\da-f]{32}$/);
	});

	it("generates unique values", () => {
		const ids = new Set(Array.from({ length: 100 }, () => generateTraceId()));
		expect(ids.size).toBe(100);
	});
});

describe("generateSpanId", () => {
	it("returns a 16-char hex string", () => {
		const id = generateSpanId();
		expect(id).toHaveLength(16);
		expect(id).toMatch(/^[\da-f]{16}$/);
	});

	it("generates unique values", () => {
		const ids = new Set(Array.from({ length: 100 }, () => generateSpanId()));
		expect(ids.size).toBe(100);
	});
});
