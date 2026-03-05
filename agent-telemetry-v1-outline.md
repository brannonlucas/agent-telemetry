# Agent Telemetry v1 Replacement Outline

This document is a replacement outline for `agent-telemetry-spec.md`.
It is intentionally narrower and more structured than the current draft.
Its job is to define a portable, agent-readable, local-first telemetry profile for development-time distributed systems.

## 1. Positioning

This section should be short.

It should define Agent Telemetry as:

- A local-first telemetry profile for AI/agent consumption during development.
- A compact event format and file transport, not a full observability platform.
- Compatible with W3C Trace Context.
- Usable either through native emission or projection from other telemetry systems such as OpenTelemetry.

This section should explicitly say the spec is for:

- Local development environments.
- Distributed systems under active development.
- Agent and tool consumption of runtime behavior.

This section should explicitly say the spec is not:

- A replacement for production observability backends.
- A collector protocol.
- A metrics system.
- A log standard.
- A framework adapter catalog.

## 2. Design Goals and Non-Goals

This section should define the design goals as normative or near-normative intent.

### 2.1 Goals

- The format MUST be cheap for agents to filter and parse.
- The format MUST support causal reconstruction across HTTP, dependencies, browser requests, and background jobs.
- The core profile MUST be implementable without a collector or backend service.
- The primary transport MUST be append-only JSON Lines on a local filesystem.
- Implementations MUST NOT crash the host application because telemetry emission fails.
- The core format MUST be implementation-agnostic and portable across languages.
- The format SHOULD be small enough for development-time use without aggressive sampling.
- The format SHOULD be compatible with direct native emission and projection from OpenTelemetry.

### 2.2 Non-Goals

- The spec does NOT define a production ingestion backend.
- The spec does NOT define a metrics signal.
- The spec does NOT define dashboards or alerting.
- The spec does NOT define framework-specific middleware contracts.
- The spec does NOT define MCP or any specific agent access protocol.
- The spec does NOT require compatibility with every OpenTelemetry semantic convention.

## 3. Conformance Model

This section should explain that the spec is split into a required core plus optional profiles.

### 3.1 Conformance Levels

- `Core` profile MUST define the record model, event model, diagnostic model, trace identifiers, timestamps, unknown-field handling, and consumer behavior.
- `File` profile MUST define JSONL file semantics, append behavior, discovery, and failure handling.
- `Browser` profile MUST define browser trace propagation behavior.
- `Async` profile MUST define cross-boundary continuation for background jobs and task dispatch.
- `Rotation` profile MUST define size-based rotation behavior.

### 3.2 Minimum Conformance

A minimally conformant implementation MUST implement:

- `Core`
- `File`
- `Browser`
- `Async`

The `Rotation` profile SHOULD be implemented and MAY be required by downstream tooling, but it need not be minimum-core if the document wants a smaller base target.

### 3.3 Producer Paths

The spec should explicitly allow two producer paths:

- Native emission of Agent Telemetry records.
- Projection from another telemetry source into Agent Telemetry records.

Both producer paths MUST emit records that conform to the same output schema.

## 4. Record Model

This section should define the top-level JSONL record structure before any event-specific details.

### 4.1 Encoding and Line Format

- Each line MUST be a complete UTF-8 encoded JSON object.
- Each line MUST be terminated with `\n`.
- Embedded newlines inside serialized records MUST NOT be emitted.
- The file MUST be valid JSON Lines / NDJSON.
- Consumers MUST treat each line independently.

### 4.2 Record Types

The spec should define exactly two record types in v1:

- `event`
- `diagnostic`

Every record MUST contain:

- `record_type`
- `spec_version`
- `timestamp`

### 4.3 Base Record Fields

Every record MUST contain:

| Field | Type | Notes |
|---|---|---|
| `record_type` | string | MUST be `event` or `diagnostic` |
| `spec_version` | integer | MUST be `1` for this version |
| `timestamp` | string | RFC 3339 / ISO 8601 UTC timestamp |

