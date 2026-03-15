#!/usr/bin/env node

import { Command } from "commander";
import { execSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
  existsSync,
  renameSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { query } from "./spawner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCP_DIR = join(homedir(), ".scp");
const BIN_DIR = join(SCP_DIR, "bin");

/** Write to a temp file then rename — atomic on POSIX, safe for concurrent reads. */
function atomicWrite(path: string, content: string, mode = 0o644): void {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, path);
}

const program = new Command();

program
  .name("scp")
  .description("subagent-context-protocol — zero-overhead MCP proxy for AI coding agents")
  .version("0.1.0");

program
  .command("query")
  .description("Send a query through a named MCP profile")
  .requiredOption("-p, --profile <name>", "Profile to use")
  .option("--raw", "Output raw text only")
  .option("--model <model>", "Override the model")
  .option("--config <path>", "Path to config file")
  .argument("<prompt>", "The prompt to send")
  .action(async (prompt: string, opts: Record<string, string | boolean | undefined>) => {
    try {
      const config = loadConfig(opts.config as string | undefined);
      const result = await query(config, opts.profile as string, prompt, {
        model: opts.model as string | undefined,
      });

      if (opts.raw) {
        process.stdout.write(result.text + "\n");
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("profiles")
  .description("List available profiles")
  .option("--config <path>", "Path to config file")
  .action((opts: Record<string, string | undefined>) => {
    try {
      const config = loadConfig(opts.config as string | undefined);

      for (const [name, profile] of Object.entries(config.profiles)) {
        const servers =
          profile.servers.length > 0 ? profile.servers.join(", ") : "(none)";
        const model = profile.model ?? "(inherited)";
        console.log(`  ${name}`);
        console.log(`    ${profile.description}`);
        console.log(`    servers: ${servers}  model: ${model}`);
        console.log();
      }
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("install")
  .description("Install the transparent claude wrapper for MCP injection")
  .option("--config <path>", "Path to profiles.yml")
  .action((opts: Record<string, string | undefined>) => {
    try {
      const config = loadConfig(opts.config);

      // Find real claude — skip ~/.scp/bin to avoid finding our own wrapper
      const pathDirs = (process.env.PATH ?? "")
        .split(":")
        .filter((d) => d !== BIN_DIR);
      const envWithoutScp = { ...process.env, PATH: pathDirs.join(":") };
      const realClaude = execSync("which claude", {
        encoding: "utf-8",
        env: envWithoutScp,
      }).trim();

      if (!realClaude) {
        console.error("Error: claude CLI not found in PATH");
        process.exit(1);
      }

      // Create dirs
      mkdirSync(BIN_DIR, { recursive: true });

      // Save real claude path (atomic)
      atomicWrite(join(SCP_DIR, "real-claude-path"), realClaude);

      // Pre-compute MCP config JSON — includes profiles and defaults so the
      // wrapper can filter by SCP_PROFILE. Env vars kept as ${VAR} placeholders,
      // resolved at runtime. No secrets on disk.
      const cache = {
        mcpServers: config.mcpServers,
        profiles: Object.fromEntries(
          Object.entries(config.profiles).map(([name, p]) => [
            name,
            { servers: p.servers, isolateMcp: p.isolateMcp },
          ])
        ),
        defaults: config.defaults,
      };
      atomicWrite(join(SCP_DIR, "mcp-config.json"), JSON.stringify(cache), 0o600);

      // Install wrapper + argv helper to ~/.scp/bin/
      const wrapperDst = join(BIN_DIR, "claude");
      copyFileSync(join(__dirname, "wrapper.js"), wrapperDst);
      chmodSync(wrapperDst, 0o755);
      copyFileSync(join(__dirname, "argv.js"), join(BIN_DIR, "argv.js"));

      console.log(`Installed wrapper to ${wrapperDst}`);
      console.log(`Real claude: ${realClaude}`);
      console.log(`MCP servers: ${Object.keys(config.mcpServers).join(", ")}`);

      // Check PATH
      if (!process.env.PATH?.split(":").includes(BIN_DIR)) {
        console.log(
          `\nAdd to your shell profile:\n  export PATH="$HOME/.scp/bin:$PATH"\n`
        );
      } else {
        console.log("\nReady. Subagents will now have MCP access.");
      }
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("uninstall")
  .description("Remove the claude wrapper")
  .action(() => {
    for (const f of [join(BIN_DIR, "claude"), join(BIN_DIR, "argv.js")]) {
      if (existsSync(f)) rmSync(f);
    }
    for (const f of ["real-claude-path", "mcp-config.json"]) {
      const p = join(SCP_DIR, f);
      if (existsSync(p)) rmSync(p);
    }
    console.log("Uninstalled. Subagents will use claude directly.");
  });

program
  .command("refresh")
  .description("Re-read profiles.yml and update the pre-computed MCP config")
  .option("--config <path>", "Path to profiles.yml")
  .action((opts: Record<string, string | undefined>) => {
    try {
      const config = loadConfig(opts.config);
      const cache = {
        mcpServers: config.mcpServers,
        profiles: Object.fromEntries(
          Object.entries(config.profiles).map(([name, p]) => [
            name,
            { servers: p.servers, isolateMcp: p.isolateMcp },
          ])
        ),
        defaults: config.defaults,
      };
      atomicWrite(join(SCP_DIR, "mcp-config.json"), JSON.stringify(cache), 0o600);
      console.log(
        `Updated MCP config: ${Object.keys(config.mcpServers).join(", ")}`
      );
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("debug")
  .description("Show the resolved MCP config that would be injected into subagents")
  .option("--config <path>", "Path to profiles.yml")
  .action((opts: Record<string, string | undefined>) => {
    try {
      const config = loadConfig(opts.config);

      // Show what's in the pre-computed cache
      const cacheFile = join(SCP_DIR, "mcp-config.json");
      const realClaudeFile = join(SCP_DIR, "real-claude-path");
      const wrapperPath = join(BIN_DIR, "claude");

      console.log("Wrapper status:");
      console.log(`  wrapper:      ${existsSync(wrapperPath) ? wrapperPath : "(not installed)"}`);
      console.log(`  real claude:  ${existsSync(realClaudeFile) ? readFileSync(realClaudeFile, "utf-8").trim() : "(not set)"}`);
      console.log(`  mcp cache:    ${existsSync(cacheFile) ? cacheFile : "(not generated)"}`);
      console.log();

      console.log("Configured MCP servers:");
      for (const [name, server] of Object.entries(config.mcpServers)) {
        const envVars = server.env ? ` env: ${Object.keys(server.env).join(", ")}` : "";
        console.log(`  ${name}: ${server.command} ${server.args.join(" ")}${envVars}`);
      }
      console.log();

      console.log("Profiles:");
      for (const [name, profile] of Object.entries(config.profiles)) {
        const servers = profile.servers.length > 0 ? profile.servers.join(", ") : "(none)";
        const model = profile.model ?? "(inherited)";
        const isolated = profile.isolateMcp ? " (isolated)" : " (inherits parent MCPs)";
        console.log(`  ${name}: ${profile.description}`);
        console.log(`    servers: ${servers}${profile.servers.length > 0 ? isolated : ""}  model: ${model}`);
      }
      console.log();

      if (existsSync(cacheFile)) {
        console.log("Resolved MCP config (injected on claude -p calls):");
        const raw = readFileSync(cacheFile, "utf-8");
        console.log(JSON.stringify(JSON.parse(raw), null, 2));
      }
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program.parse();
