import { Database } from "bun:sqlite";
import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { createTracedFetch } from "../src/adapters/fetch.ts";
import { createHonoTrace, getTraceContext } from "../src/adapters/hono.ts";
import { toSafeErrorLabel } from "../src/error.ts";
import { createTelemetry } from "../src/index.ts";
import { startSpan } from "../src/trace-context.ts";
import { formatTraceparent } from "../src/traceparent.ts";
import type {
	DbQueryEvent,
	ExternalCallEvent,
	HttpRequestEvent,
	PresetEvents,
	Telemetry,
	TraceContext,
} from "../src/types.ts";

const BIND_HOST = process.env.DEMO_HOST?.trim() || process.env.HOST?.trim() || "127.0.0.1";
const PORT = Number(process.env.PORT ?? "3001");
const CLIENT_ENTRYPOINT = new URL("./client.ts", import.meta.url).pathname;
const CLIENT_OUTDIR = "/tmp/agent-telemetry-demo-build";
const DEMO_USER_ID = "10000000-0000-4000-a000-000000000001";
const DB_PATH = "/tmp/agent-telemetry-demo.sqlite";
const LOG_DIR = path.resolve("logs/demo");
const LOG_FILE = path.join(LOG_DIR, "telemetry.jsonl");
const DEFAULT_TIMELINE_LINES = 400;
const MAX_TIMELINE_LINES = 5000;
const TELEMETRY_TAIL_CHUNK_BYTES = 16 * 1024;
const ENABLE_DEMO_DELAYS = process.env.DEMO_DELAYS !== "0";

interface DelayRange {
	min: number;
	max: number;
}

function parseConfiguredOrigin(raw: string | undefined, envName: string): string | undefined {
	if (!raw) return undefined;
	try {
		return new URL(raw).origin;
	} catch {
		throw new Error(`${envName} must be an absolute URL origin (example: http://127.0.0.1:3001)`);
	}
}

function buildLoopbackOrigin(port: number): string {
	const loopback = new URL("http://127.0.0.1");
	loopback.port = String(port);
	return loopback.origin;
}

let trustedUpstreamOrigin = parseConfiguredOrigin(
	process.env.DEMO_UPSTREAM_ORIGIN,
	"DEMO_UPSTREAM_ORIGIN",
);

function getTrustedUpstreamOrigin(): string {
	if (!trustedUpstreamOrigin) {
		throw new Error("trusted upstream origin is not initialized");
	}
	return trustedUpstreamOrigin;
}

function parseDelayRange(raw: string | undefined, fallback: DelayRange): DelayRange {
	if (!raw) return fallback;

	const single = Number(raw);
	if (Number.isFinite(single) && single >= 0) {
		const rounded = Math.floor(single);
		return { min: rounded, max: rounded };
	}

	const match = /^(\d+)\s*-\s*(\d+)$/.exec(raw);
	if (!match) return fallback;

	const a = Number(match[1]);
	const b = Number(match[2]);
	if (!Number.isFinite(a) || !Number.isFinite(b)) return fallback;
	const min = Math.max(0, Math.floor(Math.min(a, b)));
	const max = Math.max(0, Math.floor(Math.max(a, b)));
	return { min, max };
}

function sampleDelayMs(range: DelayRange): number {
	if (range.max <= range.min) return range.min;
	const span = range.max - range.min + 1;
	return range.min + Math.floor(Math.random() * span);
}

async function applyDemoDelay(range: DelayRange): Promise<number> {
	if (!ENABLE_DEMO_DELAYS) return 0;
	const ms = sampleDelayMs(range);
	if (ms > 0) {
		await Bun.sleep(ms);
	}
	return ms;
}

const REQUEST_PROCESSING_DELAY_RANGE = parseDelayRange(process.env.DEMO_REQUEST_DELAY_MS, {
	min: 20,
	max: 60,
});
const DB_DELAY_RANGE = parseDelayRange(process.env.DEMO_DB_DELAY_MS, { min: 90, max: 220 });
const BETWEEN_STEPS_DELAY_RANGE = parseDelayRange(process.env.DEMO_STEP_GAP_DELAY_MS, {
	min: 50,
	max: 140,
});
const UPSTREAM_DELAY_RANGE = parseDelayRange(process.env.DEMO_UPSTREAM_DELAY_MS, {
	min: 120,
	max: 320,
});

