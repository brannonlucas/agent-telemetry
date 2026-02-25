/**
 * JSONL Writer
 *
 * Writes telemetry events to a JSONL file with size-based rotation.
 * Auto-detects runtime: uses filesystem when available (Node/Bun),
 * falls back to console.log with a configurable prefix (Cloudflare Workers).
 *
 * The writer is initialized asynchronously (runtime probe), but the returned
 * write function is synchronous and never throws.
 */

export interface WriterConfig {
	logDir: string;
	filename: string;
	maxSize: number;
	maxBackups: number;
	prefix: string;
}

export interface Writer {
	write: (line: string) => void;
}

const DEFAULTS: WriterConfig = {
	logDir: "logs",
	filename: "telemetry.jsonl",
	maxSize: 5_000_000,
	maxBackups: 3,
	prefix: "[TEL]",
};

function hasErrnoCode(err: unknown, code: string): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		(err as { code?: unknown }).code === code
	);
}

/**
 * Create a writer that appends JSONL lines to a file with rotation.
 * Falls back to console.log if the filesystem is unavailable.
 */
export async function createWriter(config?: Partial<WriterConfig>): Promise<Writer> {
	const cfg: WriterConfig = {
		logDir: config?.logDir ?? DEFAULTS.logDir,
		filename: config?.filename ?? DEFAULTS.filename,
		maxSize: config?.maxSize ?? DEFAULTS.maxSize,
		maxBackups: config?.maxBackups ?? DEFAULTS.maxBackups,
		prefix: config?.prefix ?? DEFAULTS.prefix,
	};
	const writeToConsole = (line: string): void => {
		// biome-ignore lint/suspicious/noConsole: intentional fallback for runtimes without filesystem
		console.log(`${cfg.prefix} ${line}`);
	};

	try {
		const fs = await import("node:fs");
		const fsPromises = await import("node:fs/promises");
		const path = await import("node:path");

		const logDir = path.resolve(cfg.logDir);
		const logFile = path.join(logDir, cfg.filename);

		// Probe: verify filesystem actually works
		// (Cloudflare's nodejs_compat stubs succeed silently)
		await fsPromises.mkdir(logDir, { recursive: true });
		if (!fs.existsSync(logDir)) {
			throw new Error("Filesystem probe failed");
		}

		let useConsoleFallback = false;
		let flushScheduled = false;
		let flushInProgress = false;
		let sizeCache: number | undefined;
		let pending: string[] = [];

		const unlinkIfExists = async (filePath: string): Promise<void> => {
			try {
				await fsPromises.unlink(filePath);
			} catch (err) {
				if (!hasErrnoCode(err, "ENOENT")) throw err;
			}
		};

		const fileExists = async (filePath: string): Promise<boolean> => {
			try {
				await fsPromises.access(filePath);
				return true;
			} catch (err) {
				if (hasErrnoCode(err, "ENOENT")) return false;
				throw err;
			}
		};

		const getCurrentSize = async (): Promise<number> => {
			if (sizeCache !== undefined) return sizeCache;
			try {
				sizeCache = (await fsPromises.stat(logFile)).size;
			} catch (err) {
				if (!hasErrnoCode(err, "ENOENT")) throw err;
				sizeCache = 0;
			}
			return sizeCache;
		};

		const rotate = async (): Promise<void> => {
			if (!(await fileExists(logFile))) {
				sizeCache = 0;
				return;
			}

			if (cfg.maxBackups <= 0) {
				await unlinkIfExists(logFile);
				sizeCache = 0;
				return;
			}

			const oldestBackup = `${logFile}.${cfg.maxBackups}`;
			await unlinkIfExists(oldestBackup);

			for (let i = cfg.maxBackups - 1; i >= 1; i--) {
				const from = `${logFile}.${i}`;
				const to = `${logFile}.${i + 1}`;
				if (await fileExists(from)) {
					await fsPromises.rename(from, to);
				}
			}

			await fsPromises.rename(logFile, `${logFile}.1`);
			sizeCache = 0;
		};

		const scheduleFlush = (): void => {
			if (flushScheduled || flushInProgress || useConsoleFallback) return;
			flushScheduled = true;
			queueMicrotask(() => {
				flushScheduled = false;
				void flushPending();
			});
		};

		const flushPending = async (): Promise<void> => {
			if (flushInProgress || useConsoleFallback) return;
			flushInProgress = true;

			try {
				while (pending.length > 0 && !useConsoleFallback) {
					const batch = pending;
					pending = [];

					const chunk = batch.map((line) => `${line}\n`).join("");
					const incomingSize = Buffer.byteLength(chunk);

					try {
						let currentSize = await getCurrentSize();
						if (cfg.maxSize > 0 && currentSize + incomingSize > cfg.maxSize) {
							await rotate();
							currentSize = 0;
						}

						await fsPromises.appendFile(logFile, chunk);
						sizeCache = currentSize + incomingSize;
					} catch {
						useConsoleFallback = true;
						for (const line of batch) {
							writeToConsole(line);
						}
						for (const line of pending) {
							writeToConsole(line);
						}
						pending = [];
						sizeCache = undefined;
					}
				}
			} finally {
				flushInProgress = false;
				if (pending.length > 0 && !useConsoleFallback) {
					scheduleFlush();
				}
			}
		};

		return {
			write(line: string) {
				try {
					if (useConsoleFallback) {
						writeToConsole(line);
						return;
					}

					pending.push(line);
					scheduleFlush();
				} catch {
					writeToConsole(line);
				}
			},
		};
	} catch {
		// Import failed or filesystem probe failed — console fallback
		return {
			write: writeToConsole,
		};
	}
}
