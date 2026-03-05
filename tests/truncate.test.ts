import { describe, expect, it } from "bun:test";
import { truncateField } from "../src/truncate.ts";

describe("truncateField", () => {
	it("returns value unchanged when within limit", () => {
		expect(truncateField("hello", 256)).toBe("hello");
	});

	it("returns value unchanged when exactly at limit", () => {
		const value = "a".repeat(64);
		expect(truncateField(value, 64)).toBe(value);
	});

	it("truncates at max_bytes + 1", () => {
		const value = "a".repeat(65);
		const result = truncateField(value, 64);
		expect(result).toContain("...[truncated]");
		expect(Buffer.byteLength(result)).toBeLessThanOrEqual(64);
	});

	it("uses exact suffix ...[truncated]", () => {
		const value = "a".repeat(100);
		const result = truncateField(value, 64);
		expect(result).toEndWith("...[truncated]");
	});

	it("is deterministic (same input same output)", () => {
		const value = "x".repeat(500);
		const a = truncateField(value, 100);
		const b = truncateField(value, 100);
		expect(a).toBe(b);
	});

	it("handles multi-byte UTF-8 at boundary without splitting", () => {
		// '€' is 3 bytes. Build a string that needs truncation.
		// "aaa€" repeated: "aaa€aaa€aaa€" = (3+3)*4 = 24 bytes
		const value = "aaa€aaa€aaa€aaa€"; // 4 * 6 = 24 bytes
		expect(Buffer.byteLength(value)).toBe(24);

		// limit 20: keep = 20 - 14 = 6 bytes. "aaa€" = 6 bytes fits exactly.
		const result = truncateField(value, 20);
		expect(result).toBe("aaa€...[truncated]");
		expect(Buffer.byteLength(result)).toBeLessThanOrEqual(20);

		// limit 19: keep = 19 - 14 = 5 bytes. "aaa€" = 6 > 5, so cut before €: "aaa" = 3 bytes
		const tight = truncateField(value, 19);
		expect(tight).toBe("aaa...[truncated]");
		expect(Buffer.byteLength(tight)).toBeLessThanOrEqual(19);
	});

	it("handles 4-byte emoji at boundary", () => {
		// '😀' is 4 bytes. "ab😀cd😀ef😀" = 2 + 4 + 2 + 4 + 2 + 4 = 18 bytes
		const value = "ab😀cd😀ef😀";
		expect(Buffer.byteLength(value)).toBe(18);

		// limit 16: keep = 16 - 14 = 2. "ab" = 2 fits, "ab😀" = 6 doesn't
		const result = truncateField(value, 16);
		expect(result).toBe("ab...[truncated]");
		expect(Buffer.byteLength(result)).toBeLessThanOrEqual(16);
	});

	it("handles edge case where maxBytes < suffix length", () => {
		const value = "a".repeat(100);
		const result = truncateField(value, 5);
		// Should return first 5 bytes of "...[truncated]"
		expect(result).toBe("...[t");
		expect(Buffer.byteLength(result)).toBeLessThanOrEqual(5);
	});

	it("handles maxBytes exactly equal to suffix length", () => {
		const value = "a".repeat(100);
		const suffixLen = Buffer.byteLength("...[truncated]"); // 14
		const result = truncateField(value, suffixLen);
		expect(result).toBe("...[truncated]");
	});

	it("does not truncate multi-byte string that fits in byte limit", () => {
		// String with multi-byte chars: "café" = 5 bytes (é is 2 bytes)
		const value = "café";
		expect(truncateField(value, 5)).toBe("café");
		expect(truncateField(value, 256)).toBe("café");
	});

	it("preserves output byte length <= maxBytes for all cases", () => {
		const testCases = [
			{ value: "hello world this is a test", maxBytes: 20 },
			{ value: "€€€€€€€€€€", maxBytes: 15 },
			{ value: "😀😀😀😀😀", maxBytes: 18 },
			{ value: "abc", maxBytes: 1 },
			{ value: "a".repeat(10000), maxBytes: 256 },
		];

		for (const { value, maxBytes } of testCases) {
			const result = truncateField(value, maxBytes);
			expect(Buffer.byteLength(result)).toBeLessThanOrEqual(maxBytes);
		}
	});
});
