import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { buildMcpConfigJson, resolveConfigEnv } from "./config.js";
import type { SubMcpConfig, ClaudeResult, QueryResult } from "./types.js";

const SUB_MCP_DIR = join(homedir(), ".sub-mcp");
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Resolve the real claude binary path. Reads from ~/.sub-mcp/real-claude-path
 * to avoid hitting the wrapper (which would cause a recursion loop if
 * ~/.sub-mcp/bin is in PATH).
 * Falls back to bare "claude" if the saved path is unavailable.
 */
function getRealClaudePath(): string {
  const savedPathFile = join(SUB_MCP_DIR, "real-claude-path");
  if (existsSync(savedPathFile)) {
    const real = readFileSync(savedPathFile, "utf-8").trim();
    if (real && existsSync(real)) return real;
  }
  return "claude";
}

export interface QueryOptions {
  model?: string;
  timeout?: number;
}

export async function query(
  config: SubMcpConfig,
  profileName: string,
  prompt: string,
  options: QueryOptions = {}
): Promise<QueryResult> {
  const profile = config.profiles[profileName];
  if (!profile) {
    throw new Error(`Unknown profile: "${profileName}"`);
  }

  const model = options.model ?? profile.model;
  const maxBudget = profile.maxBudget ?? config.defaults?.maxBudget;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;

  // Minimal flags — everything else inherits from parent agent.
  // --no-session-persistence: subagent queries are stateless fire-and-forget.
  const args = ["-p", prompt, "--output-format", "json", "--no-session-persistence"];

  // Add MCP config if the profile has servers — resolve env vars at runtime
  if (profile.servers.length > 0) {
    const resolved = resolveConfigEnv(config);
    const mcpJson = buildMcpConfigJson(resolved, profileName);
    args.push("--mcp-config", mcpJson);
    // isolateMcp: only profile MCPs. Default: inherit parent MCPs + add profile ones
    if (profile.isolateMcp) {
      args.push("--strict-mcp-config");
    }
    // Pre-approve injected MCP tools for non-interactive execution
    const patterns = profile.servers.map(name => `mcp__${name}__*`).join(",");
    args.push("--allowedTools", patterns);
  }

  // Optional overrides — only when explicitly set in profile or CLI
  if (model) {
    args.push("--model", model);
  }
  if (maxBudget) {
    args.push("--max-budget-usd", maxBudget.toString());
  }
  const defaultPrompt = "IMPORTANT: You have MCP tools (mcp__*) available. Always use MCP tools when they can accomplish the task, in preference to built-in tools that overlap in functionality.";
  args.push("--system-prompt", profile.systemPrompt ?? defaultPrompt);

  const claudePath = getRealClaudePath();
  const startTime = Date.now();

  return new Promise<QueryResult>((resolve, reject) => {
    const child = spawn(claudePath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new Error(
          `Query timed out after ${timeout}ms (profile: ${profileName})`
        )
      );
    }, timeout);

    child.on("close", (code) => {
      clearTimeout(timer);

      if (code !== 0) {
        reject(
          new Error(`claude exited with code ${code}: ${stderr || stdout}`)
        );
        return;
      }

      try {
        const parsed = JSON.parse(stdout) as ClaudeResult;
        const durationMs = Date.now() - startTime;

        if (parsed.is_error) {
          reject(new Error(`Claude returned error: ${parsed.result}`));
          return;
        }

        resolve({
          text: parsed.result,
          cost: parsed.total_cost_usd,
          durationMs,
          model: model ?? "inherited",
          profile: profileName,
        });
      } catch {
        reject(new Error(`Failed to parse claude output: ${stdout}`));
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}
