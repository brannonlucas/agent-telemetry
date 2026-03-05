/**
 * JSONL Writer
 *
 * Writes telemetry records to a JSONL file with size-based rotation.
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
	maxRecordSize: number;
	prefix: string;
	sessionId?: string;
	role?: string;
}

export interface Writer {
	write: (line: string) => void;
	flush: () => Promise<void>;
}

const DEFAULTS: WriterConfig = {
	logDir: "",
	filename: "",
	maxSize: 5_000_000,
	maxBackups: 3,
	maxRecordSize: 1_048_576,
	prefix: "[TEL]",
};

/** Discover project root by walking up from cwd looking for markers. */
function findProjectRoot(
	startDir: string,
	existsSync: (p: string) => boolean,
	join: (...p: string[]) => string,
): string {
	let dir = startDir;
	const { root } = { root: "/" }; // simplified
	while (dir !== root && dir.length > 1) {
		if (
			existsSync(join(dir, ".git")) ||
			existsSync(join(dir, "package.json")) ||
			existsSync(join(dir, "deno.json"))
		) {
			return dir;
		}
		const parent = dir.slice(0, dir.lastIndexOf("/")) || "/";
		if (parent === dir) break;
		dir = parent;
	}
	return startDir;
}

/** Resolve output path following discovery order from spec. */
function resolveOutputPath(
	config: { logDir?: string; filename?: string; sessionId?: string; role?: string },
	existsSync: (p: string) => boolean,
	join: (...p: string[]) => string,
	resolve: (...p: string[]) => string,
): { logDir: string; filename: string } {
	// 1. Explicit config (highest priority)
	if (config.logDir && config.filename) {
		return { logDir: resolve(config.logDir), filename: config.filename };
	}

	// 2. AGENT_TELEMETRY_FILE env var (single-file mode)
	const envFile = process.env.AGENT_TELEMETRY_FILE;
	if (envFile) {
		const resolved = resolve(envFile);
		const lastSlash = resolved.lastIndexOf("/");
		return {
			logDir: lastSlash > 0 ? resolved.slice(0, lastSlash) : ".",
			filename: lastSlash > 0 ? resolved.slice(lastSlash + 1) : resolved,
		};
	}

	// 3. AGENT_TELEMETRY_DIR env var
	const envDir = process.env.AGENT_TELEMETRY_DIR;
	if (envDir) {
		const role = config.role ?? "server";
		const pid = process.pid;
		return { logDir: resolve(envDir), filename: `${role}-${pid}.jsonl` };
	}

	// 4. If logDir or filename provided individually
	if (config.logDir) {
		const role = config.role ?? "server";
		const pid = process.pid;
		return { logDir: resolve(config.logDir), filename: config.filename || `${role}-${pid}.jsonl` };
	}

	if (config.filename) {
		return { logDir: resolve("logs"), filename: config.filename };
	}

	// 5. Default: {project_root}/.agent-telemetry/{session_id}/{role}-{pid}.jsonl
	const projectRoot = findProjectRoot(process.cwd(), existsSync, join);
	const sessionId = config.sessionId ?? Date.now().toString(36);
	const role = config.role ?? "server";
	const pid = process.pid;
	return {
		logDir: join(projectRoot, ".agent-telemetry", sessionId),
		filename: `${role}-${pid}.jsonl`,
	};
}

function hasErrnoCode(err: unknown, code: string): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		(err as { code?: unknown }).code === code
	);
}

/** Default diagnostic levels per code. */
const DIAGNOSTIC_LEVELS: Record<string, "debug" | "info" | "warn" | "error"> = {
	event_dropped_oversize: "warn",
	writer_fallback_activated: "error",
	writer_append_failed: "error",
	writer_rotation_failed: "error",
};