The spec should say:

- `timestamp` MUST be injected at serialization time by the producing layer.
- If a caller supplies `timestamp`, it MUST be overwritten.
- Consumers MUST use `spec_version` for version gating.

### 4.4 Unknown Fields

- Producers MAY include additional fields allowed by the active profile.
- Consumers MUST ignore unknown fields.
- Consumers MUST ignore unknown event kinds.
- Consumers MUST skip malformed lines without aborting the full read.

## 5. Event Record Schema

This section should define fields common to all `event` records.

### 5.1 Required Event Fields

Every `event` record MUST contain:

| Field | Type | Notes |
|---|---|---|
| `record_type` | `"event"` | fixed |
| `spec_version` | integer | fixed at `1` |
| `timestamp` | string | injected |
| `kind` | string | namespaced event identifier |
| `trace_id` | string | 32 lowercase hex chars |
| `outcome` | string | normalized result classification |

### 5.2 Optional Event Fields

Every `event` record MAY contain:

| Field | Type | Notes |
|---|---|---|
| `span_id` | string | 16 lowercase hex chars |
| `parent_span_id` | string | 16 lowercase hex chars |
| `error_name` | string | safe error name, not raw message |
| `entities` | object | shallow key-value object of domain identifiers |

### 5.3 `kind` Grammar

The spec should retain a simple grammar:

- Lowercase segments separated by dots.
- Segments may include digits and underscores after the first character.

Examples:

- `http.request`
- `db.query`
- `external.call`
- `job.dispatch`

### 5.4 `outcome` Values

The spec should define a closed set for v1:

- `success`
- `error`

The spec should also say:

- Event-specific rules determine which outcome value is emitted.
- Consumers MUST NOT infer `outcome` from other fields when it is present.

### 5.5 `entities`

This section should define `entities` as:

- A shallow JSON object of domain-object identifiers.
- Intended for agent pivoting by business object, not trace propagation.

The spec should say:

- Keys MUST be strings.
- Values MUST be strings.
- Nested objects inside `entities` MUST NOT be emitted.
- Extraction logic is not part of core conformance.

## 6. Diagnostic Record Schema

This section should define standardized diagnostics in the same file.

### 6.1 Required Diagnostic Fields

Every `diagnostic` record MUST contain:

| Field | Type | Notes |
|---|---|---|
| `record_type` | `"diagnostic"` | fixed |
| `spec_version` | integer | fixed at `1` |
| `timestamp` | string | injected |
| `code` | string | stable machine-readable code |
| `message` | string | short human-readable summary |

### 6.2 Optional Diagnostic Fields

Diagnostics MAY contain:

| Field | Type | Notes |
|---|---|---|
| `details` | object | open-ended but shallow JSON object |
| `related_kind` | string | event kind if relevant |
| `related_trace_id` | string | optional if known |

### 6.3 Diagnostic Rules

- Diagnostics MUST NOT require a `trace_id`.
- Diagnostics SHOULD be emitted for dropped oversize events, file writer fallback, and parseable internal failures.
- Diagnostics MUST NOT include sensitive raw error messages by default.
- Consumers MUST be able to ignore diagnostics entirely and still process events correctly.

### 6.4 Standard Diagnostic Codes

The spec should define a small reserved set:

- `event_dropped_oversize`
- `writer_fallback_activated`
- `writer_rotation_failed`
- `writer_append_failed`
- `projection_mapping_failed`

Implementations MAY emit additional diagnostic codes.

## 7. Event Kinds

This section should define the event kinds that belong to the v1 core.

### 7.1 `http.request`

Required fields:

- `method`
- `path`
- `status_code`
- `duration_ms`

Optional fields:

- `route`
- `error_name`
- `entities`
- `span_id`
- `parent_span_id`

Normative rules:

