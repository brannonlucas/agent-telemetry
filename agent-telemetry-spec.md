# Agent Telemetry Specification

**Version:** 1.0.0-draft
**Status:** Draft
**Authors:** Brannon Lucas
**License:** MIT

---

**Table of Contents**

1. [Overview](#1-overview)
2. [Design Goals](#2-design-goals)
3. [Conformance and Profiles](#3-conformance-and-profiles)
4. [Record Model](#4-record-model)
5. [Event Record Schema](#5-event-record-schema)
6. [Diagnostic Record Schema](#6-diagnostic-record-schema)
7. [Trace Model and Core Event Kinds](#7-trace-model-and-core-event-kinds)
8. [Async Profile](#8-async-profile)
9. [File Profile](#9-file-profile)
10. [Browser Profile](#10-browser-profile)
11. [Rotation Profile](#11-rotation-profile)
12. [Safety and Privacy](#12-safety-and-privacy)
13. [Consumer Behavior](#13-consumer-behavior)
14. [OpenTelemetry Projection Profile](#14-opentelemetry-projection-profile)
15. [Conformance Fixtures](#15-conformance-fixtures)
16. [Informative Appendix](#16-informative-appendix)
17. [Agent Consumption Profile](#17-agent-consumption-profile)
18. [Canonical Summary Schema](#18-canonical-summary-schema)

---

## 1. Overview

### 1.1 Positioning

Agent Telemetry is a local-first telemetry profile for development-time causal debugging by tools and agents.

It defines:

- A compact event schema.
- A compact diagnostic schema.
- Causal trace and async-boundary semantics.
- A local transport model based on append-only JSON Lines files.

It does not define a hosted backend, collector protocol, dashboard, or framework adapter API.

Agent Telemetry is intended for development-time distributed systems debugging. It is designed to let tools answer questions such as:

- Which inbound request failed?
- Which dependency or query was slow?
- Which background job continued the trace?
- Where did a causal chain break across processes?

Agent Telemetry is intentionally narrower than OpenTelemetry. It is a development-time profile and projection target, not a replacement for production observability standards.

### 1.2 Scope

This specification is for:

- Local development environments.
- Development-time traces spanning browser, server, dependencies, and background jobs.
- Portable producer and consumer implementations across languages.
- Direct native emission and projection from other telemetry systems such as OpenTelemetry.

### 1.3 Non-Goals

This specification does NOT define:

- A replacement for production observability backends.
- A transport protocol for network export.
- A metrics signal.
- A log standard for arbitrary application logs.
- A framework-specific middleware catalog.
- An MCP server or any specific agent access protocol.

### 1.4 Normative References

| Reference | URL |
|---|---|
| RFC 2119 (Requirement Levels) | https://www.rfc-editor.org/rfc/rfc2119 |
| RFC 8174 (Requirement Levels Clarification) | https://www.rfc-editor.org/rfc/rfc8174 |
| W3C Trace Context | https://www.w3.org/TR/trace-context/ |
| NDJSON | https://github.com/ndjson/ndjson-spec |
| RFC 8259 (JSON) | https://www.rfc-editor.org/rfc/rfc8259 |
| RFC 3339 | https://www.rfc-editor.org/rfc/rfc3339 |
| JSON Schema Core (Draft 2020-12) | https://json-schema.org/draft/2020-12/json-schema-core.html |
| JSON Schema Validation (Draft 2020-12) | https://json-schema.org/draft/2020-12/json-schema-validation.html |
| OpenTelemetry Trace API | https://opentelemetry.io/docs/specs/otel/trace/api/ |
| OpenTelemetry HTTP Semantic Conventions | https://opentelemetry.io/docs/specs/semconv/http/http-spans/ |
| OpenTelemetry Database Semantic Conventions | https://opentelemetry.io/docs/specs/semconv/database/database-spans/ |
| OpenTelemetry Messaging Semantic Conventions | https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/ |

### 1.5 Normative Keywords

The key words "MUST", "MUST NOT", "SHOULD", "SHOULD NOT", and "MAY" in this document are to be interpreted as described in RFC 2119 and RFC 8174 when, and only when, they appear in all capitals.

## 2. Design Goals

This section is informative and describes design intent, not additional conformance requirements.

Primary design goals:

1. Agent-readable by default. Records are cheap to parse, filter, and reconstruct.
2. Causal reconstruction. The format preserves enough information to rebuild traces across HTTP, dependencies, browser requests, and background jobs.
3. Local-first operation. The primary transport is usable without a collector or remote backend.
4. Safe failure behavior. Telemetry failures do not crash the host application.
5. Portability. The core format is implementation-agnostic and portable across languages.

Secondary design preferences:

1. Compactness. Records remain shallow and compact enough for development-time use and agent context windows.
2. Interoperability. Implementations coexist with W3C Trace Context and are projectable from OpenTelemetry where practical.
3. Monotonic timing. Producers use a monotonic clock source for `duration_ms` where available to avoid negative or skewed durations from wall-clock adjustments.
4. Deterministic parsing. Implementations keep core records shallow (no deep nesting in core fields), stable in field names, and deterministic to parse without collector-side enrichment.
5. Graceful fidelity loss. When telemetry cannot be recorded perfectly, implementations preserve partial data and emit diagnostics rather than fail silently.

## 3. Conformance and Profiles

### 3.1 Profiles

This specification is split into profiles.

| Profile | Scope |
|---|---|
| `Core` | Record model, event model, diagnostic model, ID rules, consumer obligations |
| `File` | JSONL transport, file discovery, append semantics, oversize handling |
| `Browser` | Browser-side trace propagation |
| `Async` | Cross-boundary continuation and job causality |
| `Rotation` | Size-based file rotation |
| `OTel Projection` | Projection from OpenTelemetry signals into Agent Telemetry records |
| `Agent Consumption` | Consumer pipeline, uncertainty model, trust annotations, summary contract, and machine-readable artifacts for LLM/tool consumption |

### 3.2 Profile Dependencies

Non-`Core` profiles have explicit dependencies:

| Profile | Requires |
|---|---|
| `Core` | — |
| `File` | `Core` |
| `Browser` | `Core` |
| `Async` | `Core` |
| `Rotation` | `File` (and therefore `Core`) |
| `OTel Projection` | `Core` |
| `Agent Consumption` | `Core` + `File` |

Claiming a profile implicitly claims all of its dependencies.

### 3.3 Claiming Conformance

An implementation MUST explicitly state:

- Which role(s) it supports: `producer`, `writer`, `consumer`, `projector`.
- Which profile set it claims.

- An implementation claiming `Core` conformance MUST satisfy Sections 4, 5, 6, 7, 12, and 13.
- An implementation claiming `File` conformance MUST also satisfy Section 9.
- An implementation claiming `Browser` conformance MUST also satisfy Section 10.
- An implementation claiming `Async` conformance MUST also satisfy Section 8.
- An implementation claiming `Rotation` conformance MUST also satisfy Section 11.
- An implementation claiming `OTel Projection` conformance MUST also satisfy Section 14.
- An implementation claiming `Agent Consumption` conformance MUST also satisfy Sections 17 and 18.

An implementation claiming `Agent Consumption` conformance MUST also claim `Core` and `File`.

An implementation claiming base Agent Telemetry runtime conformance MUST implement at least `Core` and `File`.

Conformance applies independently to each declared role:

- A **producer** MUST satisfy event emission rules (record schemas, required fields, emission timing) for the profiles it claims.
- A **writer** MUST satisfy transport and write-path rules for the profiles it claims (for example, append behavior and file discovery in `File`).
- A **consumer** MUST satisfy parsing and tolerance rules (unknown fields, unknown kinds, malformed lines, mixed record types) for the profiles it claims.
- A **projector** MUST satisfy source mapping and output schema rules for the profiles it claims.
- An implementation that performs multiple roles MUST satisfy each role's obligations.

### 3.4 Producer Paths

This specification allows two producer paths:

1. Native emission: the implementation emits Agent Telemetry records directly.
2. Projection: the implementation transforms another telemetry source into Agent Telemetry records.

Both producer paths MUST emit the same output schema for the profiles they claim.

When projection is used, any lossy mapping decisions MUST follow Section 14 and SHOULD emit diagnostics when fidelity is materially reduced.

## 4. Record Model

### 4.1 Line Format

The primary transport format is NDJSON / JSON Lines.

- Each line MUST be a single complete JSON object.
- Each line MUST be UTF-8 encoded.
- Each line MUST be terminated by `\n`.
- Producers MUST NOT emit literal newline bytes (`\n` or `\r`) inside a serialized record line.
- Escaped JSON newline sequences inside string values (for example `"line1\nline2"`) are allowed.
- Consumers MUST treat each line independently.

### 4.2 Record Types

Version 1 defines exactly two top-level record types:

- `event`
- `diagnostic`

Every record MUST include:

- `record_type`
- `spec_version`
- `timestamp`

### 4.3 Base Record Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `record_type` | string | MUST | `event` or `diagnostic` |
| `spec_version` | integer | MUST | `1` for this version |
| `timestamp` | string | MUST | RFC 3339 timestamp in UTC |

Timestamp semantics:

- `timestamp` MUST represent producer-side observation or emission time of the record.
- For terminal operation events that include `duration_ms` (for example `http.request`, `db.query`, `external.call`, `job.end`), `timestamp` SHOULD represent operation end time.
- Producers SHOULD set `timestamp` as close as possible to the underlying occurrence.
- If `timestamp` is absent when a record reaches the writer, the writer MUST set it to the current time as an approximation.
- Writers MUST NOT overwrite a `timestamp` that is already present.

### 4.4 Versioning and Unknown Fields

- Consumers MUST use `spec_version` for version gating.
- Consumers MUST ignore unknown fields.
- Consumers MUST ignore unknown event kinds.
- Producers MAY include additional fields allowed by an active profile or extension.
- Implementations adding extension fields SHOULD use namespaced field names to reduce collisions.

### 4.5 Malformed Lines

- Consumers MUST skip malformed lines without aborting the full read.
- Consumers MAY emit warnings or separate diagnostics when malformed lines are encountered.

### 4.6 Shallow JSON

When this specification requires a field to be "shallow JSON object", it means:

- The field value is a JSON object.
- Keys are strings.
- Values MUST be scalars (`string`, `number`, `boolean`, or `null`).
- Nested objects and arrays MUST NOT appear.

### 4.7 Bounded Strings and Deterministic Truncation

To support stable LLM/tool consumption, implementations SHOULD apply deterministic field-length limits to non-ID string fields.

Implementations claiming `Agent Consumption` conformance MUST apply the limits in Section 17.6.

Truncation rules:

- `trace_id`, `span_id`, and `parent_span_id` MUST NOT be truncated.
- String truncation MUST be deterministic and based on UTF-8 byte length.
- The truncation suffix MUST be the exact ASCII string `...[truncated]`.
- If a value exceeds its configured maximum, implementations MUST:
  1. If `max_bytes` is less than or equal to `len("...[truncated]")`, emit the first `max_bytes` bytes of `...[truncated]`.
  2. Otherwise, preserve the longest valid UTF-8 prefix whose byte length is `max_bytes - len("...[truncated]")`.
  3. Append `...[truncated]`.

## 5. Event Record Schema

### 5.1 Required Event Fields

Every `event` record MUST contain:

| Field | Type | Description |
|---|---|---|
| `record_type` | `"event"` | Fixed discriminator |
| `spec_version` | integer | Fixed at `1` |
| `timestamp` | string | RFC 3339 UTC timestamp |
| `kind` | string | Namespaced event identifier |
| `trace_id` | string | 32 lowercase hexadecimal characters |

### 5.2 Optional Common Event Fields

Every `event` record MAY contain:

| Field | Type | Description |
|---|---|---|
| `span_id` | string | 16 lowercase hexadecimal characters |
| `parent_span_id` | string | 16 lowercase hexadecimal characters |
| `outcome` | string | Normalized result classification |
| `error_name` | string | Safe error label |
| `entities` | object | Shallow map of domain identifiers |

### 5.3 `kind` Grammar

`kind` MUST match the following grammar:

```text
kind = segment "." segment *("." segment)
segment = LCALPHA *(LCALPHA / DIGIT / "_")
LCALPHA = %x61-7A   ; a-z
DIGIT   = %x30-39   ; 0-9
```

Equivalent regex:

```text
^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$
```

Examples:

- `http.request`
- `db.query`
- `external.call`
- `job.dispatch`
- `acme.cache_hit`

### 5.4 `outcome`

When present, `outcome` MUST be one of:

- `success`
- `error`

Event-specific rules determine when `outcome` is required.

`outcome` represents producer-side operation result classification.

Consumers MAY derive additional classifications (for example HTTP status class), but MUST preserve the producer-emitted `outcome` value.

### 5.5 `error_name`

`error_name` is a safe label, not a raw message.

Rules:

- Producers SHOULD use a stable exception or error type name.
- Producers MUST NOT place stack traces, secrets, raw SQL, or arbitrary user input in `error_name` by default.
- Producers SHOULD cap `error_name` length. A maximum of 80 characters is RECOMMENDED.

### 5.6 `entities`

`entities` is a shallow JSON object used for agent pivoting by domain object.

Examples:

```json
{"user_id":"550e8400-e29b-41d4-a716-446655440000"}
{"order_id":"ord_123","workspace_id":"ws_456"}
```

Rules:

- Keys MUST be strings.
- Values MUST be strings.
- Nested objects and arrays MUST NOT appear inside `entities`.
- Keys SHOULD match `^[a-z][a-z0-9_]*$`.
- `entities` is not trace propagation metadata.
- Extraction strategies are out of scope for `Core` conformance.

### 5.7 `duration_ms`

When present on an event, `duration_ms` MUST be a non-negative integer representing elapsed time in milliseconds. A value of `0` is valid and indicates a sub-millisecond operation.

### 5.8 Custom Events

Custom event kinds are allowed.

Rules:

- Custom events MUST satisfy the base `event` schema.
- Custom events MUST use a valid `kind`.
- Consumers MUST ignore custom kinds they do not understand.
- Core namespaces (`http`, `db`, `external`, `job`) are reserved by this specification.
- Custom kinds SHOULD use a stable vendor or project namespace prefix (for example `acme.cache.hit`).

## 6. Diagnostic Record Schema

### 6.1 Required Diagnostic Fields

Every `diagnostic` record MUST contain:

| Field | Type | Description |
|---|---|---|
| `record_type` | `"diagnostic"` | Fixed discriminator |
| `spec_version` | integer | Fixed at `1` |
| `timestamp` | string | RFC 3339 UTC timestamp |
| `code` | string | Stable machine-readable code |
| `message` | string | Short human-readable summary |

### 6.2 Optional Diagnostic Fields

Diagnostics MAY contain:

| Field | Type | Description |
|---|---|---|
| `level` | string | Diagnostic severity (`debug`, `info`, `warn`, `error`) |
| `details` | object | Open-ended but shallow JSON object |
| `related_kind` | string | Related event kind when applicable |
| `related_trace_id` | string | Related trace ID when known |

### 6.3 Diagnostic Rules

- Diagnostics MUST NOT require `trace_id`.
- `level`, when present, MUST be one of `debug`, `info`, `warn`, or `error`.
- `code` SHOULD match `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$`.
- `details`, when present, MUST be a shallow JSON object as defined in Section 4.6.
- Consumers MUST be able to ignore diagnostics entirely and still process events correctly.
- Diagnostics SHOULD be emitted for internal conditions that materially affect telemetry fidelity.
- Diagnostics SHOULD describe telemetry-system behavior, not arbitrary application logs.

### 6.4 Reserved Diagnostic Codes

Version 1 reserves the following codes:

- `event_dropped_oversize`
- `writer_fallback_activated`
- `writer_append_failed`
- `writer_rotation_failed`
- `projection_mapping_failed`

Implementations MAY emit additional diagnostic codes.

Additional diagnostic codes SHOULD use a stable namespace prefix (for example `writer.*`, `projection.*`, `custom.*`).

## 7. Trace Model and Core Event Kinds

### 7.1 Trace IDs

- `trace_id` MUST be exactly 32 lowercase hexadecimal characters.
- The all-zero value is invalid.
- Producers SHOULD use a cryptographically secure random source when generating new trace IDs.

### 7.2 Span IDs

- `span_id` and `parent_span_id` MUST be exactly 16 lowercase hexadecimal characters.
- The all-zero value is invalid.

### 7.3 Causal Reconstruction

- A root event has no `parent_span_id`.
- A child event MUST reference the causal parent span via `parent_span_id`.
- Producers that emit child events with `parent_span_id` MUST also emit `span_id` on the corresponding parent event. A parent without a `span_id` cannot be referenced.
- When `span_id` is absent on an event, consumers MUST NOT expect that event to appear as a parent in the span tree.
- Consumers SHOULD reconstruct trees from `span_id` and `parent_span_id`, not from timestamps alone.
- Timestamps MUST NOT be treated as authoritative causal order across processes.
- The Core model uses single-parent causal edges. General link-graph semantics (for example fan-out and batch links) are outside Core unless defined by an additional profile.

### 7.4 W3C Trace Context

HTTP propagation MUST use W3C `traceparent`.

Parsing rules:

- Producers MUST validate incoming `traceparent` according to W3C Trace Context.
- Invalid `traceparent` values MUST be treated as absent context.
- Version `ff`, malformed fields, all-zero trace IDs, and all-zero parent IDs MUST be treated as invalid.
- If `tracestate` is received without a valid `traceparent`, implementations MUST discard `tracestate`.

Formatting rules:

- Producers MUST emit version `00` when formatting a new `traceparent`.
- Producers MUST emit lowercase hexadecimal identifiers.
- Producers SHOULD preserve incoming trace flags when a valid parent exists.
- When no incoming value exists, producers SHOULD default trace flags to `01` only when the implementation is actively recording the trace; otherwise they SHOULD default to `00`.

Event records do not carry a `trace_flags` field. The `_trace` continuation envelope (Section 8) and W3C `traceparent` headers carry trace flags for propagation purposes. Consumers reconstructing a `traceparent` from event data SHOULD default trace flags to `"00"` unless an implementation-specific policy is known.

### 7.5 `tracestate`

- Implementations that receive `tracestate` SHOULD pass it through unchanged when practical.
- Async and browser propagation carriers SHOULD support `tracestate` pass-through.
- The Agent Telemetry event schema MUST NOT depend on `tracestate`.

### 7.6 `http.request`

A producer emitting `http.request` MUST emit one event per completed inbound HTTP request.

Required fields:

| Field | Type |
|---|---|
| `kind` | `"http.request"` |
| `trace_id` | string |
| `outcome` | `"success"` or `"error"` |
| `method` | string |
| `path` | string |
| `status_code` | integer |
| `duration_ms` | integer |

Optional fields:

| Field | Type |
|---|---|
| `span_id` | string |
| `parent_span_id` | string |
| `route` | string |
| `error_name` | string |
| `entities` | object |

Rules:

- `method` SHOULD be uppercase.
- `path` MUST be the concrete request path.
- `path` SHOULD exclude query string and fragment.
- `route` SHOULD be the parameterized route pattern when available.
- `duration_ms` MUST measure time from request receipt to response completion.
- `outcome` MUST be `error` for `5xx`.
- `outcome` MUST be `success` for `1xx` through `4xx`.
- If the handler throws before a valid response is formed, the producer MUST emit `status_code: 500` and `outcome: "error"`.

### 7.7 `db.query`

A producer emitting `db.query` MUST emit one event per database operation.

Required fields:

| Field | Type |
|---|---|
| `kind` | `"db.query"` |
| `trace_id` | string |
| `outcome` | `"success"` or `"error"` |
| `provider` | string |
| `operation` | string |
| `duration_ms` | integer |

Optional fields:

| Field | Type |
|---|---|
| `span_id` | string |
| `parent_span_id` | string |
| `model` | string |
| `error_name` | string |

Rules:

- `provider` SHOULD identify the logical database system or managed service (for example `postgresql`, `mysql`, `dynamodb`).
- `operation` identifies the logical operation such as `find_many`, `insert`, or `select`.
- `model` SHOULD identify the entity, table, or collection when known.
- Producers SHOULD NOT emit raw SQL text in the `Core` profile.
- Implementations MAY include client-library or ORM identity in extension fields (for example `db_client`).

### 7.8 `external.call`

A producer emitting `external.call` MUST emit one event per outbound dependency call.

Required fields:

| Field | Type |
|---|---|
| `kind` | `"external.call"` |
| `trace_id` | string |
| `outcome` | `"success"` or `"error"` |
| `service` | string |
| `operation` | string |
| `duration_ms` | integer |

Optional fields:

| Field | Type |
|---|---|
| `span_id` | string |
| `parent_span_id` | string |
| `status_code` | integer |
| `error_name` | string |

Rules:

- `service` SHOULD be a stable logical service identifier or hostname.
- `operation` SHOULD identify the dependency action, such as `GET /v1/charges` or `auth/token`.
- `duration_ms` MUST measure time to response headers or terminal failure.
- Network-level failures (for example DNS resolution failure, connection refused, timeout) MUST have `outcome: "error"`.
- For HTTP-based calls with `status_code`, `outcome` MUST be `error` for `5xx`.
- For HTTP-based calls with `status_code`, `outcome` SHOULD be `error` for `4xx` unless the implementation has explicit domain knowledge that the status is expected.
- For HTTP-based calls with `status_code`, `outcome` SHOULD be `success` for `1xx` through `3xx`.
- When the external call is HTTP-based, producers SHOULD include `status_code` on the event to give consumers visibility into non-2xx responses.

### 7.9 `job.dispatch`

When dispatch telemetry is emitted, a producer MUST emit one `job.dispatch` event per dispatch attempt across an asynchronous boundary.

Required fields:

| Field | Type |
|---|---|
| `kind` | `"job.dispatch"` |
| `trace_id` | string |
| `span_id` | string |
| `parent_span_id` | string |
| `task_name` | string |
| `outcome` | `"success"` or `"error"` |

Optional fields:

| Field | Type |
|---|---|
| `entities` | object |
| `task_id` | string |
| `queue` | string |
| `attempt` | integer |
| `error_name` | string |

Rules:

- `span_id` MUST uniquely identify this dispatch operation. It is the causal anchor that downstream execution references via `parent_span_id`.
- `parent_span_id` MUST identify the span that initiated the dispatch.
- If `outcome` is `success`, the implementation MUST preserve enough context for downstream continuation as defined in Section 8.
- If `outcome` is `error`, no downstream continuation is required.

### 7.10 `job.start`

When dispatched work begins execution and telemetry is emitted, a producer MUST emit one `job.start` event.

Required fields:

| Field | Type |
|---|---|
| `kind` | `"job.start"` |
| `trace_id` | string |
| `span_id` | string |
| `task_name` | string |

Optional fields:

| Field | Type |
|---|---|
| `parent_span_id` | string |
| `entities` | object |
| `task_id` | string |
| `queue` | string |
| `attempt` | integer |

Rules:

- `span_id` MUST identify the execution span for the job run.
- `parent_span_id` MUST identify the upstream dispatch span when a continuation exists.
- If no valid upstream continuation exists, the implementation MAY begin a new root trace and omit `parent_span_id`.

### 7.11 `job.end`

For each emitted `job.start`, a producer MUST emit exactly one corresponding `job.end` when execution completes.

Required fields:

| Field | Type |
|---|---|
| `kind` | `"job.end"` |
| `trace_id` | string |
| `span_id` | string |
| `task_name` | string |
| `duration_ms` | integer |
| `outcome` | `"success"` or `"error"` |

Optional fields:

| Field | Type |
|---|---|
| `parent_span_id` | string |
| `error_name` | string |
| `task_id` | string |
| `queue` | string |
| `attempt` | integer |

Rules:

- `span_id` MUST match the corresponding `job.start`.
- If the corresponding `job.start` contained `parent_span_id`, `job.end` MUST repeat the same `parent_span_id`.
- `task_name` MUST match the corresponding `job.start`.
- `outcome` MUST represent the terminal execution result.

## 8. Async Profile

### 8.1 Continuation Envelope

The `Async` profile defines a canonical continuation payload for JSON-capable carriers:

```json
{
  "_trace": {
    "traceparent": "00-4bf92f3577b86cd56163f2543210c4a0-00f067aa0ba902b7-01",
    "tracestate": "vendorname=opaque"
  }
}
```

Rules:

- `_trace.traceparent` MUST be present when `_trace` is present.
- `_trace.traceparent` MUST be validated using W3C Trace Context parsing rules.
- `_trace.tracestate` MAY be present only when `_trace.traceparent` is valid.
- `_trace` is propagation metadata, not an `event` record field.
- For non-JSON carriers (for example message headers), implementations SHOULD propagate `traceparent` and `tracestate` using native carrier fields without requiring an `_trace` wrapper.

### 8.2 Dispatch Rules

An implementation claiming `Async` conformance MUST satisfy the following rules when it supports dispatched work:

- The dispatching side MUST continue the active trace when valid context exists; otherwise it MAY start a new trace.
- The dispatching side MUST generate a fresh `span_id` for `job.dispatch`.
- If `job.dispatch.outcome` is `success`, the dispatching side MUST propagate continuation context where the outgoing parent-id equals the dispatch `span_id`.
- If telemetry for dispatch attempts is emitted, the implementation MUST emit `job.dispatch` with required fields from Section 7.9.

### 8.3 Execution Rules

When a valid continuation envelope is present:

- The receiving side MUST continue the same `trace_id`.
- The receiving side MUST create a fresh execution `span_id`.
- The receiving side MUST emit `job.start`.
- The receiving side MUST emit `job.end`.
- `job.start.parent_span_id` MUST equal the parent-id extracted from incoming `traceparent`. When a `job.dispatch` event was emitted for the same handoff, this value is the dispatch `span_id`.
- When valid `tracestate` is present, implementations SHOULD pass it through for downstream propagation.

When no valid continuation envelope is present:

- The receiving side MAY start a new root trace.

### 8.4 Reconstruction Requirement

A conformant `Async` implementation MUST preserve enough information to reconstruct the dispatch-to-execution edge.

If retries are represented, implementations SHOULD include stable `task_id` and `attempt` fields on `job.dispatch`, `job.start`, and `job.end`.

## 9. File Profile

### 9.1 Primary Transport

The primary transport is append-only local JSONL files grouped by session directory.

Default session directory:

```text
{project_root}/.agent-telemetry/{session_id}/
```

Recommended per-writer active filename:

```text
{role}-{pid}.jsonl
```

`project_root` SHOULD resolve to the repository root when detectable; otherwise the current working directory MAY be used.

`session_id` SHOULD be stable for one local development run, and cooperating processes in the same run SHOULD share the same `session_id`.

`role` is an implementation-defined producer label (for example `server`, `worker`, `test`).

### 9.2 Discovery Order

Consumers SHOULD resolve telemetry input in the following order:

1. Explicit file path(s) or directory path provided by the caller.
2. `AGENT_TELEMETRY_FILE` environment variable (single-file mode).
3. `AGENT_TELEMETRY_DIR` environment variable (directory mode).
4. Default directory `{project_root}/.agent-telemetry/{session_id}/`.

When a directory is selected, consumers SHOULD read all `*.jsonl` files in that directory.

### 9.3 Write Semantics

- Writers MUST append full serialized records.
- Writers MUST ensure one record maps to one line.
- Writers MUST NOT overwrite prior records during normal operation.
- Writers SHOULD write to a per-process active file in directory mode.
- Writers MUST NOT rely on unsafe multi-process appends to a single shared file unless they provide explicit cross-process synchronization.
- Writers MAY buffer writes internally.
- If writers buffer writes, they SHOULD expose a flush operation and SHOULD flush on graceful shutdown.

### 9.4 Never-Crash Boundary

- Telemetry emission failures MUST NOT crash the host application.
- Producer-side serialization failures MUST NOT crash the host application.
- File-write failures MUST NOT crash the host application.

### 9.5 Record Size

The `File` profile defines `max_record_size`.

Default value:

```text
1,048,576 bytes
```

Rules:

- Serialized records larger than `max_record_size` MUST be dropped.
- Writers MUST NOT silently truncate records in version 1.
- When the active output remains writable, dropping an oversize record SHOULD emit a `diagnostic` record with code `event_dropped_oversize`.

### 9.6 Fallback Behavior

Diagnostics belong in the same JSONL output path whenever that path remains writable.

If the primary file cannot be written:

- The implementation MUST still avoid crashing the host application.
- The implementation MAY write to a documented fallback diagnostic sink such as stderr.
- The fallback sink is outside `Core` conformance and SHOULD be documented explicitly.

### 9.7 Concurrency

This specification does NOT require safe multi-process concurrent writes to the same active file.

- Conformant multi-process implementations SHOULD use per-process files in a shared session directory.
- Consumers MUST support merging records from multiple files discovered in one directory.
- Consumers SHOULD preserve byte order within each file and treat cross-file timestamp order as best-effort.
- Consumers MUST tolerate partial or malformed lines caused by interrupted writes.

## 10. Browser Profile

The `Browser` profile defines propagation behavior for browser-originated traces. It does NOT require browser-side event emission.

### 10.1 Bootstrap Order

Browser implementations MUST support the following bootstrap order:

1. Explicit initial `traceparent` provided by the caller.
2. Standardized HTML meta tags containing `traceparent` and optional `tracestate` (`agent-telemetry-traceparent`, `agent-telemetry-tracestate`).
3. Freshly generated trace and span context.

Invalid bootstrap values MUST be ignored.

If meta-tag bootstrap is used, implementations MUST read `agent-telemetry-traceparent` and MAY read `agent-telemetry-tracestate`.

### 10.2 Default Propagation Policy

- Browser fetch propagation MUST default to same-origin requests only.
- Browser propagation MUST inject `traceparent` and SHOULD inject `tracestate` when present and valid.
- Implementations MAY allow stricter or explicit allow-list policies.

### 10.3 Child Span Scoping

Browser implementations MUST support child-span scoping for local work, such as user actions or request grouping.

Rules:

- A scoped child span MUST inherit the active `trace_id`.
- A scoped child span MUST install its `span_id` as the active parent for nested work.
- The prior active parent MUST be restored when the scope ends.

### 10.4 Response Adoption

- Browser implementations MAY support adopting a valid response `traceparent` as the new active parent.
- Response adoption SHOULD be disabled by default.
- If enabled, response adoption SHOULD be restricted to same-origin responses unless explicitly configured otherwise.
- Invalid response `traceparent` values MUST be ignored.

## 11. Rotation Profile

The `Rotation` profile defines size-based file rotation.

### 11.1 Configuration

| Parameter | Type | Default | Description |
|---|---|---|---|
| `max_file_size` | integer | `5,000,000` | Rotate before the next write would exceed this size |
| `max_backups` | integer | `3` | Number of rotated backup files to keep |

### 11.2 Rotation Rules

- Rotation SHOULD occur before a write that would exceed `max_file_size`.
- Backup numbering MUST be deterministic.
- `.1` MUST be the most recent rotated file.
- Higher numbers MUST be older files.
- Rotation MUST apply per active writer file.
- Implementations SHOULD rotate only between complete-record writes.

If a single record is smaller than `max_record_size` but larger than `max_file_size`:

- The implementation MAY write that record to an empty active file.
- The next write SHOULD trigger rotation according to the normal rules.

### 11.3 Rotation Failure

- Rotation failures MUST NOT crash the host application.
- When possible, a rotation failure SHOULD emit a `diagnostic` record with code `writer_rotation_failed`.

## 12. Safety and Privacy

### 12.1 Path Safety

`http.request.path` may contain sensitive information.

Rules:

- Implementations SHOULD provide path sanitization hooks.
- Implementations SHOULD document the privacy risks of raw paths.
- Query strings SHOULD be omitted by default.
- Implementations SHOULD avoid capturing fragments, request bodies, or header values in core event fields.

### 12.2 Entity Safety

- Entity extraction SHOULD be configurable.
- Implementations SHOULD allow users to disable or narrow entity extraction.

### 12.3 Error Safety

- `error_name` SHOULD use stable type names rather than raw messages.
- Producers SHOULD avoid secrets, stack traces, and arbitrary user input in `diagnostic.message` and `diagnostic.details`.
- Producers SHOULD treat diagnostic fields as potentially user-visible and agent-consumed.

### 12.4 File Permissions

- Implementations SHOULD create telemetry files with user-private permissions where practical.
- Implementations SHOULD document that telemetry files may contain request paths, domain identifiers, and service names.
- Implementations SHOULD recommend ignoring telemetry directories in version control.

### 12.5 Untrusted Content and Agent Safety

- Consumers and agents MUST treat telemetry field values as untrusted data, not executable instructions.
- Rendering layers SHOULD escape telemetry values before display.
- Prompt builders SHOULD delimit and quote telemetry values when embedding them into model prompts.
- Implementations SHOULD provide field-level redaction and opt-out controls for sensitive domains.
- Implementations claiming `Agent Consumption` conformance MUST also satisfy the prompt-safe output requirements in Section 17.8.

## 13. Consumer Behavior

### 13.1 Required Consumer Behavior

Consumers MUST:

- Ignore unknown fields.
- Ignore unknown event kinds.
- Skip malformed lines.
- Support mixed `event` and `diagnostic` records in the same file.

### 13.2 Trace Reconstruction

Consumers SHOULD:

1. Filter by `trace_id` to collect a trace.
2. Build parent-child relationships using `span_id` and `parent_span_id`.
3. Treat missing parents as roots or external ancestors.
4. Use timestamps for temporal hints, not authoritative cross-process causality.
5. In multi-file mode, preserve record order within each file and treat cross-file ordering as best-effort.

### 13.3 Domain Pivoting

Consumers SHOULD treat `entities` as a secondary join key for debugging domain-specific issues such as:

- all events affecting a user
- all events affecting an order
- all events affecting a workspace

### 13.4 Diagnostics

Consumers MAY:

- Ignore diagnostics completely.
- Surface diagnostics separately from events.
- Use diagnostics to explain missing telemetry fidelity, such as dropped oversize records or writer fallback.

Consumers SHOULD surface trace-fidelity uncertainty when diagnostics indicate dropped records, fallback sinks, or parse failures.

Consumers claiming `Agent Consumption` conformance MUST additionally satisfy Section 17.

## 14. OpenTelemetry Projection Profile

The `OTel Projection` profile defines how an implementation may map OpenTelemetry signals into Agent Telemetry records.

### 14.1 Purpose

This profile exists so an implementation can use OpenTelemetry instrumentation and still produce Agent Telemetry records for agent consumption.

This projection profile is transport-agnostic. The resulting records may be written to file, held in memory, or delivered through any transport profile the implementation supports.

Projectors MUST document which OpenTelemetry semantic-convention version they target.

### 14.2 High-Level Mappings

Required source mappings:

| OpenTelemetry Source | Agent Telemetry Kind |
|---|---|
| Inbound server HTTP span | `http.request` |
| Database client span | `db.query` |
| Outbound client HTTP span | `external.call` |
| Messaging producer or dispatch span/event | `job.dispatch` |
| Async consumer or task execution span | `job.start` / `job.end` |

Projectors claiming `OTel Projection` conformance MUST support the mappings in this table when corresponding source signals are present.

### 14.3 Field Projection Rules

Projectors MUST apply the following base mappings:

- `trace_id` MUST be mapped from OpenTelemetry span context trace ID.
- `span_id` MUST be mapped from OpenTelemetry span context span ID.
- `parent_span_id` MUST be mapped from OpenTelemetry parent span ID when available.
- `timestamp` MUST be mapped from span end time for terminal events (`http.request`, `db.query`, `external.call`, `job.end`).
- `timestamp` MUST be mapped from span start time for point-in-time events (`job.dispatch`, `job.start`) when mapped from spans.
- `duration_ms` MUST be mapped from span elapsed time, rounded to nearest integer millisecond.
- `error_name` SHOULD be mapped from `error.type` when available; otherwise from a stable, sanitized exception type source.

For `http.request` projection:

- `method` MUST be mapped from HTTP method attributes when available.
- `status_code` MUST be mapped from HTTP response status attributes when available.
- `path` MUST be mapped from URL/path attributes when available and sanitized according to Section 12.
- `route` SHOULD be mapped from route/template attributes when available.
- `outcome` MUST follow Section 7.6 rules.

For `db.query` projection:

- `provider` SHOULD map from logical database system attributes when present.
- `operation` SHOULD map from database operation attributes when present.
- `model` SHOULD map from collection/table/entity attributes when present.
- Raw SQL text MUST NOT be projected into core fields by default.

For `external.call` projection:

- `service` SHOULD map from peer/service endpoint attributes.
- `operation` SHOULD map from request operation attributes.
- `status_code` SHOULD map for HTTP dependencies.
- `outcome` MUST follow Section 7.8 rules.

For async projection:

- `job.dispatch` SHOULD represent producer-side dispatch/enqueue operations.
- `job.start` and `job.end` SHOULD represent consumer/task execution span lifecycle.
- `task_name` SHOULD come from stable messaging/task name attributes when available.
- If `task_id`, `queue`, or `attempt` can be derived reliably, projectors SHOULD include them.

### 14.4 Link and Lossy Mapping Rules

- A projector MUST NOT invent semantics absent from the source telemetry.
- If source data is insufficient to satisfy required Agent Telemetry fields, the projector MUST omit the record or emit `projection_mapping_failed`.
- When source spans use links instead of parent-child relationships, projectors MAY approximate `parent_span_id` from a dominant link only when that choice is deterministic and documented.
- When lossy approximation is used, projectors SHOULD emit a `diagnostic` record indicating reduced causality fidelity.

### 14.5 Conformance Constraint

- The output produced by projection MUST conform to the same record schemas as native emission.

## 15. Conformance Fixtures

This specification prefers executable fixtures over prose-only test descriptions.

### 15.1 Fixture Format

Conformance fixture suites MUST define fixtures with:

- Input context.
- Claimed profile.
- Expected output records.
- Expected invariants.
- Expected uncertainty and summary outputs when `Agent Consumption` is claimed.

Fixture suites MUST include:

- A canonical fixture schema (JSON or YAML).
- Deterministic matcher semantics for generated values (for example IDs and timestamps).
- A profile and role declaration (`producer`, `writer`, `consumer`, `projector`).
- Deterministic ordering assertions for summary outputs when `Agent Consumption` is claimed.

Example fixture shape:

```yaml
id: http_handler_throw_preserves_trace
profile: Core+File
role: producer+writer
input:
  incoming_traceparent: "00-4bf92f3577b86cd56163f2543210c4a0-00f067aa0ba902b7-01"
  method: "GET"
  path: "/users/550e8400-e29b-41d4-a716-446655440000"
  route: "/users/:id"
  handler:
    throws:
      name: "TypeError"
expected:
  records:
    - record_type: "event"
      kind: "http.request"
      trace_id: "4bf92f3577b86cd56163f2543210c4a0"
      parent_span_id: "00f067aa0ba902b7"
      status_code: 500
      outcome: "error"
      error_name: "TypeError"
```

### 15.2 Minimum Fixture Set for `Core`

A `Core` implementation MUST pass fixtures covering:

- Valid record serialization.
- Unknown field tolerance.
- Unknown event kind tolerance.
- Malformed line tolerance.
- Trace ID and span ID validation.
- Safe `error_name` behavior.
- Timestamp backfill: writer sets `timestamp` when absent from the record.
- Timestamp preservation: writer does not overwrite `timestamp` when already present.
- Invalid `traceparent` handling (treated as absent context).
- `tracestate` discard when no valid `traceparent` exists.
- `external.call` outcome: an HTTP `5xx` response has `outcome: "error"`.
- `external.call` outcome: expected and explicitly configured `4xx` responses may map to `success`.
- `external.call` outcome: a network-level failure has `outcome: "error"`.

### 15.3 Minimum Fixture Set for `File`

A `File` implementation MUST pass fixtures covering:

- Default directory discovery.
- Explicit file override.
- Explicit directory override.
- Oversize record drop.
- `event_dropped_oversize` diagnostic when file remains writable.
- Never-crash behavior on serialization or append failure.
- Mixed `event` and `diagnostic` records coexist in the same output.
- Multi-file merge behavior within one session directory.

### 15.4 Minimum Fixture Set for `Browser`

A `Browser` implementation MUST pass fixtures covering:

- Bootstrap from explicit `traceparent`.
- Bootstrap from standardized meta tags.
- Same-origin propagation by default.
- Child span scoping and restoration.
- Optional response `traceparent` adoption when explicitly enabled.

### 15.5 Minimum Fixture Set for `Async`

An `Async` implementation MUST pass fixtures covering:

- Continuation envelope parsing.
- `job.dispatch` emission with a unique `span_id`.
- Successful dispatch propagates `traceparent` whose parent-id equals the dispatch `span_id`.
- Continued `trace_id` on execution.
- `job.start.parent_span_id` linkage to the propagated parent-id.
- Multiple dispatches from the same parent produce distinct dispatch `span_id` values.
- Matching `job.start` and `job.end`.
- Retry representation with `task_id` and `attempt` when available.

### 15.6 Minimum Fixture Set for `Rotation`

A `Rotation` implementation MUST pass fixtures covering:

- Rotation before exceeding `max_file_size`.
- Deterministic backup numbering.
- Rotation boundaries preserve whole records.
- Failure behavior without host crash.

### 15.7 Minimum Fixture Set for `Agent Consumption`

An `Agent Consumption` implementation MUST pass fixtures covering:

- Canonical pipeline execution (`parse -> validate -> normalize -> reconstruct -> uncertainty -> summary`).
- Field-limit enforcement and deterministic truncation suffix behavior.
- Trust classification defaults for user-influenced fields.
- Deterministic summary ordering for identical input bytes.
- Required summary object shape from Section 18.
- Contract-pack artifact presence and schema validation.
- Uncertainty emission for malformed lines, missing parents, dropped records, and lossy projection.
- Prompt-safe serialization behavior (escaped control characters and quoted values).

An `Agent Consumption` implementation MUST also pass negative vectors covering:

- Invalid IDs that prevent span linkage.
- Malformed `traceparent` and orphaned `tracestate`.
- Unexpected deeply nested objects in shallow fields.
- Oversize values requiring truncation.
- Unknown event kinds mixed with valid kinds.

## 16. Informative Appendix

This section is informative, not normative.
Sections 17 and 18 that follow remain normative.

### 16.1 Example Records

`http.request`

```json
{"record_type":"event","spec_version":1,"timestamp":"2026-02-28T18:00:00.000Z","kind":"http.request","trace_id":"4bf92f3577b86cd56163f2543210c4a0","span_id":"00f067aa0ba902b7","outcome":"success","method":"GET","path":"/users/550e8400-e29b-41d4-a716-446655440000","route":"/users/:id","status_code":200,"duration_ms":42,"entities":{"user_id":"550e8400-e29b-41d4-a716-446655440000"}}
```

`db.query`

```json
{"record_type":"event","spec_version":1,"timestamp":"2026-02-28T18:00:00.010Z","kind":"db.query","trace_id":"4bf92f3577b86cd56163f2543210c4a0","span_id":"a1b2c3d4e5f60718","parent_span_id":"00f067aa0ba902b7","outcome":"success","provider":"postgresql","db_client":"prisma","model":"user","operation":"find_many","duration_ms":8}
```

`external.call`

```json
{"record_type":"event","spec_version":1,"timestamp":"2026-02-28T18:00:00.025Z","kind":"external.call","trace_id":"4bf92f3577b86cd56163f2543210c4a0","span_id":"b2c3d4e5f6071829","parent_span_id":"00f067aa0ba902b7","outcome":"success","service":"api.stripe.com","operation":"GET /v1/charges","status_code":200,"duration_ms":120}
```

`job.dispatch`

```json
{"record_type":"event","spec_version":1,"timestamp":"2026-02-28T18:00:01.000Z","kind":"job.dispatch","trace_id":"4bf92f3577b86cd56163f2543210c4a0","span_id":"d4e5f60718293041","parent_span_id":"00f067aa0ba902b7","task_name":"email.send_receipt","task_id":"job_123","queue":"emails","attempt":1,"outcome":"success","entities":{"user_id":"550e8400-e29b-41d4-a716-446655440000"}}
```

`_trace` continuation envelope (JSON carrier)

```json
{"_trace":{"traceparent":"00-4bf92f3577b86cd56163f2543210c4a0-d4e5f60718293041-01","tracestate":"vendorname=opaque"}}
```

`job.start`

```json
{"record_type":"event","spec_version":1,"timestamp":"2026-02-28T18:00:01.010Z","kind":"job.start","trace_id":"4bf92f3577b86cd56163f2543210c4a0","span_id":"c3d4e5f607182930","parent_span_id":"d4e5f60718293041","task_name":"email.send_receipt","task_id":"job_123","queue":"emails","attempt":1,"entities":{"user_id":"550e8400-e29b-41d4-a716-446655440000"}}
```

`job.end`

```json
{"record_type":"event","spec_version":1,"timestamp":"2026-02-28T18:00:02.200Z","kind":"job.end","trace_id":"4bf92f3577b86cd56163f2543210c4a0","span_id":"c3d4e5f607182930","parent_span_id":"d4e5f60718293041","task_name":"email.send_receipt","task_id":"job_123","queue":"emails","attempt":1,"duration_ms":1190,"outcome":"success"}
```

`diagnostic`

```json
{"record_type":"diagnostic","spec_version":1,"timestamp":"2026-02-28T18:00:02.210Z","code":"event_dropped_oversize","message":"serialized record exceeded max_record_size","related_kind":"external.call","details":{"serialized_size":1320044}}
```

### 16.2 Recommended Adoption Stages

Recommended implementation sequence:

1. Emit `http.request`.
2. Add `db.query` and `external.call`.
3. Add browser propagation.
4. Add async continuation with `job.dispatch`, `job.start`, and `job.end`.
5. Add diagnostics and oversize handling.
6. Add rotation.
7. Add OpenTelemetry projection if needed.
8. Add `Agent Consumption` profile outputs and contract artifacts.

### 16.3 Rationale Summary

The format is intentionally smaller and more opinionated than general observability formats.

Its design center is:

- local development
- agent consumption
- causal trace reconstruction
- low setup overhead

It is meant to coexist with broader observability systems, not replace them.

## 17. Agent Consumption Profile

The `Agent Consumption` profile defines additional requirements for deterministic, safe, and compact telemetry consumption by LLMs and tools.

### 17.1 Scope

Implementations claiming `Agent Consumption` conformance MUST:

- Implement `Core` and `File`.
- Implement the consumer behavior in this section.
- Produce the canonical summary object defined in Section 18.
- Publish machine-readable contract artifacts as defined in Section 17.9.

### 17.2 Required Consumer Pipeline

An `Agent Consumption` consumer MUST process telemetry using the following pipeline:

1. Parse lines into candidate records.
2. Validate record shape and required fields.
3. Normalize fields (timestamps, IDs, bounded strings, and known enums).
4. Reconstruct trace structure from `trace_id`, `span_id`, and `parent_span_id`.
5. Annotate trust and uncertainty.
6. Produce a canonical trace summary object (Section 18).

Pipeline stages MUST be deterministic for identical input bytes.

### 17.3 Validation and Normalization Rules

Agent-consumption consumers MUST apply all `Core` validation and additionally:

- Reject malformed ID fields (`trace_id`, `span_id`, `parent_span_id`) from summary reconstruction.
- Preserve accepted raw records for audit visibility even when fields are unusable for reconstruction.
- Preserve producer `outcome` values exactly as emitted.
- Normalize absent optional fields as `null` in summary output where Section 18 requires explicit nullability.

### 17.4 Uncertainty Model

The summary output MUST include an `uncertainty` array (Section 18) describing fidelity gaps.

Each uncertainty entry MUST include:

- `code`: stable machine-readable identifier.
- `message`: short human-readable explanation.
- `severity`: one of `info`, `warn`, `error`.

Reserved uncertainty codes:

- `malformed_line_skipped`
- `missing_parent_span`
- `dropped_oversize_record`
- `writer_fallback_active`
- `projection_lossy_mapping`
- `unknown_kind_ignored`

Consumers MAY emit additional uncertainty codes but SHOULD namespace them (for example `custom.*`).

Recommended severity defaults:

- `malformed_line_skipped`: `warn`
- `missing_parent_span`: `warn`
- `dropped_oversize_record`: `warn`
- `writer_fallback_active`: `error`
- `projection_lossy_mapping`: `warn`
- `unknown_kind_ignored`: `info`

### 17.5 Trust and Taint Classification

Agent-consumption summaries MUST assign a trust class to each summarized event:

- `system_asserted`: emitted by instrumentation/runtime, low user influence.
- `derived`: computed by consumer from multiple records.
- `untrusted_input`: may contain direct user-controlled or external input.
- `unknown`: provenance cannot be classified confidently.

Default trust guidance:

- `http.request.path`, `entities`, `error_name`, `diagnostic.message`, and `diagnostic.details` SHOULD default to `untrusted_input` unless explicitly sanitized by policy.
- IDs generated by instrumentation (`trace_id`, `span_id`) SHOULD default to `system_asserted`.

### 17.6 Field Limits for Agent Consumption

Implementations claiming `Agent Consumption` conformance MUST enforce the following maximum UTF-8 byte lengths before summary emission:

| Field | Max Bytes |
|---|---|
| `kind` | 64 |
| `error_name` | 120 |
| `http.request.path` | 1024 |
| `http.request.route` | 256 |
| `external.call.service` | 128 |
| `external.call.operation` | 256 |
| `db.query.provider` | 64 |
| `db.query.operation` | 128 |
| `db.query.model` | 128 |
| `job.*.task_name` | 128 |
| `job.*.task_id` | 128 |
| `job.*.queue` | 128 |
| `diagnostic.code` | 96 |
| `diagnostic.message` | 256 |
| `entities` key | 64 |
| `entities` value | 256 |
| `details` key | 64 |
| `details` string value | 256 |
| unlisted string fields | 256 |

When truncation occurs, implementations MUST apply Section 4.7 and increment `truncation_count` in the summary metadata.

### 17.7 Deterministic Ordering

For a fixed telemetry input set, the summary output MUST be byte-stable when serialized with a deterministic serializer.

Ordering requirements:

- File discovery order MUST be deterministic (lexicographic path order).
- In-file order MUST follow physical line order.
- Event ordering in the summary MUST sort by:
  1. `timestamp` ascending,
  2. discovery-order file index ascending,
  3. line number ascending.
- Diagnostic ordering in the summary MUST use the same sort key.

### 17.8 Prompt-Safe Output Profile

When preparing summary data for prompts, implementations MUST:

- Treat all string fields as untrusted data.
- Delimit raw telemetry values as JSON string values, not executable instructions.
- Escape control characters.
- Preserve the distinction between data and model instructions.

Prompt builders SHOULD include trust and uncertainty metadata verbatim so models can reason about reliability.

### 17.9 Machine-Readable Contract Pack

Implementations claiming `Agent Consumption` conformance MUST publish a machine-readable contract pack for the implemented `spec_version`.

Required artifacts:

- `contracts/agent-telemetry/v1/manifest.json`
- `contracts/agent-telemetry/v1/schema/event.base.schema.json`
- `contracts/agent-telemetry/v1/schema/diagnostic.schema.json`
- `contracts/agent-telemetry/v1/schema/kinds/http.request.schema.json`
- `contracts/agent-telemetry/v1/schema/kinds/db.query.schema.json`
- `contracts/agent-telemetry/v1/schema/kinds/external.call.schema.json`
- `contracts/agent-telemetry/v1/schema/kinds/job.dispatch.schema.json`
- `contracts/agent-telemetry/v1/schema/kinds/job.start.schema.json`
- `contracts/agent-telemetry/v1/schema/kinds/job.end.schema.json`
- `contracts/agent-telemetry/v1/schema/trace-summary.schema.json`
- `contracts/agent-telemetry/v1/limits.json`
- `contracts/agent-telemetry/v1/enums.json`
- `contracts/agent-telemetry/v1/regex.json`
- `contracts/agent-telemetry/v1/glossary.json`
- `contracts/agent-telemetry/v1/negative-vectors.json`

If a different path layout is used, implementations MUST document an equivalent mapping.

`manifest.json` MUST include at least:

- `spec_version`
- `summary_version`
- `artifact_paths`
- `artifact_hashes` (SHA-256)

### 17.10 Field Glossary and Inference Constraints

`glossary.json` MUST define a stable semantic description for each core field and include inference constraints.

Minimum required constraints:

- `outcome`: operation result classification only; MUST NOT be treated as a full business-success signal.
- `duration_ms`: elapsed timing hint; MUST NOT be used as causal ordering proof across processes.
- `path`: request path value that may be user-influenced.
- `entities`: debugging pivot keys only; MUST NOT be treated as identity proof.
- `diagnostic`: telemetry-system fidelity signal; MUST NOT be interpreted as application business events.

## 18. Canonical Summary Schema

This section defines the canonical trace-summary object for agent/tool consumption.

### 18.1 Top-Level Object

A canonical summary object MUST contain:

| Field | Type | Description |
|---|---|---|
| `summary_type` | string | MUST be `"trace_summary"` |
| `summary_version` | integer | MUST be `1` |
| `spec_version` | integer | MUST be `1` |
| `trace_id` | string | Trace identifier |
| `generated_at` | string | RFC 3339 UTC generation timestamp |
| `record_count` | integer | Total accepted records |
| `event_count` | integer | Total accepted events |
| `diagnostic_count` | integer | Total accepted diagnostics |
| `truncation_count` | integer | Number of field truncations applied |
| `root_span_ids` | array of strings | Root span identifiers |
| `events` | array of objects | Canonical event entries |
| `diagnostics` | array of objects | Canonical diagnostic entries |
| `uncertainty` | array of objects | Fidelity gaps |
| `entities` | object | Map of entity key to unique sorted values |

`root_span_ids` MUST be unique and lexicographically sorted.
Each `entities` value array MUST be unique and lexicographically sorted.

### 18.2 Canonical Event Entry

Each `events` item MUST contain:

| Field | Type | Description |
|---|---|---|
| `event_index` | integer | Deterministic sequence index |
| `timestamp` | string | RFC 3339 UTC timestamp |
| `kind` | string | Event kind |
| `trace_id` | string | Trace identifier |
| `span_id` | string or null | Span identifier |
| `parent_span_id` | string or null | Parent span identifier |
| `outcome` | string or null | `success`, `error`, or `null` |
| `duration_ms` | integer or null | Duration when present |
| `attributes` | object | Shallow normalized event attributes |
| `trust` | string | Trust class from Section 17.5 |
| `source_file` | string | Source file path label |
| `source_line` | integer | 1-based source line number |

`attributes` MUST exclude duplicate core fields already represented at the top level.
`event_index` MUST start at `0` and increment by `1` in emitted order.
`trust` MUST be one of `system_asserted`, `derived`, `untrusted_input`, or `unknown`.

### 18.3 Canonical Diagnostic Entry

Each `diagnostics` item MUST contain:

| Field | Type | Description |
|---|---|---|
| `diagnostic_index` | integer | Deterministic sequence index |
| `timestamp` | string | RFC 3339 UTC timestamp |
| `code` | string | Diagnostic code |
| `level` | string or null | `debug`, `info`, `warn`, `error`, or `null` |
| `message` | string | Diagnostic message |
| `related_kind` | string or null | Related event kind |
| `related_trace_id` | string or null | Related trace identifier |
| `details` | object | Shallow diagnostic details |
| `trust` | string | Trust class from Section 17.5 |
| `source_file` | string | Source file path label |
| `source_line` | integer | 1-based source line number |

`diagnostic_index` MUST start at `0` and increment by `1` in emitted order.
`trust` MUST be one of `system_asserted`, `derived`, `untrusted_input`, or `unknown`.

### 18.4 Canonical Uncertainty Entry

Each `uncertainty` item MUST contain:

| Field | Type | Description |
|---|---|---|
| `code` | string | Uncertainty code from Section 17.4 or extension namespace |
| `severity` | string | `info`, `warn`, or `error` |
| `message` | string | Human-readable summary |
| `related_event_index` | integer or null | Related event index when known |
| `related_diagnostic_index` | integer or null | Related diagnostic index when known |

### 18.5 Deterministic Serialization Guidance

The canonical summary is a data model; JSON object member order is not semantically significant.

For reproducible prompt and fixture output, implementations SHOULD serialize summaries deterministically by:

- Emitting top-level keys in lexicographic order.
- Preserving array order from Section 17.7.
- Emitting object keys within `attributes`, `details`, and `entities` in lexicographic order.

### 18.6 Required Schema Artifact

The file `contracts/agent-telemetry/v1/schema/trace-summary.schema.json` MUST validate the summary object defined in this section.