/** Create a diagnostic JSONL line for writer health events. */
function makeDiagnostic(
	code:
		| "event_dropped_oversize"
		| "writer_fallback_activated"
		| "writer_append_failed"
		| "writer_rotation_failed",
	message: string,
	details?: Record<string, string | number | boolean | null>,
): string {
	const record: Record<string, unknown> = {
		record_type: "diagnostic",
		spec_version: 1,
		timestamp: new Date().toISOString(),
		code,
		message,
		level: DIAGNOSTIC_LEVELS[code] ?? "warn",
	};
	if (details) record.details = details;
	return JSON.stringify(record);
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
		maxRecordSize: config?.maxRecordSize ?? DEFAULTS.maxRecordSize,
		prefix: config?.prefix ?? DEFAULTS.prefix,
		sessionId: config?.sessionId,
		role: config?.role,
	};
	const writeToConsole = (line: string): void => {
		// biome-ignore lint/suspicious/noConsole: intentional fallback for runtimes without filesystem
		console.log(`${cfg.prefix} ${line}`);
	};

	try {
		const fs = await import("node:fs");
		const fsPromises = await import("node:fs/promises");
		const path = await import("node:path");

		const resolved = resolveOutputPath(
			{
				logDir: cfg.logDir || undefined,
				filename: cfg.filename || undefined,
				sessionId: cfg.sessionId,
				role: cfg.role,
			},
			fs.existsSync,
			path.join,
			path.resolve,
		);
		const logDir = resolved.logDir;
		const logFile = path.join(logDir, resolved.filename);

		// Probe: verify filesystem actually works
		// (Cloudflare's nodejs_compat stubs succeed silently)
		await fsPromises.mkdir(logDir, { recursive: true });
		if (!fs.existsSync(logDir)) {
			throw new Error("Filesystem probe failed");
		}

		// Restrict directory permissions (best-effort; fails silently on Windows)
		try {
			await fsPromises.chmod(logDir, 0o700);
		} catch {
			// chmod unsupported — not fatal
		}

		// Auto-create .gitignore in the .agent-telemetry root if this is a session dir
		if (logDir.includes(".agent-telemetry")) {
			const telemetryRoot = logDir.slice(
				0,
				logDir.indexOf(".agent-telemetry") + ".agent-telemetry".length,
			);
			const gitignorePath = path.join(telemetryRoot, ".gitignore");
			if (!fs.existsSync(gitignorePath)) {
				try {
					await fsPromises.writeFile(gitignorePath, "*\n");
				} catch {
					// Not fatal
				}
			}
		}

		let useConsoleFallback = false;
		let flushScheduled = false;
		let flushInProgress = false;
		let fileChmodDone = false;
		let sizeCache: number | undefined;
		let pending: string[] = [];
		let flushResolvers: Array<() => void> = [];

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

		const resolveFlushWaiters = (): void => {
			const waiters = flushResolvers;
			flushResolvers = [];
			for (const resolve of waiters) resolve();
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
			if (flushInProgress || useConsoleFallback) {
				resolveFlushWaiters();
				return;
			}
			flushInProgress = true;

			try {
				while (pending.length > 0 && !useConsoleFallback) {
					const batch = pending;
					pending = [];

					const chunk = `${batch.join("\n")}\n`;
					const incomingSize = Buffer.byteLength(chunk);

					try {
						let currentSize = await getCurrentSize();
						if (cfg.maxSize > 0 && currentSize + incomingSize > cfg.maxSize) {
							await rotate();
							currentSize = 0;
						}

						await fsPromises.appendFile(logFile, chunk);
						sizeCache = currentSize + incomingSize;

						// Restrict file permissions on first write (best-effort)
						if (!fileChmodDone) {
							fileChmodDone = true;
							try {
								await fsPromises.chmod(logFile, 0o600);
							} catch {
								// chmod unsupported — not fatal
							}
						}
					} catch {
						useConsoleFallback = true;
						// Emit diagnostic about fallback activation
						const diag = makeDiagnostic(
							"writer_fallback_activated",
							"switched to console fallback after file write failure",
						);
						writeToConsole(diag);
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
				resolveFlushWaiters();
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

					// Oversize record check — use string length as fast gate (1 char ≤ 3 UTF-8 bytes)
					if (cfg.maxRecordSize > 0 && line.length > cfg.maxRecordSize / 3) {
						const byteLength = Buffer.byteLength(line);
						if (byteLength > cfg.maxRecordSize) {
							const diag = makeDiagnostic(
								"event_dropped_oversize",
								"serialized record exceeded max_record_size",
								{ serialized_size: byteLength, max_record_size: cfg.maxRecordSize },
							);
							pending.push(diag);
							scheduleFlush();
							return;
						}
					}

					pending.push(line);
					scheduleFlush();
				} catch {
					writeToConsole(line);
				}
			},
			flush(): Promise<void> {
				if (pending.length === 0 && !flushInProgress) {
					return Promise.resolve();
				}
				return new Promise<void>((resolve) => {
					flushResolvers.push(resolve);
					if (!flushScheduled && !flushInProgress) {
						void flushPending();
					}
				});
			},
		};
	} catch {
		// Import failed or filesystem probe failed — console fallback
		return {
			write: writeToConsole,
			flush: () => Promise.resolve(),
		};
	}
}
