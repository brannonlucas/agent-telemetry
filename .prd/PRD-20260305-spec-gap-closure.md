# PRD: Agent Telemetry Spec Gap Closure

**Status:** COMPLETE
**Created:** 2026-03-05
**Target Version:** 0.6.0 (wire breaks) → 0.7.0 (behavioral breaks) → 1.0.0 (stable)
**Spec Version:** 1.0.0-draft

---

## Context

Audit identified 23 gaps between the Agent Telemetry Specification v1 and the
current implementation (v0.5.0). This PRD defines the phased execution plan to
reach full spec conformance.

Since the package is pre-1.0, semver permits breaking changes in minor bumps.
All wire-format breaks ship together in 0.6.0 to minimize churn.

---

## Phase 1 — Wire Format Breaking Changes (0.6.0)

**Goal:** Fix every wire-format MUST violation in one atomic release.

**Rationale:** These changes alter the shape of emitted JSONL records and the
`_trace` continuation envelope. Shipping them together means consumers only
adapt once.

### 1A. `_trace` Continuation Envelope

**Finding:** Implementation uses `{ _trace: { trace_id, parent_span_id, trace_flags } }`.
Spec Section 8.1 requires `{ _trace: { traceparent: "00-...-...-01" } }`.

**Changes:**

| File | Change |
|---|---|
| `src/types.ts` | Redefine `TraceContext` to `{ traceparent: string; tracestate?: string }`. Remove `trace_id`, `parent_span_id`, `trace_flags` from `TraceContext`. |
| `src/types.ts` | `TraceContextCarrier._trace` value type becomes `{ traceparent: string; tracestate?: string }`. |
| `src/adapters/hono.ts` | `getTraceContext()` calls `formatTraceparent(traceId, spanId, traceFlags)` and returns `{ _trace: { traceparent } }`. |
| `src/adapters/express.ts` | Same as Hono. |
| `src/adapters/fastify.ts` | Same as Hono. |
| `src/adapters/next.ts` | Same as Hono. |
| `src/adapters/inngest.ts` | **Reading:** Parse `_trace.traceparent` via `parseTraceparent()` instead of reading `.trace_id` / `.parent_span_id`. |
| `src/adapters/inngest.ts` | **Writing:** `(data)._trace = { traceparent: formatTraceparent(trace_id, dispatch_span_id, flags) }`. |
| `src/browser.ts` | `getTraceContext()` returns `{ trace_id, parent_span_id, trace_flags }` for internal state — but `_trace` carrier uses `{ traceparent }`. Update `BrowserTraceContext.getTraceContext()` to return a `traceparent` string or keep separate internal API. |

**Design Decision:** The internal `BrowserTraceContext` state can stay decomposed (trace_id, parent_span_id, trace_flags) since that's not a wire type. Only `TraceContextCarrier` (the `_trace` envelope for dispatch payloads) must use the formatted `traceparent` string.

**Test updates:**
- `tests/adapters/inngest.test.ts` — all `_trace` assertions switch to `{ traceparent: "00-..." }`.
- `tests/adapters/express.test.ts`, `hono.test.ts`, `fastify.test.ts`, `next.test.ts` — `getTraceContext()` return shape changes.
- `tests/trace-linking.test.ts` — verify causal chain still works through new envelope format.

**Backward compatibility:** The Inngest adapter MUST detect the old decomposed
`_trace` format (`{ trace_id, parent_span_id }`) during the 0.6.x window. When
detected, it MUST parse it successfully AND emit a diagnostic with code
`writer.trace_envelope_deprecated`. This compat shim is removed in 0.7.0.

**Acceptance criteria:**
- [ ] `_trace.traceparent` is a valid W3C traceparent string in all adapters
- [ ] `TraceContext` type supports optional `tracestate` field (functional passthrough is Phase 3)
- [ ] Inngest adapter parses `_trace.traceparent` on receive
- [ ] Inngest adapter parses old decomposed `_trace` format with deprecation diagnostic
- [ ] Inngest adapter writes `_trace.traceparent` on dispatch
- [ ] All `getTraceContext()` functions return `{ _trace: { traceparent: "..." } }`
- [ ] Round-trip test: dispatch → receive → verify trace_id and parent linkage preserved
- [ ] Old-format compat test: decomposed `_trace` still links correctly + diagnostic emitted

---

### 1B. Job Event Field Renames