async function ensureDemoLogFile(): Promise<void> {
	await mkdir(LOG_DIR, { recursive: true });
	try {
		await writeFile(LOG_FILE, "", { flag: "ax" });
	} catch (err) {
		// file exists is fine
		if (
			!(
				typeof err === "object" &&
				err !== null &&
				"code" in err &&
				(err as { code?: unknown }).code === "EEXIST"
			)
		) {
			throw err;
		}
	}
}

function failBuild(logs: Array<{ message: string }>): never {
	const details = logs.map((log) => log.message).join("\n");
	throw new Error(`failed to build demo client bundle:\n${details}`);
}

async function buildClientBundle(): Promise<string> {
	const build = await Bun.build({
		entrypoints: [CLIENT_ENTRYPOINT],
		target: "browser",
		format: "esm",
		sourcemap: "inline",
		outdir: CLIENT_OUTDIR,
		throw: false,
	});

	if (!build.success) {
		failBuild(build.logs);
	}

	const jsOutput = build.outputs.find((output) => output.path.endsWith(".js"));
	if (!jsOutput) {
		throw new Error("failed to locate browser bundle output");
	}

	return await jsOutput.text();
}

const clientBundle = await buildClientBundle();
await ensureDemoLogFile();

const telemetry = await createTelemetry<PresetEvents>({
	logDir: LOG_DIR,
	filename: path.basename(LOG_FILE),
});
const db = new Database(DB_PATH);
db.exec(
	[
		"CREATE TABLE IF NOT EXISTS users (",
		"  id TEXT PRIMARY KEY,",
		"  email TEXT NOT NULL,",
		"  plan TEXT NOT NULL",
		");",
	].join("\n"),
);
db.query("INSERT OR REPLACE INTO users (id, email, plan) VALUES (?, ?, ?)").run(
	DEMO_USER_ID,
	"demo-user@example.com",
	"pro",
);

const app = new Hono();
app.use(
	"*",
	createHonoTrace({
		telemetry: telemetry as Telemetry<HttpRequestEvent>,
		entityPatterns: [{ segment: "users", key: "userId" }],
	}),
);

function resolveTraceContext(ctx: ReturnType<typeof getTraceContext>): TraceContext | undefined {
	if ("_trace" in ctx) return ctx._trace;
	return undefined;
}

async function readLastTelemetryLines(maxLines: number): Promise<string[]> {
	try {
		const lineLimit = Math.max(1, Math.floor(maxLines));
		const handle = await open(LOG_FILE, "r");
		try {
			const stat = await handle.stat();
			if (stat.size <= 0) return [];

			const chunks: Buffer[] = [];
			let position = stat.size;
			let newlineCount = 0;

			while (position > 0 && newlineCount <= lineLimit) {
				const readSize = Math.min(position, TELEMETRY_TAIL_CHUNK_BYTES);
				position -= readSize;

				const chunk = Buffer.allocUnsafe(readSize);
				const { bytesRead } = await handle.read(chunk, 0, readSize, position);
				if (bytesRead <= 0) break;

				const view = bytesRead === readSize ? chunk : chunk.subarray(0, bytesRead);
				chunks.unshift(view);
				for (const byte of view) {
					if (byte === 0x0a) newlineCount += 1;
				}
			}

			if (chunks.length === 0) return [];
			const text = Buffer.concat(chunks).toString("utf8");
			const trimmed = text.trim();
			if (!trimmed) return [];
			const lines = trimmed.split("\n");
			return lines.slice(Math.max(0, lines.length - lineLimit));
		} finally {
			await handle.close();
		}
	} catch (err) {
		if (
			typeof err === "object" &&
			err !== null &&
			"code" in err &&
			(err as { code?: string }).code === "ENOENT"
		) {
			return [];
		}
		throw err;
	}
}

interface TimelineEvent {
	kind: string;
	label: string;
	detail: string;
	status?: string;
	spanId?: string;
	parentSpanId?: string;
	startMs: number;
	endMs: number;
	durationMs: number;
}

