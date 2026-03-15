export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ProfileConfig {
  description: string;
  servers: string[];
  model?: string;
  isolateMcp?: boolean;
  maxBudget?: number;
  systemPrompt?: string;
}

export interface ScpConfig {
  mcpServers: Record<string, McpServerConfig>;
  profiles: Record<string, ProfileConfig>;
  defaults?: {
    model?: string;
    maxBudget?: number;
    profile?: string;
  };
}

export interface ClaudeResult {
  result: string;
  is_error: boolean;
  total_cost_usd: number;
  duration_ms: number;
  session_id: string;
  num_turns: number;
}

export interface QueryResult {
  text: string;
  cost: number;
  durationMs: number;
  model: string;
  profile: string;
}
