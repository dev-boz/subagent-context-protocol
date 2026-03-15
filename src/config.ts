import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";
import type { SubMcpConfig, McpServerConfig } from "./types.js";

const SUB_MCP_DIR = join(homedir(), ".sub-mcp");

const DEFAULT_CONFIG_PATHS = [
  "profiles.yml",
  "profiles.yaml",
  "sub-mcp.yml",
  "sub-mcp.yaml",
];

export function resolveEnvVars(
  env: Record<string, string>
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    resolved[key] = value.replace(/\$\{(\w+)\}/g, (_, name) => {
      const val = process.env[name];
      if (val === undefined) {
        throw new Error(`Environment variable ${name} is not set`);
      }
      return val;
    });
  }
  return resolved;
}

export function loadConfig(configPath?: string): SubMcpConfig {
  let filePath: string | undefined;

  if (configPath) {
    filePath = resolve(configPath);
  } else {
    // Search CWD first
    for (const p of DEFAULT_CONFIG_PATHS) {
      const candidate = resolve(p);
      if (existsSync(candidate)) {
        filePath = candidate;
        break;
      }
    }
    // Fall back to ~/.sub-mcp/
    if (!filePath) {
      for (const p of DEFAULT_CONFIG_PATHS) {
        const candidate = join(SUB_MCP_DIR, p);
        if (existsSync(candidate)) {
          filePath = candidate;
          break;
        }
      }
    }
  }

  if (!filePath || !existsSync(filePath)) {
    throw new Error(
      `Config not found. Searched: ${configPath ?? DEFAULT_CONFIG_PATHS.join(", ")}`
    );
  }

  const raw = readFileSync(filePath, "utf-8");
  const config = yaml.load(raw) as SubMcpConfig;

  // Runtime type validation — yaml.load returns unknown, the `as` cast is not safe
  if (!config || typeof config !== "object") {
    throw new Error("Config file is empty or not a YAML object");
  }
  if (!config.mcpServers || typeof config.mcpServers !== "object") {
    throw new Error("Config must define mcpServers as an object");
  }
  if (!config.profiles || typeof config.profiles !== "object") {
    throw new Error("Config must define profiles as an object");
  }

  for (const [profileName, profile] of Object.entries(config.profiles)) {
    if (!profile || typeof profile !== "object") {
      throw new Error(`Profile "${profileName}" must be an object`);
    }
    if (!Array.isArray(profile.servers)) {
      throw new Error(
        `Profile "${profileName}": servers must be an array`
      );
    }
    for (const serverName of profile.servers) {
      if (typeof serverName !== "string") {
        throw new Error(
          `Profile "${profileName}": each server name must be a string`
        );
      }
      if (!config.mcpServers[serverName]) {
        throw new Error(
          `Profile "${profileName}" references unknown server "${serverName}"`
        );
      }
    }
  }

  // Env vars are NOT resolved here — they stay as ${VAR} placeholders.
  // Resolution happens at runtime in the wrapper/spawner, so secrets
  // never get persisted to ~/.sub-mcp/mcp-config.json.

  return config;
}

/** Resolve env vars in a config (for runtime use in spawner, not for persistence). */
export function resolveConfigEnv(config: SubMcpConfig): SubMcpConfig {
  const resolved = structuredClone(config);
  for (const server of Object.values(resolved.mcpServers)) {
    if (server.env) {
      server.env = resolveEnvVars(server.env);
    }
  }
  return resolved;
}

export function buildMcpConfigJson(
  config: SubMcpConfig,
  profileName: string
): string {
  const profile = config.profiles[profileName];
  if (!profile) {
    throw new Error(`Unknown profile: "${profileName}"`);
  }

  const servers: Record<string, McpServerConfig> = {};
  for (const serverName of profile.servers) {
    servers[serverName] = config.mcpServers[serverName];
  }

  return JSON.stringify({ mcpServers: servers });
}
