# Project: subagent-context-protocol

## What this is

A proxy layer that gives AI coding agents (Claude Code, Codex, etc.) **on-demand MCP access with zero token overhead** in the main session.

The problem: MCP tool definitions consume 500-850 tokens per tool. 5 MCP servers can eat 40-60k tokens just in schema definitions, permanently sitting in context even when unused. Everyone wants dynamic MCP loading — Anthropic hasn't shipped it. Cursor achieved 46.9% reduction with lazy loading. We achieve effectively 100% reduction.

The solution: MCPs never load into the main agent session. Instead, when the main agent needs an MCP capability, the request routes through this proxy to a separate agent instance that has exactly the right MCPs pre-configured. The response comes back as a clean summary. The MCP connection never touches the main session's context window.

## How it works

```
Main Agent (Opus, clean, no MCPs)
    │
    ├─ "look up Django 5.1 migration docs"
    │       │
    │       ▼
    │   subagent-context-protocol (proxy)
    │       │
    │       ▼
    │   Agent Instance with Context7 MCP loaded
    │       │
    │       ▼
    │   Returns: clean summary
    │
    ├─ "check the GitHub issues for bug reports"
    │       │
    │       ▼
    │   subagent-context-protocol (proxy)
    │       │
    │       ▼
    │   Agent Instance with GitHub MCP loaded
    │       │
    │       ▼
    │   Returns: clean summary
    │
    └─ Main agent continues with full context window intact
```

## Architecture

### Core concept: MCP Profiles

Named configurations that define which MCPs an agent instance gets:

```yaml
profiles:
  docs:
    description: "Documentation lookup"
    mcpServers:
      - context7
      - doc-scraper
  browser:
    description: "Web automation and testing"
    mcpServers:
      - playwright
  github:
    description: "GitHub operations"
    mcpServers:
      - github
  gemini:
    description: "Large file reading, repo scanning, URL fetching"
    mcpServers:
      - gemini-cli
  clean:
    description: "No MCPs — pure coding"
    mcpServers: []
```

### Request flow

1. Main agent makes a request (via tool call, subagent spawn, or explicit routing)
2. Proxy intercepts and determines which MCP profile is needed
3. Proxy routes to an agent instance configured with that profile's MCPs
4. Agent instance executes, returns result
5. Proxy returns clean result to main agent
6. MCP connection exists only for the duration of the request

### Key design principles

- **Zero token overhead**: Main session never sees MCP tool schemas
- **On-demand**: MCP servers start when needed, stop when done
- **Profile-based**: Named, reusable MCP configurations
- **Agent-agnostic**: Should work with Claude Code, Codex, Gemini CLI, or any agent that can make outbound requests
- **Transparent**: The main agent doesn't need to know the plumbing — it just asks for something and gets an answer

## Tech stack

- **Node.js / TypeScript** — consistency with the broader cli-agent-nexus ecosystem
- **HTTP proxy / mitmproxy pattern** — intercept and route requests
- **Config-driven** — YAML or JSON for profile definitions
- **Standalone** — runs independently, not coupled to any specific agent

## Phase 1: MVP

Build the simplest possible version that proves the concept:

1. Config file with MCP profiles (which MCPs belong to which profile)
2. A way to spawn a Claude Code subprocess with a specific MCP profile
3. Route a request to that subprocess and return the result
4. Clean up the subprocess after

Don't overengineer. Don't build a framework. Build the thinnest possible proxy that makes one MCP profile request work end-to-end.

## Phase 2: Multi-profile routing

- Automatic profile selection based on request content
- Concurrent requests to different profiles
- Connection pooling / warm instances for frequently-used profiles

## Phase 3: Protocol support

- Expose as an MCP server itself (meta — an MCP that manages MCPs)
- ACP/A2A compatibility
- SSE streaming support

## Start here

1. Initialise the repo: TypeScript, minimal deps
2. Define the config schema for MCP profiles
3. Build the subprocess spawner that launches Claude Code with a specific set of MCPs
4. Build a simple request/response flow: main agent → proxy → subprocess → response
5. Test with one profile (e.g., Context7) end to end
