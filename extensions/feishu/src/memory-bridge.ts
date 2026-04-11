// src/memory-bridge.ts
/**
 * Enhanced OpenClaw Memory Bridge for Feishu Plugin
 *
 * Automatically writes Claude Code sessions to OpenClaw memory files, with support for:
 * - Auto-indexing (makes new files immediately searchable)
 * - Message notifications (sends messages directly to agent)
 * - Complete session records and key insight extraction
 *
 * Hybrid approach (cost-optimized):
 * - Full summary → OpenClaw memory file (free)
 * - Key insights → OpenClaw agent notification (~200 tokens)
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Session data captured from Claude Code execution
 */
export interface ClaudeCodeSession {
  /** Feishu user ID */
  userId: string;
  /** Chat ID (direct message or group chat) */
  chatId: string;
  /** Task brief description */
  task: string;
  /** List of actions taken during session */
  actions: string[];
  /** Tools used (Read, Edit, Bash, etc.) */
  toolsUsed: string[];
  /** Files that were modified */
  filesModified: string[];
  /** Session result */
  result: "success" | "failure" | "partial";
  /** Key insights from the session */
  insights: string[];
  /** Full context/detailed summary */
  fullContext: string;
  /** Session duration in milliseconds */
  duration?: number;
  /** Error message when failed */
  error?: string;
  /** Cross-layer request tracing ID */
  requestId?: string;
}

/**
 * Memory write result
 */
export interface MemoryWriteResult {
  success: boolean;
  filepath?: string;
  error?: string;
}

/** Cached CLI availability result: null = unchecked, boolean = checked */
let openclawAvailable: boolean | null = null;

/** Log prefix for consistent structured logging */
const LOG_PREFIX = "[feishu:memory-bridge]";

/**
 * Check whether the `openclaw` CLI is available in PATH.
 *
 * The result is cached after the first probe so subsequent calls are free.
 * We spawn `openclaw --version` with a short timeout; ENOENT or any error
 * means the binary is not reachable.
 */
async function checkOpenClawAvailable(): Promise<boolean> {
  if (openclawAvailable !== null) {
    return openclawAvailable;
  }

  return new Promise<boolean>((resolve) => {
    const proc = spawn("openclaw", ["--version"], { stdio: "ignore" });

    const timer = setTimeout(() => {
      proc.kill();
      openclawAvailable = false;
      console.warn(
        `${LOG_PREFIX} openclaw CLI not found in PATH — memory bridge auto-index and notifications disabled`,
      );
      resolve(false);
    }, 5_000);

    proc.on("error", () => {
      clearTimeout(timer);
      openclawAvailable = false;
      console.warn(
        `${LOG_PREFIX} openclaw CLI not found in PATH — memory bridge auto-index and notifications disabled`,
      );
      resolve(false);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      openclawAvailable = code === 0;
      if (!openclawAvailable) {
        console.warn(
          `${LOG_PREFIX} openclaw CLI exited with code ${code} — memory bridge auto-index and notifications disabled`,
        );
      }
      resolve(openclawAvailable);
    });
  });
}

/**
 * Check whether the memory bridge is disabled via environment variable.
 *
 * Set `FEISHU_MEMORY_BRIDGE_ENABLED=false` or `FEISHU_MEMORY_BRIDGE_ENABLED=0`
 * to disable all memory bridge operations.
 */
function isBridgeDisabledByEnv(): boolean {
  const val = process.env.FEISHU_MEMORY_BRIDGE_ENABLED;
  return val === "false" || val === "0";
}

/**
 * Spawn a child process with automatic retry on transient failures.
 *
 * ENOENT errors (binary not found) are never retried. Other errors
 * are retried up to `retries` times with a 2-second delay between attempts.
 */
async function spawnWithRetry(
  command: string,
  args: string[],
  options: SpawnOptions,
  retries = 1,
): Promise<ChildProcess> {
  return new Promise<ChildProcess>((resolve, reject) => {
    function attempt(remaining: number): void {
      const proc = spawn(command, args, options);

      proc.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT" || remaining <= 0) {
          reject(err);
          return;
        }
        console.warn(
          `${LOG_PREFIX} spawn failed (${err.message}), retrying in 2s (${remaining} left)`,
        );
        setTimeout(() => attempt(remaining - 1), 2_000);
      });

      proc.on("spawn", () => {
        resolve(proc);
      });
    }

    attempt(retries);
  });
}

/**
 * Default memory directory - can be overridden via OPENCLAW_MEMORY_DIR env var
 */
const DEFAULT_MEMORY_DIR = "/root/.openclaw/workspace/memory";

/**
 * Get the memory directory from environment variable or use default
 */