interface TimelineResponse {
	traceId: string;
	rootSpanId?: string;
	startTimestamp: string;
	endTimestamp: string;
	totalDurationMs: number;
	eventCount: number;
	events: TimelineEvent[];
}

interface ParsedTimelineEvent {
	kind: string;
	label: string;
	detail: string;
	status?: string;
	spanId?: string;
	parentSpanId?: string;
	startEpochMs: number;
	endEpochMs: number;
	durationMs: number;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return value;
}

function toTimelinePresentation(line: Record<string, unknown>): {
	kind: string;
	label: string;
	detail: string;
	status?: string;
	spanId?: string;
	parentSpanId?: string;
} {
	const kind = asString(line.kind) ?? "unknown";
	const spanId = asString(line.spanId);
	const parentSpanId = asString(line.parentSpanId);
	const statusValue = line.status;
	const status =
		typeof statusValue === "number" || typeof statusValue === "string"
			? String(statusValue)
			: undefined;

	if (kind === "http.request") {
		const method = asString(line.method) ?? "HTTP";
		const pathValue = asString(line.path) ?? "/";
		const label = `${method} ${pathValue}`;
		return {
			kind,
			label,
			detail: status ? `http status ${status}` : "http request",
			status,
			spanId,
			parentSpanId,
		};
	}

	if (kind === "db.query") {
		const provider = asString(line.provider) ?? "db";
		const operation = asString(line.operation) ?? "query";
		const model = asString(line.model);
		const label = model ? `${provider} ${operation} ${model}` : `${provider} ${operation}`;
		return {
			kind,
			label,
			detail: status ? `db status ${status}` : "db query",
			status,
			spanId,
			parentSpanId,
		};
	}

	if (kind === "external.call") {
		const service = asString(line.service) ?? "external";
		const operation = asString(line.operation) ?? "call";
		return {
			kind,
			label: `${service} ${operation}`,
			detail: status ? `external status ${status}` : "external call",
			status,
			spanId,
			parentSpanId,
		};
	}

	return {
		kind,
		label: kind,
		detail: "event",
		status,
		spanId,
		parentSpanId,
	};
}

async function buildTraceTimeline(traceId: string, maxLines: number): Promise<TimelineResponse> {
	return buildTraceTimelineForSpan(traceId, maxLines, undefined);
}

function filterBySpanSubtree(
	events: ParsedTimelineEvent[],
	rootSpanId: string,
): ParsedTimelineEvent[] {
	const childrenByParent = new Map<string, Set<string>>();

	for (const event of events) {
		if (!event.spanId || !event.parentSpanId) continue;
		const set = childrenByParent.get(event.parentSpanId) ?? new Set<string>();
		set.add(event.spanId);
		childrenByParent.set(event.parentSpanId, set);
	}

	const allowedSpanIds = new Set<string>();
	const queue: string[] = [rootSpanId];
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current || allowedSpanIds.has(current)) continue;
		allowedSpanIds.add(current);
		const children = childrenByParent.get(current);
		if (!children) continue;
		for (const child of children) {
			queue.push(child);
		}
	}

	return events.filter((event) => {
		if (!event.spanId) return false;
		return allowedSpanIds.has(event.spanId);
	});
}

