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
import { parseArgs, resolveEnvVarsInJson } from "./argv.js";

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
      const resolved = resolveEnvVarsInJson(raw);
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