**Finding:** Types use `function_id` / `event_name` / `run_id`. Spec uses
`task_name` / `task_id` / `queue` / `attempt`.

**Changes:**

| File | Change |
|---|---|
| `src/types.ts` `JobStartEvent` | `function_id: string` → `task_name: string`. `run_id?: string` → `task_id?: string`. Add `queue?: string`, `attempt?: number`. |
| `src/types.ts` `JobEndEvent` | Same renames as JobStartEvent. Add `queue?: string`, `attempt?: number`. |
| `src/types.ts` `JobDispatchEvent` | `event_name: string` → `task_name: string`. `outcome?: ...` → `outcome: ...` (make required). Add `task_id?: string`, `queue?: string`, `attempt?: number`. |
| `src/adapters/inngest.ts` | `function_id` → `task_name` (value: `fn.id("")`). `run_id` → `task_id` (value: `ctx.runId`). Add `outcome: "success"` to dispatch events. |
| All job tests | Update field name assertions. |

**Acceptance criteria:**
- [ ] `JobStartEvent`, `JobEndEvent`, `JobDispatchEvent` types use spec field names
- [ ] Wire output contains `task_name`, not `function_id` or `event_name`
- [ ] Wire output contains `task_id`, not `run_id`
- [ ] `job.dispatch` events always include `outcome` field
- [ ] Optional `queue` and `attempt` fields available on all three event types

---

### 1C. `external.call` Outcome for 5xx

**Finding:** Fetch adapter sets `outcome: "success"` for all HTTP responses.
Spec Section 7.8: MUST be `error` for 5xx.

**Changes:**

| File | Change |
|---|---|
| `src/adapters/fetch.ts` | After `const response = await baseFetch(...)`, derive outcome: `response.status >= 500 ? "error" : "success"`. Use `httpOutcome()` from error.ts. |
| `src/adapters/supabase.ts` | Same fix for `external.call` events (PostgREST `db.query` events can keep the current behavior since `db.query` outcome rules differ — db adapters determine outcome by exception, not status). For `external.call`, apply `httpOutcome(response.status)`. |

**Decision — Supabase `db.query` outcome:** PostgREST HTTP errors ARE query
failures (constraint violations, missing tables, etc.). Supabase `db.query`
events use `response.ok ? "success" : "error"` — non-2xx means the query
failed at the database level, regardless of transport semantics.

**Acceptance criteria:**
- [ ] Fetch adapter: HTTP 500+ responses get `outcome: "error"`
- [ ] Fetch adapter: HTTP 1xx-4xx responses get `outcome: "success"`
- [ ] Supabase adapter: `external.call` events use `httpOutcome()` for status-based outcome
- [ ] Network failures still produce `outcome: "error"` (already correct)
- [ ] Tests verify 5xx → error, 2xx → success, network fail → error

---

### 1D. `emit()` Runtime Safety

**Finding:** `emit()` doesn't inject `record_type` or `spec_version`.

**Change:**

| File | Change |
|---|---|
| `src/index.ts` | In `emit()`, always set `record_type: "event"` and `spec_version: 1` on the merged record, after the spread. This makes them immune to caller omission. |

```ts
const record = {
  ...event,
  record_type: "event" as const,
  spec_version: 1 as const,
  timestamp: event.timestamp ?? new Date().toISOString(),
};
```

**Acceptance criteria:**
- [ ] `emit()` always produces records with `record_type: "event"` and `spec_version: 1`
- [ ] Test: emit a plain object missing both fields → verify they appear in output
- [ ] Existing adapter-set values are harmlessly overwritten (no conflict)

---

### 1E. Release 0.6.0

- Bump `package.json` version to 0.6.0
- All tests pass
- CHANGELOG documents every breaking change
- Migration guide section in README

---

## Phase 2 — Type System & Schema Hardening (0.6.1)

**Goal:** Align types and runtime behavior with spec. No behavior-breaking
changes — only type narrowing, additive fields, and documentation.

### 2A. DiagnosticRecord Improvements

| Change | Detail |
|---|---|
| Add `level` field | `level?: "debug" \| "info" \| "warn" \| "error"` to `DiagnosticRecord` in `types.ts`. |
| Constrain `details` to shallow | Change `details?: Record<string, unknown>` to `details?: Record<string, string \| number \| boolean \| null>` in both `types.ts` and `writer.ts`. |
| Emit `level` in `makeDiagnostic` | Add `level` parameter to `makeDiagnostic()`. Use appropriate defaults: `event_dropped_oversize` → `warn`, `writer_fallback_activated` → `error`, etc. |

