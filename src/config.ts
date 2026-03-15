import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import type { ScpConfig, McpServerConfig } from "./types.js";

const DEFAULT_CONFIG_PATHS = [
  "profiles.yml",
  "profiles.yaml",
  "scp.yml",
  "scp.yaml",
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

export function loadConfig(configPath?: string): ScpConfig {
  let filePath: string | undefined;

  if (configPath) {
    filePath = resolve(configPath);
  } else {
    for (const p of DEFAULT_CONFIG_PATHS) {
      const candidate = resolve(p);
      if (existsSync(candidate)) {
        filePath = candidate;
        break;
      }
    }
  }

  if (!filePath || !existsSync(filePath)) {
    throw new Error(
      `Config not found. Searched: ${configPath ?? DEFAULT_CONFIG_PATHS.join(", ")}`
    );
  }

  const raw = readFileSync(filePath, "utf-8");
  const config = yaml.load(raw) as ScpConfig;

  if (!config.mcpServers) {
    throw new Error("Config must define mcpServers");
  }
  if (!config.profiles) {
    throw new Error("Config must define profiles");
  }

  // Validate all profile server refs exist
  for (const [profileName, profile] of Object.entries(config.profiles)) {
    for (const serverName of profile.servers) {
      if (!config.mcpServers[serverName]) {
        throw new Error(
          `Profile "${profileName}" references unknown server "${serverName}"`
        );
      }
    }
  }

  // Env vars are NOT resolved here — they stay as ${VAR} placeholders.
  // Resolution happens at runtime in the wrapper/spawner, so secrets
  // never get persisted to ~/.scp/mcp-config.json.

  return config;
}

/** Resolve env vars in a config (for runtime use in spawner, not for persistence). */
export function resolveConfigEnv(config: ScpConfig): ScpConfig {
  const resolved = structuredClone(config);
  for (const server of Object.values(resolved.mcpServers)) {
    if (server.env) {
      server.env = resolveEnvVars(server.env);
    }
  }
  return resolved;
}

export function buildMcpConfigJson(
  config: ScpConfig,
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
