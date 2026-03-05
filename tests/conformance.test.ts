import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLine } from "../src/consumer/parser.ts";
import { processTelemetry } from "../src/consumer/pipeline.ts";

const CONTRACTS_DIR = join(import.meta.dirname, "..", "contracts", "agent-telemetry", "v1");

describe("contract pack", () => {
	it("manifest.json is valid and references existing files", () => {
		const manifest = JSON.parse(readFileSync(join(CONTRACTS_DIR, "manifest.json"), "utf-8"));
		expect(manifest.spec_version).toBe(1);
		expect(manifest.contract_version).toBeDefined();

		for (const path of Object.keys(manifest.artifacts)) {
			const fullPath = join(CONTRACTS_DIR, path);
			// File should exist and be valid JSON
			const content = readFileSync(fullPath, "utf-8");
			expect(() => JSON.parse(content)).not.toThrow();
		}
	});

	it("all schemas are valid JSON", () => {
		const manifest = JSON.parse(readFileSync(join(CONTRACTS_DIR, "manifest.json"), "utf-8"));
		for (const path of Object.keys(manifest.artifacts)) {
			if (path.endsWith(".schema.json")) {
				const schema = JSON.parse(readFileSync(join(CONTRACTS_DIR, path), "utf-8"));
				expect(schema.$schema).toBeDefined();
				expect(schema.type || schema.allOf).toBeDefined();
			}
		}
	});

	it("limits.json matches src/limits.ts field limits", () => {
		const limits = JSON.parse(readFileSync(join(CONTRACTS_DIR, "limits.json"), "utf-8"));
		expect(limits.kind).toBe(64);
		expect(limits.error_name).toBe(120);
		expect(limits["http.request.path"]).toBe(1024);
		expect(limits._default).toBe(256);
	});

	it("enums.json contains all required enums", () => {
		const enums = JSON.parse(readFileSync(join(CONTRACTS_DIR, "enums.json"), "utf-8"));
		expect(enums.outcome).toEqual(["success", "error"]);
		expect(enums.diagnostic_level).toEqual(["debug", "info", "warn", "error"]);
		expect(enums.record_type).toEqual(["event", "diagnostic"]);
	});

	it("regex.json patterns match spec grammar", () => {
		const regex = JSON.parse(readFileSync(join(CONTRACTS_DIR, "regex.json"), "utf-8"));

		// Test kind pattern
		const kindRe = new RegExp(regex.kind);
		expect(kindRe.test("http.request")).toBe(true);
		expect(kindRe.test("db.query")).toBe(true);
		expect(kindRe.test("custom.event.deep")).toBe(true);
		expect(kindRe.test("HTTP.Request")).toBe(false);
		expect(kindRe.test("single")).toBe(false);

		// Test trace_id pattern
		const traceRe = new RegExp(regex.trace_id);
		expect(traceRe.test("a".repeat(32))).toBe(true);
		expect(traceRe.test("abc")).toBe(false);

		// Test span_id pattern
		const spanRe = new RegExp(regex.span_id);
		expect(spanRe.test("a".repeat(16))).toBe(true);
		expect(spanRe.test("abc")).toBe(false);
	});
});

describe("negative vectors", () => {
	const vectors = JSON.parse(
		readFileSync(join(CONTRACTS_DIR, "negative-vectors.json"), "utf-8"),
	).vectors;

	it("parser correctly handles skip vectors", () => {
		for (const vector of vectors.filter((v: { expected: string }) => v.expected === "skip")) {
			const result = parseLine(vector.input);
			expect(result).toBeNull();
		}
	});

	it("pipeline handles truncation vectors", () => {
		// nv-09: oversize path field
		const oversizeEvent = JSON.stringify({
			record_type: "event",
			spec_version: 1,
			kind: "http.request",
			trace_id: "t1",
			span_id: "s1",
			path: "x".repeat(2000),
		});
		const result = processTelemetry(oversizeEvent);
		expect(result.summaries[0].truncation_count).toBeGreaterThan(0);
	});
});

describe("conformance fixtures", () => {
	it("valid http.request event matches base schema structure", () => {
		const event = {
			record_type: "event",
			spec_version: 1,
			kind: "http.request",
			trace_id: "a".repeat(32),
			span_id: "b".repeat(16),
			method: "GET",
			path: "/api/users",
			status_code: 200,
			outcome: "success",
			duration_ms: 42,
		};

		const line = JSON.stringify(event);
		const parsed = parseLine(line);
		expect(parsed).not.toBeNull();
		expect(parsed?.record_type).toBe("event");
		expect(parsed?.spec_version).toBe(1);
	});

	it("valid diagnostic record matches schema structure", () => {
		const diag = {
			record_type: "diagnostic",
			spec_version: 1,
			code: "event_dropped_oversize",
			message: "record exceeded max size",
			level: "warn",
			details: { serialized_size: 2000000, max_record_size: 1048576 },
		};

		const parsed = parseLine(JSON.stringify(diag));
		expect(parsed).not.toBeNull();
		expect(parsed?.record_type).toBe("diagnostic");
	});

	it("pipeline produces valid trace summary structure", () => {
		const content = [
			JSON.stringify({
				record_type: "event",
				spec_version: 1,
				kind: "http.request",
				trace_id: "a".repeat(32),
				span_id: "b".repeat(16),
				method: "GET",
				path: "/api",
				status_code: 200,
				outcome: "success",
				duration_ms: 10,
			}),
		].join("\n");

		const result = processTelemetry(content);
		const summary = result.summaries[0];

		// Verify required fields
		expect(summary.spec_version).toBe(1);
		expect(summary.trace_id).toBe("a".repeat(32));
		expect(summary.event_count).toBe(1);
		expect(summary.diagnostic_count).toBeGreaterThanOrEqual(0);
		expect(summary.truncation_count).toBeGreaterThanOrEqual(0);
		expect(Array.isArray(summary.root_span_ids)).toBe(true);
		expect(Array.isArray(summary.events)).toBe(true);
		expect(Array.isArray(summary.diagnostics)).toBe(true);
		expect(Array.isArray(summary.uncertainties)).toBe(true);
		expect(typeof summary.entities).toBe("object");
	});
});