async function buildTraceTimelineForSpan(
	traceId: string,
	maxLines: number,
	rootSpanId: string | undefined,
): Promise<TimelineResponse> {
	const lines = await readLastTelemetryLines(maxLines);
	const parsed: ParsedTimelineEvent[] = [];

	for (const line of lines) {
		try {
			const decoded = JSON.parse(line) as unknown;
			if (typeof decoded !== "object" || decoded === null) continue;
			const event = decoded as Record<string, unknown>;
			if (asString(event.traceId) !== traceId) continue;

			const timestampRaw = asString(event.timestamp);
			if (!timestampRaw) continue;
			const endEpochMs = Date.parse(timestampRaw);
			if (!Number.isFinite(endEpochMs)) continue;

			const durationMs = Math.max(0, asFiniteNumber(event.duration_ms) ?? 0);
			const startEpochMs = endEpochMs - durationMs;
			const presentation = toTimelinePresentation(event);

			parsed.push({
				...presentation,
				startEpochMs,
				endEpochMs,
				durationMs,
			});
		} catch {
			// ignore malformed lines
		}
	}

	if (parsed.length === 0) {
		const nowIso = new Date().toISOString();
		return {
			traceId,
			rootSpanId,
			startTimestamp: nowIso,
			endTimestamp: nowIso,
			totalDurationMs: 0,
			eventCount: 0,
			events: [],
		};
	}

	parsed.sort((a, b) => a.startEpochMs - b.startEpochMs || a.endEpochMs - b.endEpochMs);

	const scoped = rootSpanId ? filterBySpanSubtree(parsed, rootSpanId) : parsed;
	if (scoped.length === 0) {
		const nowIso = new Date().toISOString();
		return {
			traceId,
			rootSpanId,
			startTimestamp: nowIso,
			endTimestamp: nowIso,
			totalDurationMs: 0,
			eventCount: 0,
			events: [],
		};
	}

	const rootEvent = rootSpanId ? scoped.find((event) => event.spanId === rootSpanId) : undefined;

	const traceStartMs =
		rootEvent?.startEpochMs ??
		scoped.reduce(
			(min, event) => (event.startEpochMs < min ? event.startEpochMs : min),
			scoped[0]?.startEpochMs ?? 0,
		);
	const maxScopedEndMs = scoped.reduce(
		(max, event) => (event.endEpochMs > max ? event.endEpochMs : max),
		scoped[0]?.endEpochMs ?? 0,
	);
	const traceEndMs = rootEvent ? Math.max(maxScopedEndMs, rootEvent.endEpochMs) : maxScopedEndMs;
	const totalDurationMs = Math.max(1, traceEndMs - traceStartMs);

	return {
		traceId,
		rootSpanId,
		startTimestamp: new Date(traceStartMs).toISOString(),
		endTimestamp: new Date(traceEndMs).toISOString(),
		totalDurationMs,
		eventCount: scoped.length,
		events: scoped.map((event) => ({
			kind: event.kind,
			label: event.label,
			detail: event.detail,
			status: event.status,
			spanId: event.spanId,
			parentSpanId: event.parentSpanId,
			startMs: event.startEpochMs - traceStartMs,
			endMs: event.endEpochMs - traceStartMs,
			durationMs: event.durationMs,
		})),
	};
}

function selectUserById(
	id: string,
	parentTrace: TraceContext | undefined,
): Promise<{ row: { id: string; email: string; plan: string } | null; simulatedDelayMs: number }> {
	return selectUserByIdWithDelay(id, parentTrace);
}

async function selectUserByIdWithDelay(
	id: string,
	parentTrace: TraceContext | undefined,
): Promise<{ row: { id: string; email: string; plan: string } | null; simulatedDelayMs: number }> {
	const start = performance.now();
	const span = startSpan({
		traceId: parentTrace?.traceId,
		parentSpanId: parentTrace?.parentSpanId,
		traceFlags: parentTrace?.traceFlags,
	});

	try {
		const simulatedDelayMs = await applyDemoDelay(DB_DELAY_RANGE);
		const row = db.query("SELECT id, email, plan FROM users WHERE id = ? LIMIT 1").get(id) as {
			id: string;
			email: string;
			plan: string;
		} | null;

		const event: DbQueryEvent = {
			kind: "db.query",
			traceId: span.traceId,
			spanId: span.spanId,
			parentSpanId: span.parentSpanId,
			provider: "sqlite",
			model: "users",
			operation: "select",
			duration_ms: Math.round(performance.now() - start),
			status: "success",
		};
		(telemetry as Telemetry<DbQueryEvent>).emit(event);
		return { row, simulatedDelayMs };
	} catch (err) {
		const event: DbQueryEvent = {
			kind: "db.query",
			traceId: span.traceId,
			spanId: span.spanId,
			parentSpanId: span.parentSpanId,
			provider: "sqlite",
			model: "users",
			operation: "select",
			duration_ms: Math.round(performance.now() - start),
			status: "error",
			error: toSafeErrorLabel(err),
		};
		(telemetry as Telemetry<DbQueryEvent>).emit(event);
		throw err;
	}
}

