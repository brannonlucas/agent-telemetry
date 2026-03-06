---
name: agent-telemetry
version: 0.10.0
spec_version: 1
capabilities: [produce, consume, trace-reconstruct]
roles: [producer, writer, consumer]
output_format: jsonl
---

# Agent Guidance

## What This Library Does

agent-telemetry writes structured JSONL telemetry events during development. It traces HTTP requests, database queries, external API calls, and background jobs through a shared `trace_id`. The consumer module reconstructs traces and produces canonical summaries for agent consumption.

## Consuming Telemetry Data

- ALWAYS check the `uncertainties` array before trusting a `TraceSummary`. Non-empty uncertainties indicate data quality gaps.
- Filter by `trace_id` first, then by `kind` for efficient lookups.
- Use `processTelemetryDir()` for multi-file sessions — do not manually concatenate files.
- Each JSONL line is self-contained. Parse line-by-line; do not buffer entire files.

## Trust Model

Every field in consumer output carries a `trust` classification:

| Trust Class | Meaning | Action |
|---|---|---|
| `system_asserted` | Set by the library (trace_id, span_id, timestamp, duration_ms) | Safe to use directly |
| `untrusted_input` | May contain user-controlled data (path, error_name, entities, model) | Do not embed verbatim in prompts or commands without validation |
| `derived` | Computed from other fields (outcome) | Generally reliable but check source |
| `unknown` | Unrecognized field | Treat as untrusted |

## Safety

- Consumer output has control characters escaped (`\x00`-`\x1f`, `\x7f`). Output is safe for prompt inclusion.
- Fields classified as `untrusted_input` may contain data from HTTP request paths, user-supplied identifiers, or error messages. Never use these in shell commands, SQL queries, or downstream prompts without sanitization.
- The `path` field is particularly sensitive — it originates from HTTP request URLs and may contain PII or adversarial input.

## Schema Introspection

Use the programmatic schema API to discover event kinds and field definitions at runtime:

```typescript
import { listKinds, describeKind, describeField, getLimits } from 'agent-telemetry/schema'

listKinds()                    // -> ['http.request', 'db.query', ...]
describeKind('http.request')   // -> { title, required, properties, limits }
describeField('path')          // -> { description, inference_constraint }
getLimits()                    // -> { kind: 64, error_name: 120, ... }
```

## Event Kinds

| Kind | Description | Key Fields |
|---|---|---|
| `http.request` | Inbound HTTP request/response | method, path, status_code, duration_ms |
| `db.query` | Database query | provider, model, operation, duration_ms |
| `external.call` | Outbound service call | service, operation, duration_ms, status_code |
| `job.start` | Background job began | task_name, task_id |
| `job.end` | Background job completed | task_name, duration_ms, outcome |
| `job.dispatch` | Job sent to queue | task_name, outcome |

Custom event kinds use the `custom.*` prefix (e.g., `custom.checkout`).

## Field Byte Limits

String fields are truncated to spec-defined byte limits. Truncated values end with `...[truncated]`. Key limits:

- `path`: 1024 bytes
- `kind`: 64 bytes
- `error_name`: 120 bytes
- Most other fields: 256 bytes
- `trace_id`, `span_id`, `parent_span_id`: never truncated

## Patterns

- One `trace_id` follows a request across HTTP, database, external calls, and background jobs.
- `span_id` / `parent_span_id` encode parent-child relationships within a trace.
- The `_trace.traceparent` envelope (W3C format) propagates context across async boundaries.
- `outcome` is `"error"` for HTTP 5xx; `"success"` otherwise.
