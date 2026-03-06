import { describe, expect, test } from "bun:test";
import {
	describeField,
	describeKind,
	getEnums,
	getGlossary,
	getLimits,
	getPatterns,
	listKinds,
} from "../src/schema.ts";

describe("schema introspection", () => {
	test("listKinds returns all six spec kinds", () => {
		const kinds = listKinds();
		expect(kinds).toEqual([
			"db.query",
			"external.call",
			"http.request",
			"job.dispatch",
			"job.end",
			"job.start",
		]);
	});

	test("describeKind returns merged schema for http.request", () => {
		const desc = describeKind("http.request");
		expect(desc).toBeDefined();
		expect(desc!.title).toBe("HTTP Request Event");
		expect(desc!.required).toContain("method");
		expect(desc!.required).toContain("trace_id");
		expect(desc!.properties.path).toEqual({ type: "string", maxLength: 1024 });
		expect(desc!.limits.path).toBe(1024);
		expect(desc!.limits.error_name).toBe(120);
	});

	test("describeKind returns undefined for unknown kind", () => {
		expect(describeKind("unknown.kind")).toBeUndefined();
	});

	test("describeKind includes base properties", () => {
		const desc = describeKind("db.query");
		expect(desc).toBeDefined();
		expect(desc!.properties.trace_id).toBeDefined();
		expect(desc!.properties.span_id).toBeDefined();
		expect(desc!.properties.timestamp).toBeDefined();
	});

	test("describeField returns glossary entry", () => {
		const desc = describeField("path");
		expect(desc).toBeDefined();
		expect(desc!.description).toContain("URL path");
		expect(desc!.inference_constraint).toContain("Untrusted");
	});

	test("describeField returns undefined for unknown field", () => {
		expect(describeField("nonexistent")).toBeUndefined();
	});

	test("getLimits returns all limits", () => {
		const limits = getLimits();
		expect(limits.kind).toBe(64);
		expect(limits["http.request.path"]).toBe(1024);
		expect(limits._default).toBe(256);
	});

	test("getLimits returns a copy", () => {
		const a = getLimits();
		const b = getLimits();
		expect(a).toEqual(b);
		a.kind = 999;
		expect(getLimits().kind).toBe(64);
	});

	test("getEnums returns all enums", () => {
		const enums = getEnums();
		expect(enums.outcome).toEqual(["success", "error"]);
		expect(enums.trust_class).toContain("system_asserted");
	});

	test("getPatterns returns regex patterns", () => {
		const patterns = getPatterns();
		expect(patterns.trace_id).toBe("^[0-9a-f]{32}$");
		expect(patterns.kind).toContain("[a-z]");
	});

	test("getGlossary returns all entries with descriptions", () => {
		const glossary = getGlossary();
		expect(Object.keys(glossary).length).toBeGreaterThanOrEqual(10);
		expect(glossary.trace_id.description).toContain("32 lowercase hex");
		expect(glossary.trace_id.inference_constraint).toContain("Opaque");
	});

	test("getGlossary returns copies", () => {
		const a = getGlossary();
		a.trace_id.description = "mutated";
		expect(getGlossary().trace_id.description).toContain("32 lowercase hex");
	});
});
