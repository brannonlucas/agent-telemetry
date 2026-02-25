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
			kind: "http.request",
			traceId: "abc123",
			method: "GET",
			path: "/api/health",
			status: 200,
			duration_ms: 12,
		});

		const logFile = join(TEST_DIR, TEST_FILE);
		await waitFor(() => existsSync(logFile));
		const content = readFileSync(logFile, "utf-8").trim();
		const event = JSON.parse(content);
		expect(event.kind).toBe("http.request");
		expect(event.traceId).toBe("abc123");
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
			kind: "http.request",
			traceId: "abc",
			method: "GET",
			path: "/",
			status: 200,
			duration_ms: 1,
		});

		// File should not exist when disabled
		const fileExists = Bun.file(join(TEST_DIR, TEST_FILE)).size > 0;
		expect(fileExists).toBe(false);

		// Enable and emit
		enabled = true;
		telemetry.emit({
			kind: "http.request",
			traceId: "def",
			method: "POST",
			path: "/data",
			status: 201,
			duration_ms: 5,
		});

		const logFile = join(TEST_DIR, TEST_FILE);
		await waitFor(() => existsSync(logFile));
		const content = readFileSync(logFile, "utf-8").trim();
		expect(JSON.parse(content).traceId).toBe("def");
	});

	it("emit never throws even with bad data", async () => {
		type LooseEvent = {
			kind: string;
			traceId: string;
			[key: string]: unknown;
		};

		const telemetry = await createTelemetry<LooseEvent>({
			logDir: TEST_DIR,
			filename: TEST_FILE,
		});

		// Create circular reference to break JSON.stringify
		const circular: LooseEvent = { kind: "custom.circular", traceId: "x" };
		circular.self = circular;

		expect(() => telemetry.emit(circular)).not.toThrow();
	});

	it("supports custom event types", async () => {
		type CustomEvent = {
			kind: "custom.checkout";
			traceId: string;
			orderId: string;
			amount: number;
		};

		const telemetry = await createTelemetry<CustomEvent>({
			logDir: TEST_DIR,
			filename: TEST_FILE,
		});

		telemetry.emit({
			kind: "custom.checkout",
			traceId: "trace1",
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
});
