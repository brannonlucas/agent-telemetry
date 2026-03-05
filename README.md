# agent-telemetry

Lightweight JSONL telemetry for easier AI agent consumption. Zero runtime dependencies.

Writes structured telemetry events to rotating JSONL files in development. Falls back to `console.log` in runtimes without filesystem access (Cloudflare Workers). Includes framework adapters for Hono, Inngest, Express, Fastify, Next.js, Prisma, Supabase, a generic traced fetch wrapper, and browser trace-context helpers.

## Spec Conformance

This package implements the [Agent Telemetry Specification v1](./agent-telemetry-spec.md).

| Profile | Status |
|---------|--------|
| Core | Conformant |
| File | Conformant |
| Browser | Conformant |
| Async | Conformant |
| Rotation | Conformant |
| Agent Consumption | Conformant |
| OTel Projection | Not claimed (planned post-1.0) |

**Roles:** producer, writer, consumer

All emitted records include `record_type: "event"`, `spec_version: 1`, and an ISO 8601 `timestamp`. Field names use `snake_case` to match the spec wire format. The `_trace` continuation envelope uses the W3C `traceparent` string format.

## Install

```bash
bun add agent-telemetry
```

> **Node.js users:** This package ships TypeScript source (no build step). You'll need a bundler that handles `.ts` imports (esbuild, tsup, Vite, etc.).

## Demo App

This repo includes a runnable browser-to-backend demo in [`demo/`](./demo).

```bash
bun run demo
```

