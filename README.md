# subagent-context-protocol (SCP)

**Give AI coding agents MCP access with zero token overhead in the main session.**

## The problem

MCP (Model Context Protocol) tool definitions consume 500-850 tokens each. 5 MCP servers can eat 40-60k tokens in schema definitions, permanently sitting in context even when most tools go unused. That's context window you're paying for on every turn.

Everyone wants dynamic MCP loading. Nobody has shipped it yet. Cursor achieved 46.9% reduction with lazy loading. SCP achieves effectively **100% reduction**.

## How SCP solves it

SCP installs a transparent wrapper around the `claude` binary. The main agent runs clean — no MCPs loaded, no schema overhead. When it spawns a subagent (via the Agent tool, `claude -p`, or any subprocess), the wrapper intercepts the call and injects MCP server configurations automatically. The subagent gets full MCP access. The main agent never knows.

```
Main Agent (clean context, zero MCP overhead)
    │
    └─ spawns subagent: claude -p "look up React docs"
                            │
                    ~/.scp/bin/claude (wrapper)
                            │
                    Detects -p flag → injects --mcp-config
                            │
                    Real claude with Context7 MCP available
                            │
                    Subagent uses MCP tools naturally
                            │
                    Returns result to main agent
```

The subagent pays the schema cost in its own short-lived context. The main agent's context window stays intact.

## Quick start

```bash
# Clone and build
cd subagent-context-protocol
npm install && npm run build

# Configure your MCP servers in profiles.yml (already has Context7 as an example)

# Install the transparent wrapper
node dist/cli.js install

# Add to your shell profile (~/.bashrc, ~/.zshrc, etc.)
export PATH="$HOME/.scp/bin:$PATH"

# Done. All subagents now have MCP access automatically.
```

## How the wrapper works

1. `scp install` finds your real `claude` binary, saves its path, and installs a Node.js wrapper at `~/.scp/bin/claude`
2. The wrapper sits earlier in PATH than the real binary
3. On every `claude` invocation, the wrapper checks if `-p`/`--print` is in the args (subagent/non-interactive mode)
4. If yes: injects `--mcp-config` with your configured MCP servers, then execs the real `claude`
5. If no (interactive mode): pure passthrough, zero overhead

The main agent never sees MCP schemas. Subagents discover and use MCP tools naturally.

## Configuration

Edit `profiles.yml` in the project root:

```yaml
mcpServers:
  context7:
    command: npx
    args: ["-y", "@upstash/context7-mcp"]
  github:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_TOKEN: "${GITHUB_TOKEN}"  # resolved at runtime, never saved to disk

profiles:
  docs:
    description: "Documentation lookup via Context7"
    servers: [context7]
    model: haiku          # optional: override model for this profile
    isolateMcp: true      # optional: only these MCPs, don't inherit parent's
  github:
    description: "GitHub operations"
    servers: [github]
  clean:
    description: "No MCPs - pure coding assistant"
    servers: []

defaults:
  maxBudget: 1.0
```

### Profile options

| Field | Required | Description |
|-------|----------|-------------|
| `description` | yes | What this profile is for |
| `servers` | yes | List of MCP server names from `mcpServers` |
| `model` | no | Override model (e.g. `haiku` for cheap lookups). Omit to inherit from parent. |
| `isolateMcp` | no | If `true`, subagent only gets this profile's MCPs. If `false`/omitted, inherits parent MCPs + adds profile ones. |
| `maxBudget` | no | Max spend in USD for this profile |
| `systemPrompt` | no | Custom system prompt for subagents using this profile |

### Environment variables

Server configs can reference env vars with `${VAR_NAME}` syntax. These are **never persisted to disk** — they're resolved at runtime when the wrapper injects the config. The `~/.scp/mcp-config.json` cache file contains only the `${VAR}` placeholders.

After changing `profiles.yml`, run:

```bash
scp refresh
```

## CLI commands

```bash
# Transparent wrapper (primary use — automatic, no commands needed)
# Just use Claude Code normally. Subagents get MCPs automatically.

# Management
scp install [--config <path>]     # Install wrapper, pre-compute MCP config
scp uninstall                     # Remove wrapper, restore direct claude
scp refresh [--config <path>]     # Re-read profiles.yml after config changes

# Direct query (explicit profile routing, bypasses wrapper)
scp query -p <profile> <prompt>   # Send a query through a named profile
scp query -p docs --raw "how do Django migrations work"
scp query -p docs --model haiku "explain React hooks"

# Info
scp profiles [--config <path>]    # List available profiles
```

## Architecture

```
profiles.yml                     ~/.scp/
├─ mcpServers:                   ├─ bin/claude          (wrapper script)
│   context7: {command, args}    ├─ real-claude-path    (absolute path to real binary)
│   github: {command, args, env} └─ mcp-config.json     (pre-computed, no secrets)
└─ profiles:
    docs: {servers: [context7]}
    github: {servers: [github]}
```

```
src/
├─ wrapper.ts    Transparent claude wrapper (zero external deps)
├─ cli.ts        CLI: install, uninstall, refresh, query, profiles
├─ config.ts     YAML config loader with validation
├─ spawner.ts    Direct subprocess spawner (for scp query)
└─ types.ts      TypeScript interfaces
```

## Security

- **No secrets on disk**: Env vars (`${GITHUB_TOKEN}`, etc.) are stored as placeholders in `mcp-config.json` and resolved at runtime
- **Atomic writes**: Config files use write-to-temp-then-rename to prevent corrupted reads from concurrent access
- **No shell injection**: Wrapper uses `spawn()` with an args array, never shell interpolation
- **Stale path recovery**: If the saved claude path goes stale (after an update), the wrapper falls back to PATH search
- **Proper argv parsing**: Flag detection uses a state machine that handles `--flag=value` forms and value-consuming flags
- **File permissions**: `mcp-config.json` written with `0600` (owner-only)

## How it compares to alternatives

| Approach | Main agent context cost | Seamless? |
|----------|------------------------|-----------|
| Load all MCPs directly | 40-60k tokens permanent | Yes |
| Lazy MCP loading (Cursor-style) | ~50% reduction | Yes |
| MCP-as-MCP-server | ~800 tokens (one tool schema) | Mostly |
| **SCP wrapper** | **0 tokens** | **Yes — fully transparent** |

## Phase 2 (planned)

- Automatic profile routing based on prompt content
- Concurrent requests to different profiles
- Connection pooling for frequently-used MCP servers
- Per-directory `profiles.yml` overrides
