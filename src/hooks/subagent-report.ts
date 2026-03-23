#!/usr/bin/env node

/**
 * SubagentStop hook — reports MCP tool usage from subagent transcripts.
 *
 * Receives the hook payload as JSON on stdin. Reads the subagent's
 * transcript JSONL, finds all mcp__* tool calls, and prints a one-line
 * summary to stderr. Silent when no MCP tools were used.
 *
 * Zero external dependencies — node builtins only.
 */

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

interface HookPayload {
  agent_type?: string;
  agent_transcript_path?: string;
}

interface ToolUseEntry {
  type: "tool_use";
  name: string;
}

interface TranscriptMessage {
  content?: Array<ToolUseEntry | { type: string }>;
}

interface TranscriptLine {
  message?: TranscriptMessage;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => chunks.push(line));
    rl.on("close", () => resolve(chunks.join("\n")));
  });
}

function extractMcpToolNames(transcriptPath: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf-8");
  } catch {
    return [];
  }

  const names: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: TranscriptLine;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === "tool_use" && "name" in block && (block as ToolUseEntry).name.startsWith("mcp__")) {
        names.push((block as ToolUseEntry).name);
      }
    }
  }
  return names;
}

function formatSummary(agentType: string, mcpNames: string[]): string {
  // Count occurrences of each short name (strip mcp__server__ prefix)
  const counts = new Map<string, number>();
  for (const full of mcpNames) {
    // mcp__server__tool → tool
    const parts = full.split("__");
    const short = parts.length >= 3 ? parts.slice(2).join("__") : full;
    counts.set(short, (counts.get(short) ?? 0) + 1);
  }

  const parts: string[] = [];
  for (const [name, count] of counts) {
    parts.push(count > 1 ? `${name} \u00d7${count}` : name);
  }

  return `[sub-mcp] ${agentType} agent: ${mcpNames.length} MCP call${mcpNames.length === 1 ? "" : "s"} (${parts.join(", ")})`;
}

async function main(): Promise<void> {
  const input = await readStdin();
  let payload: HookPayload;
  try {
    payload = JSON.parse(input);
  } catch {
    return; // malformed input — stay silent
  }

  const transcriptPath = payload.agent_transcript_path;
  if (!transcriptPath) return;

  const mcpNames = extractMcpToolNames(transcriptPath);
  if (mcpNames.length === 0) return;

  const agentType = payload.agent_type ?? "unknown";
  process.stderr.write(formatSummary(agentType, mcpNames) + "\n");
}

main();