**Acceptance criteria:**
- [ ] `DiagnosticRecord` type includes `level` field
- [ ] `details` type rejects nested objects at compile time
- [ ] Writer's `makeDiagnostic()` emits `level` on all diagnostic records
- [ ] Level values match spec Section 17.4 severity defaults

### 2B. `kind` Runtime Validation (WARNING ONLY)

| File | Change |
|---|---|
| `src/index.ts` | Add `kind` validation in `emit()`. If `kind` doesn't match `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`, emit a diagnostic warning but STILL emit the event. This is non-breaking — events are never silently dropped by this validation. |

**Rationale:** Dropping events silently would be a behavior-breaking change
(finding F2). The spec says `kind` MUST match the grammar, but the enforcement
mechanism should be a diagnostic + TypeScript narrowing, not silent rejection.
Silent rejection moves to Phase 3 (0.7.0) alongside other behavior breaks.

**Acceptance criteria:**
- [ ] Invalid `kind` values emit a diagnostic warning
- [ ] Invalid `kind` values still emit the event (non-breaking)
- [ ] Valid custom kinds (e.g. `acme.cache_hit`) pass silently
- [ ] Reserved namespace kinds (`http.request`, `db.query`, etc.) pass silently

### 2C. Entity Key Convention

**Change:** Add a runtime warning (diagnostic) when entity keys don't match `^[a-z][a-z0-9_]*$`. Don't block emission — the spec says SHOULD, not MUST.

**Acceptance criteria:**
- [ ] Entity keys matching pattern pass silently
- [ ] Non-matching keys (e.g. `userId`) still emit but with a diagnostic in dev mode

### 2D. Trace Flags Default

**Change in `src/traceparent.ts`:** `formatTraceparent` default flags should be `"00"` unless the caller explicitly passes `"01"`. The spec says producers SHOULD default to `01` only when actively recording, otherwise `00`.

Since this library IS actively recording when `formatTraceparent` is called from an adapter, the current `"01"` default is actually correct for adapters. But external callers may not be recording. Add a JSDoc note clarifying this semantic.

**Acceptance criteria:**
- [ ] JSDoc on `formatTraceparent` explains when to use `"01"` vs `"00"`
- [ ] No behavior change needed (current default is correct for recording producers)

---

## Phase 3 — Behavioral Default Changes (0.7.0)

**Goal:** Ship all remaining behavior-breaking default changes in one release.
These change observable behavior but NOT the JSONL record schema.

Changes in this phase that are breaking:
- Meta tag name default (`traceparent` → `agent-telemetry-traceparent`)
- Response adoption default (`true` → `false`)
- `kind` validation promoted from warning (Phase 2B) to silent rejection
- Old `_trace` decomposed format compat shim removed (added in Phase 1A)

Changes in this phase that are additive (non-breaking):
- `tracestate` passthrough (new capability, no existing behavior altered)

### 3A. Meta Tag Name

**Change in `src/browser.ts`:** Default `metaName` from `"traceparent"` to `"agent-telemetry-traceparent"`.

```ts
const metaName = options.metaName ?? "agent-telemetry-traceparent";
```

Also support reading `agent-telemetry-tracestate`:
```ts
const metaTraceparent = readMetaTraceparent("agent-telemetry-traceparent");
const metaTracestate = readMetaContent("agent-telemetry-tracestate");
```

**Acceptance criteria:**
- [ ] Default meta tag name is `agent-telemetry-traceparent`
- [ ] `agent-telemetry-tracestate` meta tag is read when present
- [ ] Custom `metaName` option still works for backwards compatibility
- [ ] Test: meta tag bootstrap with spec-compliant tag names

### 3B. Response Adoption Default

**Change in `src/browser.ts`:** `updateContextFromResponse = false`

**Acceptance criteria:**
- [ ] Response adoption disabled by default
- [ ] Explicitly setting `updateContextFromResponse: true` still works
- [ ] Test: verify no response header adoption without opt-in

### 3C. `kind` Validation Promotion

**Change:** Promote `kind` validation from warning-only (Phase 2B) to silent
rejection. Events with invalid `kind` values are now dropped with a diagnostic.

