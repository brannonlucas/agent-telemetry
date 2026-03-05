import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type ReconstructedTrace,
	buildEntityIndex,
	getEntityValues,
	lookupEntity,
	parseContent,
	parseDirectory,
	parseFile,
	parseLine,
	reconstructTraces,
} from "../src/consumer/index.ts";

const TEST_DIR = join(import.meta.dirname, ".test-consumer-logs");

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("parseLine", () => {
	it("parses valid event record", () => {
		const line = JSON.stringify({
			record_type: "event",
			spec_version: 1,
			kind: "http.request",
			trace_id: "abc",
		});
		const result = parseLine(line);
		expect(result).not.toBeNull();
		expect(result?.record_type).toBe("event");
		expect(result?.kind).toBe("http.request");
	});

	it("parses valid diagnostic record", () => {
		const line = JSON.stringify({
			record_type: "diagnostic",
			spec_version: 1,
			code: "test",
			message: "hello",
		});
		const result = parseLine(line);
		expect(result).not.toBeNull();
		expect(result?.record_type).toBe("diagnostic");
	});

	it("returns null for malformed JSON", () => {
		expect(parseLine("{invalid")).toBeNull();
	});

	it("returns null for wrong record_type", () => {
		expect(parseLine(JSON.stringify({ record_type: "unknown", spec_version: 1 }))).toBeNull();
	});

	it("returns null for wrong spec_version", () => {
		expect(parseLine(JSON.stringify({ record_type: "event", spec_version: 2 }))).toBeNull();
	});

	it("returns null for empty line", () => {
		expect(parseLine("")).toBeNull();
		expect(parseLine("   ")).toBeNull();
	});

	it("returns null for array", () => {
		expect(parseLine("[1,2,3]")).toBeNull();
	});

	it("ignores unknown fields gracefully", () => {
		const line = JSON.stringify({
			record_type: "event",
			spec_version: 1,
			kind: "custom.thing",
			unknown_field: "hi",
		});
		const result = parseLine(line);
		expect(result).not.toBeNull();
		expect((result as Record<string, unknown>).unknown_field).toBe("hi");
	});
});

describe("parseContent", () => {
	it("parses multiple lines", () => {
		const lines = [
			JSON.stringify({
				record_type: "event",
				spec_version: 1,
				kind: "http.request",
				trace_id: "a",
			}),
			JSON.stringify({
				record_type: "event",
				spec_version: 1,
				kind: "http.request",
				trace_id: "b",
			}),
		].join("\n");

		const { records, diagnostics } = parseContent(lines, "test.jsonl");
		expect(records).toHaveLength(2);
		expect(diagnostics.malformed_lines).toBe(0);
	});

	it("skips malformed lines and counts them", () => {
		const lines = [
			JSON.stringify({
				record_type: "event",
				spec_version: 1,
				kind: "http.request",
				trace_id: "a",
			}),
			"{bad json",
			JSON.stringify({
				record_type: "event",
				spec_version: 1,
				kind: "http.request",
				trace_id: "b",
			}),
		].join("\n");

		const { records, diagnostics } = parseContent(lines, "test.jsonl");
		expect(records).toHaveLength(2);
		expect(diagnostics.malformed_lines).toBe(1);
	});

	it("includes source file and line metadata", () => {
		const lines = [
			"",
			JSON.stringify({
				record_type: "event",
				spec_version: 1,
				kind: "http.request",
				trace_id: "a",
			}),
		].join("\n");

		const { records } = parseContent(lines, "my-file.jsonl");
		expect(records[0].source_file).toBe("my-file.jsonl");
		expect(records[0].source_line).toBe(2);
	});
});

describe("parseFile", () => {
	it("reads and parses a .jsonl file", async () => {
		const filePath = join(TEST_DIR, "test.jsonl");
		writeFileSync(
			filePath,
			[
				JSON.stringify({
					record_type: "event",
					spec_version: 1,
					kind: "http.request",
					trace_id: "x",
				}),
				JSON.stringify({
					record_type: "diagnostic",
					spec_version: 1,
					code: "test",
					message: "msg",
				}),
			].join("\n"),
		);

		const { records, diagnostics } = await parseFile(filePath);
		expect(records).toHaveLength(2);
		expect(diagnostics.files_processed).toBe(1);
	});
});