- Emitted once per inbound HTTP request.
- `path` MUST be the concrete request path.
- `route` SHOULD be the parameterized route if the framework can supply it.
- `outcome` MUST be `error` for `5xx`.
- `outcome` MUST be `success` for `1xx`-`4xx`.
- If the handler throws before a valid response is formed, the producer MUST emit `status_code: 500` and `outcome: "error"`.

### 7.2 `db.query`

Required fields:

- `provider`
- `operation`
- `duration_ms`

Optional fields:

- `model`
- `error_name`
- `span_id`
- `parent_span_id`

Normative rules:

- Emitted once per database operation.
- Raw SQL text SHOULD NOT be emitted in the core profile.
- `outcome` MUST be `success` or `error` based on query execution result.

### 7.3 `external.call`

Required fields:

- `service`
- `operation`
- `duration_ms`

Optional fields:

- `error_name`
- `span_id`
- `parent_span_id`

Normative rules:

- Emitted once per outbound network call.
- `duration_ms` MUST measure time to response headers or terminal failure.
- Non-2xx HTTP responses with a valid response object MUST still be classified as a successful network call unless the implementation explicitly defines a stricter profile.
- Network-level failures MUST emit `outcome: "error"`.

### 7.4 `job.dispatch`

Required fields:

- `parent_span_id`
- `event_name`

Optional fields:

- `entities`

Normative rules:

- Emitted when work is dispatched across an asynchronous boundary.
- The record MUST preserve the originating trace context needed to continue causality in the downstream process.

### 7.5 `job.start`

Required fields:

- `span_id`
- `parent_span_id`
- `function_id`

Optional fields:

- `entities`

Normative rules:

- Emitted when the dispatched job begins execution.
- `parent_span_id` MUST reference the dispatching span when the trace continues from a dispatch event.
- If no upstream trace exists, the job MAY start a new root trace.

### 7.6 `job.end`

Required fields:

- `span_id`
- `parent_span_id`
- `function_id`
- `duration_ms`

Optional fields:

- `error_name`

Normative rules:

- Emitted exactly once for each `job.start`.
- `span_id` MUST match the corresponding `job.start`.
- `parent_span_id` MUST match the corresponding `job.start`.
- `outcome` MUST represent the terminal execution result.

### 7.7 Custom Event Kinds

The spec should allow custom kinds.

Rules:

- Custom events MUST follow the base event schema.
- Custom events MUST conform to the `kind` grammar.
- Consumers MUST ignore custom kinds they do not understand.

## 8. Trace Model

This section should define trace identifiers and span identifiers independently from any transport.

### 8.1 Trace IDs

- `trace_id` MUST be 32 lowercase hexadecimal characters.
- All-zero trace IDs MUST be rejected.
- Producers SHOULD use a cryptographically secure random source.

### 8.2 Span IDs

- `span_id` and `parent_span_id` MUST be 16 lowercase hexadecimal characters.
- All-zero span IDs MUST be rejected.

### 8.3 Span Tree Rules

- A root event has no `parent_span_id`.
- A child event MUST reference the span ID of its causal parent.
- Consumers SHOULD reconstruct trees from `span_id` and `parent_span_id`, not from timestamps alone.

### 8.4 Timestamps

- Timestamps are required for every record.
- Timestamps MUST NOT be treated as authoritative causal order across processes.

## 9. Propagation Model

This section should define propagation across boundaries.

### 9.1 W3C Trace Context

- HTTP propagation MUST use W3C `traceparent`.
- `traceparent` parsing MUST reject malformed values, all-zero IDs, and version `ff`.
- Formatting MUST emit version `00`.
- Producers MAY accept future versions, but the spec should avoid promising full round-trip preservation of unknown versions unless explicitly supported.

### 9.2 `tracestate`

- HTTP implementations SHOULD pass through `tracestate` unchanged when available.
- The core event schema MUST NOT depend on `tracestate`.

