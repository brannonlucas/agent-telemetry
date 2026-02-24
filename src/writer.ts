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
	logDir: string
	filename: string
	maxSize: number
	maxBackups: number
	prefix: string
}

export interface Writer {
	write: (line: string) => void
}

const DEFAULTS: WriterConfig = {
	logDir: 'logs',
	filename: 'telemetry.jsonl',
	maxSize: 5_000_000,
	maxBackups: 3,
	prefix: '[TEL]',
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
	}
	const writeToConsole = (line: string): void => {
		// biome-ignore lint/suspicious/noConsole: intentional fallback for runtimes without filesystem
		console.log(`${cfg.prefix} ${line}`)
	}

	try {
		const fs = await import('node:fs')
		const path = await import('node:path')

		const logDir = path.resolve(cfg.logDir)
		const logFile = path.join(logDir, cfg.filename)

		// Probe: verify filesystem actually works
		// (Cloudflare's nodejs_compat stubs succeed silently)
		fs.mkdirSync(logDir, { recursive: true })
		if (!fs.existsSync(logDir)) {
			throw new Error('Filesystem probe failed')
		}

		let useConsoleFallback = false

		const rotate = (): void => {
			if (!fs.existsSync(logFile)) return

			if (cfg.maxBackups <= 0) {
				fs.unlinkSync(logFile)
				return
			}

			const oldestBackup = `${logFile}.${cfg.maxBackups}`
			if (fs.existsSync(oldestBackup)) {
				fs.unlinkSync(oldestBackup)
			}

			for (let i = cfg.maxBackups - 1; i >= 1; i--) {
				const from = `${logFile}.${i}`
				const to = `${logFile}.${i + 1}`
				if (fs.existsSync(from)) {
					fs.renameSync(from, to)
				}
			}

			fs.renameSync(logFile, `${logFile}.1`)
		}

		return {
			write(line: string) {
				if (useConsoleFallback) {
					writeToConsole(line)
					return
				}

				try {
					const lineWithNewline = `${line}\n`
					const incomingSize = Buffer.byteLength(lineWithNewline)
					let currentSize = 0

					try {
						currentSize = fs.statSync(logFile).size
					} catch (err) {
						const isEnoent =
							typeof err === 'object' &&
							err !== null &&
							'code' in err &&
							(err as { code?: unknown }).code === 'ENOENT'
						if (!isEnoent) {
							throw err
						}
					}

					if (cfg.maxSize > 0 && currentSize + incomingSize > cfg.maxSize) {
						rotate()
					}

					fs.appendFileSync(logFile, lineWithNewline)
				} catch {
					useConsoleFallback = true
					writeToConsole(line)
				}
			},
		}
	} catch {
		// Import failed or filesystem probe failed — console fallback
		return {
			write: writeToConsole,
		}
	}
}