**Acceptance criteria:**
- [ ] Invalid `kind` values are silently dropped
- [ ] A diagnostic record is emitted for each dropped event
- [ ] Valid kinds pass through unchanged

### 3D. Remove Old `_trace` Compat Shim

**Change:** Remove the decomposed `_trace` format detection added in Phase 1A.
Only `_trace.traceparent` is accepted from 0.7.0 onward.

**Acceptance criteria:**
- [ ] Old `{ _trace: { trace_id, parent_span_id } }` format is ignored (treated as no context)
- [ ] No deprecation diagnostic emitted (shim removed entirely)

### 3E. `tracestate` Passthrough

**Changes across all adapters:**

| File | Change |
|---|---|
| `src/trace-context.ts` | Add `tracestate?: string` to `SpanContext`. Populate from parsed traceparent's accompanying `tracestate` header. |
| HTTP adapters (express, fastify, hono, next) | Read `tracestate` request header. Store alongside trace context. Include in response headers when present. Include in `_trace.tracestate` via `getTraceContext()`. |
| `src/browser.ts` | Read `tracestate` in bootstrap. Pass through in fetch requests. |
| `src/adapters/inngest.ts` | Read `_trace.tracestate`. Propagate on dispatch. |

**Acceptance criteria:**
- [ ] `tracestate` is read from incoming HTTP requests
- [ ] `tracestate` is included in `_trace` carrier when present
- [ ] `tracestate` is injected into outgoing fetch requests when present
- [ ] `tracestate` discarded when no valid `traceparent` exists (spec §7.4)
- [ ] Test: round-trip tracestate through HTTP → dispatch → receive

---

## Phase 4 — File Profile Alignment (0.7.0)

### 4A. Session Directory Structure

**Changes:**

| File | Change |
|---|---|
| `src/writer.ts` | New `resolveOutputPath()` function implementing discovery order: 1. Explicit config, 2. `AGENT_TELEMETRY_FILE` env var, 3. `AGENT_TELEMETRY_DIR` env var, 4. `{project_root}/.agent-telemetry/{session_id}/`. |
| `src/writer.ts` | `session_id` defaults to `Date.now().toString(36)` generated once per writer creation. Configurable via `TelemetryConfig.sessionId`. |
| `src/writer.ts` | Filename defaults to `{role}-{pid}.jsonl` where `role` comes from config (default: `"server"`) and `pid` from `process.pid`. |
| `src/types.ts` | Add `sessionId?: string`, `role?: string` to `TelemetryConfig`. |

**Project root detection:** Walk up from `cwd()` looking for `.git`, `package.json`, or `deno.json`. Fall back to `cwd()`.

**Acceptance criteria:**
- [ ] Default output path is `{project_root}/.agent-telemetry/{session_id}/{role}-{pid}.jsonl`
- [ ] `AGENT_TELEMETRY_FILE` overrides to single-file mode
- [ ] `AGENT_TELEMETRY_DIR` overrides directory
- [ ] Explicit `logDir`/`filename` config still works (highest priority)
- [ ] `.gitignore` in `.agent-telemetry/` created automatically
- [ ] Tests verify discovery order

### 4B. File Permissions

**Change in `src/writer.ts`:** After creating the log directory, explicitly
`chmod` to restrict access. `mkdir`'s `mode` option is umask-dependent and
does not apply to existing directories, so an explicit `chmod` is required.

```ts
await fsPromises.mkdir(logDir, { recursive: true });
try {
  await fsPromises.chmod(logDir, 0o700);
} catch {
  // chmod unsupported (Windows, some containers) — not fatal
}

// After first file write:
try {
  await fsPromises.chmod(logFile, 0o600);
} catch {
  // chmod unsupported — not fatal
}
```

**Acceptance criteria:**
- [ ] Directory is not world-readable after creation (on POSIX: `mode & 0o077 === 0`)
- [ ] Files are not world-readable after creation (on POSIX: `mode & 0o077 === 0`)
- [ ] `chmod` failure does not crash or prevent telemetry (never-crash boundary)
- [ ] Test on POSIX: verify `stat().mode` has no group/other bits set
- [ ] Test on Windows (or mock): verify `chmod` failure is silently caught

### 4C. Path Sanitization Hook

**Change in `src/types.ts`:**
```ts
export interface TelemetryConfig {
  // ... existing fields ...
  /** Optional path sanitizer. Receives raw path, returns sanitized path. */
  sanitizePath?: (path: string) => string;
}
```

