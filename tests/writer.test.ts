import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createWriter } from "../src/writer.ts";

const TEST_DIR = join(import.meta.dirname, ".test-logs");
const TEST_FILE = "test.jsonl";

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

describe("createWriter", () => {
	it("creates log directory and writes lines", async () => {
		const writer = await createWriter({ logDir: TEST_DIR, filename: TEST_FILE });
		writer.write('{"test":1}');
		writer.write('{"test":2}');

		const logFile = join(TEST_DIR, TEST_FILE);
		await waitFor(() => {
			try {
				return readFileSync(logFile, "utf-8").trim().split("\n").length === 2;
			} catch {
				return false;
			}
		});

		const content = readFileSync(logFile, "utf-8");
		const lines = content.trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0])).toEqual({ test: 1 });
	});

	it("rotates file when maxSize is exceeded", async () => {
		mkdirSync(TEST_DIR, { recursive: true });
		const logFile = join(TEST_DIR, TEST_FILE);

		// Write a file that exceeds the small maxSize
		writeFileSync(logFile, "x".repeat(200));

		const writer = await createWriter({
			logDir: TEST_DIR,
			filename: TEST_FILE,
			maxSize: 100,
			maxBackups: 2,
		});

		writer.write('{"after":"rotation"}');

		await waitFor(() => {
			if (!existsSync(`${logFile}.1`) || !existsSync(logFile)) return false;
			try {
				return JSON.parse(readFileSync(logFile, "utf-8").trim()).after === "rotation";
			} catch {
				return false;
			}
		});

		// Original file should have been rotated to .1
		expect(existsSync(`${logFile}.1`)).toBe(true);
		const rotatedContent = readFileSync(`${logFile}.1`, "utf-8");
		expect(rotatedContent).toBe("x".repeat(200));

		// New file should have the new line
		const newContent = readFileSync(logFile, "utf-8").trim();
		expect(JSON.parse(newContent)).toEqual({ after: "rotation" });
	});

	it("rotates when next line would exceed maxSize", async () => {
		mkdirSync(TEST_DIR, { recursive: true });
		const logFile = join(TEST_DIR, TEST_FILE);
		writeFileSync(logFile, "x".repeat(100));

		const writer = await createWriter({
			logDir: TEST_DIR,
			filename: TEST_FILE,
			maxSize: 100,
			maxBackups: 2,
		});

		writer.write('{"next":1}');

		await waitFor(() => {
			if (!existsSync(`${logFile}.1`) || !existsSync(logFile)) return false;
			try {
				return JSON.parse(readFileSync(logFile, "utf-8").trim()).next === 1;
			} catch {
				return false;
			}
		});

		expect(existsSync(`${logFile}.1`)).toBe(true);
		expect(readFileSync(`${logFile}.1`, "utf-8")).toBe("x".repeat(100));
		expect(JSON.parse(readFileSync(logFile, "utf-8").trim())).toEqual({ next: 1 });
	});

	it("chains rotation backups correctly", async () => {
		mkdirSync(TEST_DIR, { recursive: true });
		const logFile = join(TEST_DIR, TEST_FILE);

		// Create existing backup
		writeFileSync(`${logFile}.1`, "backup-1");
		writeFileSync(logFile, "x".repeat(200));

		const writer = await createWriter({
			logDir: TEST_DIR,
			filename: TEST_FILE,
			maxSize: 100,
			maxBackups: 3,
		});

		writer.write('{"new":true}');

		await waitFor(
			() => existsSync(`${logFile}.2`) && existsSync(`${logFile}.1`) && existsSync(logFile),
		);

		// backup-1 should have moved to .2
		expect(readFileSync(`${logFile}.2`, "utf-8")).toBe("backup-1");
		// original should be at .1
		expect(readFileSync(`${logFile}.1`, "utf-8")).toBe("x".repeat(200));
	});

	it("replaces existing .1 when maxBackups is 1", async () => {
		mkdirSync(TEST_DIR, { recursive: true });
		const logFile = join(TEST_DIR, TEST_FILE);

		writeFileSync(`${logFile}.1`, "old-backup");
		writeFileSync(logFile, "x".repeat(200));

		const writer = await createWriter({
			logDir: TEST_DIR,
			filename: TEST_FILE,
			maxSize: 100,
			maxBackups: 1,
		});

		writer.write('{"new":true}');

		await waitFor(() => {
			if (!existsSync(`${logFile}.1`) || !existsSync(logFile)) return false;
			try {
				return JSON.parse(readFileSync(logFile, "utf-8").trim()).new === true;
			} catch {
				return false;
			}
		});

		expect(readFileSync(`${logFile}.1`, "utf-8")).toBe("x".repeat(200));
		expect(JSON.parse(readFileSync(logFile, "utf-8").trim())).toEqual({ new: true });
	});

	it("does not keep backups when maxBackups is 0", async () => {
		mkdirSync(TEST_DIR, { recursive: true });
		const logFile = join(TEST_DIR, TEST_FILE);

		writeFileSync(logFile, "x".repeat(200));

		const writer = await createWriter({
			logDir: TEST_DIR,
			filename: TEST_FILE,
			maxSize: 100,
			maxBackups: 0,
		});

		writer.write('{"zero":true}');

		await waitFor(() => {
			if (!existsSync(logFile)) return false;
			try {
				return JSON.parse(readFileSync(logFile, "utf-8").trim()).zero === true;
			} catch {
				return false;
			}
		});

		expect(existsSync(`${logFile}.1`)).toBe(false);
		expect(JSON.parse(readFileSync(logFile, "utf-8").trim())).toEqual({ zero: true });
	});

	it("falls back to console when filesystem writes fail after startup", async () => {
		mkdirSync(TEST_DIR, { recursive: true });
		mkdirSync(join(TEST_DIR, TEST_FILE), { recursive: true });

		const writer = await createWriter({
			logDir: TEST_DIR,
			filename: TEST_FILE,
		});

		const logSpy = spyOn(console, "log").mockImplementation(() => {});
		try {
			writer.write('{"first":1}');
			writer.write('{"second":2}');

			await waitFor(() => logSpy.mock.calls.length === 2);

			expect(logSpy).toHaveBeenCalledTimes(2);
			expect(logSpy.mock.calls[0]?.[0]).toBe('[TEL] {"first":1}');
			expect(logSpy.mock.calls[1]?.[0]).toBe('[TEL] {"second":2}');
		} finally {
			logSpy.mockRestore();
		}
	});

	it("write never throws on error", async () => {
		const writer = await createWriter({
			logDir: "/nonexistent/deeply/nested/path/that/will/fail",
			filename: TEST_FILE,
		});

		// Should not throw — falls back to console
		expect(() => writer.write('{"test":1}')).not.toThrow();
	});

	it("uses default logDir and filename when called with no config", async () => {
		// Regression: passing { logDir: undefined } via spread would override defaults,
		// causing path.resolve(undefined) to throw and trigger console fallback.
		const defaultDir = join(process.cwd(), "logs");
		const defaultFile = join(defaultDir, "telemetry.jsonl");
		rmSync(defaultFile, { force: true });

		const writer = await createWriter();
		writer.write('{"default":true}');

		await waitFor(() => {
			if (!existsSync(defaultFile)) return false;
			try {
				return JSON.parse(readFileSync(defaultFile, "utf-8").trim()).default === true;
			} catch {
				return false;
			}
		});

		const content = readFileSync(defaultFile, "utf-8").trim();
		expect(JSON.parse(content)).toEqual({ default: true });

		// Clean up default log
		rmSync(defaultFile, { force: true });
	});
});