function getMemoryDir(): string {
  return process.env.OPENCLAW_MEMORY_DIR || DEFAULT_MEMORY_DIR;
}

/**
 * OpenClaw Memory Bridge
 *
 * Writes Claude Code sessions to OpenClaw memory files (markdown format),
 * with support for auto-indexing and agent notifications.
 */
export class OpenClawMemoryBridge {
  private memoryDir: string;
  private enabled: boolean;
  private autoIndex: boolean;
  private autoNotify: boolean;

  constructor(
    memoryDir?: string,
    options?: {
      autoIndex?: boolean;
      autoNotify?: boolean;
    },
  ) {
    this.memoryDir = memoryDir ?? getMemoryDir();
    this.autoIndex = options?.autoIndex ?? true; // Auto-index enabled by default
    this.autoNotify = options?.autoNotify ?? true; // Auto-notify enabled by default

    if (isBridgeDisabledByEnv()) {
      this.enabled = false;
      console.warn(`${LOG_PREFIX} disabled via FEISHU_MEMORY_BRIDGE_ENABLED env var`);
      return;
    }

    this.enabled = existsSync(this.memoryDir);

    if (!this.enabled) {
      console.warn(`${LOG_PREFIX} OpenClaw memory directory does not exist: ${this.memoryDir}`);
      console.warn(`${LOG_PREFIX} Memory bridge is disabled, will not write files.`);
    } else {
      console.log(`${LOG_PREFIX} Initialization complete, directory: ${this.memoryDir}`);
      console.log(`${LOG_PREFIX} Auto-index: ${this.autoIndex ? "enabled" : "disabled"}`);
      console.log(`${LOG_PREFIX} Auto-notify: ${this.autoNotify ? "enabled" : "disabled"}`);
    }
  }

