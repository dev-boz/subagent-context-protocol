#!/usr/bin/env node

/**
 * Transparent claude wrapper. Installed to ~/.scp/bin/claude.
 * When called with -p (subagent mode), injects --mcp-config with
 * MCP server definitions. Otherwise pure passthrough.
 * Zero external dependencies — only node builtins + ./argv.js.
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

// --- Bypass: SCP_BYPASS=1 skips all injection ---

function findRealClaude(): string {
  if (existsSync(REAL_CLAUDE_FILE)) {
    const saved = readFileSync(REAL_CLAUDE_FILE, "utf-8").trim();
    if (existsSync(saved)) return saved;
    process.stderr.write(
      `scp: saved claude path is stale (${saved}), searching PATH...\n`
    );
  }

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

// --- Profile-aware MCP config building ---

interface CachedConfig {
  mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
  profiles: Record<string, { servers: string[]; isolateMcp?: boolean }>;
  defaults?: { profile?: string };
}

function buildMcpJson(config: CachedConfig, profileName: string | undefined): string | null {
  // If a profile is specified, inject only that profile's servers
  if (profileName) {
    const profile = config.profiles[profileName];
    if (!profile) {
      process.stderr.write(
        `scp: warning: unknown profile "${profileName}", injecting all servers\n`
      );
      return JSON.stringify({ mcpServers: config.mcpServers });
    }
    if (profile.servers.length === 0) return null;
    const filtered: Record<string, unknown> = {};
    for (const name of profile.servers) {
      if (config.mcpServers[name]) filtered[name] = config.mcpServers[name];
    }
    return JSON.stringify({ mcpServers: filtered });
  }

  // No profile specified — inject all servers
  return JSON.stringify({ mcpServers: config.mcpServers });
}

// --- Main ---

const realClaude = findRealClaude();
const args = process.argv.slice(2);

// SCP_BYPASS=1 → pure passthrough, no injection
const bypass = process.env.SCP_BYPASS === "1";

if (!bypass) {
  const { isSubagent, hasMcpConfig } = parseArgs(args);

  if (isSubagent && !hasMcpConfig && existsSync(MCP_CONFIG_FILE)) {
    try {
      const raw = readFileSync(MCP_CONFIG_FILE, "utf-8").trim();
      if (raw) {
        const config = JSON.parse(raw) as CachedConfig;

        // Profile selection: SCP_PROFILE env var → defaults.profile → all servers
        const profileName = process.env.SCP_PROFILE ?? config.defaults?.profile;
        const mcpJson = buildMcpJson(config, profileName);

        if (mcpJson) {
          const resolved = resolveEnvVarsInJson(mcpJson);
          args.push("--mcp-config", resolved);
        }
      }
    } catch (err) {
      process.stderr.write(
        `scp: warning: bad mcp-config.json, skipping injection: ${(err as Error).message}\n`
      );
    }
  }
}

const child = spawn(realClaude, args, { stdio: "inherit" });
child.on("close", (code) => process.exit(code ?? 1));
child.on("error", (err) => {
  process.stderr.write(`scp: failed to run claude: ${err.message}\n`);
  process.exit(1);
});
