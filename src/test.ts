import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadConfig, resolveConfigEnv, buildMcpConfigJson } from "./config.js";
import { parseArgs, resolveEnvVarsInJson } from "./argv.js";
import {
  shouldInjectMcp,
  buildInjectedArgs,
  buildMcpJson,
  type CachedConfig,
} from "./wrapper.js";
import {
  generateAgentFiles,
  generateRulesFile,
  cleanGeneratedFiles,
} from "./cli.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp directory, write a file inside it, return the dir path. */
function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "sub-mcp-test-"));
}

function writeTempConfig(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf-8");
  return p;
}

// ---------------------------------------------------------------------------
// Config tests
// ---------------------------------------------------------------------------

describe("loadConfig()", () => {
  it("finds and parses a profiles.yml correctly", () => {
    const dir = makeTempDir();
    try {
      const yml = `
mcpServers:
  myserver:
    command: npx
    args: ["-y", "some-mcp"]

profiles:
  mypro:
    description: "A test profile"
    servers: [myserver]
    model: haiku
`;
      writeTempConfig(dir, "profiles.yml", yml);
      const config = loadConfig(join(dir, "profiles.yml"));
      assert.ok(config.mcpServers["myserver"]);
      assert.equal(config.mcpServers["myserver"].command, "npx");
      assert.ok(config.profiles["mypro"]);
      assert.equal(config.profiles["mypro"].model, "haiku");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("throws on a missing config file", () => {
    assert.throws(
      () => loadConfig("/nonexistent/path/to/profiles.yml"),
      /Config not found/
    );
  });

  it("throws when a profile references a nonexistent server", () => {
    const dir = makeTempDir();
    try {
      const yml = `
mcpServers:
  realserver:
    command: npx
    args: []

profiles:
  broken:
    description: "Broken profile"
    servers: [ghostserver]
`;
      writeTempConfig(dir, "profiles.yml", yml);
      assert.throws(
        () => loadConfig(join(dir, "profiles.yml")),
        /references unknown server/
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("throws on profile with non-array servers", () => {
    const dir = makeTempDir();
    try {
      const yml = `
mcpServers:
  s:
    command: npx
    args: []

profiles:
  broken:
    description: "servers is a string"
    servers: "s"
`;
      writeTempConfig(dir, "profiles.yml", yml);
      assert.throws(
        () => loadConfig(join(dir, "profiles.yml")),
        /servers must be an array/
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("throws on profiles defined as a non-object", () => {
    const dir = makeTempDir();
    try {
      const yml = `
mcpServers:
  s:
    command: npx
    args: []

profiles: "not an object"
`;
      writeTempConfig(dir, "profiles.yml", yml);
      assert.throws(
        () => loadConfig(join(dir, "profiles.yml")),
        /profiles as an object/
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("does NOT resolve env vars — they stay as ${VAR} placeholders", () => {
    const dir = makeTempDir();
    try {
      const yml = `
mcpServers:
  s:
    command: npx
    args: []
    env:
      TOKEN: "\${MY_SECRET_TOKEN}"

profiles:
  p:
    description: "env test"
    servers: [s]
`;
      writeTempConfig(dir, "profiles.yml", yml);
      const config = loadConfig(join(dir, "profiles.yml"));
      assert.equal(config.mcpServers["s"].env?.["TOKEN"], "${MY_SECRET_TOKEN}");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("resolveConfigEnv()", () => {
  it("resolves ${VAR} patterns from process.env", () => {
    const dir = makeTempDir();
    try {
      const yml = `
mcpServers:
  s:
    command: npx
    args: []
    env:
      API_KEY: "\${SUB_MCP_TEST_API_KEY}"

profiles:
  p:
    description: "resolve test"
    servers: [s]
`;
      writeTempConfig(dir, "profiles.yml", yml);
      const config = loadConfig(join(dir, "profiles.yml"));

      const saved = process.env["SUB_MCP_TEST_API_KEY"];
      process.env["SUB_MCP_TEST_API_KEY"] = "supersecret";
      try {
        const resolved = resolveConfigEnv(config);
        assert.equal(resolved.mcpServers["s"].env?.["API_KEY"], "supersecret");
      } finally {
        if (saved === undefined) {
          delete process.env["SUB_MCP_TEST_API_KEY"];
        } else {
          process.env["SUB_MCP_TEST_API_KEY"] = saved;
        }
      }
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("throws on missing env vars", () => {
    const dir = makeTempDir();
    try {
      const yml = `
mcpServers:
  s:
    command: npx
    args: []
    env:
      TOKEN: "\${SUB_MCP_TEST_DEFINITELY_MISSING_VAR_XYZ}"

profiles:
  p:
    description: "missing env test"
    servers: [s]
`;
      writeTempConfig(dir, "profiles.yml", yml);
      const config = loadConfig(join(dir, "profiles.yml"));

      delete process.env["SUB_MCP_TEST_DEFINITELY_MISSING_VAR_XYZ"];

      assert.throws(
        () => resolveConfigEnv(config),
        /Environment variable SUB_MCP_TEST_DEFINITELY_MISSING_VAR_XYZ is not set/
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("buildMcpConfigJson()", () => {
  it("returns correct JSON for a named profile", () => {
    const dir = makeTempDir();
    try {
      const yml = `
mcpServers:
  alpha:
    command: node
    args: ["alpha.js"]
  beta:
    command: node
    args: ["beta.js"]

profiles:
  only-alpha:
    description: "just alpha"
    servers: [alpha]
`;
      writeTempConfig(dir, "profiles.yml", yml);
      const config = loadConfig(join(dir, "profiles.yml"));
      const json = buildMcpConfigJson(config, "only-alpha");
      const parsed = JSON.parse(json) as {
        mcpServers: Record<string, unknown>;
      };
      assert.ok(parsed.mcpServers["alpha"]);
      assert.equal(parsed.mcpServers["beta"], undefined);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("throws on an unknown profile", () => {
    const dir = makeTempDir();
    try {
      const yml = `
mcpServers:
  s:
    command: npx
    args: []

profiles:
  known:
    description: "known"
    servers: [s]
`;
      writeTempConfig(dir, "profiles.yml", yml);
      const config = loadConfig(join(dir, "profiles.yml"));
      assert.throws(
        () => buildMcpConfigJson(config, "unknown-profile"),
        /Unknown profile/
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// parseArgs tests
// ---------------------------------------------------------------------------

describe("parseArgs()", () => {
  it('treats -p as isSubagent=true', () => {
    const result = parseArgs(["-p", "hello"]);
    assert.equal(result.isSubagent, true);
    assert.equal(result.hasMcpConfig, false);
  });

  it('treats --print as isSubagent=true', () => {
    const result = parseArgs(["--print", "hello"]);
    assert.equal(result.isSubagent, true);
    assert.equal(result.hasMcpConfig, false);
  });

  it('--model alone does not set isSubagent', () => {
    const result = parseArgs(["--model", "haiku"]);
    assert.equal(result.isSubagent, false);
    assert.equal(result.hasMcpConfig, false);
  });

  it('detects --mcp-config alongside -p', () => {
    const result = parseArgs(["-p", "hello", "--mcp-config", "{}"]);
    assert.equal(result.isSubagent, true);
    assert.equal(result.hasMcpConfig, true);
  });

  it('detects --mcp-config=value form (--flag=value)', () => {
    const result = parseArgs(["--mcp-config={}", "-p", "hello"]);
    assert.equal(result.isSubagent, true);
    assert.equal(result.hasMcpConfig, true);
  });

  it('--version returns isSubagent=false, hasMcpConfig=false', () => {
    const result = parseArgs(["--version"]);
    assert.equal(result.isSubagent, false);
    assert.equal(result.hasMcpConfig, false);
  });

  it('empty array returns isSubagent=false, hasMcpConfig=false', () => {
    const result = parseArgs([]);
    assert.equal(result.isSubagent, false);
    assert.equal(result.hasMcpConfig, false);
  });

  it('treats --print=value form as isSubagent=true', () => {
    const result = parseArgs(["--print=do my task"]);
    assert.equal(result.isSubagent, true);
    assert.equal(result.hasMcpConfig, false);
  });
});

// ---------------------------------------------------------------------------
// resolveEnvVarsInJson tests
// ---------------------------------------------------------------------------

describe("resolveEnvVarsInJson()", () => {
  it("resolves ${FOO} when FOO is set", () => {
    const result = resolveEnvVarsInJson('{"key":"${FOO}"}', { FOO: "bar" });
    assert.equal(result, '{"key":"bar"}');
  });

  it("throws on missing env vars", () => {
    assert.throws(
      () => resolveEnvVarsInJson('{"key":"${MISSING}"}', {}),
      /Missing environment variables: MISSING/
    );
  });

  it("reports all missing vars in one error", () => {
    assert.throws(
      () => resolveEnvVarsInJson('{"a":"${X}","b":"${Y}"}', {}),
      /Missing environment variables: X, Y/
    );
  });

  it("JSON-escapes values with special characters", () => {
    const result = resolveEnvVarsInJson('{"key":"${TOKEN}"}', {
      TOKEN: 'has"quotes\\and\nnewlines',
    });
    // Must be valid JSON
    const parsed = JSON.parse(result) as { key: string };
    assert.equal(parsed.key, 'has"quotes\\and\nnewlines');
  });

  it("passes through strings with no placeholders unchanged", () => {
    const input = '{"no":"vars","here":42}';
    const result = resolveEnvVarsInJson(input, {});
    assert.equal(result, input);
  });
});

// ---------------------------------------------------------------------------
// cache format tests
// ---------------------------------------------------------------------------

describe("cache format", () => {
  it("includes profiles and defaults alongside mcpServers", () => {
    const dir = makeTempDir();
    try {
      const yml = `
mcpServers:
  alpha:
    command: node
    args: ["a.js"]
  beta:
    command: node
    args: ["b.js"]

profiles:
  onlyAlpha:
    description: "just alpha"
    servers: [alpha]
    isolateMcp: true
  all:
    description: "everything"
    servers: [alpha, beta]

defaults:
  profile: onlyAlpha
  maxBudget: 2.0
`;
      writeTempConfig(dir, "profiles.yml", yml);
      const config = loadConfig(join(dir, "profiles.yml"));

      // Build cache the same way cli.ts does
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

      // Verify structure
      assert.ok(cache.mcpServers["alpha"]);
      assert.ok(cache.mcpServers["beta"]);
      assert.deepStrictEqual(cache.profiles["onlyAlpha"].servers, ["alpha"]);
      assert.equal(cache.profiles["onlyAlpha"].isolateMcp, true);
      assert.deepStrictEqual(cache.profiles["all"].servers, ["alpha", "beta"]);
      assert.equal(cache.defaults?.profile, "onlyAlpha");
      assert.equal(cache.defaults?.maxBudget, 2.0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// defaults.profile tests
// ---------------------------------------------------------------------------

describe("defaults.profile", () => {
  it("parses defaults.profile from config", () => {
    const dir = makeTempDir();
    try {
      const yml = `
mcpServers:
  s:
    command: npx
    args: []

profiles:
  myprofile:
    description: "test"
    servers: [s]

defaults:
  profile: myprofile
`;
      writeTempConfig(dir, "profiles.yml", yml);
      const config = loadConfig(join(dir, "profiles.yml"));
      assert.equal(config.defaults?.profile, "myprofile");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("defaults.profile is optional", () => {
    const dir = makeTempDir();
    try {
      const yml = `
mcpServers:
  s:
    command: npx
    args: []

profiles:
  p:
    description: "test"
    servers: [s]

defaults:
  maxBudget: 1.0
`;
      writeTempConfig(dir, "profiles.yml", yml);
      const config = loadConfig(join(dir, "profiles.yml"));
      assert.equal(config.defaults?.profile, undefined);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// wrapper function tests (shouldInjectMcp, buildMcpJson, buildInjectedArgs)
// ---------------------------------------------------------------------------

describe("shouldInjectMcp()", () => {
  it("returns true when subagent mode and no existing mcp-config", () => {
    assert.equal(shouldInjectMcp(true, false), true);
  });

  it("returns false when not in subagent mode", () => {
    assert.equal(shouldInjectMcp(false, false), false);
  });

  it("returns false when mcp-config already present", () => {
    assert.equal(shouldInjectMcp(true, true), false);
  });
});

describe("buildMcpJson()", () => {
  const config: CachedConfig = {
    mcpServers: {
      alpha: { command: "node", args: ["a.js"] },
      beta: { command: "node", args: ["b.js"] },
    },
    profiles: {
      onlyAlpha: { servers: ["alpha"], isolateMcp: true },
      all: { servers: ["alpha", "beta"] },
      empty: { servers: [] },
    },
  };

  it("filters servers by profile", () => {
    const json = buildMcpJson(config, "onlyAlpha");
    assert.ok(json);
    const parsed = JSON.parse(json) as { mcpServers: Record<string, unknown> };
    assert.ok(parsed.mcpServers["alpha"]);
    assert.equal(parsed.mcpServers["beta"], undefined);
  });

  it("returns all servers when no profile specified", () => {
    const json = buildMcpJson(config, undefined);
    assert.ok(json);
    const parsed = JSON.parse(json) as { mcpServers: Record<string, unknown> };
    assert.ok(parsed.mcpServers["alpha"]);
    assert.ok(parsed.mcpServers["beta"]);
  });

  it("returns null for empty server list", () => {
    const json = buildMcpJson(config, "empty");
    assert.equal(json, null);
  });

  it("returns null for unknown profile (fail closed)", () => {
    const json = buildMcpJson(config, "nonexistent");
    assert.equal(json, null);
  });
});

describe("buildInjectedArgs()", () => {
  const config: CachedConfig = {
    mcpServers: {
      alpha: { command: "node", args: ["a.js"] },
      beta: { command: "node", args: ["b.js"] },
    },
    profiles: {
      isolated: { servers: ["alpha"], isolateMcp: true },
      shared: { servers: ["alpha"] },
      customPrompt: { servers: ["alpha"], systemPrompt: "Custom instructions here" },
      empty: { servers: [] },
    },
  };

  it("appends --mcp-config with resolved JSON", () => {
    const args = buildInjectedArgs(["-p", "hello"], config, "shared");
    assert.ok(args.includes("--mcp-config"));
    const mcpIdx = args.indexOf("--mcp-config");
    const mcpJson = args[mcpIdx + 1];
    const parsed = JSON.parse(mcpJson) as { mcpServers: Record<string, unknown> };
    assert.ok(parsed.mcpServers["alpha"]);
  });

  it("adds --strict-mcp-config when isolateMcp is true", () => {
    const args = buildInjectedArgs(["-p", "hello"], config, "isolated");
    assert.ok(args.includes("--strict-mcp-config"));
  });

  it("does not add --strict-mcp-config when isolateMcp is false/unset", () => {
    const args = buildInjectedArgs(["-p", "hello"], config, "shared");
    assert.ok(!args.includes("--strict-mcp-config"));
  });

  it("adds --allowedTools to pre-approve injected MCP tools", () => {
    const args = buildInjectedArgs(["-p", "hello"], config, "shared");
    assert.ok(args.includes("--allowedTools"));
    const idx = args.indexOf("--allowedTools");
    assert.equal(args[idx + 1], "mcp__alpha__*");
  });

  it("adds --allowedTools for all servers when no profile specified", () => {
    const args = buildInjectedArgs(["-p", "hello"], config, undefined);
    const idx = args.indexOf("--allowedTools");
    assert.ok(idx !== -1);
    assert.ok(args[idx + 1].includes("mcp__alpha__*"));
    assert.ok(args[idx + 1].includes("mcp__beta__*"));
  });

  it("appends default MCP nudge after the prompt", () => {
    const args = buildInjectedArgs(["-p", "hello"], config, "shared");
    const pIdx = args.indexOf("-p");
    const prompt = args[pIdx + 1];
    assert.ok(prompt.includes("MCP tools"));
    assert.ok(prompt.includes("hello"));
    // Nudge appended after the original prompt, not before
    assert.ok(prompt.startsWith("hello"));
    assert.ok(prompt.indexOf("MCP tools") > prompt.indexOf("hello"));
  });

  it("appends custom systemPrompt when profile defines one", () => {
    const args = buildInjectedArgs(["-p", "hello"], config, "customPrompt");
    const pIdx = args.indexOf("-p");
    assert.ok(args[pIdx + 1].includes("Custom instructions here"));
    assert.ok(args[pIdx + 1].startsWith("hello"));
  });

  it("handles --print=value form for nudge injection", () => {
    const args = buildInjectedArgs(["--print=hello"], config, "shared");
    assert.ok(args[0].startsWith("--print=hello"));
    assert.ok(args[0].includes("MCP tools"));
  });

  it("does not add --allowedTools when profile has no servers", () => {
    const args = buildInjectedArgs(["-p", "hello"], config, "empty");
    assert.ok(!args.includes("--allowedTools"));
  });

  it("returns copy of args when profile has no servers", () => {
    const original = ["-p", "hello"];
    const args = buildInjectedArgs(original, config, "empty");
    assert.deepStrictEqual(args, ["-p", "hello"]);
    // Verify it's a copy, not the same array
    assert.notEqual(args, original);
  });
});

// ---------------------------------------------------------------------------
// Agent file generation tests
// ---------------------------------------------------------------------------

describe("generateAgentFiles()", () => {
  it("creates .claude/agents/<profile>.md for each profile", () => {
    const dir = makeTempDir();
    try {
      const config = loadConfig(writeTempConfig(dir, "profiles.yml", `
mcpServers:
  alpha:
    command: node
    args: ["a.js"]
  beta:
    command: node
    args: ["b.js"]

profiles:
  docs:
    description: "Documentation lookup"
    servers: [alpha]
    model: haiku
  all:
    description: "All servers"
    servers: [alpha, beta]
`));
      const files = generateAgentFiles(config, dir);
      assert.equal(files.length, 2);
      assert.ok(existsSync(join(dir, ".claude", "agents", "docs.md")));
      assert.ok(existsSync(join(dir, ".claude", "agents", "all.md")));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("includes mcpServers as list with inline definitions and type: stdio", () => {
    const dir = makeTempDir();
    try {
      const config = loadConfig(writeTempConfig(dir, "profiles.yml", `
mcpServers:
  myserver:
    command: npx
    args: ["-y", "some-mcp"]

profiles:
  test:
    description: "Test profile"
    servers: [myserver]
`));
      generateAgentFiles(config, dir);
      const content = readFileSync(join(dir, ".claude", "agents", "test.md"), "utf-8");
      // Should have frontmatter with mcpServers as list
      assert.ok(content.startsWith("---\n"));
      assert.ok(content.includes("mcpServers:"));
      assert.ok(content.includes("myserver:"));
      assert.ok(content.includes("type: stdio"));
      assert.ok(content.includes("command: npx"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("includes name and description in frontmatter", () => {
    const dir = makeTempDir();
    try {
      const config = loadConfig(writeTempConfig(dir, "profiles.yml", `
mcpServers:
  alpha:
    command: node
    args: ["a.js"]

profiles:
  test:
    description: "Test agent"
    servers: [alpha]
`));
      generateAgentFiles(config, dir);
      const content = readFileSync(join(dir, ".claude", "agents", "test.md"), "utf-8");
      assert.ok(content.includes("name: test"));
      assert.ok(content.includes("description: Test agent"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("includes model override when specified", () => {
    const dir = makeTempDir();
    try {
      const config = loadConfig(writeTempConfig(dir, "profiles.yml", `
mcpServers:
  s:
    command: npx
    args: []

profiles:
  fast:
    description: "Fast agent"
    servers: [s]
    model: haiku
`));
      generateAgentFiles(config, dir);
      const content = readFileSync(join(dir, ".claude", "agents", "fast.md"), "utf-8");
      assert.ok(content.includes("model: haiku"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("handles profiles with no servers (no mcpServers in frontmatter)", () => {
    const dir = makeTempDir();
    try {
      const config = loadConfig(writeTempConfig(dir, "profiles.yml", `
mcpServers:
  s:
    command: npx
    args: []

profiles:
  clean:
    description: "No MCPs"
    servers: []
`));
      generateAgentFiles(config, dir);
      const content = readFileSync(join(dir, ".claude", "agents", "clean.md"), "utf-8");
      assert.ok(!content.includes("mcpServers:"));
      assert.ok(content.includes("name: clean"));
      assert.ok(content.includes("No MCPs"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("uses custom systemPrompt when profile defines one", () => {
    const dir = makeTempDir();
    try {
      const config = loadConfig(writeTempConfig(dir, "profiles.yml", `
mcpServers:
  s:
    command: npx
    args: []

profiles:
  custom:
    description: "Custom prompt"
    servers: [s]
    systemPrompt: "Always use the MCP search tool first."
`));
      generateAgentFiles(config, dir);
      const content = readFileSync(join(dir, ".claude", "agents", "custom.md"), "utf-8");
      assert.ok(content.includes("Always use the MCP search tool first."));
      // Should NOT include the default nudge
      assert.ok(!content.includes("IMPORTANT INSTRUCTION OVERRIDE"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("preserves env var placeholders in mcpServers", () => {
    const dir = makeTempDir();
    try {
      const config = loadConfig(writeTempConfig(dir, "profiles.yml", `
mcpServers:
  s:
    command: npx
    args: []
    env:
      TOKEN: "\${MY_SECRET}"

profiles:
  envtest:
    description: "Env var test"
    servers: [s]
`));
      generateAgentFiles(config, dir);
      const content = readFileSync(join(dir, ".claude", "agents", "envtest.md"), "utf-8");
      assert.ok(content.includes("${MY_SECRET}"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("skips user-created files without generated marker", () => {
    const dir = makeTempDir();
    try {
      const config = loadConfig(writeTempConfig(dir, "profiles.yml", `
mcpServers:
  s:
    command: npx
    args: []

profiles:
  custom:
    description: "Test"
    servers: [s]
`));
      // Pre-create a user file without the generated marker
      const agentsDir = join(dir, ".claude", "agents");
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, "custom.md"), "My custom agent file\n");

      const files = generateAgentFiles(config, dir);
      assert.equal(files.length, 0);
      // User file should be preserved
      const content = readFileSync(join(agentsDir, "custom.md"), "utf-8");
      assert.equal(content, "My custom agent file\n");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("includes generated marker comment", () => {
    const dir = makeTempDir();
    try {
      const config = loadConfig(writeTempConfig(dir, "profiles.yml", `
mcpServers:
  s:
    command: npx
    args: []

profiles:
  test:
    description: "Test"
    servers: [s]
`));
      generateAgentFiles(config, dir);
      const content = readFileSync(join(dir, ".claude", "agents", "test.md"), "utf-8");
      assert.ok(content.includes("Generated by sub-mcp"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("generateRulesFile()", () => {
  it("creates .claude/rules/sub-mcp.md with profile inventory", () => {
    const dir = makeTempDir();
    try {
      const config = loadConfig(writeTempConfig(dir, "profiles.yml", `
mcpServers:
  alpha:
    command: node
    args: ["a.js"]

profiles:
  docs:
    description: "Doc lookup"
    servers: [alpha]
    model: haiku
  clean:
    description: "No MCPs"
    servers: []

defaults:
  profile: docs
`));
      const filePath = generateRulesFile(config, dir);
      assert.ok(existsSync(filePath));
      const content = readFileSync(filePath, "utf-8");
      assert.ok(content.includes("docs"));
      assert.ok(content.includes("Doc lookup"));
      assert.ok(content.includes("model: haiku"));
      assert.ok(content.includes("clean"));
      assert.ok(content.includes("No MCPs"));
      assert.ok(content.includes("Default profile: **docs**"));
      assert.ok(content.includes("Generated by sub-mcp"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("cleanGeneratedFiles()", () => {
  it("removes files with the generated marker", () => {
    const dir = makeTempDir();
    try {
      const agentsDir = join(dir, ".claude", "agents");
      const rulesDir = join(dir, ".claude", "rules");
      mkdirSync(agentsDir, { recursive: true });
      mkdirSync(rulesDir, { recursive: true });

      // Write a generated file
      writeFileSync(join(agentsDir, "test.md"), "content\n<!-- Generated by sub-mcp. Do not edit manually. -->\n");
      // Write a user-created file (no marker)
      writeFileSync(join(agentsDir, "manual.md"), "user content\n");
      // Write generated rules
      writeFileSync(join(rulesDir, "sub-mcp.md"), "rules\n<!-- Generated by sub-mcp. Do not edit manually. -->\n");

      const removed = cleanGeneratedFiles(dir);
      assert.equal(removed.length, 2);
      assert.ok(!existsSync(join(agentsDir, "test.md")));
      assert.ok(existsSync(join(agentsDir, "manual.md"))); // preserved
      assert.ok(!existsSync(join(rulesDir, "sub-mcp.md")));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("returns empty array when no generated files exist", () => {
    const dir = makeTempDir();
    try {
      const removed = cleanGeneratedFiles(dir);
      assert.equal(removed.length, 0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