app.get("/", (c) => {
	const trace = resolveTraceContext(getTraceContext(c));
	const bootstrapTraceparent = trace
		? formatTraceparent(trace.traceId, trace.parentSpanId, trace.traceFlags ?? "01")
		: "";

	return c.html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="traceparent" content="${bootstrapTraceparent}" />
  <title>agent-telemetry demo</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *,*::before,*::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg-0: #0a0a0c; --bg-1: #111115; --bg-2: #1a1a1f; --bg-3: #242430;
      --border: #28283a; --border-s: #1d1d28;
      --text-0: #e8e8ef; --text-1: #9898a8; --text-2: #606078;
      --mono: 'JetBrains Mono', ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
      --http: #60a5fa; --http-bar: #3b82f6; --http-dim: rgba(59,130,246,.12);
      --db: #4ade80; --db-bar: #22c55e; --db-dim: rgba(34,197,94,.12);
      --ext: #fbbf24; --ext-bar: #f59e0b; --ext-dim: rgba(245,158,11,.12);
      --browser: #c084fc; --browser-bar: #a855f7; --browser-dim: rgba(168,85,247,.12);
      --other: #94a3b8; --accent: #a78bfa; --r: 8px;
    }
    body { font-family: var(--mono); font-size: 13px; line-height: 1.5; background: var(--bg-0); color: var(--text-0); -webkit-font-smoothing: antialiased; }
    .app { max-width: 980px; margin: 0 auto; padding: 2rem 1.5rem 4rem; }

    /* Header */
    .header { margin-bottom: 1.75rem; padding-bottom: 1.5rem; border-bottom: 1px solid var(--border); }
    .header-row { display: flex; align-items: baseline; gap: 0.75rem; margin-bottom: 0.5rem; }
    .header h1 { font-size: 1.1rem; font-weight: 600; letter-spacing: -0.02em; }
    .version { font-size: 0.7rem; color: var(--text-2); background: var(--bg-2); padding: 0.15rem 0.5rem; border-radius: 99px; border: 1px solid var(--border-s); }
    .header-desc { color: var(--text-1); font-size: 0.8rem; line-height: 1.6; }
    .header-desc code { color: var(--accent); }

    /* Trace flow */
    .trace-flow { display: flex; align-items: center; gap: 0; margin-top: 1rem; font-size: 0.72rem; flex-wrap: wrap; }
    .flow-step { display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.3rem 0.6rem; background: var(--bg-1); border: 1px solid var(--border); color: var(--text-1); }
    .flow-step:first-child { border-radius: 6px 0 0 6px; }
    .flow-step:last-child { border-radius: 0 6px 6px 0; }
    .flow-step:not(:first-child) { border-left: none; }
    .flow-dot { width: 6px; height: 6px; border-radius: 2px; display: inline-block; }

    /* Actions */
    .actions { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1.75rem; flex-wrap: wrap; }
    .btn-primary { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.55rem 1rem; font-family: var(--mono); font-size: 0.8rem; font-weight: 500; color: #fff; background: var(--http-bar); border: none; border-radius: 6px; cursor: pointer; transition: background 0.15s, opacity 0.15s; }
    .btn-primary:hover { background: #2563eb; }
    .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-secondary { display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.45rem 0.75rem; font-family: var(--mono); font-size: 0.72rem; color: var(--text-1); background: var(--bg-2); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; transition: background 0.15s; }
    .btn-secondary:hover { background: var(--bg-3); }
    .btn-secondary:disabled { opacity: 0.4; cursor: not-allowed; }
    .trace-pill { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.3rem 0.65rem; background: var(--bg-2); border: 1px solid var(--border); border-radius: 99px; font-size: 0.68rem; }
    .trace-pill-label { color: var(--text-2); }
    .trace-pill-id { color: var(--accent); cursor: pointer; }
    .trace-pill-id:hover { text-decoration: underline; }

    /* Sections */
    .section { margin-bottom: 1.5rem; }
    .section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.6rem; }
    .section-head-left { display: flex; align-items: center; gap: 0.75rem; }
    .section-head h2 { font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-1); }
    .section-badge { font-size: 0.62rem; padding: 0.1rem 0.45rem; border-radius: 4px; color: var(--text-1); background: var(--bg-2); border: 1px solid var(--border-s); }

    /* Legend */
    .legend { display: flex; gap: 0.8rem; font-size: 0.68rem; color: var(--text-1); }
    .legend-item { display: flex; align-items: center; gap: 0.25rem; }
    .legend-dot { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
    .legend-dot.http { background: var(--http-bar); }
    .legend-dot.db { background: var(--db-bar); }
    .legend-dot.browser { background: var(--browser-bar); }
    .legend-dot.ext { background: var(--ext-bar); }

    /* Flame graph */
    .waterfall { background: var(--bg-1); border: 1px solid var(--border); border-radius: var(--r); overflow: hidden; }
    .waterfall-empty { padding: 3rem 1.5rem; text-align: center; color: var(--text-2); font-size: 0.8rem; }
    .waterfall-meta { font-size: 0.72rem; color: var(--text-2); }

    .fg-container { position: relative; padding: 6px 12px 12px; }
    .fg-ruler { position: relative; height: 22px; margin-bottom: 2px; }
    .fg-tick { position: absolute; bottom: 2px; transform: translateX(-50%); font-size: 0.56rem; color: var(--text-2); white-space: nowrap; }
    .fg-tick::after { content: ''; position: absolute; bottom: -2px; left: 50%; width: 1px; height: 4px; background: var(--border); }

    .fg-row { position: relative; height: 36px; margin-bottom: 2px; }
    .fg-block { position: absolute; top: 0; height: 100%; border-radius: 4px; display: flex; align-items: center; justify-content: space-between; padding: 0 8px; overflow: hidden; cursor: default; transition: filter 0.12s; min-width: 3px; clip-path: inset(0 100% 0 0); animation: fgReveal 0.35s ease-out forwards; }
    .fg-block:hover { filter: brightness(1.25); }
    .fg-block.browser { background: var(--browser-bar); }
    .fg-block.http { background: var(--http-bar); }
    .fg-block.db { background: var(--db-bar); }
    .fg-block.ext { background: var(--ext-bar); }
    .fg-block.other { background: var(--other); }
    @keyframes fgReveal { to { clip-path: inset(0 0 0 0); } }

    .fg-label { font-size: 0.68rem; font-weight: 500; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-shadow: 0 1px 2px rgba(0,0,0,0.5); }
    .fg-dur { font-size: 0.62rem; font-weight: 400; color: rgba(255,255,255,0.75); white-space: nowrap; margin-left: 8px; flex-shrink: 0; font-variant-numeric: tabular-nums; text-shadow: 0 1px 2px rgba(0,0,0,0.5); }

    /* Response (collapsible) */
    .response-toggle { cursor: pointer; user-select: none; }
    .toggle-chevron { font-size: 0.65rem; color: var(--text-2); transition: transform 0.2s; display: inline-block; }
    .section.collapsed .toggle-chevron { transform: rotate(-90deg); }
    .response-body { max-height: 600px; overflow: hidden; transition: max-height 0.25s ease; }
    .section.collapsed .response-body { max-height: 0; }
    .code-block { background: var(--bg-1); border: 1px solid var(--border); border-radius: var(--r); padding: 1rem; overflow: auto; font-size: 0.7rem; line-height: 1.65; color: var(--text-1); max-height: 360px; white-space: pre-wrap; word-break: break-all; }

    /* Telemetry list */
    .telemetry-list { background: var(--bg-1); border: 1px solid var(--border); border-radius: var(--r); overflow: hidden; max-height: 440px; overflow-y: auto; }
    .tl-row { display: flex; align-items: flex-start; gap: 0.6rem; padding: 0.4rem 0.75rem; border-bottom: 1px solid var(--border-s); font-size: 0.68rem; line-height: 1.5; }
    .tl-row:last-child { border-bottom: none; }
    .tl-row.tl-active { background: rgba(167,139,250,0.06); }
    .tl-badge { flex-shrink: 0; display: inline-block; padding: 0.08rem 0.45rem; border-radius: 3px; font-size: 0.6rem; font-weight: 500; white-space: nowrap; margin-top: 0.08rem; min-width: 80px; text-align: center; }
    .tl-badge.http { color: var(--http); background: var(--http-dim); }
    .tl-badge.db { color: var(--db); background: var(--db-dim); }
    .tl-badge.ext { color: var(--ext); background: var(--ext-dim); }
    .tl-badge.browser { color: var(--browser); background: var(--browser-dim); }
    .tl-badge.other { color: var(--other); background: rgba(148,163,184,.08); }
    .tl-json { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-2); }
    .tl-empty { padding: 2.5rem; text-align: center; color: var(--text-2); font-size: 0.8rem; }

    /* Footer */
    .footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--border-s); font-size: 0.68rem; color: var(--text-2); display: flex; gap: 1.5rem; flex-wrap: wrap; }
    .footer code { color: var(--text-1); }
  </style>
