/**
 * Shared argv parsing and env-var resolution utilities used by both
 * wrapper.ts (at runtime) and test.ts (during testing).
 */

export interface ParsedArgs {
  isSubagent: boolean;
  hasMcpConfig: boolean;
}

/**
 * Known claude CLI flags that consume the next arg as a value.
 * Last synced with Claude Code 2.1.x. If Anthropic adds new value-taking
 * flags, this set may need updating — but false negatives only affect
 * edge cases where a new flag's value happens to be "-p".
 */
export const VALUE_FLAGS = new Set([
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

export function parseArgs(args: string[]): ParsedArgs {
  let isSubagent = false;
  let hasMcpConfig = false;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    // Handle --flag=value form
    if (arg.startsWith("--") && arg.includes("=")) {
      const flag = arg.slice(0, arg.indexOf("="));
      if (flag === "--print") isSubagent = true;
      if (flag === "--mcp-config") hasMcpConfig = true;
      i++;
      continue;
    }

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

/**
 * Resolve ${VAR} placeholders inside a JSON string.
 * Values are JSON-escaped so quotes/backslashes/newlines in env vars
 * don't produce invalid JSON. Throws on missing env vars.
 */
export function resolveEnvVarsInJson(
  json: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): string {
  const missing: string[] = [];
  const result = json.replace(/\$\{(\w+)\}/g, (match, name) => {
    const val = env[name];
    if (val === undefined) {
      missing.push(name);
      return match;
    }
    // JSON-escape: strip outer quotes from JSON.stringify to get the escaped content
    return JSON.stringify(val).slice(1, -1);
  });
  if (missing.length > 0) {
    throw new Error(
      `Missing environment variables: ${missing.join(", ")}`
    );
  }
  return result;
}