Used in HTTP adapters before setting `path` on the event.

**Acceptance criteria:**
- [ ] `sanitizePath` hook called before path enters event record
- [ ] Default behavior (no hook) preserves existing path behavior
- [ ] Test: custom sanitizer replaces UUIDs with `:id`

---

## Phase 5 — Truncation Engine (0.7.1)

### 5A. Core Truncation Function

**New file: `src/truncate.ts`**

```ts
const TRUNCATION_SUFFIX = "...[truncated]";
const SUFFIX_BYTES = Buffer.byteLength(TRUNCATION_SUFFIX); // 14

/**
 * Find the largest valid UTF-8 boundary at or before `maxBytes`.
 *
 * Walks backward from the cut point past any continuation bytes (10xxxxxx),
 * then checks whether the lead byte's full sequence fits. If not, excludes
 * the partial sequence entirely. This guarantees:
 *   - No U+FFFD replacement characters
 *   - Output byte length <= maxBytes
 *   - No split multi-byte code points
 */
function findUtf8Boundary(bytes: Uint8Array, maxBytes: number): number {
  if (maxBytes >= bytes.length) return bytes.length;
  let i = maxBytes;
  // Walk backward past continuation bytes (10xxxxxx pattern)
  while (i > 0 && (bytes[i] & 0xc0) === 0x80) i--;
  // i is now at a lead byte (or 0). Determine sequence length.
  if (i > 0 || (bytes[0] & 0x80) === 0) {
    const lead = bytes[i];
    let seqLen = 1;
    if ((lead & 0xe0) === 0xc0) seqLen = 2;
    else if ((lead & 0xf0) === 0xe0) seqLen = 3;
    else if ((lead & 0xf8) === 0xf0) seqLen = 4;
    // If the full sequence doesn't fit, exclude it
    if (i + seqLen > maxBytes) return i;
    return i + seqLen;
  }
  return 0;
}

export function truncateField(value: string, maxBytes: number): string {
  // Fast path: ASCII-only strings where length === byte length
  if (value.length <= maxBytes) return value;

  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) return value;

  if (maxBytes <= SUFFIX_BYTES) {
    return TRUNCATION_SUFFIX.slice(0, maxBytes);
  }

  const keepBytes = maxBytes - SUFFIX_BYTES;
  const boundary = findUtf8Boundary(encoded, keepBytes);
  return encoded.slice(0, boundary).toString("utf8") + TRUNCATION_SUFFIX;
}
```

**Correctness guarantee:** `findUtf8Boundary` never cuts inside a multi-byte
sequence. It walks backward past continuation bytes, identifies the lead byte,
computes the expected sequence length, and excludes the sequence if it would
exceed the budget. No `TextDecoder` with replacement characters. Output byte
length is always `<= maxBytes`.

### 5B. Field Limit Map

**New file: `src/limits.ts`**

Exports field limit constants matching Section 17.6 table:
```ts
export const FIELD_LIMITS: Record<string, number> = {
  "kind": 64,
  "error_name": 120,
  "http.request.path": 1024,
  "http.request.route": 256,
  // ... all limits from spec
  "_default": 256,
};
```

### 5C. Integration

Apply truncation in `emit()` before serialization. Track truncation count per-session for future summary metadata.

**Acceptance criteria:**
- [ ] Truncation suffix is exactly `...[truncated]`
- [ ] Truncation is deterministic (same input → same output)
- [ ] UTF-8 safe (no split multi-byte characters)
- [ ] `trace_id`, `span_id`, `parent_span_id` are never truncated
- [ ] Test: field at exactly max_bytes passes through unchanged
- [ ] Test: field at max_bytes + 1 gets truncated
- [ ] Test: multi-byte UTF-8 character at boundary handled correctly
- [ ] Test: max_bytes < suffix length edge case

---

## Phase 6 — Consumer Implementation (0.8.0)

### 6A. JSONL Parser

**New file: `src/consumer/parser.ts`**

- Read `.jsonl` files line by line
- Skip malformed lines (emit diagnostic count)
- Validate `record_type` and `spec_version`
- Ignore unknown fields
- Ignore unknown event kinds
- Support both single-file and directory mode
- Deterministic file discovery (lexicographic)

### 6B. Trace Reconstructor

**New file: `src/consumer/reconstructor.ts`**

