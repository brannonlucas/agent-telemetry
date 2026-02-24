# agent-telemetry

Lightweight JSONL telemetry for AI agent backends. Zero runtime dependencies.

Writes structured telemetry events to rotating JSONL files in development. Falls back to `console.log` in runtimes without filesystem access (Cloudflare Workers). Includes framework adapters for [Hono](https://hono.dev) and [Inngest](https://inngest.com).

## Install

```bash
bun add agent-telemetry
```

> **Node.js users:** This package ships TypeScript source (no build step). You'll need a bundler that handles `.ts` imports (esbuild, tsup, Vite, etc.).

## Quick Start

```typescript
import { createTelemetry, generateTraceId, type PresetEvents } from 'agent-telemetry'

// createTelemetry is async (one-time runtime probe). The returned emit() is synchronous.
const telemetry = await createTelemetry<PresetEvents>()

telemetry.emit({
  kind: 'http.request',
  traceId: generateTraceId(),
  method: 'GET',
  path: '/api/health',
  status: 200,
  duration_ms: 12,
})
```

Each call to `emit()` appends a JSON line to `logs/telemetry.jsonl` with an auto-injected `timestamp`:

```jsonl
{"kind":"http.request","traceId":"0a1b2c3d4e5f67890a1b2c3d4e5f6789","method":"GET","path":"/api/health","status":200,"duration_ms":12,"timestamp":"2026-02-24T21:00:00.000Z"}
```

## How It Works

The library connects three layers of tracing — HTTP requests, event dispatch, and background jobs — through a shared `traceId`:

```
Browser → HTTP Request → Hono Middleware (generates traceId)
                              ↓
                         getTraceContext(c)  →  { _trace: { traceId, parentSpanId } }
                              ↓
                         inngest.send({ data: { ...payload, ...getTraceContext(c) } })
                              ↓
                         Inngest Middleware (reads _trace from event data)
                              ↓
                         job.start / job.end (same traceId)
```

One `traceId` follows a request from the HTTP boundary through dispatch into background job execution. Query your JSONL logs by `traceId` to see the full chain.

## Full-Stack Example

Create **one** telemetry instance and share it across both adapters:

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

// --- HTTP tracing ---
const trace = createHonoTrace({
  telemetry,
  entityPatterns: [
    { segment: 'users', key: 'userId' },
    { segment: 'posts', key: 'postId' },
  ],
})

const app = new Hono()
app.use('*', trace)

// Propagate traceId into background job dispatch
app.post('/api/users/:id/process', async (c) => {
  await inngest.send({
    name: 'app/user.process',
    data: { userId: c.req.param('id'), ...getTraceContext(c) },
  })
  return c.json({ ok: true })
})

// --- Background job tracing ---
const inngestTrace = createInngestTrace({
  telemetry,
  entityKeys: ['userId', 'postId'],
})

const inngest = new Inngest({ id: 'my-app', middleware: [inngestTrace] })
```

This produces a correlated trace:
```jsonl
{"kind":"http.request","traceId":"aabb...","method":"POST","path":"/api/users/550e8400-e29b-41d4-a716-446655440000/process","status":200,"duration_ms":45,"entities":{"userId":"550e8400-e29b-41d4-a716-446655440000"},"timestamp":"..."}
{"kind":"job.dispatch","traceId":"aabb...","parentSpanId":"cc11...","eventName":"app/user.process","entities":{"userId":"550e8400-e29b-41d4-a716-446655440000"},"timestamp":"..."}
{"kind":"job.start","traceId":"aabb...","spanId":"dd22...","functionId":"process-user","timestamp":"..."}
{"kind":"job.end","traceId":"aabb...","spanId":"dd22...","functionId":"process-user","duration_ms":230,"status":"success","timestamp":"..."}
```

All four events share the same `traceId`. Filter with `jq 'select(.traceId == "aabb...")'` to see the full chain.

## Custom Events

Extend the type system with your own event kinds:

```typescript
import { createTelemetry, type HttpEvents, type JobEvents } from 'agent-telemetry'

type MyEvents = HttpEvents | JobEvents | {
  kind: 'custom.checkout'
  traceId: string
  orderId: string
  amount: number
}

const telemetry = await createTelemetry<MyEvents>()

telemetry.emit({
  kind: 'custom.checkout',
  traceId: 'trace-1',
  orderId: 'order-abc',
  amount: 4999,
})
```

## Hono Adapter

```typescript
import { createHonoTrace, getTraceContext } from 'agent-telemetry/hono'

const trace = createHonoTrace({
  telemetry,
  entityPatterns: [            // Extract entity IDs from URL path segments
    { segment: 'users', key: 'userId' },
    { segment: 'posts', key: 'postId' },
  ],
  traceHeader: 'X-Trace-Id',  // Header name (default: 'X-Trace-Id')
  isEnabled: () => true,       // Guard function (default: () => true)
})

app.use('*', trace)
```

The middleware:
- Generates a unique `traceId` per request (or propagates a valid 32-char hex ID from `X-Trace-Id`)
- Sets `X-Trace-Id` on the response for client-side correlation
- Emits `http.request` events with method, path, status, duration, and extracted entities
- Extracts entity IDs from URL paths — looks for a matching `segment`, then checks if the next segment is a UUID

`getTraceContext(c)` returns `{ _trace: { traceId, parentSpanId } }` for spreading into dispatch payloads. Returns `{}` if no trace middleware is active.

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
- Emits `job.dispatch` events for outgoing event sends
- Reads `traceId` from the `_trace` field in `event.data` (set by `getTraceContext()` at the dispatch site)
- Generates a new `traceId` when no `_trace` is present, so every function run is always traceable

## Configuration

```typescript
const telemetry = await createTelemetry({
  logDir: 'logs',              // Directory for log files (default: 'logs')
  filename: 'telemetry.jsonl', // Log filename (default: 'telemetry.jsonl')
  maxSize: 5_000_000,          // Max file size before rotation (default: 5MB)
  maxBackups: 3,               // Number of rotated backups (default: 3)
  prefix: '[TEL]',             // Console fallback prefix (default: '[TEL]')
  isEnabled: () => true,       // Guard function (default: () => true)
})
```

When `isEnabled` returns `false`, `emit()` is a no-op. Useful for environment-based guards:

```typescript
const telemetry = await createTelemetry({
  isEnabled: () => process.env.NODE_ENV === 'development',
})
```

## Preset Event Types

| Type | Events | Description |
|------|--------|-------------|
| `HttpEvents` | `http.request` | HTTP request/response telemetry |
| `JobEvents` | `job.start`, `job.end`, `job.dispatch`, `job.step` | Background job lifecycle |
| `ExternalEvents` | `external.call` | External service calls |
| `PresetEvents` | All of the above | Combined preset union |

## Utilities

```typescript
import {
  generateTraceId,
  generateSpanId,
  extractEntities,
  extractEntitiesFromEvent,
} from 'agent-telemetry'

generateTraceId()  // → '0a1b2c3d4e5f67890a1b2c3d4e5f6789' (32 hex chars)
generateSpanId()   // → '0a1b2c3d4e5f6789' (16 hex chars)

// Extract entity IDs from URL paths (matches UUID segments only)
extractEntities('/api/users/550e8400-e29b-41d4-a716-446655440000/posts/6ba7b810-9dad-11d1-80b4-00c04fd430c8', [
  { segment: 'users', key: 'userId' },
  { segment: 'posts', key: 'postId' },
])
// → { userId: '550e8400-...', postId: '6ba7b810-...' }

extractEntities('/api/users/john', [{ segment: 'users', key: 'userId' }])
// → undefined (non-UUID values are skipped)

// Extract entity IDs from event data objects
extractEntitiesFromEvent({ userId: 'abc', count: 5 }, ['userId', 'postId'])
// → { userId: 'abc' }
```

## Runtime Detection

The writer automatically detects the runtime environment:

| Runtime | Behavior |
|---------|----------|
| **Bun / Node.js** | Writes to filesystem with size-based rotation |
| **Cloudflare Workers** | Falls back to `console.log` with `[TEL]` prefix |

Detection happens once during `createTelemetry()` — it probes the filesystem by creating the log directory and verifying it exists. Cloudflare's `nodejs_compat` stubs succeed silently on `mkdirSync` but fail the existence check, triggering the console fallback.

The returned `emit()` function is synchronous and **never throws**, even with malformed data or filesystem errors. Telemetry must not crash the host application.

## License

MIT