describe("parseDirectory", () => {
	it("reads all .jsonl files in lexicographic order", async () => {
		writeFileSync(
			join(TEST_DIR, "b.jsonl"),
			JSON.stringify({
				record_type: "event",
				spec_version: 1,
				kind: "http.request",
				trace_id: "b",
			}),
		);
		writeFileSync(
			join(TEST_DIR, "a.jsonl"),
			JSON.stringify({
				record_type: "event",
				spec_version: 1,
				kind: "http.request",
				trace_id: "a",
			}),
		);
		writeFileSync(join(TEST_DIR, "not-jsonl.txt"), "ignored");

		const { records, diagnostics } = await parseDirectory(TEST_DIR);
		expect(records).toHaveLength(2);
		expect(diagnostics.files_processed).toBe(2);
		// a.jsonl should come first (lexicographic)
		expect(records[0].record.trace_id).toBe("a");
		expect(records[1].record.trace_id).toBe("b");
	});
});

describe("reconstructTraces", () => {
	it("groups events by trace_id", () => {
		const { records } = parseContent(
			[
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
				JSON.stringify({
					record_type: "event",
					spec_version: 1,
					kind: "http.request",
					trace_id: "t1",
					span_id: "s3",
				}),
			].join("\n"),
			"test.jsonl",
		);

		const traces = reconstructTraces(records);
		expect(traces.size).toBe(2);
		expect(traces.get("t1")?.events).toHaveLength(2);
		expect(traces.get("t2")?.events).toHaveLength(1);
	});

	it("builds parent-child span tree", () => {
		const { records } = parseContent(
			[
				JSON.stringify({
					record_type: "event",
					spec_version: 1,
					kind: "http.request",
					trace_id: "t1",
					span_id: "root",
				}),
				JSON.stringify({
					record_type: "event",
					spec_version: 1,
					kind: "db.query",
					trace_id: "t1",
					span_id: "child1",
					parent_span_id: "root",
				}),
				JSON.stringify({
					record_type: "event",
					spec_version: 1,
					kind: "external.call",
					trace_id: "t1",
					span_id: "child2",
					parent_span_id: "root",
				}),
			].join("\n"),
			"test.jsonl",
		);

		const traces = reconstructTraces(records);
		const trace = traces.get("t1") as ReconstructedTrace;
		expect(trace.root_spans).toHaveLength(1);
		expect(trace.root_spans[0].span_id).toBe("root");
		expect(trace.root_spans[0].children).toHaveLength(2);
	});

	it("handles missing parents as orphan roots", () => {
		const { records } = parseContent(
			[
				JSON.stringify({
					record_type: "event",
					spec_version: 1,
					kind: "http.request",
					trace_id: "t1",
					span_id: "s1",
					parent_span_id: "missing",
				}),
			].join("\n"),
			"test.jsonl",
		);

		const traces = reconstructTraces(records);
		const trace = traces.get("t1") as ReconstructedTrace;
		// Orphan span should be promoted to root
		expect(trace.root_spans).toHaveLength(1);
		expect(trace.root_spans[0].span_id).toBe("s1");
	});

	it("skips diagnostic records", () => {
		const { records } = parseContent(
			[
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
					code: "test",
					message: "msg",
				}),
			].join("\n"),
			"test.jsonl",
		);

		const traces = reconstructTraces(records);
		expect(traces.size).toBe(1);
	});
});

describe("entity pivoting", () => {
	const testRecords = () => {
		const { records } = parseContent(
			[
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
					entities: { userId: "u1" },
				}),
				JSON.stringify({
					record_type: "event",
					spec_version: 1,
					kind: "http.request",
					trace_id: "t2",
					span_id: "s3",
					entities: { userId: "u2" },
				}),
			].join("\n"),
			"test.jsonl",
		);
		return records;
	};

	it("builds entity index", () => {
		const index = buildEntityIndex(testRecords());
		expect(index.keys).toEqual(["orgId", "userId"]);
	});

	it("looks up events by entity", () => {
		const index = buildEntityIndex(testRecords());
		const u1Events = lookupEntity(index, "userId", "u1");
		expect(u1Events).toHaveLength(2);
		const u2Events = lookupEntity(index, "userId", "u2");
		expect(u2Events).toHaveLength(1);
	});

	it("returns empty for unknown entity", () => {
		const index = buildEntityIndex(testRecords());
		expect(lookupEntity(index, "userId", "nonexistent")).toHaveLength(0);
		expect(lookupEntity(index, "nonexistent", "u1")).toHaveLength(0);
	});

	it("gets unique values for entity key", () => {
		const index = buildEntityIndex(testRecords());
		expect(getEntityValues(index, "userId")).toEqual(["u1", "u2"]);
		expect(getEntityValues(index, "orgId")).toEqual(["o1"]);
	});
});
