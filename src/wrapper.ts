#!/usr/bin/env node

/**
 * Transparent claude wrapper. Installed to ~/.sub-mcp/bin/claude.
 * When called with -p (subagent mode), injects --mcp-config with
 * MCP server definitions. Otherwise pure passthrough.
 * Zero external dependencies — only node builtins + ./argv.js.
 */

import { spawn, execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs, resolveEnvVarsInJson } from "./argv.js";

const SUB_MCP_DIR = join(homedir(), ".sub-mcp");
const BIN_DIR = join(SUB_MCP_DIR, "bin");
const REAL_CLAUDE_FILE = join(SUB_MCP_DIR, "real-claude-path");
const MCP_CONFIG_FILE = join(SUB_MCP_DIR, "mcp-config.json");

// --- CachedConfig interface ---
// MUST match the shape produced by buildCache() in cli.ts. Duplicated here
// because the wrapper is deployed standalone (copied to ~/.sub-mcp/bin/) and
// cannot import from the main package at runtime.

export interface CachedConfig {
  mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
  profiles: Record<string, { servers: string[]; isolateMcp?: boolean }>;
  defaults?: { profile?: string };
}

// --- Testable exports ---

export function findRealClaude(): string {
  if (existsSync(REAL_CLAUDE_FILE)) {
    const saved = readFileSync(REAL_CLAUDE_FILE, "utf-8").trim();
    if (existsSync(saved)) return saved;
    process.stderr.write(
      `sub-mcp: saved claude path is stale (${saved}), searching PATH...\n`
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
      "sub-mcp: claude CLI not found. Install it or run: sub-mcp install\n"
    );
    process.exit(1);
  }
}

/** Build the MCP JSON string for a given profile (or all servers if no profile). */
export function buildMcpJson(config: CachedConfig, profileName: string | undefined): string | null {
  if (profileName) {
    const profile = config.profiles[profileName];
    if (!profile) {
      process.stderr.write(
        `sub-mcp: warning: unknown profile "${profileName}", injecting all servers\n`
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

/** Determine whether MCP injection should happen. */
export function shouldInjectMcp(isSubagent: boolean, hasMcpConfig: boolean): boolean {
  return isSubagent && !hasMcpConfig;
}

/**
 * Build the args array with MCP config injected.
 * NOTE: The resolved JSON is passed as a CLI argument. If the config exceeds
 * ARG_MAX (~128KB on Linux, ~256KB on macOS), the spawn will fail. For Phase 1
 * we accept this risk; a future version should write to a temp file for large configs.
 */
export function buildInjectedArgs(
  args: string[],
  config: CachedConfig,
  profileName: string | undefined
): string[] {
  const mcpJson = buildMcpJson(config, profileName);
  if (!mcpJson) return [...args];

  const resolved = resolveEnvVarsInJson(mcpJson);
  const newArgs = [...args, "--mcp-config", resolved];

  // Honour isolateMcp: only profile MCPs, don't inherit parent's
  if (profileName && config.profiles[profileName]?.isolateMcp) {
    newArgs.push("--strict-mcp-config");
  }

  // Pre-approve injected MCP tools so subagents don't hit permission prompts
  // (claude -p runs non-interactively and can't approve tools)
  const serverNames = profileName && config.profiles[profileName]
    ? config.profiles[profileName].servers
    : Object.keys(config.mcpServers);
  if (serverNames.length > 0) {
    const patterns = serverNames.map(name => `mcp__${name}__*`).join(",");
    newArgs.push("--allowedTools", patterns);
  }

  return newArgs;
}

// --- Main ---

function main(): void {
  const realClaude = findRealClaude();
  let args = process.argv.slice(2);

  // SUB_MCP_BYPASS=1 → pure passthrough, no injection
  const bypass = process.env.SUB_MCP_BYPASS === "1";

  if (!bypass) {
    const { isSubagent, hasMcpConfig } = parseArgs(args);

    if (shouldInjectMcp(isSubagent, hasMcpConfig) && existsSync(MCP_CONFIG_FILE)) {
      try {
        const raw = readFileSync(MCP_CONFIG_FILE, "utf-8").trim();
        if (raw) {
          const config = JSON.parse(raw) as CachedConfig;

          // Profile selection: SUB_MCP_PROFILE env var → defaults.profile → all servers
          const profileName = process.env.SUB_MCP_PROFILE ?? config.defaults?.profile;
          args = buildInjectedArgs(args, config, profileName);
        }
      } catch (err) {
        process.stderr.write(
          `sub-mcp: warning: skipping MCP injection: ${(err as Error).message}\n`
        );
      }
    }
  }

  const child = spawn(realClaude, args, { stdio: "inherit" });
  child.on("close", (code, signal) => {
    if (signal) {
      process.stderr.write(`sub-mcp: claude terminated by signal ${signal}\n`);
    }
    process.exit(code ?? 1);
  });
  child.on("error", (err) => {
    process.stderr.write(`sub-mcp: failed to run claude: ${err.message}\n`);
    process.exit(1);
  });
}

// Only run when executed directly, not when imported for testing
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
