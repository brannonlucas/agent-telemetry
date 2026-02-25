import { createBrowserTraceContext, createBrowserTracedFetch } from "../src/browser.ts";

const DEMO_USER_ID = "10000000-0000-4000-a000-000000000001";
const RECENT_LINE_COUNT = 40;
const TIMELINE_LINE_COUNT = 400;

// --- Types ---

interface TimelineEventPayload {
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

interface TimelinePayload {
	traceId: string;
	rootSpanId?: string;
	startTimestamp: string;
	endTimestamp: string;
	totalDurationMs: number;
	eventCount: number;
	events: TimelineEventPayload[];
}

interface FlatSpan {
	event: TimelineEventPayload;
	depth: number;
	isLastChild: boolean;
}

// --- DOM helpers ---

function byId<T extends HTMLElement>(id: string): T {
	const el = document.getElementById(id);
	if (!el) throw new Error(`missing element: #${id}`);
	return el as T;
}

function emptyState(className: string, text: string): HTMLDivElement {
	const div = document.createElement("div");
	div.className = className;
	div.textContent = text;
	return div;
}

function clearNode(node: HTMLElement): void {
	node.replaceChildren();
}

const runBtn = byId<HTMLButtonElement>("run-demo");
const refreshBtn = byId<HTMLButtonElement>("refresh-btn");
const tracePill = byId("trace-pill");
const tracePillId = byId("trace-pill-id");
const waterfallMeta = byId("waterfall-meta");
const waterfallContainer = byId("waterfall-container");
const responseSection = byId("response-section");
const responseToggle = byId("response-toggle");
const responseOutput = byId("response-output");
const telemetryContainer = byId("telemetry-container");
const telemetryCount = byId("telemetry-count");

// --- Trace ---

const trace = createBrowserTraceContext();
const tracedFetch = createBrowserTracedFetch({
	trace,
	propagateTo: (url) => url.origin === window.location.origin,
});

// --- State ---

let activeTraceId: string | null = null;
let activeRootSpanId: string | null = null;
let browserDurationMs: number | null = null;

// --- Utilities ---

function kindClass(kind: string): string {
	if (kind === "browser") return "browser";
	if (kind === "http.request") return "http";
	if (kind === "db.query") return "db";
	if (kind === "external.call") return "ext";
	return "other";
}

function computeTickInterval(totalMs: number): number {
	if (totalMs <= 0) return 1;
	const raw = totalMs / 5;
	const mag = 10 ** Math.floor(Math.log10(raw));
	const norm = raw / mag;
	let nice: number;
	if (norm <= 1.5) nice = 1;
	else if (norm <= 3.5) nice = 2;
	else if (norm <= 7.5) nice = 5;
	else nice = 10;
	return Math.max(1, nice * mag);
}

function getTraceIdFromResponse(body: Record<string, unknown>): string | null {
	if (typeof body.traceId === "string") return body.traceId;
	const t = body.trace;
	if (typeof t === "object" && t !== null) {
		const id = (t as Record<string, unknown>).traceId;
		if (typeof id === "string") return id;
	}
	return null;
}

function getRootSpanIdFromResponse(body: Record<string, unknown>): string | null {
	if (typeof body.requestSpanId === "string") return body.requestSpanId;
	const t = body.trace;
	if (typeof t === "object" && t !== null) {
		const id = (t as Record<string, unknown>).parentSpanId;
		if (typeof id === "string") return id;
	}
	return null;
}

// --- Browser span injection ---

function injectBrowserSpan(payload: TimelinePayload): TimelinePayload {
	if (browserDurationMs === null || payload.events.length === 0) return payload;

	// The root server event's parentSpanId is the browser fetch's spanId
	const rootEvent = activeRootSpanId
		? payload.events.find((e) => e.spanId === activeRootSpanId)
		: undefined;
	const browserSpanId = rootEvent?.parentSpanId;
	if (!browserSpanId) return payload;

	// Distribute network overhead evenly before/after server processing
	const serverDurationMs = payload.totalDurationMs;
	const networkOverheadMs = Math.max(0, browserDurationMs - serverDurationMs);
	const offsetMs = Math.round(networkOverheadMs / 2);

	// Offset server events to account for request network time
	const offsetEvents = payload.events.map((e) => ({
		...e,
		startMs: e.startMs + offsetMs,
		endMs: e.endMs + offsetMs,
	}));

	const totalDurationMs = Math.max(browserDurationMs, serverDurationMs);

	const browserEvent: TimelineEventPayload = {
		kind: "browser",
		label: "browser fetch",
		detail: "browser round-trip including network",
		spanId: browserSpanId,
		startMs: 0,
		endMs: totalDurationMs,
		durationMs: totalDurationMs,
	};

	return {
		...payload,
		totalDurationMs,
		eventCount: payload.eventCount + 1,
		events: [browserEvent, ...offsetEvents],
	};
}

// --- Span tree ---

function buildFlatSpanList(events: TimelineEventPayload[]): FlatSpan[] {
	const bySpanId = new Map<string, TimelineEventPayload>();
	const childrenOf = new Map<string, TimelineEventPayload[]>();

	for (const ev of events) {
		if (ev.spanId) bySpanId.set(ev.spanId, ev);
	}

	const roots: TimelineEventPayload[] = [];
	for (const ev of events) {
		if (!ev.parentSpanId || !bySpanId.has(ev.parentSpanId)) {
			roots.push(ev);
		} else {
			const list = childrenOf.get(ev.parentSpanId) ?? [];
			list.push(ev);
			childrenOf.set(ev.parentSpanId, list);
		}
	}

	const result: FlatSpan[] = [];
	function walk(node: TimelineEventPayload, depth: number, isLast: boolean): void {
		result.push({ event: node, depth, isLastChild: isLast });
		const kids = node.spanId ? (childrenOf.get(node.spanId) ?? []) : [];
		kids.sort((a, b) => a.startMs - b.startMs);
		for (let i = 0; i < kids.length; i++) {
			walk(kids[i] as TimelineEventPayload, depth + 1, i === kids.length - 1);
		}
	}

	roots.sort((a, b) => a.startMs - b.startMs);
	for (let i = 0; i < roots.length; i++) {
		walk(roots[i] as TimelineEventPayload, 0, i === roots.length - 1);
	}
	return result;
}

// --- Waterfall rendering ---

function setWaterfallEmpty(text: string, opacity?: number): void {
	clearNode(waterfallContainer);
	waterfallContainer.className = "waterfall";
	const placeholder = emptyState("waterfall-empty", text);
	if (opacity !== undefined) placeholder.style.opacity = String(opacity);
	waterfallContainer.append(placeholder);
}

function renderWaterfall(payload: TimelinePayload): void {
	clearNode(waterfallContainer);
	waterfallContainer.className = "waterfall";

	if (payload.events.length === 0) {
		waterfallMeta.textContent = "";
		setWaterfallEmpty("No events found for this trace.");
		return;
	}

	const spanCount = payload.eventCount;
	const durMs = payload.totalDurationMs;
	waterfallMeta.textContent = `${spanCount} span${spanCount !== 1 ? "s" : ""} \u00b7 ${durMs}ms`;

	const totalDuration = Math.max(durMs, 1);
	const tickInterval = computeTickInterval(totalDuration);

	const container = document.createElement("div");
	container.className = "fg-container";

	// Ruler
	const ruler = document.createElement("div");
	ruler.className = "fg-ruler";
	for (let t = 0; t <= totalDuration + tickInterval * 0.1; t += tickInterval) {
		if (t > totalDuration) break;
		const pct = (t / totalDuration) * 100;
		const tick = document.createElement("span");
		tick.className = "fg-tick";
		tick.style.left = `${pct}%`;
		tick.textContent = `${Math.round(t)}ms`;
		ruler.append(tick);
	}
	container.append(ruler);

	// Build depth-grouped rows: one row per depth level
	const flat = buildFlatSpanList(payload.events);
	const maxDepth = flat.reduce((max, s) => Math.max(max, s.depth), 0);

	for (let d = 0; d <= maxDepth; d++) {
		const row = document.createElement("div");
		row.className = "fg-row";

		const spansAtDepth = flat.filter((s) => s.depth === d);
		for (let i = 0; i < spansAtDepth.length; i++) {
			const { event } = spansAtDepth[i] as FlatSpan;

			const leftPct = Math.max(0, (event.startMs / totalDuration) * 100);
			const rawWidth = event.durationMs <= 0 ? 0.5 : (event.durationMs / totalDuration) * 100;
			const widthPct = Math.min(Math.max(rawWidth, 0.5), 100 - leftPct);

			const block = document.createElement("div");
			block.className = `fg-block ${kindClass(event.kind)}`;
			block.style.left = `${leftPct}%`;
			block.style.width = `${widthPct}%`;
			block.style.animationDelay = `${(d * spansAtDepth.length + i) * 60}ms`;
			block.title = [
				event.label,
				event.detail,
				`start: ${Math.round(event.startMs)}ms  end: ${Math.round(event.endMs)}ms  duration: ${event.durationMs}ms`,
			].join("\n");

			const label = document.createElement("span");
			label.className = "fg-label";
			label.textContent = event.label;

			const dur = document.createElement("span");
			dur.className = "fg-dur";
			dur.textContent = `${event.durationMs}ms`;

			block.append(label, dur);
			row.append(block);
		}

		container.append(row);
	}

	waterfallContainer.append(container);
}

// --- Telemetry rendering ---

function renderTelemetryLines(lines: string[]): void {
	clearNode(telemetryContainer);

	if (lines.length === 0) {
		telemetryCount.textContent = "";
		telemetryContainer.append(
			emptyState("tl-empty", "No events recorded yet. Run a request to generate telemetry."),
		);
		return;
	}

	telemetryCount.textContent = `${lines.length}`;

	for (const line of lines) {
		const row = document.createElement("div");
		row.className = "tl-row";

		try {
			const parsed = JSON.parse(line) as Record<string, unknown>;
			const kind = typeof parsed.kind === "string" ? parsed.kind : "unknown";
			const traceId = typeof parsed.traceId === "string" ? parsed.traceId : null;

			if (activeTraceId && traceId === activeTraceId) {
				row.classList.add("tl-active");
			}

			const badge = document.createElement("span");
			badge.className = `tl-badge ${kindClass(kind)}`;
			badge.textContent = kind;

			const json = document.createElement("span");
			json.className = "tl-json";
			json.textContent = line;
			json.title = JSON.stringify(parsed, null, 2);

			row.append(badge, json);
		} catch {
			const json = document.createElement("span");
			json.className = "tl-json";
			json.textContent = line;
			row.append(json);
		}

		telemetryContainer.append(row);
	}
}

// --- Actions ---

async function runDemo(): Promise<void> {
	runBtn.disabled = true;
	responseOutput.textContent = "Request in progress\u2026";
	waterfallMeta.textContent = "";
	setWaterfallEmpty("Loading trace\u2026", 0.6);

	try {
		const before = trace.getTraceparent();
		const browserStart = performance.now();
		const response = await tracedFetch(`/api/users/${DEMO_USER_ID}/report`);
		const body = (await response.json()) as Record<string, unknown>;
		browserDurationMs = Math.round(performance.now() - browserStart);
		const after = trace.getTraceparent();

		responseOutput.textContent = JSON.stringify(
			{ beforeTraceparent: before, afterTraceparent: after, response: body },
			null,
			2,
		);

		activeTraceId = getTraceIdFromResponse(body);
		activeRootSpanId = getRootSpanIdFromResponse(body);

		if (activeTraceId) {
			tracePill.style.display = "";
			tracePillId.textContent = `${activeTraceId.slice(0, 16)}\u2026`;
			tracePillId.title = activeTraceId;
		}

		await refreshAll();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		responseOutput.textContent = `Request failed: ${msg}`;
	} finally {
		runBtn.disabled = false;
	}
}

async function refreshTelemetry(): Promise<void> {
	try {
		const resp = await fetch(`/api/demo/telemetry?lines=${RECENT_LINE_COUNT}`);
		const payload = (await resp.json()) as { logFile?: unknown; lines?: unknown };
		const lines = Array.isArray(payload.lines)
			? payload.lines.filter((l): l is string => typeof l === "string")
			: [];
		renderTelemetryLines(lines);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		clearNode(telemetryContainer);
		telemetryContainer.append(emptyState("tl-empty", `Failed to load: ${msg}`));
	}
}

async function refreshTimeline(): Promise<void> {
	if (!activeTraceId) {
		waterfallMeta.textContent = "";
		setWaterfallEmpty("Run a request to see the trace waterfall.");
		return;
	}

	try {
		const params = new URLSearchParams({
			traceId: activeTraceId,
			lines: String(TIMELINE_LINE_COUNT),
		});
		if (activeRootSpanId) params.set("rootSpanId", activeRootSpanId);

		const resp = await fetch(`/api/demo/timeline?${params.toString()}`);
		const payload = (await resp.json()) as TimelinePayload | { error?: unknown };

		if (!resp.ok) {
			const err =
				typeof (payload as { error?: unknown }).error === "string"
					? (payload as { error: string }).error
					: `HTTP ${resp.status}`;
			throw new Error(err);
		}

		const enriched = injectBrowserSpan(payload as TimelinePayload);
		renderWaterfall(enriched);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		waterfallMeta.textContent = "";
		setWaterfallEmpty(`Failed to load: ${msg}`);
	}
}

async function refreshAll(): Promise<void> {
	await Promise.all([refreshTelemetry(), refreshTimeline()]);
}

// --- Event listeners ---

runBtn.addEventListener("click", () => void runDemo());
refreshBtn.addEventListener("click", () => void refreshAll());

responseToggle.addEventListener("click", () => {
	responseSection.classList.toggle("collapsed");
});

tracePillId.addEventListener("click", () => {
	if (activeTraceId) {
		void navigator.clipboard.writeText(activeTraceId);
		const prev = tracePillId.textContent;
		tracePillId.textContent = "copied!";
		setTimeout(() => {
			tracePillId.textContent = prev;
		}, 1200);
	}
});

// --- Init ---

void refreshAll();