Then open [http://localhost:3001](http://localhost:3001) and click **Run Demo Request**.
Telemetry is written to `.agent-telemetry/{session}/server-{pid}.jsonl` by default.
The demo emits correlated `http.request`, `db.query`, and `external.call` events.
The demo page includes a built-in Recent Telemetry panel and a temporal trace timeline view, and you can follow logs with `bun run demo:tail`.
The timeline uses configurable synthetic delays so spans are easier to distinguish visually.
The demo binds to `127.0.0.1` by default; set `DEMO_HOST=0.0.0.0` if you explicitly want LAN access.

## Quick Start

```typescript
import { createTelemetry, type PresetEvents } from 'agent-telemetry'

// createTelemetry is async (one-time runtime probe). The returned emit() is synchronous.
const telemetry = await createTelemetry<PresetEvents>()

telemetry.emit({
  kind: 'http.request',
  trace_id: generateTraceId(),
  span_id: generateSpanId(),
  method: 'GET',
  path: '/api/health',
  status_code: 200,
  outcome: 'success',
  duration_ms: 12,
})
```

Each call to `emit()` appends a JSON line to `.agent-telemetry/{session}/server-{pid}.jsonl` with auto-injected `record_type`, `spec_version`, and `timestamp`:

```jsonl
{"kind":"http.request","trace_id":"0a1b2c3d4e5f67890a1b2c3d4e5f6789","span_id":"a1b2c3d4e5f67890","method":"GET","path":"/api/health","status_code":200,"outcome":"success","duration_ms":12,"record_type":"event","spec_version":1,"timestamp":"2026-02-24T21:00:00.000Z"}
```

## How It Works

The library connects every layer of your stack through a shared `trace_id`:

```
Inbound HTTP  ->  Database Queries  ->  External API Calls  ->  Background Jobs
  Hono            Prisma               Traced Fetch           Inngest
  Express         Supabase (PostgREST)  Supabase (auth/
  Fastify                                storage/functions)
  Next.js
```

One `trace_id` follows a request from the HTTP boundary through database queries, external API calls, and into background job execution. `span_id`/`parent_span_id` fields preserve parent-child relationships inside that trace. HTTP adapters use the [W3C `traceparent`](https://www.w3.org/TR/trace-context/) header for propagation, enabling interop with OpenTelemetry and other standards-compliant tools. Query your JSONL logs by `trace_id` to see the full chain.

## Full-Stack Example

Create **one** telemetry instance and share it across adapters:

```typescript
// lib/telemetry.ts
import { createTelemetry, type PresetEvents } from 'agent-telemetry'

export const telemetry = await createTelemetry<PresetEvents>()
```

```typescript
// server.ts
import { Hono } from 'hono'
import { Inngest } from 'inngest'
import { createHonoTrace, getTraceContext } from 'agent-telemetry/hono'
import { createInngestTrace } from 'agent-telemetry/inngest'
import { telemetry } from './lib/telemetry'

// --- Background job tracing (define client before use) ---
const inngestTrace = createInngestTrace({
  telemetry,
  entityKeys: ['userId'],
})

const inngest = new Inngest({ id: 'my-app', middleware: [inngestTrace] })

// --- HTTP tracing ---
const trace = createHonoTrace({
  telemetry,
  entityPatterns: [
    { segment: 'users', key: 'userId' },
  ],
})

const app = new Hono()
app.use('*', trace)

// Propagate trace context into background job dispatch
app.post('/api/users/:id/process', async (c) => {
  await inngest.send({
    name: 'app/user.process',
    data: { userId: c.req.param('id'), ...getTraceContext(c) },
  })
  return c.json({ ok: true })
})
```

The `getTraceContext(c)` call spreads `{ _trace: { traceparent: "00-..." } }` into the dispatch payload. The Inngest middleware reads `_trace.traceparent` on the receiving end to continue the trace.

This produces a correlated trace:
```jsonl
{"kind":"http.request","trace_id":"aabb...","span_id":"cc11...","method":"POST","path":"/api/users/550e8400-e29b-41d4-a716-446655440000/process","status_code":200,"outcome":"success","duration_ms":45,"entities":{"userId":"550e8400-..."},"record_type":"event","spec_version":1,"timestamp":"..."}
{"kind":"job.dispatch","trace_id":"aabb...","span_id":"dd11...","parent_span_id":"cc11...","task_name":"app/user.process","outcome":"success","record_type":"event","spec_version":1,"timestamp":"..."}
{"kind":"job.start","trace_id":"aabb...","span_id":"ee22...","parent_span_id":"dd11...","task_name":"my-app/process-user","task_id":"run-abc","record_type":"event","spec_version":1,"timestamp":"..."}
{"kind":"job.end","trace_id":"aabb...","span_id":"ee22...","task_name":"my-app/process-user","task_id":"run-abc","duration_ms":230,"outcome":"success","record_type":"event","spec_version":1,"timestamp":"..."}
```

All four events share the same `trace_id`. Filter with `jq 'select(.trace_id == "aabb...")'` to see the full chain.

## Custom Events

Extend the type system with your own event kinds:

```typescript
import { createTelemetry, type HttpEvents, type JobEvents } from 'agent-telemetry'

type MyEvents = HttpEvents | JobEvents | {
  kind: 'custom.checkout'
  trace_id: string
  span_id: string
  orderId: string
  amount: number
}

const telemetry = await createTelemetry<MyEvents>()

telemetry.emit({
  kind: 'custom.checkout',
  trace_id: 'abc'.repeat(10) + 'ab',
  span_id: 'def'.repeat(5) + 'd',
  orderId: 'order-abc',
  amount: 4999,
})
```

Custom event kinds must use `custom.*` prefix (e.g. `custom.checkout`, `custom.cache_hit`).

## Hono Adapter

```typescript
import { createHonoTrace, getTraceContext } from 'agent-telemetry/hono'

const trace = createHonoTrace({
  telemetry,
  entityPatterns: [            // Extract entity IDs from URL path segments
    { segment: 'users', key: 'userId' },
    { segment: 'posts', key: 'postId' },
  ],
  sanitizePath: (path) =>      // Optional: sanitize paths before emission
    path.replace(/[0-9a-f-]{36}/gi, ':id'),
  isEnabled: () => true,       // Guard function (default: () => true)
})

app.use('*', trace)
```

The middleware:
- Parses the incoming W3C `traceparent` header, or generates a fresh trace ID if absent/invalid
- Sets `traceparent` on the response for client-side correlation (format: `00-{traceId}-{spanId}-01`)
- Emits `http.request` events with method, path, status_code, outcome, duration, extracted entities, and span linkage (`span_id`, `parent_span_id`)
- Extracts entity IDs from URL paths -- looks for a matching `segment`, then checks if the next segment is a UUID
- `outcome` is `"error"` for HTTP 5xx, `"success"` otherwise

`getTraceContext(c)` returns `{ _trace: { traceparent: "00-..." } }` for spreading into dispatch payloads. Returns `{}` if no trace middleware is active.

## Inngest Adapter

```typescript
import { createInngestTrace } from 'agent-telemetry/inngest'

const trace = createInngestTrace({
  telemetry,
  name: 'my-app/trace',               // Middleware name (default: 'agent-telemetry/trace')
  entityKeys: ['userId', 'orderId'],   // Keys to extract from event.data (default: [])
})

const inngest = new Inngest({ id: 'my-app', middleware: [trace] })
```

The middleware:
- Emits `job.start` and `job.end` events for function lifecycle (with duration and error tracking)
- Emits `job.dispatch` events for outgoing event sends (with `outcome: "success"`)
- Reads trace context from `_trace.traceparent` in `event.data` (set by `getTraceContext()` at the dispatch site)
- Generates a new `trace_id` when no `_trace` is present, so every function run is always traceable
- Uses spec field names: `task_name` (function ID), `task_id` (run ID)

## Fetch Adapter

Wraps any `fetch` call with telemetry. Does not monkey-patch the global -- returns a new function with identical semantics.

```typescript
import { createTracedFetch } from 'agent-telemetry/fetch'

const fetch = createTracedFetch({
  telemetry,
  baseFetch: globalThis.fetch,       // Optional -- default: globalThis.fetch
  getTraceContext: () => ctx,         // Optional -- correlate with parent request
  propagateTo: (url) => url.origin === 'https://api.my-app.com', // Optional header allowlist
  onResponseTraceparent: (tp) => {    // Optional response callback
    console.log(tp)
  },
  isEnabled: () => true,             // Optional guard
})

const res = await fetch('https://api.stripe.com/v1/charges', { method: 'POST' })
```

- Emits `external.call` events with `service` (hostname), `operation` (`METHOD /pathname`), and span linkage (`span_id`, optional `parent_span_id`)
- `duration_ms` measures time-to-headers (TTFB) -- the Response body is returned untouched for streaming
- Handles all three fetch input types: `string`, `URL`, `Request`
- Can inject outbound `traceparent` headers using `propagateTo` (default: same-origin only in browser, disabled elsewhere)
- HTTP 5xx responses get `outcome: "error"`; 1xx-4xx get `outcome: "success"`
- Network errors re-throw after emitting with `outcome: "error"`

## Browser Trace Context

Use the browser helpers to continue the same trace from UI requests into server adapters.

```typescript
import { createBrowserTraceContext, createBrowserTracedFetch } from 'agent-telemetry/browser'

const trace = createBrowserTraceContext({
  // Optional SSR bootstrap: <meta name="agent-telemetry-traceparent" content="00-...">
  initialTraceparent: document.querySelector('meta[name="agent-telemetry-traceparent"]')?.getAttribute('content'),
})

const fetch = createBrowserTracedFetch({
  trace,
  // Default is same-origin only. Keep this allowlist strict.
  propagateTo: (url) => url.origin === window.location.origin,
})

await fetch('/api/users')
```

- `createBrowserTraceContext()` bootstraps from `initialTraceparent`, then `<meta name="agent-telemetry-traceparent">`, then fresh IDs
- `createBrowserTracedFetch()` injects W3C `traceparent` on allowed requests and can adopt response `traceparent`
- `trace.withSpan(name, fn)` creates a child span for user actions and restores the previous parent span after completion
- Response adoption is **disabled by default** -- set `updateContextFromResponse: true` to enable

## Prisma Adapter

Traces all Prisma model operations via `$extends()`. No runtime `@prisma/client` import -- the extension is structurally compatible.

```typescript
import { createPrismaTrace } from 'agent-telemetry/prisma'

const prisma = new PrismaClient().$extends(createPrismaTrace({
  telemetry,
  getTraceContext: () => ctx,         // Optional -- correlate with parent request
  isEnabled: () => true,             // Optional guard
}))
```

- Emits `db.query` events with `provider: "prisma"`, `model` (e.g. `"User"`), `operation` (e.g. `"findMany"`), and span linkage (`span_id`, optional `parent_span_id`)
- Requires Prisma 5.0.0+ (stable `$extends` API)
- No access to raw SQL at the query extension level -- model and operation names only

## Express Adapter

Standard Express middleware with the same tracing pattern as Hono. No `express` or `@types/express` runtime dependency.

```typescript
import { createExpressTrace, getTraceContext } from 'agent-telemetry/express'

app.use(createExpressTrace({
  telemetry,
  entityPatterns: [
    { segment: 'users', key: 'userId' },
  ],
  sanitizePath: (path) => path.replace(/[0-9a-f-]{36}/gi, ':id'),
  isEnabled: () => true,
}))

app.post('/api/users/:id', (req, res) => {
  // Propagate trace context to downstream services
  const ctx = getTraceContext(req)
  // ctx = { _trace: { traceparent: "00-..." } }
  res.json({ ok: true })
})
```

- Emits `http.request` events with method, path (query string stripped), status_code, outcome, duration, entities, and span linkage
- Parses/sets W3C `traceparent` header for propagation
- Uses `req.route.path` for parameterized patterns (e.g. `/users/:id`), falls back to `req.originalUrl`
- Handles both `res.on("finish")` and `res.on("close")` to capture aborted requests

## Fastify Adapter

Fastify plugin using `onRequest`/`onResponse` hooks. No `fastify` runtime dependency -- uses `Symbol.for("skip-override")` instead of `fastify-plugin`.

```typescript
import { createFastifyTrace, getTraceContext } from 'agent-telemetry/fastify'

app.register(createFastifyTrace({
  telemetry,
  entityPatterns: [
    { segment: 'users', key: 'userId' },
  ],
  sanitizePath: (path) => path.replace(/[0-9a-f-]{36}/gi, ':id'),
  isEnabled: () => true,
}))
```

- Emits `http.request` events using `reply.elapsedTime` for high-resolution duration, including span linkage
- Strips query strings from emitted `path` values
- Parses/sets W3C `traceparent` header for propagation
- Uses `request.routeOptions.url` for parameterized route patterns
- Requires Fastify 4.0.0+ (`reply.elapsedTime` not available in 3.x)

## Next.js Adapter

Next.js middleware and route handlers run in separate execution contexts, so tracing is split into two pieces: middleware handles trace propagation, route handler wrappers handle timing and event emission. No `next` runtime dependency.

**Middleware** -- injects `traceparent` into request headers for downstream route handlers:

```typescript
// middleware.ts
import { createNextMiddleware } from 'agent-telemetry/next'

const traceMiddleware = createNextMiddleware()

export function middleware(request: NextRequest) {
  return traceMiddleware(request)
}
```

**Route handlers** -- reads `traceparent`, measures duration, emits `http.request` events:

```typescript
// app/api/users/route.ts
import { withNextTrace } from 'agent-telemetry/next'

export const GET = withNextTrace(async (request) => {
  const users = await db.query('SELECT * FROM users')
  return Response.json(users)
}, { telemetry })
```

**Server Actions** -- wraps actions with `method: "ACTION"` events:

```typescript
// app/actions.ts
'use server'
import { withActionTrace } from 'agent-telemetry/next'

export const createPost = withActionTrace(async (formData: FormData) => {
  // ...
}, { telemetry, name: 'createPost' })
```

- `createNextMiddleware()` parses incoming `traceparent` (or generates fresh IDs), creates a child span, and forwards the new `traceparent` via `NextResponse.next({ request: { headers } })`
- `withNextTrace(handler, options)` reads the propagated `traceparent`, times the handler with `performance.now()`, and emits `http.request` with method, path, status_code, outcome, duration, entities, and span linkage
- `withActionTrace(action, options)` creates a standalone span and emits events with `method: "ACTION"` and `path: actionName`
- `getTraceContext(request)` parses `traceparent` from request headers and returns `{ _trace: { traceparent: "00-..." } }` for passing to fetch/prisma/supabase adapters
- Supports `entityPatterns`, `sanitizePath`, and `isEnabled` options on route handler wrappers (same as other HTTP adapters)
- Uses only Web APIs (Headers, Response, performance.now) -- works in both Node and Edge runtimes

## Supabase Adapter

A traced `fetch` that parses Supabase URL patterns to emit rich, service-aware telemetry. PostgREST calls become `db.query` events; auth/storage/functions calls become `external.call` events.

```typescript
import { createClient } from '@supabase/supabase-js'
import { createSupabaseTrace } from 'agent-telemetry/supabase'

const tracedFetch = createSupabaseTrace({ telemetry })
const supabase = createClient(url, key, { global: { fetch: tracedFetch } })
```

URL pattern classification:

| Pattern | Event | Fields |
|---------|-------|--------|
| `/rest/v{N}/{table}` | `db.query` | `model: table`, `operation: select\|insert\|update\|delete` |
| `/auth/v{N}/{endpoint}` | `external.call` | `service: "supabase-auth"` |
| `/storage/v{N}/object/{bucket}` | `external.call` | `service: "supabase-storage"` |
| `/functions/v{N}/{name}` | `external.call` | `service: "supabase-functions"` |

- Each `fetch` invocation emits one event -- Supabase's built-in retry logic generates separate events per retry
- Realtime (WebSocket) subscriptions are not intercepted (they don't use `fetch`)
- `external.call` events use `outcome: "error"` for HTTP 5xx; `db.query` events use `outcome: "error"` for any non-2xx (PostgREST errors are query failures)

## Consumer

The consumer module parses JSONL telemetry files and produces canonical trace summaries for AI agent consumption.

```typescript
import {
  processTelemetry,
  processTelemetryDir,
  type TraceSummary,
} from 'agent-telemetry/consumer'

// From a string
const result = processTelemetry(jsonlContent)

// From a directory of .jsonl files
const result = await processTelemetryDir('.agent-telemetry/my-session/')

for (const summary of result.summaries) {
  console.log(summary.trace_id, summary.event_count)
  console.log(summary.uncertainties) // data quality signals
  console.log(summary.entities)      // aggregated entity values
}
```

The consumer pipeline runs six stages: **parse** (JSONL lines) -> **validate** (record_type, spec_version, known kinds) -> **normalize** (field truncation) -> **reconstruct** (span trees from trace_id/span_id/parent_span_id) -> **uncertainty** (data quality annotations) -> **summary** (canonical output with trust classification).

Each `TraceSummary` includes:
- `events` with per-field `trust` classification (`system_asserted`, `untrusted_input`, `derived`, `unknown`)
- `uncertainties` for data quality signals (malformed lines, missing parent spans, writer fallbacks)
- `entities` aggregated across all events in the trace
- Control characters escaped for prompt safety

Lower-level APIs are also exported: `parseLine`, `parseContent`, `parseFile`, `parseDirectory`, `reconstructTraces`, `buildEntityIndex`, `lookupEntity`, `classifyTrust`, `escapeControlChars`.

## Configuration

```typescript
const telemetry = await createTelemetry({
  logDir: '.agent-telemetry/my-session', // Directory for log files (default: auto-discovered)
  filename: 'telemetry.jsonl',           // Log filename (default: '{role}-{pid}.jsonl')
  maxSize: 5_000_000,                    // Max file size before rotation (default: 5MB)
  maxBackups: 3,                         // Number of rotated backups (default: 3)
  maxRecordSize: 1_048_576,              // Max record size before dropping (default: 1MB)
  prefix: '[TEL]',                       // Console fallback prefix (default: '[TEL]')
  isEnabled: () => true,                 // Guard function (default: () => true)
  sessionId: 'my-session',              // Session ID for directory structure
  role: 'worker',                        // Role identifier for filename (default: 'server')
  sanitizePath: (p) => p.replace(/[0-9a-f-]{36}/gi, ':id'), // Path sanitizer
})
```

**Output path discovery order:**
1. Explicit `logDir` + `filename` config
2. `AGENT_TELEMETRY_FILE` environment variable (single-file mode)
3. `AGENT_TELEMETRY_DIR` environment variable
4. `{project_root}/.agent-telemetry/{session_id}/{role}-{pid}.jsonl` (auto-discovered)

Project root is detected by walking up from `cwd()` looking for `.git`, `package.json`, or `deno.json`.

The `.agent-telemetry/` directory is automatically added to `.gitignore` and created with restricted permissions (`0o700` directory, `0o600` files on POSIX).

When `isEnabled` returns `false`, `emit()` is a no-op. Useful for environment-based guards:

```typescript
const telemetry = await createTelemetry({
  isEnabled: () => process.env.NODE_ENV === 'development',
})
```

## Field Truncation

Fields are automatically truncated to spec-defined byte limits before emission. Truncation is UTF-8 safe (never splits multi-byte characters) and appends `...[truncated]` as a suffix.

Key limits: `kind` (64 bytes), `path` (1024 bytes), `error_name` (120 bytes), most other string fields (256 bytes). `trace_id`, `span_id`, and `parent_span_id` are never truncated.

Entity keys are limited to 64 bytes, entity values to 256 bytes.

## Preset Event Types

| Type | Events | Description |
|------|--------|-------------|
| `HttpEvents` | `http.request` | HTTP request/response telemetry |
| `JobEvents` | `job.start`, `job.end`, `job.dispatch` | Background job lifecycle |
| `ExternalEvents` | `external.call` | External service calls |
| `DbEvents` | `db.query` | Database query telemetry |
| `SupabaseEvents` | `db.query`, `external.call` | Supabase-specific union |
| `PresetEvents` | All of the above | Combined preset union |

## Utilities

```typescript
import {
  generateTraceId,
  generateSpanId,
  extractEntities,
  extractEntitiesFromEvent,
  formatTraceparent,
  parseTraceparent,
  truncateField,
} from 'agent-telemetry'

generateTraceId()  // -> '0a1b2c3d4e5f67890a1b2c3d4e5f6789' (32 hex chars)
generateSpanId()   // -> '0a1b2c3d4e5f6789' (16 hex chars)

// Format a W3C traceparent header
formatTraceparent(traceId, spanId, '01')
// -> '00-0a1b2c3d4e5f67890a1b2c3d4e5f6789-0a1b2c3d4e5f6789-01'

// Parse a traceparent header
parseTraceparent('00-0a1b...6789-0a1b...6789-01')
// -> { version: '00', traceId: '0a1b...', parentId: '0a1b...', traceFlags: '01' }

// Extract entity IDs from URL paths (matches UUID segments only)
extractEntities('/api/users/550e8400-e29b-41d4-a716-446655440000/posts/6ba7b810-9dad-11d1-80b4-00c04fd430c8', [
  { segment: 'users', key: 'userId' },
  { segment: 'posts', key: 'postId' },
])
// -> { userId: '550e8400-...', postId: '6ba7b810-...' }

extractEntities('/api/users/john', [{ segment: 'users', key: 'userId' }])
// -> undefined (non-UUID values are skipped)

// Extract entity IDs from event data objects
extractEntitiesFromEvent({ userId: 'abc', count: 5 }, ['userId', 'postId'])
// -> { userId: 'abc' }

// UTF-8 safe field truncation
truncateField('very long string...', 32)
```

## Runtime Detection

The writer automatically detects the runtime environment:

| Runtime | Behavior |
|---------|----------|
| **Bun / Node.js** | Writes to filesystem with size-based rotation |
| **Cloudflare Workers** | Falls back to `console.log` with `[TEL]` prefix |

Detection happens once during `createTelemetry()` -- it probes the filesystem by creating the log directory and verifying it exists. Cloudflare's `nodejs_compat` stubs succeed silently on `mkdirSync` but fail the existence check, triggering the console fallback.

The returned `emit()` function is synchronous, non-blocking, and **never throws**, even with malformed data or filesystem errors. Telemetry must not crash the host application.

## Contract Pack

The `contracts/agent-telemetry/v1/` directory contains machine-readable contract artifacts for the spec:

- JSON Schemas for all event kinds, diagnostics, and trace summaries
- Field byte limits, enums, and regex patterns
- A glossary with field semantic descriptions
- Negative test vectors for conformance testing
- A manifest with SHA-256 hashes for integrity verification

## Migrating from 0.5.x

If you're upgrading from agent-telemetry 0.5.x, the following breaking changes apply:

### 1. `_trace` envelope format

The `_trace` continuation envelope now uses a W3C `traceparent` string instead of decomposed fields.

```typescript
// Before (0.5.x)
getTraceContext(c) // -> { _trace: { trace_id: "...", parent_span_id: "...", trace_flags: "01" } }

// After (0.6.0+)
getTraceContext(c) // -> { _trace: { traceparent: "00-{traceId}-{spanId}-01" } }
```

### 2. Job event field renames

Job events use spec-standard field names:

| 0.5.x field | 1.0 field |
|-------------|-----------|
| `function_id` | `task_name` |
| `run_id` | `task_id` |
| `event_name` | `task_name` |

`job.dispatch` events now always include an `outcome` field. New optional fields: `queue`, `attempt`.

### 3. `external.call` outcome for 5xx

The fetch adapter now sets `outcome: "error"` for HTTP 5xx responses. Previously all HTTP responses were `outcome: "success"`.

### 4. Browser meta tag name

The default meta tag name changed from `"traceparent"` to `"agent-telemetry-traceparent"`. Update your server-rendered HTML:

```html
<!-- Before -->
<meta name="traceparent" content="00-...">

<!-- After -->
<meta name="agent-telemetry-traceparent" content="00-...">
```

Or pass `metaName: "traceparent"` to `createBrowserTraceContext()` for backwards compatibility.

### 5. Response adoption default

`createBrowserTracedFetch()` no longer adopts response `traceparent` headers by default. Set `updateContextFromResponse: true` explicitly if needed.

### 6. File directory structure

Default output path changed from `logs/telemetry.jsonl` to `{project_root}/.agent-telemetry/{session_id}/{role}-{pid}.jsonl`. Pass `logDir` and `filename` to keep the old behavior:

```typescript
const telemetry = await createTelemetry({
  logDir: 'logs',
  filename: 'telemetry.jsonl',
})
```

## License

MIT
