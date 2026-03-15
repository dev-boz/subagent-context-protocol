# sub-mcp

**Give AI coding agents MCP access without loading schemas into the main session.**

## The problem

MCP (Model Context Protocol) tool definitions consume 500-850 tokens each. 5 MCP servers can eat 40-60k tokens in schema definitions, permanently sitting in context even when most tools go unused. That's context window you're paying for on every turn.

## How it works

sub-mcp installs a transparent wrapper around the `claude` binary. The main agent runs clean — no MCPs loaded, no schema overhead. When it spawns a subagent (via the Agent tool, `claude -p`, or any subprocess), the wrapper intercepts the call and injects MCP server configurations. The subagent gets full MCP access. The main agent never sees the schemas.

```
Main Agent (clean context, no MCP schemas)
    │
    └─ spawns subagent: claude -p "look up React docs"
                            │
                    ~/.sub-mcp/bin/claude (wrapper)
                            │
                    Detects -p flag → injects --mcp-config + --allowedTools
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
cd sub-mcp
npm install && npm run build

# Configure your MCP servers in profiles.yml (already has Context7 as an example)

# Install the transparent wrapper
node dist/cli.js install

# Add to your shell profile (~/.bashrc, ~/.zshrc, etc.)
export PATH="$HOME/.sub-mcp/bin:$PATH"

# Done. All subagents now have MCP access automatically.
```

## How the wrapper works

1. `sub-mcp install` finds your real `claude` binary, saves its path, and installs a wrapper at `~/.sub-mcp/bin/claude`
2. The wrapper sits earlier in PATH than the real binary
3. On every `claude` invocation, the wrapper checks if `-p`/`--print` is in the args (subagent/non-interactive mode)
4. If yes: injects `--mcp-config` with the appropriate MCP servers and `--allowedTools` to pre-approve them, then execs the real `claude`
5. If no (interactive mode): pure passthrough

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
  profile: docs           # default profile for subagent injection (omit to inject all servers)
  maxBudget: 1.0
```

### Profile options

| Field | Required | Description |
|-------|----------|-------------|
| `description` | yes | What this profile is for |
| `servers` | yes | List of MCP server names from `mcpServers` |
| `model` | no | Override model (e.g. `haiku` for cheap lookups). Omit to inherit from parent. |
| `isolateMcp` | no | If `true`, subagent only gets this profile's MCPs (passes `--strict-mcp-config`). If `false`/omitted, inherits parent MCPs + adds profile ones. |
| `maxBudget` | no | Max spend in USD for this profile |
| `systemPrompt` | no | Custom system prompt for subagents using this profile |

### Profile selection

The wrapper decides which MCPs to inject using this priority:

1. `SUB_MCP_PROFILE` env var — e.g. `SUB_MCP_PROFILE=docs claude -p "look up migrations"`
2. `defaults.profile` in profiles.yml — the default profile for all subagent calls
3. If neither is set, all configured MCP servers are injected

### Environment variables

Server configs can reference env vars with `${VAR_NAME}` syntax. These are **never persisted to disk** — they're resolved at runtime when the wrapper injects the config. The `~/.sub-mcp/mcp-config.json` cache file contains only the `${VAR}` placeholders.

After changing `profiles.yml`, run:

```bash
sub-mcp refresh
```

## CLI commands

```bash
# Transparent wrapper (primary use — automatic, no commands needed)
# Just use Claude Code normally. Subagents get MCPs automatically.

# Management
sub-mcp install [--config <path>]     # Install wrapper, pre-compute MCP config
sub-mcp uninstall                     # Remove wrapper, restore direct claude
sub-mcp refresh [--config <path>]     # Re-read profiles.yml after config changes
sub-mcp debug [--config <path>]       # Show wrapper state and resolved config

# Direct query (explicit profile routing, bypasses wrapper)
sub-mcp query -p <profile> <prompt>   # Send a query through a named profile
sub-mcp query -p docs --raw "how do Django migrations work"
sub-mcp query -p docs --model haiku "explain React hooks"

