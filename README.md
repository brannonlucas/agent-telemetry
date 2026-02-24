# agent-telemetry

Lightweight JSONL telemetry for AI agent backends. Zero runtime dependencies.

Writes structured telemetry events to rotating JSONL files in development. Falls back to `console.log` in runtimes without filesystem access (Cloudflare Workers). Includes framework adapters for [Hono](https://hono.dev) and [Inngest](https://inngest.com).

## Install

```bash
bun add agent-telemetry
# or
npm install agent-telemetry
```

## Quick Start

```typescript
import { createTelemetry, type PresetEvents } from 'agent-telemetry'

const telemetry = await createTelemetry<PresetEvents>()

telemetry.emit({
  kind: 'http.request',
  traceId: 'abc123',
  method: 'GET',
  path: '/api/health',
  status: 200,
  duration_ms: 12,
})
```

Events are written to `logs/telemetry.jsonl` as newline-delimited JSON with automatic rotation.

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

const telemetry = await createTelemetry<MyEvents>({ logDir: 'logs' })

telemetry.emit({
  kind: 'custom.checkout',
  traceId: 'trace-1',
  orderId: 'order-abc',
  amount: 4999,
})
```

## Hono Adapter

```typescript
import { createTelemetry, type HttpEvents } from 'agent-telemetry'
import { createHonoTrace, getTraceContext } from 'agent-telemetry/hono'

const telemetry = await createTelemetry<HttpEvents>()

const trace = createHonoTrace({
  telemetry,
  entityPatterns: [
    { segment: 'users', key: 'userId' },
    { segment: 'posts', key: 'postId' },
  ],
})

app.use('*', trace)

// In route handlers, get trace context for downstream propagation:
app.post('/api/process', async (c) => {
  await queue.send({ ...payload, ...getTraceContext(c) })
  return c.json({ ok: true })
})
```

The middleware:
- Generates a unique `traceId` per request (or propagates from `X-Trace-Id` header)
- Sets `X-Trace-Id` on the response
- Emits `http.request` events with method, path, status, duration, and entity IDs
- Extracts entity IDs from URL paths using configurable patterns

## Inngest Adapter

```typescript
import { createTelemetry, type JobEvents } from 'agent-telemetry'
import { createInngestTrace } from 'agent-telemetry/inngest'

const telemetry = await createTelemetry<JobEvents>()

const trace = createInngestTrace({
  telemetry,
  entityKeys: ['userId', 'orderId'],
})

const inngest = new Inngest({ id: 'my-app', middleware: [trace] })
```

The middleware:
- Emits `job.start` and `job.end` events for function lifecycle
- Emits `job.dispatch` events for outgoing event sends
- Propagates `traceId` from the `_trace` field in event data
- Generates a new `traceId` when none exists

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

## Preset Event Types

| Type | Events | Description |
|------|--------|-------------|
| `HttpEvents` | `http.request` | HTTP request/response telemetry |
| `JobEvents` | `job.start`, `job.end`, `job.dispatch`, `job.step` | Background job lifecycle |
| `ExternalEvents` | `external.call` | External service calls |
| `PresetEvents` | All of the above | Combined preset union |

## Utilities

```typescript
import { generateTraceId, generateSpanId, extractEntities, extractEntitiesFromEvent } from 'agent-telemetry'

generateTraceId()  // → '0a1b2c3d4e5f6789...' (32 hex chars)
generateSpanId()   // → '0a1b2c3d4e5f6789' (16 hex chars)

extractEntities('/api/users/abc-uuid/posts/def-uuid', [
  { segment: 'users', key: 'userId' },
  { segment: 'posts', key: 'postId' },
])
// → { userId: 'abc-uuid', postId: 'def-uuid' }

extractEntitiesFromEvent({ userId: 'abc', count: 5 }, ['userId', 'postId'])
// → { userId: 'abc' }
```

## Runtime Detection

The writer automatically detects the runtime:

- **Node.js / Bun**: Writes to filesystem with rotation
- **Cloudflare Workers**: Falls back to `console.log` with prefix (filesystem stubs are detected)

Detection happens once at startup via `createTelemetry()` (which is why it's async). The returned `emit()` is synchronous and never throws.

## License

MIT
