import { describe, expect, it } from "bun:test";
import {
	type TraceSummary,
	classifyTrust,
	escapeControlChars,
	processTelemetry,
} from "../src/consumer/index.ts";

describe("processTelemetry", () => {
	it("produces deterministic summary from valid events", () => {
		const content = [
			JSON.stringify({
				record_type: "event",
				spec_version: 1,
				kind: "http.request",
				trace_id: "t1",
				span_id: "s1",
				method: "GET",
				path: "/api",
				status_code: 200,
				outcome: "success",
				duration_ms: 10,
			}),
			JSON.stringify({
				record_type: "event",
				spec_version: 1,
				kind: "db.query",
				trace_id: "t1",
				span_id: "s2",
				parent_span_id: "s1",
				provider: "prisma",
				operation: "findMany",
				duration_ms: 5,
				outcome: "success",
			}),
		].join("\n");

		const result1 = processTelemetry(content);
		const result2 = processTelemetry(content);
		expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));

		const summary = result1.summaries[0];
		expect(summary.trace_id).toBe("t1");
		expect(summary.event_count).toBe(2);
		expect(summary.root_span_ids).toEqual(["s1"]);
		expect(summary.events).toHaveLength(2);
	});

	it("tracks malformed lines as uncertainty", () => {
		const content = [
			JSON.stringify({
				record_type: "event",
				spec_version: 1,
				kind: "http.request",
				trace_id: "t1",
				span_id: "s1",
			}),
			"{bad json",
			"also bad",
		].join("\n");

		const result = processTelemetry(content);
		const malformed = result.summaries[0].uncertainties.find(
			(u) => u.code === "malformed_line_skipped",
		);
		expect(malformed).toBeDefined();
		expect(malformed?.count).toBe(2);
		expect(malformed?.severity).toBe("warn");
	});

	it("tracks missing parent spans as uncertainty", () => {
		const content = [
			JSON.stringify({
				record_type: "event",
				spec_version: 1,
				kind: "http.request",
				trace_id: "t1",
				span_id: "s1",
				parent_span_id: "nonexistent",
			}),
		].join("\n");

		const result = processTelemetry(content);
		const missing = result.summaries[0].uncertainties.find((u) => u.code === "missing_parent_span");
		expect(missing).toBeDefined();
		expect(missing?.severity).toBe("warn");
	});

	it("tracks unknown event kinds as uncertainty", () => {
		const content = JSON.stringify({
			record_type: "event",
			spec_version: 1,
			kind: "weird.unknown",
			trace_id: "t1",
			span_id: "s1",
		});

		const result = processTelemetry(content);
		const unknown = result.summaries[0].uncertainties.find(
			(u) => u.code === "unknown_kind_ignored",
		);
		expect(unknown).toBeDefined();
		expect(unknown?.severity).toBe("info");
	});

	it("does not flag custom.* kinds as unknown", () => {
		const content = JSON.stringify({
			record_type: "event",
			spec_version: 1,
			kind: "custom.checkout",
			trace_id: "t1",
			span_id: "s1",
		});

		const result = processTelemetry(content);
		const unknown = result.summaries[0].uncertainties.find(
			(u) => u.code === "unknown_kind_ignored",
		);
		expect(unknown).toBeUndefined();
	});

	it("detects writer_fallback_active from diagnostics", () => {
		const content = [
			JSON.stringify({
				record_type: "event",
				spec_version: 1,
				kind: "http.request",
				trace_id: "t1",
				span_id: "s1",
			}),
			JSON.stringify({
				record_type: "diagnostic",
				spec_version: 1,
				code: "writer_fallback_activated",
				message: "fallback",
			}),
		].join("\n");

		const result = processTelemetry(content);
		const fallback = result.summaries[0].uncertainties.find(
			(u) => u.code === "writer_fallback_active",
		);
		expect(fallback).toBeDefined();
		expect(fallback?.severity).toBe("error");
	});

	it("applies field truncation and tracks count", () => {
		const longPath = "x".repeat(2000);
		const content = JSON.stringify({
			record_type: "event",
			spec_version: 1,
			kind: "http.request",
			trace_id: "t1",
			span_id: "s1",
			path: longPath,
		});

		const result = processTelemetry(content);
		expect(result.summaries[0].truncation_count).toBeGreaterThan(0);
		const pathValue = result.summaries[0].events[0].attributes.path as string;
		expect(pathValue).toContain("...[truncated]");
	});

	it("aggregates entities across events", () => {
		const content = [
			JSON.stringify({
				record_type: "event",
				spec_version: 1,
				kind: "http.request",
				trace_id: "t1",
				span_id: "s1",
				entities: { userId: "u1", orgId: "o1" },
			}),
			JSON.stringify({
				record_type: "event",
				spec_version: 1,
				kind: "http.request",
				trace_id: "t1",
				span_id: "s2",
				entities: { userId: "u2" },
			}),
		].join("\n");

		const result = processTelemetry(content);
		const entities = result.summaries[0].entities;
		expect(entities.userId).toEqual(["u1", "u2"]);
		expect(entities.orgId).toEqual(["o1"]);
	});

	it("includes trust classification per field", () => {
		const content = JSON.stringify({
			record_type: "event",
			spec_version: 1,
			kind: "http.request",
			trace_id: "t1",
			span_id: "s1",
			path: "/api",
			method: "GET",
		});

		const result = processTelemetry(content);
		const trust = result.summaries[0].events[0].trust;
		expect(trust.trace_id).toBe("system_asserted");
		expect(trust.path).toBe("untrusted_input");
		expect(trust.method).toBe("system_asserted");
	});

	it("handles multiple traces in single file", () => {
		const content = [
			JSON.stringify({
				record_type: "event",
				spec_version: 1,
				kind: "http.request",
				trace_id: "t1",
				span_id: "s1",
			}),
			JSON.stringify({
				record_type: "event",
				spec_version: 1,
				kind: "http.request",
				trace_id: "t2",
				span_id: "s2",
			}),
		].join("\n");

		const result = processTelemetry(content);
		expect(result.summaries).toHaveLength(2);
		// Sorted by trace_id
		expect(result.summaries[0].trace_id).toBe("t1");
		expect(result.summaries[1].trace_id).toBe("t2");
	});
});

describe("classifyTrust", () => {
	it("classifies known fields correctly", () => {
		expect(classifyTrust("trace_id")).toBe("system_asserted");
		expect(classifyTrust("path")).toBe("untrusted_input");
		expect(classifyTrust("outcome")).toBe("derived");
	});

	it("classifies unknown fields as unknown", () => {
		expect(classifyTrust("custom_field")).toBe("unknown");
	});
});

describe("escapeControlChars", () => {
	it("escapes common control characters", () => {
		expect(escapeControlChars("hello\tworld")).toBe("hello\\tworld");
		expect(escapeControlChars("line\nbreak")).toBe("line\\nbreak");
		expect(escapeControlChars("cr\rreturn")).toBe("cr\\rreturn");
	});

	it("escapes null bytes", () => {
		expect(escapeControlChars("null\x00byte")).toBe("null\\u0000byte");
	});

	it("passes through normal text unchanged", () => {
		expect(escapeControlChars("normal text 123")).toBe("normal text 123");
	});

	it("handles mixed control characters", () => {
		expect(escapeControlChars("\x01\x02\x03")).toBe("\\u0001\\u0002\\u0003");
	});
});