# Info
sub-mcp profiles [--config <path>]    # List available profiles
```

## Install layout

After `sub-mcp install`, the following files are created:

```
~/.sub-mcp/
├── bin/
│   ├── claude          # wrapper script (earlier in PATH than real binary)
│   └── argv.js         # arg parser module (imported by wrapper)
├── real-claude-path    # absolute path to the real claude binary
├── mcp-config.json     # pre-computed MCP config cache (no secrets, env vars as placeholders)
└── profiles.yml        # copy of source config (so `sub-mcp refresh` works from any directory)
```

## Architecture

```
src/
├─ wrapper.ts    Transparent claude wrapper (node builtins + argv.js only)
├─ argv.ts       Shared arg parser and env var resolver
├─ cli.ts        CLI: install, uninstall, refresh, query, profiles, debug
├─ config.ts     YAML config loader with validation
├─ spawner.ts    Direct subprocess spawner (for sub-mcp query)
├─ types.ts      TypeScript interfaces
└─ test.ts       Test suite (node:test)
```

## Security

- **No secrets on disk**: Env vars are stored as `${VAR}` placeholders in `mcp-config.json` and resolved at runtime
- **Auto-approved MCP tools**: Injected MCP tools are pre-approved via `--allowedTools mcp__<server>__*` so subagents can use them without interactive permission prompts
- **Process list visibility**: Resolved env vars appear in process arguments for the duration of the subagent call. On shared systems, use short-lived tokens.
- **Atomic writes**: Config files use write-to-temp-then-rename to prevent corrupted reads
- **No shell injection**: Wrapper uses `spawn()` with an args array, never shell interpolation
- **Stale path recovery**: If the saved claude path goes stale, the wrapper falls back to PATH search

## How it compares

| Approach | Main agent context cost | Seamless? |
|----------|------------------------|-----------|
| Load all MCPs directly | 40-60k tokens permanent | Yes |
| Lazy MCP loading (Cursor-style) | ~50% reduction | Yes |
| MCP-as-MCP-server | ~800 tokens (one tool schema) | Mostly |
| **sub-mcp** | **0 tokens in main session** | **Transparent for subagent calls** |

## Verifying it works

```bash
# Check wrapper is active
which claude  # should show ~/.sub-mcp/bin/claude

# Verify subagent gets MCP tools
claude -p "list your MCP tools" --output-format json --no-session-persistence

# Inspect resolved config
sub-mcp debug

# Test with bypass to confirm real claude still works
SUB_MCP_BYPASS=1 claude --version
```

## Troubleshooting

**Claude Code stopped working after install**
Run `sub-mcp uninstall` to remove the wrapper. Or set `SUB_MCP_BYPASS=1` for immediate passthrough without uninstalling.

**MCP server not connecting**
Run `sub-mcp debug` to verify your config. Make sure the server command (e.g. `npx`) is available in your PATH.

**"Environment variable not set" warning**
The wrapper resolves `${VAR}` references at runtime. Make sure the variable is exported in your shell, not just set in a dotfile that hasn't been sourced.

**Stale claude path after update**
The wrapper auto-recovers by searching PATH. If it still fails, run `sub-mcp install` again.

**Want to bypass the wrapper temporarily**
```bash
SUB_MCP_BYPASS=1 claude -p "this call skips MCP injection"
```

## Limitations

- **Claude Code only** — other agents (Codex, Gemini CLI) are not yet supported
- **Subagent mode only** — the wrapper intercepts `claude -p` subprocess calls, not interactive sessions
- **MCP startup latency remains** — sub-mcp eliminates token overhead, not MCP server connection time
- **Process list exposure** — resolved env vars are visible in `ps` for the duration of the subagent call
- **Config changes need refresh** — after editing profiles.yml, run `sub-mcp refresh`

## Example: before and after

**Without sub-mcp** — Context7 schema permanently in context:
```
$ claude
> /context
> MCP tools: 42.6k tokens (21.3%)  ← eating your context window every turn
```

**With sub-mcp** — main agent stays clean:
```
$ claude
> /context
> MCP tools: 0k tokens  ← clean

> "Use a subagent to look up the Django 5.1 migration docs"
  └─ Agent spawns: claude -p "..."
     └─ Wrapper injects Context7 MCP → subagent uses it → returns summary
  Main agent context: still clean
```

## Phase 2 (planned)

- Automatic profile routing based on prompt content
- Concurrent requests to different profiles
- Connection pooling for frequently-used MCP servers
- Per-directory `profiles.yml` overrides
