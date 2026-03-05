import { generateSpanId, generateTraceId } from "./ids.ts";
import { parseTraceparent } from "./traceparent.ts";

const TRACE_FLAGS_RE = /^[\da-f]{2}$/;

export function normalizeTraceFlags(traceFlags: string | undefined): string {
	if (!traceFlags) return "01";
	const normalized = traceFlags.toLowerCase();
	return TRACE_FLAGS_RE.test(normalized) ? normalized : "01";
}

export interface SpanStartOptions {
	trace_id?: string;
	parent_span_id?: string;
	trace_flags?: string;
	tracestate?: string;
}

export interface SpanContext {
	trace_id: string;
	span_id: string;
	parent_span_id?: string;
	trace_flags: string;
	tracestate?: string;
}

export function startSpan(options: SpanStartOptions = {}): SpanContext {
	return {
		trace_id: options.trace_id ?? generateTraceId(),
		span_id: generateSpanId(),
		parent_span_id: options.parent_span_id,
		trace_flags: normalizeTraceFlags(options.trace_flags),
		tracestate: options.tracestate,
	};
}

export function startSpanFromTraceparent(
	header: string | null | undefined,
	tracestate?: string | null,
): SpanContext {
	const parsed = parseTraceparent(header);
	return startSpan({
		trace_id: parsed?.traceId,
		parent_span_id: parsed?.parentId,
		trace_flags: parsed?.traceFlags,
		// tracestate MUST be discarded when no valid traceparent exists (spec §7.4)
		tracestate: parsed ? (tracestate ?? undefined) : undefined,
	});
}