</head>
<body>
  <div class="app">
    <header class="header">
      <div class="header-row">
        <h1>agent-telemetry</h1>
        <span class="version">v0.3.0</span>
      </div>
      <p class="header-desc">
        Browser-to-backend distributed trace demo. One <code>traceparent</code> header connects every span.
      </p>
      <div class="trace-flow">
        <span class="flow-step"><span class="flow-dot" style="background:var(--browser)"></span> Browser</span>
        <span class="flow-step"><span class="flow-dot" style="background:var(--http)"></span> Hono HTTP</span>
        <span class="flow-step"><span class="flow-dot" style="background:var(--db)"></span> SQLite</span>
        <span class="flow-step"><span class="flow-dot" style="background:var(--ext)"></span> Fetch</span>
        <span class="flow-step"><span class="flow-dot" style="background:var(--http)"></span> Upstream</span>
      </div>
    </header>

    <div class="actions">
      <button id="run-demo" class="btn-primary" type="button">&#9654; Run Request</button>
      <button id="refresh-btn" class="btn-secondary" type="button">&#8635; Refresh</button>
      <span id="trace-pill" class="trace-pill" style="display:none">
        <span class="trace-pill-label">trace</span>
        <span id="trace-pill-id" class="trace-pill-id"></span>
      </span>
    </div>

    <section class="section">
      <div class="section-head">
        <div class="section-head-left">
          <h2>Trace Waterfall</h2>
          <div class="legend">
            <span class="legend-item"><span class="legend-dot browser"></span> Browser</span>
            <span class="legend-item"><span class="legend-dot http"></span> HTTP</span>
            <span class="legend-item"><span class="legend-dot db"></span> Database</span>
            <span class="legend-item"><span class="legend-dot ext"></span> External</span>
          </div>
        </div>
        <span id="waterfall-meta" class="waterfall-meta"></span>
      </div>
      <div id="waterfall-container" class="waterfall">
        <div class="waterfall-empty">Run a request to see the trace waterfall.</div>
      </div>
    </section>

    <section class="section" id="response-section">
      <div class="section-head response-toggle" id="response-toggle">
        <div class="section-head-left">
          <h2>Response</h2>
          <span class="toggle-chevron">&#9662;</span>
        </div>
      </div>
      <div class="response-body" id="response-body">
        <pre id="response-output" class="code-block">Click &#9654; Run Request to generate a traced API call.</pre>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <div class="section-head-left">
          <h2>Raw Events</h2>
          <span id="telemetry-count" class="section-badge"></span>
        </div>
      </div>
      <div id="telemetry-container" class="telemetry-list">
        <div class="tl-empty">No events recorded yet. Run a request to generate telemetry.</div>
      </div>
    </section>

    <footer class="footer">
      <span><code>${LOG_FILE}</code></span>
      <span>tail -f logs/demo/telemetry.jsonl</span>
    </footer>
  </div>
  <script type="module" src="/demo-client.js"></script>
