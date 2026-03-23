# sub-mcp

**Give AI coding agents MCP access without loading schemas into the main session.**

## The problem

MCP (Model Context Protocol) tool definitions consume 500-850 tokens each. 5 MCP servers can eat 40-60k tokens in schema definitions, permanently sitting in context even when most tools go unused. That's context window you're paying for on every turn.

## How it works

sub-mcp keeps MCP overhead at zero in your main session. It provides two mechanisms depending on how subagents are spawned:

**Interactive sessions** (Agent tool) — generates `.claude/agents/<profile>.md` files with `mcpServers` frontmatter. Claude Code natively starts MCP servers scoped to the subagent. The main session never loads the schemas.

**CLI/scripts** (`claude -p`) — installs a transparent wrapper at `~/.sub-mcp/bin/claude` that intercepts subagent calls and injects `--mcp-config`.

Both are driven by the same `profiles.yml` config.

```
Main Agent (clean context, no MCP schemas)
    │
    ├─ Interactive: Agent tool with subagent_type: "docs"
    │       │
    │       Claude Code reads .claude/agents/docs.md
    │       │
    │       Starts Context7 MCP scoped to subagent only
    │       │
    │       Subagent uses MCP tools → returns result
    │
    └─ CLI: claude -p "look up React docs"
            │
            ~/.sub-mcp/bin/claude (wrapper)
            │
            Injects --mcp-config + --allowedTools
            │
            Subagent uses MCP tools → returns result
```

The subagent pays the schema cost in its own short-lived context. The main agent's context window stays intact.

## Quick start

```bash
# Clone and build
cd sub-mcp
npm install && npm run build

# Configure your MCP servers in profiles.yml (already has Context7 as an example)

# Generate agent files for interactive sessions
sub-mcp agents

# Install the CLI wrapper for claude -p calls
sub-mcp install

# Add to your shell profile (~/.bashrc, ~/.zshrc, etc.)
export PATH="$HOME/.sub-mcp/bin:$PATH"

# Done. Subagents now have MCP access in both interactive and CLI modes.
```

If `sub-mcp` isn't in your PATH yet, use `node dist/cli.js` instead (or `npm link` to install globally).

## Interactive mode (Agent tool)

`sub-mcp agents` generates `.claude/agents/<profile>.md` files that Claude Code reads natively. Each file defines MCP servers scoped to that subagent — the servers only start when the subagent is spawned, and the main session never loads their schemas.

**Generated file** (`.claude/agents/docs.md`):
```yaml
---
name: docs
description: Documentation lookup via Context7
mcpServers:
  - context7:
      type: stdio
      command: npx
      args:
        - "-y"
        - "@upstash/context7-mcp"
model: haiku
---

Documentation lookup via Context7

You have MCP tools (mcp__*) available. Prefer using MCP tools
over built-in alternatives like Fetch, WebFetch, or WebSearch.
```

It also generates `.claude/rules/sub-mcp.md` so the main agent knows which profiles exist and can choose the right one.

**Usage**: Just ask Claude naturally — "use a docs subagent to look up the React 19 use() hook". The rules file tells it about available profiles, and it spawns the right agent type.

## CLI wrapper mode (claude -p)

For scripts, CI, and `sub-mcp query` calls:

1. `sub-mcp install` finds your real `claude` binary, saves its path, and installs a wrapper at `~/.sub-mcp/bin/claude`
2. The wrapper sits earlier in PATH than the real binary
3. On every `claude` invocation, the wrapper checks if `-p`/`--print` is in the args (subagent/non-interactive mode)
4. If yes: injects `--mcp-config`, `--allowedTools` (pre-approves MCP tools), and wraps the prompt with an MCP-preference nudge
5. If no (interactive mode): pure passthrough

The default MCP nudge can be overridden per-profile with the `systemPrompt` field in profiles.yml.

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
    isolateMcp: true      # optional: CLI wrapper only — only these MCPs, don't inherit parent's
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
| `isolateMcp` | no | **CLI wrapper only.** If `true`, subagent only gets this profile's MCPs (passes `--strict-mcp-config`). If `false`/omitted, inherits parent MCPs + adds profile ones. Has no effect in interactive mode — Claude Code subagents always inherit parent MCPs. |
| `maxBudget` | no | Max spend in USD for this profile |
| `systemPrompt` | no | Custom system prompt for subagents using this profile |

### Profile selection (CLI wrapper)

The wrapper decides which MCPs to inject using this priority:

1. `SUB_MCP_PROFILE` env var — e.g. `SUB_MCP_PROFILE=docs claude -p "look up migrations"`
2. `defaults.profile` in profiles.yml — the default profile for all subagent calls
3. If neither is set, all configured MCP servers are injected

### Environment variables

Server configs can reference env vars with `${VAR_NAME}` syntax. These are **never persisted to disk** — they're resolved at runtime when the wrapper injects the config. The `~/.sub-mcp/mcp-config.json` cache file contains only the `${VAR}` placeholders. Agent files also preserve placeholders for Claude Code to resolve at runtime.

After changing `profiles.yml`, run:

```bash
sub-mcp refresh    # updates CLI wrapper cache + regenerates agent files
# or just regenerate agent files:
sub-mcp agents
```

## CLI commands