- Group events by `trace_id`
- Build parent-child tree from `span_id` / `parent_span_id`
- Identify root spans (no parent_span_id)
- Handle missing parents gracefully (orphan spans become roots)
- Timestamp-based ordering within traces (not authoritative for causality)

### 6C. Entity Pivoting

- Aggregate `entities` across events
- Index by entity key for domain queries ("all events for user X")

**Acceptance criteria:**
- [ ] Parser handles: valid records, malformed lines, unknown fields, unknown kinds, mixed types
- [ ] Reconstructor builds correct span trees
- [ ] Missing parents produce orphan roots (not crashes)
- [ ] Multi-file merge preserves per-file order
- [ ] Entity index supports lookup by key and value

---

## Phase 7 — Agent Consumption Profile (0.9.0)

### 7A. Consumer Pipeline (Section 17.2)

Six-stage pipeline: parse → validate → normalize → reconstruct → uncertainty → summary

### 7B. Uncertainty Model (Section 17.4)

Emit uncertainty entries for:
- `malformed_line_skipped` (warn)
- `missing_parent_span` (warn)
- `dropped_oversize_record` (warn)
- `writer_fallback_active` (error)
- `projection_lossy_mapping` (warn)
- `unknown_kind_ignored` (info)

### 7C. Trust Classification (Section 17.5)

Assign trust class per event:
- `system_asserted`: IDs, timestamps
- `untrusted_input`: path, entities, error_name, diagnostic.message
- `derived`: computed fields
- `unknown`: unclassifiable

### 7D. Canonical Summary (Section 18)

Produce `trace_summary` object with:
- All required top-level fields
- Canonical event entries with `event_index`, `attributes`, `trust`, `source_file`, `source_line`
- Canonical diagnostic entries
- Canonical uncertainty entries
- Deterministic serialization (lexicographic key order)
- Entity aggregation (unique sorted values)

### 7E. Prompt-Safe Output (Section 17.8)

- Escape control characters in all string fields
- Delimit values as JSON strings
- Include trust/uncertainty metadata

**Acceptance criteria:**
- [ ] Pipeline is deterministic (identical input → identical output bytes)
- [ ] Summary matches Section 18 schema exactly
- [ ] Uncertainty entries emitted for all six reserved codes when conditions occur
- [ ] Trust classification defaults match spec guidance
- [ ] Prompt output escapes control characters
- [ ] Field limits from Phase 5 enforced before summary emission
- [ ] `truncation_count` in summary metadata is accurate

---

## Phase 8 — Contract Pack & Conformance Fixtures (0.9.1)

### 8A. Contract Pack (Section 17.9)

Create `contracts/agent-telemetry/v1/` with all required artifacts:

| Artifact | Purpose |
|---|---|
| `manifest.json` | Version, paths, SHA-256 hashes |
| `schema/event.base.schema.json` | Base event JSON Schema |
| `schema/diagnostic.schema.json` | Diagnostic JSON Schema |
| `schema/kinds/http.request.schema.json` | Per-kind schema |
| `schema/kinds/db.query.schema.json` | Per-kind schema |
| `schema/kinds/external.call.schema.json` | Per-kind schema |
| `schema/kinds/job.dispatch.schema.json` | Per-kind schema |
| `schema/kinds/job.start.schema.json` | Per-kind schema |
| `schema/kinds/job.end.schema.json` | Per-kind schema |
| `schema/trace-summary.schema.json` | Summary object schema |
| `limits.json` | Field byte limits |
| `enums.json` | outcome, level, trust, severity values |
| `regex.json` | kind, trace_id, span_id, diagnostic code patterns |
| `glossary.json` | Field semantic descriptions + inference constraints |
| `negative-vectors.json` | Invalid inputs for conformance testing |

### 8B. Conformance Fixtures (Section 15)

Create executable fixtures for each profile's minimum fixture set:

- Core: 13 fixture scenarios (Section 15.2)
- File: 8 fixture scenarios (Section 15.3)
- Browser: 5 fixture scenarios (Section 15.4)
- Async: 8 fixture scenarios (Section 15.5)
- Rotation: 4 fixture scenarios (Section 15.6)
- Agent Consumption: positive + negative vectors (Section 15.7)

