import { describe, expect, it } from "bun:test";
import { extractEntities, extractEntitiesFromEvent } from "../src/entities.ts";

const patterns = [
	{ segment: "users", key: "userId" },
	{ segment: "posts", key: "postId" },
];

describe("extractEntities", () => {
	it("extracts a single entity from a path", () => {
		const result = extractEntities("/api/users/10000000-0000-4000-a000-000000000001", patterns);
		expect(result).toEqual({ userId: "10000000-0000-4000-a000-000000000001" });
	});

	it("extracts multiple entities from a nested path", () => {
		const result = extractEntities(
			"/api/users/10000000-0000-4000-a000-000000000001/posts/20000000-0000-4000-a000-000000000002",
			patterns,
		);
		expect(result).toEqual({
			userId: "10000000-0000-4000-a000-000000000001",
			postId: "20000000-0000-4000-a000-000000000002",
		});
	});

	it("returns undefined when no patterns match", () => {
		expect(extractEntities("/api/health", patterns)).toBeUndefined();
	});

	it("returns undefined when segment matches but value is not a UUID", () => {
		expect(extractEntities("/api/users/not-a-uuid", patterns)).toBeUndefined();
	});

	it("works with empty patterns array", () => {
		expect(extractEntities("/api/users/10000000-0000-4000-a000-000000000001", [])).toBeUndefined();
	});
});

describe("extractEntitiesFromEvent", () => {
	const keys = ["userId", "postId"];

	it("extracts string values at specified keys", () => {
		const result = extractEntitiesFromEvent({ userId: "abc", postId: "def" }, keys);
		expect(result).toEqual({ userId: "abc", postId: "def" });
	});

	it("ignores non-string values", () => {
		const result = extractEntitiesFromEvent({ userId: "abc", postId: 42 }, keys);
		expect(result).toEqual({ userId: "abc" });
	});

	it("returns undefined when no keys match", () => {
		expect(extractEntitiesFromEvent({ other: "val" }, keys)).toBeUndefined();
	});

	it("returns undefined for undefined data", () => {
		expect(extractEntitiesFromEvent(undefined, keys)).toBeUndefined();
	});

	it("returns undefined for empty keys", () => {
		expect(extractEntitiesFromEvent({ userId: "abc" }, [])).toBeUndefined();
	});
});