```bash
# Agent file generation (interactive sessions)
sub-mcp agents [--config <path>]      # Generate .claude/agents/ and .claude/rules/ files
sub-mcp agents --clean                # Remove generated files

# CLI wrapper management (claude -p calls)
sub-mcp install [--config <path>]     # Install wrapper + generate agent files
sub-mcp install --no-agents           # Install wrapper only, skip agent file generation
sub-mcp uninstall                     # Remove wrapper + clean generated files
sub-mcp refresh [--config <path>]     # Re-read profiles.yml, update cache + agent files

# Direct query (explicit profile routing, bypasses wrapper)
sub-mcp query -p <profile> <prompt>   # Send a query through a named profile
sub-mcp query -p docs --raw "how do Django migrations work"
sub-mcp query -p docs --model haiku "explain React hooks"

# Info
sub-mcp profiles [--config <path>]    # List available profiles
sub-mcp debug [--config <path>]       # Show wrapper state and resolved config
```

## Install layout

After `sub-mcp install`, the following files are created:

```
~/.sub-mcp/                          # CLI wrapper (global)
├── bin/
│   ├── claude                       # wrapper script (earlier in PATH)
│   └── argv.js                      # arg parser module
├── hooks/
│   └── subagent-report.js           # SubagentStop hook — reports MCP tool usage
├── real-claude-path                 # absolute path to the real claude binary
├── mcp-config.json                  # pre-computed MCP config cache (no secrets)
└── profiles.yml                     # copy of source config

.claude/                             # Agent files (per-project)
├── agents/
│   ├── docs.md                      # agent with Context7 MCP
│   └── clean.md                     # agent with no MCPs
└── rules/
    └── sub-mcp.md                   # profile inventory for the main agent
```

## Architecture

```
src/
├─ wrapper.ts          Transparent claude wrapper (node builtins + argv.js only)
├─ argv.ts             Shared arg parser and env var resolver
├─ cli.ts              CLI: install, uninstall, refresh, agents, query, profiles, debug
├─ config.ts           YAML config loader with validation
├─ spawner.ts          Direct subprocess spawner (for sub-mcp query)
├─ types.ts            TypeScript interfaces
├─ test.ts             Test suite (node:test, 52 tests)
└─ hooks/
   └─ subagent-report.ts  SubagentStop hook — reports MCP tool usage to stderr
```

## Security

- **No secrets on disk**: Env vars are stored as `${VAR}` placeholders in `mcp-config.json` and agent files, resolved at runtime
- **Auto-approved MCP tools**: Injected MCP tools are pre-approved via `--allowedTools mcp__<server>__*` so subagents can use them without interactive permission prompts
- **Process list visibility**: Resolved env vars appear in process arguments for the duration of the subagent call. On shared systems, use short-lived tokens.
- **Atomic writes**: Config files use write-to-temp-then-rename to prevent corrupted reads
- **No shell injection**: Wrapper uses `spawn()` with an args array, never shell interpolation
- **Stale path recovery**: If the saved claude path goes stale, the wrapper falls back to PATH search
- **Scoped MCP servers**: Agent files define MCP servers inline, scoped to the subagent only — they never load in the main session

## How it compares

| Approach | Main agent context cost | Seamless? |
|----------|------------------------|-----------|
| Load all MCPs directly | 40-60k tokens permanent | Yes |
| Lazy MCP loading (Cursor-style) | ~50% reduction | Yes |
| MCP-as-MCP-server | ~800 tokens (one tool schema) | Mostly |
| **sub-mcp** | **0 tokens in main session** | **Yes — interactive + CLI** |

## Verifying it works

```bash
# Check agent files exist
ls .claude/agents/

# Check wrapper is active (CLI mode)
which claude  # should show ~/.sub-mcp/bin/claude

# Verify subagent gets MCP tools (CLI mode)
claude -p "list your MCP tools" --output-format json --no-session-persistence

# Inspect resolved config
sub-mcp debug

# Test with bypass to confirm real claude still works
SUB_MCP_BYPASS=1 claude --version
```

## MCP usage reporting (SubagentStop hook)

sub-mcp includes a `SubagentStop` hook that prints a one-line summary of MCP tool usage after each subagent completes. This gives you visibility into what MCP tools subagents actually called without cluttering the main session.

**Example output** (printed to stderr):
```
[sub-mcp] docs agent: 3 MCP calls (resolve-library-id, get-library-docs ×2)
```

If a subagent didn't use any MCP tools, the hook stays silent.

### Setup

After running `sub-mcp install`, add the hook to your Claude Code settings (`~/.claude/settings.json`):

```json
{
  "hooks": {
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.sub-mcp/hooks/subagent-report.js"
          }
        ]
      }
    ]
  }
}
```

The hook reads the subagent's transcript JSONL (provided in the hook payload's `agent_transcript_path` field), finds all `mcp__*` tool calls, and formats a summary showing which MCP tools were called and how many times.

## Troubleshooting

**Agent not using MCP tools in interactive mode**
Make sure you ran `sub-mcp agents` from your project directory. Check that `.claude/agents/*.md` files exist and contain `mcpServers` in the frontmatter.

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
- **MCP startup latency remains** — sub-mcp eliminates token overhead, not MCP server connection time
- **Process list exposure** — resolved env vars are visible in `ps` for the duration of the subagent call (CLI mode)
- **Config changes need refresh** — after editing profiles.yml, run `sub-mcp refresh` or `sub-mcp agents`

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

> "Use a docs subagent to look up the Django 5.1 migration docs"
  └─ Agent spawns subagent_type: "docs"
     └─ Claude Code reads .claude/agents/docs.md
     └─ Starts Context7 MCP scoped to subagent
     └─ Subagent uses MCP tools → returns summary
  Main agent context: still clean
```

## Phase 2 (planned)

- Automatic profile routing based on prompt content
- Concurrent requests to different profiles
- Connection pooling for frequently-used MCP servers
- Per-directory `profiles.yml` overrides
