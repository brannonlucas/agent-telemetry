# Demo App

This demo shows browser-to-backend trace propagation with `agent-telemetry`.
It also adds synthetic jittered delays so the timeline chart is visually clear.

## Run

```bash
bun run demo
```

Open:

```text
http://localhost:3001
```

By default the demo listens on `127.0.0.1` only. Set `DEMO_HOST=0.0.0.0` if you explicitly want external/LAN access.

Click **Run Demo Request**. The demo performs:

1. Browser request with `traceparent` (via `agent-telemetry/browser`)
2. Traced Hono API request (`http.request`)
3. Traced SQLite query (`db.query`, provider: `sqlite`)
4. Traced server-side fetch call (`external.call`)
5. Downstream API request (`http.request`)

The server injects a `<meta name="traceparent">` tag into the HTML response, which the browser client reads via `createBrowserTraceContext()` to bootstrap trace correlation — no manual ID passing needed.

The page includes:

1. **Recent Telemetry** panel (last 40 JSONL lines)
2. **Trace Timeline (Temporal View)** panel (Gantt-style bars scoped to the selected request span)

This lets users validate setup without manual shell commands.

## Delay tuning

The demo can simulate arbitrary timing with environment variables:

```bash
DEMO_DELAYS=1 \
DEMO_DB_DELAY_MS=80-260 \
DEMO_STEP_GAP_DELAY_MS=40-180 \
DEMO_UPSTREAM_DELAY_MS=120-420 \
bun run demo
```

Notes:

1. Set `DEMO_DELAYS=0` to disable all synthetic delays.
2. Each delay var accepts either a single value (`120`) or range (`80-260`).
3. Optional: set `DEMO_UPSTREAM_ORIGIN=http://127.0.0.1:3001` to pin the trusted upstream base URL used by the demo's server-side fetch.

Telemetry is written to:

```text
logs/demo/telemetry.jsonl
```

The file is created automatically at startup, even before the first event.

SQLite demo database path:

```text
/tmp/agent-telemetry-demo.sqlite
```

Example filter:

```bash
tail -n 50 logs/demo/telemetry.jsonl
```
