/**
 * Trace Reconstructor
 *
 * Groups events by trace_id and builds parent-child span trees.
 * Handles missing parents gracefully (orphan spans become roots).
 */

import type { ParsedLine } from "./parser.ts";

/** A span node in the reconstructed trace tree. */
export interface SpanNode {
	span_id: string;
	parent_span_id?: string;
	events: ParsedLine[];
	children: SpanNode[];
}

/** A reconstructed trace with its span tree. */
export interface ReconstructedTrace {
	trace_id: string;
	root_spans: SpanNode[];
	all_spans: Map<string, SpanNode>;
	events: ParsedLine[];
}

/**
 * Reconstruct traces from parsed telemetry records.
 *
 * Groups events by trace_id, builds span trees from span_id/parent_span_id
 * relationships, and identifies root spans. Orphan spans (whose parent_span_id
 * doesn't exist in the trace) are promoted to root spans.
 */
export function reconstructTraces(records: ParsedLine[]): Map<string, ReconstructedTrace> {
	const traces = new Map<string, ReconstructedTrace>();

	// Group events by trace_id
	for (const parsed of records) {
		const { record } = parsed;
		if (record.record_type !== "event") continue;

		const traceId = record.trace_id as string | undefined;
		if (!traceId) continue;

		let trace = traces.get(traceId);
		if (!trace) {
			trace = {
				trace_id: traceId,
				root_spans: [],
				all_spans: new Map(),
				events: [],
			};
			traces.set(traceId, trace);
		}
		trace.events.push(parsed);
	}

	// Build span trees for each trace
	for (const trace of traces.values()) {
		const spanMap = new Map<string, SpanNode>();

		// Create span nodes
		for (const parsed of trace.events) {
			const { record } = parsed;
			const spanId = record.span_id as string | undefined;
			if (!spanId) continue;

			let node = spanMap.get(spanId);
			if (!node) {
				node = {
					span_id: spanId,
					parent_span_id: record.parent_span_id as string | undefined,
					events: [],
					children: [],
				};
				spanMap.set(spanId, node);
			}
			node.events.push(parsed);
		}

		// Build parent-child relationships
		const rootSpans: SpanNode[] = [];
		for (const node of spanMap.values()) {
			if (node.parent_span_id) {
				const parent = spanMap.get(node.parent_span_id);
				if (parent) {
					parent.children.push(node);
				} else {
					// Orphan span — promote to root
					rootSpans.push(node);
				}
			} else {
				rootSpans.push(node);
			}
		}

		// Sort events within each span by timestamp
		for (const node of spanMap.values()) {
			node.events.sort((a, b) => {
				const ta = a.record.timestamp as string | undefined;
				const tb = b.record.timestamp as string | undefined;
				if (!ta || !tb) return 0;
				return ta.localeCompare(tb);
			});
		}

		trace.root_spans = rootSpans;
		trace.all_spans = spanMap;
	}

	return traces;
}
