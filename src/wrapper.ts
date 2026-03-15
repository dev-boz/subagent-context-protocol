#!/usr/bin/env node

/**
 * Transparent claude wrapper. Installed to ~/.scp/bin/claude.
 * When called with -p (subagent mode), injects --mcp-config with
 * pre-computed MCP server definitions. Otherwise pure passthrough.
 * Zero external dependencies — only node builtins.
 */

import { spawn, execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SCP_DIR = join(homedir(), ".scp");
const BIN_DIR = join(SCP_DIR, "bin");
const REAL_CLAUDE_FILE = join(SCP_DIR, "real-claude-path");
const MCP_CONFIG_FILE = join(SCP_DIR, "mcp-config.json");

// --- Resolve real claude path, recovering from stale installs ---

function findRealClaude(): string {
  // Try saved path first
  if (existsSync(REAL_CLAUDE_FILE)) {
    const saved = readFileSync(REAL_CLAUDE_FILE, "utf-8").trim();
    if (existsSync(saved)) return saved;
    process.stderr.write(
      `scp: saved claude path is stale (${saved}), searching PATH...\n`
    );
  }

  // Fallback: search PATH excluding our wrapper dir
  const pathDirs = (process.env.PATH ?? "")
    .split(":")
    .filter((d) => d !== BIN_DIR);
  try {
    return execFileSync("which", ["claude"], {
      encoding: "utf-8",
      env: { ...process.env, PATH: pathDirs.join(":") },
    }).trim();
  } catch {
    process.stderr.write(
      "scp: claude CLI not found. Install it or run: scp install\n"
    );
    process.exit(1);
  }
}

// --- Argv parsing ---

/** Known claude CLI flags that consume the next arg as a value. */
const VALUE_FLAGS = new Set([
  "-p",
  "--print",
  "--model",
  "--agent",
  "--effort",
  "--mcp-config",
  "--system-prompt",
  "--permission-mode",
  "--max-budget-usd",
  "--name",
  "-n",
  "-r",
  "--resume",
  "--session-id",
  "--plugin-dir",
  "--from-pr",
]);

interface ParsedArgs {
  isSubagent: boolean;
  hasMcpConfig: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  let isSubagent = false;
  let hasMcpConfig = false;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    // Handle --flag=value form
    if (arg.startsWith("--") && arg.includes("=")) {
      const flag = arg.slice(0, arg.indexOf("="));
      if (flag === "--mcp-config") hasMcpConfig = true;
      i++;
      continue;
    }

    // Check for -p/--print as a flag (not as a value to another flag)
    if (arg === "-p" || arg === "--print") {
      isSubagent = true;
    }
    if (arg === "--mcp-config") {
      hasMcpConfig = true;
    }

    // If this flag takes a value, skip the next arg
    if (VALUE_FLAGS.has(arg) && i + 1 < args.length) {
      i += 2;
      continue;
    }

    i++;
  }

  return { isSubagent, hasMcpConfig };
}

// --- Env var resolution (runtime, no secrets on disk) ---

function resolveEnvVars(json: string): string {
  return json.replace(/\$\{(\w+)\}/g, (match, name) => {
    const val = process.env[name];
    if (val === undefined) {
      process.stderr.write(
        `scp: warning: env var ${name} not set in MCP config\n`
      );
      return match; // leave placeholder — MCP server will fail with a clear error
    }
    return val;
  });
}

// --- Main ---

const realClaude = findRealClaude();
const args = process.argv.slice(2);
const { isSubagent, hasMcpConfig } = parseArgs(args);

if (isSubagent && !hasMcpConfig && existsSync(MCP_CONFIG_FILE)) {
  try {
    const raw = readFileSync(MCP_CONFIG_FILE, "utf-8").trim();
    if (raw) {
      // Validate JSON is parseable before injecting
      JSON.parse(raw);
      const resolved = resolveEnvVars(raw);
      args.push("--mcp-config", resolved);
    }
  } catch (err) {
    process.stderr.write(
      `scp: warning: bad mcp-config.json, skipping injection: ${(err as Error).message}\n`
    );
  }
}

const child = spawn(realClaude, args, { stdio: "inherit" });
child.on("close", (code) => process.exit(code ?? 1));
child.on("error", (err) => {
  process.stderr.write(`scp: failed to run claude: ${err.message}\n`);
  process.exit(1);
});