**Acceptance criteria:**
- [ ] All contract pack artifacts present and valid JSON/JSON Schema
- [ ] `manifest.json` includes SHA-256 hashes for all artifacts
- [ ] All conformance fixtures pass against the implementation
- [ ] Negative vectors correctly rejected
- [ ] Schemas validate example records from spec Section 16.1

---

## Phase 9 — Conformance Declaration & Documentation (1.0.0)

### 9A. Conformance Statement

Add to `README.md` and `package.json`:

```
Profiles: Core, File, Browser, Async, Rotation, Agent Consumption
Roles: producer, writer, consumer
Spec Version: 1

Note: OTel Projection profile is NOT claimed at 1.0. It ships post-1.0.
```

### 9B. Migration Guide

Document all breaking changes from 0.5.0 → 1.0.0:

1. `_trace` envelope format change
2. Job event field renames
3. `external.call` outcome semantics for 5xx
4. Browser meta tag name change
5. Response adoption default change
6. File directory structure change

### 9C. API Documentation

- Public API surface documented
- Adapter-specific guides updated
- Examples updated to reflect spec-conformant usage

**Acceptance criteria:**
- [ ] README declares profiles and roles explicitly
- [ ] Migration guide covers every breaking change with before/after examples
- [ ] All examples in README produce spec-conformant output
- [ ] `package.json` keywords updated

---

## Release Schedule

| Version | Phase(s) | Type | Key Changes |
|---|---|---|---|
| **0.6.0** | 1 | **Breaking** | Wire format: `_trace` envelope, field renames, outcome fixes, emit safety |
| **0.6.1** | 2 | Additive | Type hardening, diagnostics, `kind` warning, entity key warning |
| **0.7.0** | 3, 4 | **Breaking** | Behavioral defaults: meta tag, response adoption, `kind` rejection, file paths, compat shim removal, tracestate passthrough |
| **0.7.1** | 5 | Additive | Truncation engine + field limits |
| **0.8.0** | 6 | Additive | Consumer implementation (`agent-telemetry/consumer` export) |
| **0.9.0** | 7 | Additive | Agent Consumption profile + canonical summary |
| **0.9.1** | 8 | Additive | Contract pack + conformance fixtures |
| **1.0.0** | 9 (docs) | **Stable** | Conformance declaration, migration guide, API docs |

**Removed from critical path:** OTel Projection (Phase 9 from original plan)
ships post-1.0 as an additive feature.

**Breaking change windows:** Only two — 0.6.0 (wire format) and 0.7.0
(behavioral defaults). Everything else is additive. After 1.0.0, semver
governs strictly.

---

## Risk Register

| Risk | Impact | Mitigation |
|---|---|---|
| `_trace` format change breaks Inngest users | High | Compat shim in 0.6.x detects old format + deprecation diagnostic. Removed in 0.7.0. |
| Field renames break JSONL consumers | High | Old data is development-time only — document "delete old logs" |
| Session directory changes break existing log paths | Medium | `logDir` override has highest priority. Old paths still work if configured. |
| Truncation changes determinism of existing tests | Low | Update test fixtures |
| Compat shim accumulates tech debt | Low | Hard removal deadline: 0.7.0. No extending. |
| Two breaking releases (0.6.0 + 0.7.0) fatigue users | Medium | Clear changelog + migration guide. Behavioral breaks are lower-impact than wire breaks. |

---

## Design Decisions (CLOSED)

1. **Supabase `db.query` outcome for HTTP errors:** DECIDED — non-2xx PostgREST
   responses produce `outcome: "error"`. PostgREST HTTP errors (400 constraint
   violations, 404 missing tables, 409 conflicts) are query failures regardless
   of transport layer. Implemented in Phase 1C.

2. **`_trace` backward compatibility period:** DECIDED — Inngest adapter accepts
   both old decomposed format and new `traceparent` format during 0.6.x with a
   deprecation diagnostic. Old format compat removed in 0.7.0 (Phase 3D).

3. **OTel Projection scope:** DECIDED — deferred past 1.0. The 1.0 release
   declares conformance for Core + File + Browser + Async + Rotation + Agent
   Consumption. OTel Projection ships as a post-1.0 additive feature. Phase 9
   is removed from the critical path.

4. **Consumer as separate export:** DECIDED — `import { ... } from
   'agent-telemetry/consumer'`. Keeps producer bundle small. Consumer adds
   `fs` + parsing dependencies that server-side producers don't need. Added to
   `package.json` exports in Phase 6.
