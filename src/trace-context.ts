import { generateSpanId, generateTraceId } from "./ids.ts";
import { parseTraceparent } from "./traceparent.ts";

const TRACE_FLAGS_RE = /^[\da-f]{2}$/;

export function normalizeTraceFlags(traceFlags: string | undefined): string {
	if (!traceFlags) return "01";
	const normalized = traceFlags.toLowerCase();
	return TRACE_FLAGS_RE.test(normalized) ? normalized : "01";
}

export interface SpanStartOptions {
	traceId?: string;
	parentSpanId?: string;
	traceFlags?: string;
}

export interface SpanContext {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	traceFlags: string;
}

export function startSpan(options: SpanStartOptions = {}): SpanContext {
	return {
		traceId: options.traceId ?? generateTraceId(),
		spanId: generateSpanId(),
		parentSpanId: options.parentSpanId,
		traceFlags: normalizeTraceFlags(options.traceFlags),
	};
}

export function startSpanFromTraceparent(header: string | null | undefined): SpanContext {
	const parsed = parseTraceparent(header);
	return startSpan({
		traceId: parsed?.traceId,
		parentSpanId: parsed?.parentId,
		traceFlags: parsed?.traceFlags,
	});
}