### 9.3 Browser Propagation

This should be in core v1 because you explicitly want it there.

Rules:

- Browser propagation MUST support bootstrapping from an explicit `traceparent`.
- Browser propagation MUST support bootstrapping from a meta tag.
- Browser propagation MUST generate fresh IDs if no valid bootstrap context exists.
- Browser fetch propagation MUST default to same-origin only.
- Browser implementations MUST support child-span scoping.
- Browser implementations SHOULD support adopting a response `traceparent` when present.

## 10. Async Causality Model

This section should define how causality survives background jobs and asynchronous work.

### 10.1 Continuation Envelope

The core spec should define a transport-agnostic continuation object for asynchronous boundaries.

Example:

```json
{
  "_trace": {
    "trace_id": "4bf92f3577b86cd56163f2543210c4a0",
    "parent_span_id": "00f067aa0ba902b7",
    "trace_flags": "01"
  }
}
```

Normative rules:

- `trace_id` MUST be required when a continuation envelope is present.
- `parent_span_id` MUST be required when a continuation envelope is present.
- `trace_flags` MAY be omitted.

### 10.2 Dispatch and Execution

- The dispatching side MUST emit `job.dispatch` if it emits async telemetry at all.
- The receiving side MUST continue the same `trace_id` when a valid continuation envelope is present.
- The receiving side MUST create a fresh execution `span_id`.
- The receiving side MUST emit `job.start` and `job.end`.
- `job.start.parent_span_id` MUST equal the upstream dispatch span ID.

### 10.3 Causal Reconstruction Requirement

- A conformant `Async` implementation MUST preserve enough information to reconstruct the dispatch-to-execution edge.

## 11. File Profile

This section should define the local filesystem contract.

### 11.1 Primary Transport

- The primary transport MUST be append-only JSONL on a local filesystem.
- The default path SHOULD be `{cwd}/logs/agent-telemetry.jsonl` or another explicitly chosen standard path. The document should pick one and stay consistent.

### 11.2 Discovery

The spec should define discovery order:

1. Explicit file path
2. Environment override
3. Default path

### 11.3 Write Semantics

- Producers MUST append full serialized records.
- Producers MUST NOT overwrite prior records during normal operation.
- Producers MUST ensure one serialized record maps to one line.

### 11.4 Never-Crash Boundary

- Emission failures MUST NOT crash the host application.
- If file writing fails, producers MUST either keep writing diagnostics to the same file when possible or fall back to a documented diagnostic sink.

### 11.5 Oversize Records

The spec should standardize drop behavior, not truncation.

Rules:

- The file profile MUST define `max_record_size`.
- Records larger than `max_record_size` MUST be dropped.
- Dropped oversize records SHOULD produce a `diagnostic` record when possible.
- Producers MUST NOT silently truncate records unless a future optional profile defines exact truncation semantics.

## 12. Rotation Profile

This section should be a profile, not core.

### 12.1 Rotation Configuration

- `max_file_size`
- `max_backups`

### 12.2 Rotation Behavior

- Rotation SHOULD occur before a new write would exceed `max_file_size`.
- Backup numbering MUST be deterministic.
- `.1` MUST be the most recent rotated file.

### 12.3 Failure Handling

- Rotation failures MUST NOT crash the host.
- Rotation failures SHOULD emit a `diagnostic` record or use the fallback diagnostic sink.

## 13. Safety and Privacy

This section should stay concise and practical.

### 13.1 Error Safety

- `error_name` MUST contain a safe label, not a raw message by default.
- Producers SHOULD use the exception type or equivalent stable class name.
- Producers SHOULD limit `error_name` length.

### 13.2 Path and Identifier Safety

- Path sanitization SHOULD be supported by implementations.
- Entity extraction SHOULD be configurable.
- Producers SHOULD document the risk of emitting user-identifiable path segments.

### 13.3 Diagnostic Safety