  /**
   * Check if memory bridge is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Write Claude Code session to OpenClaw memory
   *
   * @param session - Session data to write
   * @returns Result with file path (if successful)
   */
  async writeSession(session: ClaudeCodeSession): Promise<MemoryWriteResult> {
    if (!this.enabled) {
      return {
        success: false,
        error: "Memory bridge disabled - directory does not exist",
      };
    }

    try {
      const sessionId = randomUUID();
      const timestamp = new Date();
      const dateStr = timestamp.toISOString().split("T")[0]; // YYYY-MM-DD
      const _timeStr = timestamp.toTimeString().split(" ")[0]; // HH:MM:SS

      // Create filename: YYYY-MM-DD-claude-code-{task-abbrev}-{session-id-8-chars}.md
      // Sanitize task: remove path separators and special chars, limit to 20 chars
      const taskAbbrev = session.task
        .substring(0, 20)
        .replace(/[/\\:*?"<>|]/g, "-") // Replace path-unsafe chars
        .replace(/\s+/g, "-") // Replace spaces
        .toLowerCase();
      const sessionIdShort = sessionId.substring(0, 8);
      const filename = `${dateStr}-claude-code-${taskAbbrev || "task"}-${sessionIdShort}.md`;
      const filepath = join(this.memoryDir, filename);

      // Format as OpenClaw memory markdown
      const content = this.formatMarkdown(sessionId, timestamp, session);

      // Ensure directory exists
      await mkdir(this.memoryDir, { recursive: true });

      // Write file
      await writeFile(filepath, content, "utf-8");

      console.log(`${LOG_PREFIX} Session written: ${filepath}`);
      console.log(`${LOG_PREFIX} Task: ${session.task}`);
      console.log(`${LOG_PREFIX} User: ${session.userId}`);
      if (session.requestId) {
        console.log(`${LOG_PREFIX} Request ID: ${session.requestId}`);
      }

      const result: MemoryWriteResult = {
        success: true,
        filepath,
      };

      // Auto-index memory (async, non-blocking)
      if (this.autoIndex) {
        this.reindexMemory()
          .then((indexed) => {
            if (indexed) {
              console.log(`${LOG_PREFIX} Memory reindex complete`);
            }
          })
          .catch((err) => {
            console.error(`${LOG_PREFIX} Reindex failed:`, err);
          });
      }

      // Auto-notify agent (async, non-blocking)
      if (this.autoNotify) {
        this.notifyAgent(filepath, session.insights)
          .then((notified) => {
            if (notified) {
              console.log(`${LOG_PREFIX} Agent notification sent`);
            }
          })
          .catch((err) => {
            console.error(`${LOG_PREFIX} Agent notification failed:`, err);
          });
      }

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`${LOG_PREFIX} Failed to write session: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Format session data as OpenClaw memory markdown
   */
  private formatMarkdown(sessionId: string, timestamp: Date, session: ClaudeCodeSession): string {
    const dateStr = timestamp.toISOString();
    const actions = session.actions.map((a) => `- ${a}`).join("\n");
    const files = session.filesModified.map((f) => `- ${f}`).join("\n") || "- (none)";
    const tools = session.toolsUsed.join(", ") || "none";
    const insights = session.insights.map((i) => `- ${i}`).join("\n") || "- (none)";

    const durationStr = session.duration ? `${Math.round(session.duration / 1000)}s` : "N/A";

    return `# Session: ${dateStr}

- **Session key**: claude-code:feishu:${session.userId}:${timestamp.getTime()}
- **Session ID**: ${sessionId}
- **Source**: claude-code-plugin
- **User**: ${session.userId}
- **Chat**: ${session.chatId}
${session.requestId ? `- **Request ID**: ${session.requestId}\n` : ""}

## Session Summary

**Task**: ${session.task}

**Actions taken**:
${actions}

**Tools used**: ${tools}

**Files modified**:
${files}

**Result**: ${session.result}
**Duration**: ${durationStr}

${session.error ? `**Error**: ${session.error}\n` : ""}

## Key Insights

${insights}

## Full Context

${session.fullContext}

---
`;
  }

  /**
   * Re-index OpenClaw memory files
   *
   * Triggers OpenClaw to rescan the memory directory and index new files.
   * Call this method after writing new memory files to make them searchable.
   */
  async reindexMemory(): Promise<boolean> {
    const available = await checkOpenClawAvailable();
    if (!available) {
      return false;
    }

    try {
      console.log(`${LOG_PREFIX} Re-indexing OpenClaw memory...`);

      const proc = await spawnWithRetry("openclaw", ["memory", "index", "--force"], {
        stdio: "ignore",
        detached: true,
      });

      // Don't wait for completion - fire and forget
      proc.unref();

      console.log(`${LOG_PREFIX} Memory reindex started in background`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${LOG_PREFIX} Reindex failed: ${msg}`);
      return false;
    }
  }

  /**
   * Send notification message to OpenClaw agent
   *
   * Sends a brief message to the OpenClaw agent about new memory.
   * Used to enable immediate agent awareness.
   */
  async notifyAgent(memoryFile: string, insights: string[]): Promise<boolean> {
    const available = await checkOpenClawAvailable();
    if (!available) {
      return false;
    }

    try {
      const insightText = insights.slice(0, 3).join("; ");
      const message = `[Memory Update] New session saved to ${memoryFile}\n\nKey insights: ${insightText}`;

      console.log(`${LOG_PREFIX} Notifying OpenClaw agent...`);

      const proc = await spawnWithRetry("openclaw", ["agent", "--message", message], {
        stdio: "ignore",
        detached: true,
      });

      // Don't wait for completion
      proc.unref();

      console.log(`${LOG_PREFIX} Agent notification sent`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${LOG_PREFIX} Agent notification failed: ${msg}`);
      return false;
    }
  }

  /**
   * Extract session data from execution context
   *
   * This is a helper method for building session data from execution context.
   * You can customize this method based on available data in your implementation.
   */
  static extractSessionFromContext(context: {
    userId: string;
    chatId: string;
    prompt: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    streamEvents: any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result: any;
    startTime: number;
    endTime: number;
  }): ClaudeCodeSession {
    const { userId, chatId, prompt, streamEvents, result, startTime, endTime } = context;

    // Extract tool usage from stream events
    const toolUses: string[] = [];
    const files: Set<string> = new Set();

    for (const event of streamEvents) {
      if (event.type === "tool_use") {
        toolUses.push(event.name);
        // Extract file paths from tool input
        if (event.name === "read_file" && event.input?.file_path) {
          files.add(event.input.file_path);
        }
        if (event.name === "write_file" && event.input?.file_path) {
          files.add(event.input.file_path);
        }
        if (event.name === "edit_file" && event.input?.file_path) {
          files.add(event.input.file_path);
        }
      }
    }

    // Generate insights from execution
    const insights: string[] = [];
    if (toolUses.includes("bash")) {
      insights.push("User executed shell commands");
    }
    if (files.size > 0) {
      insights.push(`Modified ${files.size} files`);
    }
    if (result.error) {
      insights.push("Session encountered errors");
    }

    // Build task description from prompt
    const task = prompt.substring(0, 200);

    return {
      userId,
      chatId,
      task,
      actions: [`Executed prompt: "${task.substring(0, 50)}..."`],
      toolsUsed: toolUses,
      filesModified: Array.from(files),
      result: result.error ? "failure" : "success",
      insights,
      fullContext: `Prompt: ${prompt}\n\nResult: ${JSON.stringify(result, null, 2)}`,
      duration: endTime - startTime,
      error: result.error,
    };
  }
}

/**
 * Global memory bridge instance
 */
let globalMemoryBridge: OpenClawMemoryBridge | null = null;

/**
 * Get or create the global memory bridge instance
 */
export function getMemoryBridge(): OpenClawMemoryBridge {
  if (!globalMemoryBridge) {
    globalMemoryBridge = new OpenClawMemoryBridge();
  }
  return globalMemoryBridge;
}

/**
 * Stream event data from SDK execution
 */
export interface StreamEventData {
  type: string;
  data: unknown;
  timestamp?: number;
}

/**
 * Extract tool usage and file modifications from stream events
 *
 * Analyzes stream events to extract:
 * - Tools used (Read, Write, Edit, Bash, etc.)
 * - Files that were read or modified
 * - Commands that were executed
 *
 * @param events - Stream events from SDK execution
 * @returns Object with tools used and files modified
 */
export function extractExecutionDetails(events: StreamEventData[]): {
  toolsUsed: string[];
  filesModified: string[];
  filesRead: string[];
  commandsExecuted: string[];
  actions: string[];
} {
  const toolsUsed = new Set<string>();
  const filesModified = new Set<string>();
  const filesRead = new Set<string>();
  const commandsExecuted = new Set<string>();
  const actions: string[] = [];

  for (const event of events) {
    if (event.type === "tool_use") {
      const data = event.data as { toolName?: string; input?: string | Record<string, unknown> };

      if (!data?.toolName) {
        continue;
      }

      const toolName = data.toolName;
      toolsUsed.add(toolName);

      // Parse tool input to extract file paths
      let toolInput: Record<string, unknown> | null = null;
      if (typeof data.input === "string") {
        try {
          toolInput = JSON.parse(data.input) as Record<string, unknown>;
        } catch {
          // Not JSON, skip parsing
        }
      } else if (typeof data.input === "object" && data.input !== null) {
        toolInput = data.input;
      }

      if (!toolInput) {
        continue;
      }

      // Extract file paths based on tool type
      switch (toolName) {
        case "read_file":
        case "Read": {
          const filePath = toolInput.file_path as string | undefined;
          if (filePath) {
            filesRead.add(filePath);
            actions.push(`📖 Read: ${filePath}`);
          }
          break;
        }
        case "write_file":
        case "Write": {
          const filePath = toolInput.file_path as string | undefined;
          if (filePath) {
            filesModified.add(filePath);
            actions.push(`✍️  Write: ${filePath}`);
          }
          break;
        }
        case "edit_file":
        case "Edit": {
          const filePath = toolInput.file_path as string | undefined;
          if (filePath) {
            filesModified.add(filePath);
            actions.push(`✏️  Edit: ${filePath}`);
          }
          break;
        }
        case "bash":
        case "Bash":
        case "command":
        case "run_command": {
          const command = toolInput.command as string | undefined;
          if (command) {
            commandsExecuted.add(command);
            // Truncate long commands for display
            const displayCmd = command.length > 60 ? command.substring(0, 57) + "..." : command;
            actions.push(`💻 Bash: ${displayCmd}`);
          }
          break;
        }
        case "web_search":
        case "WebSearch": {
          const query = toolInput.query as string | undefined;
          if (query) {
            actions.push(`🔍 Web: ${query}`);
          }
          break;
        }
        default: {
          actions.push(`🔧 Tool: ${toolName}`);
          break;
        }
      }
    }

    // Track tool results for additional context
    if (event.type === "tool_result") {
      const data = event.data as { output?: string; exitCode?: number };
      if (data?.exitCode === 0) {
        // Tool succeeded - could add more analysis here
      }
    }
  }

  return {
    toolsUsed: Array.from(toolsUsed),
    filesModified: Array.from(filesModified),
    filesRead: Array.from(filesRead),
    commandsExecuted: Array.from(commandsExecuted),
    actions: actions.length > 0 ? actions : ["Executed task"],
  };
}

/**
 * Write session to memory using global bridge
 *
 * Convenience function that handles null check and logging.
 * Note: autoIndex and autoNotify are determined by global bridge configuration,
 * configurable via environment variables:
 * - OPENCLAW_MEMORY_DIR: Memory directory path
 *
 * @param session - Session data to write
 * @returns Result with file path if successful
 */
export async function writeSessionToMemory(session: ClaudeCodeSession): Promise<MemoryWriteResult> {
  if (isBridgeDisabledByEnv()) {
    return { success: false, error: "Bridge disabled via FEISHU_MEMORY_BRIDGE_ENABLED" };
  }

  const bridge = getMemoryBridge();
  if (!bridge.isEnabled()) {
    console.log(`${LOG_PREFIX} Skipping - bridge not enabled`);
    return { success: false, error: "Bridge not enabled" };
  }

  return await bridge.writeSession(session);
}
