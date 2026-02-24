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

/**
 * Create a writer that appends JSONL lines to a file with rotation.
 * Falls back to console.log if the filesystem is unavailable.
 */
export async function createWriter(config?: Partial<WriterConfig>): Promise<Writer> {
	const cfg = { ...DEFAULTS, ...config };

	try {
		const fs = await import("node:fs");
		const path = await import("node:path");

		const logDir = path.resolve(cfg.logDir);
		const logFile = path.join(logDir, cfg.filename);

		// Probe: verify filesystem actually works
		// (Cloudflare's nodejs_compat stubs succeed silently)
		fs.mkdirSync(logDir, { recursive: true });
		if (!fs.existsSync(logDir)) {
			throw new Error("Filesystem probe failed");
		}

		return {
			write(line: string) {
				try {
					// Rotate if over max size
					try {
						const stats = fs.statSync(logFile);
						if (stats.size > cfg.maxSize) {
							for (let i = cfg.maxBackups - 1; i >= 1; i--) {
								const from = `${logFile}.${i}`;
								const to = `${logFile}.${i + 1}`;
								if (fs.existsSync(from)) {
									if (i === cfg.maxBackups - 1 && fs.existsSync(to)) fs.unlinkSync(to);
									fs.renameSync(from, to);
								}
							}
							fs.renameSync(logFile, `${logFile}.1`);
						}
					} catch {
						// File doesn't exist yet — that's fine
					}
					fs.appendFileSync(logFile, `${line}\n`);
				} catch {
					// Filesystem write failed — silent fallback
				}
			},
		};
	} catch {
		// Import failed or filesystem probe failed — console fallback
		return {
			write(line: string) {
				// biome-ignore lint/suspicious/noConsole: intentional fallback for runtimes without filesystem
				console.log(`${cfg.prefix} ${line}`);
			},
		};
	}
}
