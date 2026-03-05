import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
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

			// Expect 3 calls: diagnostic (writer_fallback_activated) + 2 data lines
			await waitFor(() => logSpy.mock.calls.length === 3);

			expect(logSpy).toHaveBeenCalledTimes(3);
			// First call is the fallback activation diagnostic
			const diagLine = logSpy.mock.calls[0]?.[0] as string;
			expect(diagLine).toContain("writer_fallback_activated");
			expect(logSpy.mock.calls[1]?.[0]).toBe('[TEL] {"first":1}');
			expect(logSpy.mock.calls[2]?.[0]).toBe('[TEL] {"second":2}');
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
		// With no config, resolveOutputPath discovers project root and creates
		// .agent-telemetry/{sessionId}/{role}-{pid}.jsonl — verify it doesn't
		// fall back to console by writing to a known test directory instead.
		const writer = await createWriter({ logDir: TEST_DIR });
		writer.write('{"default":true}');

		// The filename should follow {role}-{pid}.jsonl pattern
		// readdirSync imported at top
		await waitFor(() => {
			if (!existsSync(TEST_DIR)) return false;
			try {
				const files = readdirSync(TEST_DIR) as string[];
				const jsonl = files.find((f: string) => f.endsWith(".jsonl"));
				if (!jsonl) return false;
				return JSON.parse(readFileSync(join(TEST_DIR, jsonl), "utf-8").trim()).default === true;
			} catch {
				return false;
			}
		});

		const files = readdirSync(TEST_DIR) as string[];
		const logFileName = files.find((f: string) => f.endsWith(".jsonl"));
		expect(logFileName).toBeDefined();
		expect(logFileName).toMatch(/^server-\d+\.jsonl$/);

		const content = readFileSync(join(TEST_DIR, logFileName as string), "utf-8").trim();
		expect(JSON.parse(content)).toEqual({ default: true });
	});

	it("restricts directory permissions to owner-only on POSIX", async () => {
		const writer = await createWriter({ logDir: TEST_DIR, filename: TEST_FILE });
		writer.write('{"perm":1}');
		await writer.flush();

		const stat = statSync(TEST_DIR);
		// mode & 0o077 should be 0 (no group/other access)
		expect(stat.mode & 0o077).toBe(0);
	});

	it("restricts file permissions to owner-only on POSIX", async () => {
		const writer = await createWriter({ logDir: TEST_DIR, filename: TEST_FILE });
		writer.write('{"perm":1}');
		await writer.flush();

		const logFile = join(TEST_DIR, TEST_FILE);
		await waitFor(() => existsSync(logFile));
		const stat = statSync(logFile);
		// mode & 0o077 should be 0 (no group/other access)
		expect(stat.mode & 0o077).toBe(0);
	});

	it("creates .gitignore in .agent-telemetry root", async () => {
		const telemetryRoot = join(TEST_DIR, ".agent-telemetry");
		const sessionDir = join(telemetryRoot, "test-session");

		const writer = await createWriter({ logDir: sessionDir, filename: TEST_FILE });
		writer.write('{"git":1}');
		await writer.flush();

		const gitignorePath = join(telemetryRoot, ".gitignore");
		await waitFor(() => existsSync(gitignorePath));
		expect(readFileSync(gitignorePath, "utf-8")).toBe("*\n");
	});

	it("uses custom sessionId and role in filename", async () => {
		const writer = await createWriter({
			logDir: TEST_DIR,
			sessionId: "my-session",
			role: "worker",
		});
		writer.write('{"custom":1}');
		await writer.flush();

		const files = readdirSync(TEST_DIR) as string[];
		const logFileName = files.find((f: string) => f.endsWith(".jsonl"));
		expect(logFileName).toMatch(/^worker-\d+\.jsonl$/);
	});

	it("respects AGENT_TELEMETRY_FILE env var", async () => {
		const envFile = join(TEST_DIR, "custom-output.jsonl");
		const original = process.env.AGENT_TELEMETRY_FILE;
		process.env.AGENT_TELEMETRY_FILE = envFile;
		try {
			const writer = await createWriter();
			writer.write('{"env":1}');
			await writer.flush();

			await waitFor(() => existsSync(envFile));
			const content = readFileSync(envFile, "utf-8").trim();
			expect(JSON.parse(content)).toEqual({ env: 1 });
		} finally {
			process.env.AGENT_TELEMETRY_FILE = original;
		}
	});

	it("respects AGENT_TELEMETRY_DIR env var", async () => {
		const original = process.env.AGENT_TELEMETRY_DIR;
		process.env.AGENT_TELEMETRY_DIR = TEST_DIR;
		try {
			const writer = await createWriter();
			writer.write('{"envdir":1}');
			await writer.flush();

			const files = readdirSync(TEST_DIR) as string[];
			const logFileName = files.find((f: string) => f.endsWith(".jsonl"));
			expect(logFileName).toBeDefined();
			expect(logFileName).toMatch(/^server-\d+\.jsonl$/);

			const content = readFileSync(join(TEST_DIR, logFileName as string), "utf-8").trim();
			expect(JSON.parse(content)).toEqual({ envdir: 1 });
		} finally {
			process.env.AGENT_TELEMETRY_DIR = original;
		}
	});

	it("explicit config takes priority over env vars", async () => {
		const original = process.env.AGENT_TELEMETRY_FILE;
		process.env.AGENT_TELEMETRY_FILE = "/tmp/should-not-be-used.jsonl";
		try {
			const writer = await createWriter({ logDir: TEST_DIR, filename: TEST_FILE });
			writer.write('{"priority":1}');
			await writer.flush();

			const logFile = join(TEST_DIR, TEST_FILE);
			await waitFor(() => existsSync(logFile));
			const content = readFileSync(logFile, "utf-8").trim();
			expect(JSON.parse(content)).toEqual({ priority: 1 });
		} finally {
			process.env.AGENT_TELEMETRY_FILE = original;
		}
	});
});
