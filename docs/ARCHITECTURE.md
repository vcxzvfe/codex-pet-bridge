# Architecture

Codex Pet Bridge is a local notification hub for coding agents and small ambient devices.

The bridge deliberately avoids patching Codex Desktop, Claude Desktop, Claude Code, or device firmware. Every upstream integration should enter through a stable public extension point, then be normalized into one internal event shape.

## Components

```mermaid
flowchart LR
  ClaudeCode["Claude Code CLI"] -->|"command hook"| Hook["claude-hook.js"]
  ClaudeDesktop["Claude Desktop"] -->|"MCP stdio"| MCP["mcp-server.js"]
  Codex["Codex Desktop / CLI"] -->|"MCP / App Server adapter"| Bridge["bridge-server.js"]
  Polymarket["Polymarket adapter"] -->|"POST /events"| Bridge
  Hook -->|"POST /events"| Bridge
  MCP -->|"POST /events"| Bridge
  Bridge -->|"SSE /stream"| Pet["Desktop Pet"]
  Bridge -->|"GET /esp32/poll"| ESP["ESP S3 / XiaoZhi"]
  Bridge -->|"webhook"| Push["Push or automation sink"]
```

## Data Model

`PetEvent` is the full state feed. It is useful for live UI animation, logs, and diagnostics.

`PetNotification` is the intervention queue. It is intentionally smaller and more stable so it can be consumed by the desktop pet, ESP S3, future push notification sinks, or another project.

Default notification statuses:

- `needs-attention`
- `completed`
- `near-complete`
- `error`

## Integration Policy

Adapters should stay thin:

- Read upstream events from a public hook, MCP tool, webhook, or polling API.
- Normalize to `PetEvent`.
- Let `bridge-server.js` decide whether to enqueue a `PetNotification`.
- Avoid storing upstream secrets or full prompts unless explicitly enabled.

This keeps future upstream updates local to one adapter instead of touching the notification devices.
