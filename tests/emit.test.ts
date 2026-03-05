import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createTelemetry } from "../src/index.ts";
import type { PresetEvents } from "../src/types.ts";

const TEST_DIR = join(import.meta.dirname, ".test-emit-logs");
const TEST_FILE = "emit-test.jsonl";

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (condition()) return;
		await Bun.sleep(5);
	}
	throw new Error("Timed out waiting for condition");
}

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("createTelemetry", () => {
	it("emits events with timestamp to file", async () => {
		const telemetry = await createTelemetry<PresetEvents>({
			logDir: TEST_DIR,
			filename: TEST_FILE,
		});

		telemetry.emit({
			record_type: "event",
			spec_version: 1,
			kind: "http.request",
			trace_id: "abc123",
			method: "GET",
			path: "/api/health",
			status_code: 200,
			outcome: "success",
			duration_ms: 12,
		});

		const logFile = join(TEST_DIR, TEST_FILE);
		await waitFor(() => existsSync(logFile));
		const content = readFileSync(logFile, "utf-8").trim();
		const event = JSON.parse(content);
		expect(event.kind).toBe("http.request");
		expect(event.trace_id).toBe("abc123");
		expect(event.timestamp).toBeDefined();
		expect(typeof event.timestamp).toBe("string");
	});

	it("respects isEnabled guard", async () => {
		let enabled = false;
		const telemetry = await createTelemetry<PresetEvents>({
			logDir: TEST_DIR,
			filename: TEST_FILE,
			isEnabled: () => enabled,
		});

		telemetry.emit({
			record_type: "event",
			spec_version: 1,
			kind: "http.request",
			trace_id: "abc",
			method: "GET",
			path: "/",
			status_code: 200,
			outcome: "success",
			duration_ms: 1,
		});

		// File should not exist when disabled
		const fileExists = Bun.file(join(TEST_DIR, TEST_FILE)).size > 0;
		expect(fileExists).toBe(false);

		// Enable and emit
		enabled = true;
		telemetry.emit({
			record_type: "event",
			spec_version: 1,
			kind: "http.request",
			trace_id: "def",
			method: "POST",
			path: "/data",
			status_code: 201,
			outcome: "success",
			duration_ms: 5,
		});

		const logFile = join(TEST_DIR, TEST_FILE);
		await waitFor(() => existsSync(logFile));
		const content = readFileSync(logFile, "utf-8").trim();
		expect(JSON.parse(content).trace_id).toBe("def");
	});

	it("emit never throws even with bad data", async () => {
		type LooseEvent = {
			record_type: "event";
			spec_version: 1;
			kind: string;
			trace_id: string;
			[key: string]: unknown;
		};

		const telemetry = await createTelemetry<LooseEvent>({
			logDir: TEST_DIR,
			filename: TEST_FILE,
		});

		// Create circular reference to break JSON.stringify
		const circular: LooseEvent = {
			record_type: "event",
			spec_version: 1,
			kind: "custom.circular",
			trace_id: "x",
		};
		circular.self = circular;

		expect(() => telemetry.emit(circular)).not.toThrow();
	});

	it("supports custom event types", async () => {
		type CustomEvent = {
			record_type: "event";
			spec_version: 1;
			kind: "custom.checkout";
			trace_id: string;
			orderId: string;
			amount: number;
		};

		const telemetry = await createTelemetry<CustomEvent>({
			logDir: TEST_DIR,
			filename: TEST_FILE,
		});

		telemetry.emit({
			record_type: "event",
			spec_version: 1,
			kind: "custom.checkout",
			trace_id: "trace1",
			orderId: "order-abc",
			amount: 4999,
		});

		const logFile = join(TEST_DIR, TEST_FILE);
		await waitFor(() => existsSync(logFile));
		const content = readFileSync(logFile, "utf-8").trim();
		const event = JSON.parse(content);
		expect(event.kind).toBe("custom.checkout");
		expect(event.orderId).toBe("order-abc");
	});

	it("truncates overlong string fields in emitted events", async () => {
		type LooseEvent = {
			record_type: "event";
			spec_version: 1;
			kind: string;
			trace_id: string;
			[key: string]: unknown;
		};

		const telemetry = await createTelemetry<LooseEvent>({
			logDir: TEST_DIR,
			filename: TEST_FILE,
		});

		telemetry.emit({
			record_type: "event",
			spec_version: 1,
			kind: "http.request",
			trace_id: "abc123",
			path: "x".repeat(2000), // exceeds http.request.path limit of 1024
			error_name: "e".repeat(200), // exceeds error_name limit of 120
		} as LooseEvent);

		const logFile = join(TEST_DIR, TEST_FILE);
		await waitFor(() => existsSync(logFile));
		const content = readFileSync(logFile, "utf-8").trim();
		const event = JSON.parse(content);

		// path should be truncated to 1024 bytes
		expect(Buffer.byteLength(event.path)).toBeLessThanOrEqual(1024);
		expect(event.path).toContain("...[truncated]");

		// error_name should be truncated to 120 bytes
		expect(Buffer.byteLength(event.error_name)).toBeLessThanOrEqual(120);
		expect(event.error_name).toContain("...[truncated]");

		// trace_id must NOT be truncated
		expect(event.trace_id).toBe("abc123");
	});

	it("truncates entity keys and values", async () => {
		const telemetry = await createTelemetry<PresetEvents>({
			logDir: TEST_DIR,
			filename: TEST_FILE,
		});

		telemetry.emit({
			record_type: "event",
			spec_version: 1,
			kind: "http.request",
			trace_id: "abc",
			method: "GET",
			path: "/test",
			status_code: 200,
			outcome: "success",
			duration_ms: 1,
			entities: { ["k".repeat(100)]: "v".repeat(500) },
		});

		const logFile = join(TEST_DIR, TEST_FILE);
		await waitFor(() => existsSync(logFile));
		const content = readFileSync(logFile, "utf-8").trim();
		const event = JSON.parse(content);

		const keys = Object.keys(event.entities);
		expect(Buffer.byteLength(keys[0])).toBeLessThanOrEqual(64);
		expect(Buffer.byteLength(Object.values(event.entities)[0] as string)).toBeLessThanOrEqual(256);
	});

	it("always injects record_type and spec_version even if omitted by caller", async () => {
		type LooseEvent = {
			record_type: "event";
			spec_version: 1;
			kind: string;
			trace_id: string;
			[key: string]: unknown;
		};

		const telemetry = await createTelemetry<LooseEvent>({
			logDir: TEST_DIR,
			filename: TEST_FILE,
		});

		// Cast to bypass TypeScript — simulates a caller who omits required fields
		telemetry.emit({ kind: "custom.test", trace_id: "abc" } as unknown as LooseEvent);

		const logFile = join(TEST_DIR, TEST_FILE);
		await waitFor(() => existsSync(logFile));
		const content = readFileSync(logFile, "utf-8").trim();
		const event = JSON.parse(content);
		expect(event.record_type).toBe("event");
		expect(event.spec_version).toBe(1);
		expect(event.kind).toBe("custom.test");
		expect(event.timestamp).toBeDefined();
	});
});