</body>
</html>`);
});

app.get("/demo-client.js", (c) => {
	c.header("content-type", "text/javascript; charset=utf-8");
	c.header("cache-control", "no-store");
	return c.body(clientBundle);
});

app.get("/api/upstream/:id", async (c) => {
	const simulatedDelayMs = await applyDemoDelay(UPSTREAM_DELAY_RANGE);
	return c.json({
		ok: true,
		source: "upstream-service",
		userId: c.req.param("id"),
		simulatedDelayMs,
	});
});

app.get("/api/demo/telemetry", async (c) => {
	const linesParam = Number(c.req.query("lines") ?? "40");
	const maxLines = Number.isFinite(linesParam)
		? Math.min(Math.max(Math.floor(linesParam), 1), 500)
		: 40;
	const lines = await readLastTelemetryLines(maxLines);

	return c.json({
		logFile: LOG_FILE,
		lines,
	});
});

app.get("/api/demo/timeline", async (c) => {
	const traceId = c.req.query("traceId");
	if (!traceId) {
		return c.json({ error: "traceId query parameter is required" }, 400);
	}

	const linesParam = Number(c.req.query("lines") ?? String(DEFAULT_TIMELINE_LINES));
	const maxLines = Number.isFinite(linesParam)
		? Math.min(Math.max(Math.floor(linesParam), 1), MAX_TIMELINE_LINES)
		: DEFAULT_TIMELINE_LINES;
	const rootSpanId = c.req.query("rootSpanId") || undefined;
	const timeline = await buildTraceTimelineForSpan(traceId, maxLines, rootSpanId);

	return c.json({
		logFile: LOG_FILE,
		...timeline,
	});
});

app.get("/api/users/:id/report", async (c) => {
	const id = c.req.param("id");
	const requestTrace = resolveTraceContext(getTraceContext(c));
	const upstreamOrigin = getTrustedUpstreamOrigin();
	await applyDemoDelay(REQUEST_PROCESSING_DELAY_RANGE);
	const db = await selectUserById(id, requestTrace);
	const betweenStepsDelayMs = await applyDemoDelay(BETWEEN_STEPS_DELAY_RANGE);

	const tracedFetch = createTracedFetch({
		telemetry: telemetry as Telemetry<ExternalCallEvent>,
		getTraceContext: () => requestTrace,
		propagateTo: (url) => url.origin === upstreamOrigin,
	});

	const upstreamUrl = new URL(`/api/upstream/${encodeURIComponent(id)}`, upstreamOrigin);
	const upstream = await tracedFetch(upstreamUrl);
	const upstreamBody = (await upstream.json()) as Record<string, unknown>;
	const upstreamDelayMs =
		typeof upstreamBody.simulatedDelayMs === "number" ? upstreamBody.simulatedDelayMs : 0;

	return c.json({
		ok: true,
		userId: id,
		user: db.row,
		upstream: upstreamBody,
		demoDelays: {
			dbDelayMs: db.simulatedDelayMs,
			betweenStepsDelayMs,
			upstreamDelayMs,
		},
		traceId: requestTrace?.traceId ?? null,
		requestSpanId: requestTrace?.parentSpanId ?? null,
		trace: requestTrace ?? null,
		logFile: LOG_FILE,
	});
});

const server = Bun.serve({
	hostname: BIND_HOST,
	port: PORT,
	fetch: app.fetch,
});

const resolvedServerPort = server.port;
if (
	typeof resolvedServerPort !== "number" ||
	!Number.isFinite(resolvedServerPort) ||
	resolvedServerPort <= 0
) {
	throw new Error("failed to determine demo server port");
}

trustedUpstreamOrigin ??= buildLoopbackOrigin(resolvedServerPort);

process.stdout.write(`[demo] server running at http://${BIND_HOST}:${resolvedServerPort}\n`);
process.stdout.write(`[demo] trusted upstream origin: ${getTrustedUpstreamOrigin()}\n`);
process.stdout.write(`[demo] telemetry output: ${LOG_FILE}\n`);
process.stdout.write(`[demo] sqlite db: ${DB_PATH}\n`);
process.stdout.write(
	`[demo] synthetic delay ranges: req=${REQUEST_PROCESSING_DELAY_RANGE.min}-${REQUEST_PROCESSING_DELAY_RANGE.max}ms, db=${DB_DELAY_RANGE.min}-${DB_DELAY_RANGE.max}ms, gap=${BETWEEN_STEPS_DELAY_RANGE.min}-${BETWEEN_STEPS_DELAY_RANGE.max}ms, upstream=${UPSTREAM_DELAY_RANGE.min}-${UPSTREAM_DELAY_RANGE.max}ms\n`,
);