- Diagnostic messages SHOULD avoid raw secrets, stack traces, and arbitrary user input.

## 14. Consumer Behavior

This section should make the agent-facing contract explicit.

### 14.1 Required Consumer Behavior

- Consumers MUST ignore unknown fields.
- Consumers MUST ignore unknown event kinds.
- Consumers MUST skip malformed lines.
- Consumers MUST support mixed `event` and `diagnostic` records in the same file.

### 14.2 Trace Reconstruction

- Consumers SHOULD reconstruct traces using `trace_id`.
- Consumers SHOULD reconstruct span trees using `span_id` and `parent_span_id`.
- Consumers SHOULD NOT rely solely on timestamp order.

### 14.3 Filtering Guidance

This section can remain informative, but should emphasize:

- Filter by `trace_id`
- Filter by `kind`
- Filter by `entities`
- Treat diagnostics as optional support data

## 15. OpenTelemetry Projection Profile

This section should be optional but real.
It is the best way to explain where this fits without pretending to replace OTel.

### 15.1 Purpose

- This profile defines how to project OpenTelemetry signals into Agent Telemetry output.

### 15.2 Mapping Rules

This section should define mappings such as:

- OTel server HTTP span -> `http.request`
- OTel DB span -> `db.query`
- OTel client HTTP span -> `external.call`
- OTel messaging/task span -> `job.dispatch` / `job.start` / `job.end` where enough metadata exists

### 15.3 Projection Constraints

- Projection MUST NOT invent semantics absent from source telemetry.
- If a source signal cannot be mapped faithfully, the projector SHOULD emit a `diagnostic` record rather than a misleading event.

## 16. Conformance Fixtures

This section should replace the current mostly prose-based definition of done.

### 16.1 Fixture Format

Define a standard fixture format:

- input context
- emitted record(s)
- expected required fields
- expected invariants

### 16.2 Core Fixture Set

The minimum fixture set should include:

- Valid event serialization
- Unknown field tolerance
- Unknown kind tolerance
- Malformed line tolerance
- Trace ID and span ID validation
- Timestamp overwrite
- Oversize record drop with diagnostic

### 16.3 HTTP Fixture Set

- Incoming `traceparent` continuation
- Fresh trace creation
- Handler throw -> `500` + `outcome: "error"`
- `404` -> `outcome: "success"`
- Response propagation

### 16.4 Async Fixture Set

- Dispatch emits `job.dispatch`
- Execution continues `trace_id`
- `job.start.parent_span_id` points to dispatch span
- `job.end` matches `job.start`

### 16.5 Browser Fixture Set

- Bootstrap from explicit `traceparent`
- Bootstrap from meta tag
- Same-origin propagation
- Child span scoping
- Response `traceparent` adoption

### 16.6 Rotation Fixture Set

- Rotate before exceeding file size
- Backup numbering
- Rotation failure behavior

## 17. Informative Appendices

This section should be explicitly non-normative.

Recommended appendices:

- Rationale and design tradeoffs
- Example records
- Example agent queries
- Example implementation stages

### 17.1 Adoption Stages

Since you explicitly want implementation steps, this appendix should give staged rollout guidance:

1. Emit `http.request` only
2. Add `db.query` and `external.call`
3. Add browser propagation
4. Add async job propagation
5. Add rotation and diagnostics
6. Add OpenTelemetry projection if needed

## Rewrite Notes

When rewriting the current spec into this shape:

- Remove framework-specific adapter contracts from the normative body.
- Move MCP to a separate companion document if you still want it.
- Normalize all field names to `snake_case`.
- Replace `status`/`statusCode` split with `status_code` plus `outcome`.
- Replace `error` with `error_name`.
- Replace the current "flat JSONL" language with "shallow structured JSON records".
- Replace the current Definition of Done with executable conformance fixtures.
- Make async causality explicit and mandatory for the `Async` profile.
