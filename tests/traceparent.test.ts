import { describe, expect, it } from "bun:test";
import { formatTraceparent, parseTraceparent } from "../src/traceparent.ts";

describe("parseTraceparent", () => {
	it("parses a valid traceparent header", () => {
		const result = parseTraceparent("00-4bf92f3577b86cd56163f2543210c4a0-00f067aa0ba902b7-01");
		expect(result).toEqual({
			version: "00",
			traceId: "4bf92f3577b86cd56163f2543210c4a0",
			parentId: "00f067aa0ba902b7",
			traceFlags: "01",
		});
	});

	it("returns null for null/undefined/empty input", () => {
		expect(parseTraceparent(null)).toBeNull();
		expect(parseTraceparent(undefined)).toBeNull();
		expect(parseTraceparent("")).toBeNull();
	});

	it("rejects all-zero trace-id", () => {
		const result = parseTraceparent(`00-${"0".repeat(32)}-00f067aa0ba902b7-01`);
		expect(result).toBeNull();
	});

	it("rejects all-zero parent-id", () => {
		const result = parseTraceparent(`00-4bf92f3577b86cd56163f2543210c4a0-${"0".repeat(16)}-01`);
		expect(result).toBeNull();
	});

	it("rejects malformed headers", () => {
		expect(parseTraceparent("not-a-traceparent")).toBeNull();
		expect(parseTraceparent("00-short-abcdef0123456789-01")).toBeNull();
		expect(parseTraceparent("00-4bf92f3577b86cd56163f2543210c4a0-short-01")).toBeNull();
		expect(parseTraceparent("xx-4bf92f3577b86cd56163f2543210c4a0-00f067aa0ba902b7-01")).toBeNull();
	});

	it("rejects reserved ff version", () => {
		expect(parseTraceparent("ff-4bf92f3577b86cd56163f2543210c4a0-00f067aa0ba902b7-01")).toBeNull();
	});

	it("normalizes uppercase to lowercase", () => {
		const result = parseTraceparent("00-4BF92F3577B86CD56163F2543210C4A0-00F067AA0BA902B7-01");
		expect(result).toEqual({
			version: "00",
			traceId: "4bf92f3577b86cd56163f2543210c4a0",
			parentId: "00f067aa0ba902b7",
			traceFlags: "01",
		});
	});

	it("trims whitespace", () => {
		const result = parseTraceparent("  00-4bf92f3577b86cd56163f2543210c4a0-00f067aa0ba902b7-01  ");
		expect(result).not.toBeNull();
		expect(result?.traceId).toBe("4bf92f3577b86cd56163f2543210c4a0");
	});

	it("parses trace-flags 00 (not sampled)", () => {
		const result = parseTraceparent("00-4bf92f3577b86cd56163f2543210c4a0-00f067aa0ba902b7-00");
		expect(result).not.toBeNull();
		expect(result?.traceFlags).toBe("00");
	});
});

describe("formatTraceparent", () => {
	it("formats a traceparent header with default flags", () => {
		const result = formatTraceparent("4bf92f3577b86cd56163f2543210c4a0", "00f067aa0ba902b7");
		expect(result).toBe("00-4bf92f3577b86cd56163f2543210c4a0-00f067aa0ba902b7-01");
	});

	it("formats with custom flags", () => {
		const result = formatTraceparent("4bf92f3577b86cd56163f2543210c4a0", "00f067aa0ba902b7", "00");
		expect(result).toBe("00-4bf92f3577b86cd56163f2543210c4a0-00f067aa0ba902b7-00");
	});

	it("round-trips with parseTraceparent", () => {
		const traceId = "abcdef0123456789abcdef0123456789";
		const parentId = "fedcba9876543210";
		const header = formatTraceparent(traceId, parentId, "01");
		const parsed = parseTraceparent(header);
		expect(parsed).toEqual({
			version: "00",
			traceId,
			parentId,
			traceFlags: "01",
		});
	});
});
