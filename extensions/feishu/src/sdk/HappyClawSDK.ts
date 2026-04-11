// src/HappyClawSDK.ts

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import type {
  HappyClawSDKOptions,
  PermissionCallback,
  ExecutionResult,
  ExecutionOptions,
  ToolType,
  QuestionCallback,
} from "./types.js";

/**
 * Happy Claw SDK
 * Wrapper for Claude Agent SDK with permission control support
 */
export class HappyClawSDK {
  private workingDirectory: string;
  private claudePath: string;
  private timeout: number;
  private permissionMode: HappyClawSDKOptions["permissionMode"];
  private model: string;
  private onPermission: PermissionCallback | undefined;
  /**
   * Stream event callback for real-time output
   *
   * When provided, stream events (text_delta, tool_use, etc.) will be
   * emitted during execution via this callback.
   */
  private onStreamEvent: import("./types.js").StreamEventHandler | undefined;
  /**
   * Question callback for AskUserQuestion
   *
   * When provided, will be called when Claude needs to ask the user a question.
   */
  private onAskUserQuestion: QuestionCallback | undefined;
  private sdkAvailable: boolean = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private agentSdk: any = null;
  private currentAbortController: AbortController | null = null;

  constructor(options: HappyClawSDKOptions = {}) {
    this.workingDirectory = options.workingDirectory || "/tmp/happy-claw-sdk";
    this.claudePath = options.claudePath || "claude";
    this.timeout = options.timeout || 120000;
    this.permissionMode = options.permissionMode || "default";
    this.model = options.model || "claude-sonnet-4-6";
    this.onPermission = options.onPermission;
    this.onStreamEvent = options.onStreamEvent;
    this.onAskUserQuestion = options.onAskUserQuestion;

    // Load Claude Agent SDK
    this.loadAgentSDK();
  }

  /**
   * Load Claude Agent SDK
   */
  private loadAgentSDK(): void {
    try {
      const require = createRequire(import.meta.url);
      this.agentSdk = require("@anthropic-ai/claude-agent-sdk");
      this.sdkAvailable = true;
      console.log("[HappyClawSDK] Claude Agent SDK loaded successfully");
    } catch {
      this.sdkAvailable = false;
      console.log("[HappyClawSDK] Claude Agent SDK not available, will use CLI fallback");
    }
  }

  /**
   * Get tool type for permission display
   */
  private getToolType(toolName: string): string {
    const fileRead = ["read_file", "directory_tree"];
    const fileWrite = ["write_file", "edit_file"];
    const commands = ["bash", "command", "run_command"];
    const web = ["web_search", "read_website"];

    if (fileRead.includes(toolName)) {
      return "file_read";
    }
    if (fileWrite.includes(toolName)) {
      return "file_write";
    }
    if (commands.includes(toolName)) {
      return "command";
    }
    if (web.includes(toolName)) {
      return "web_search";
    }
    return "unknown";
  }

  /**
   * Execute command
   */
  async execute(prompt: string, options?: ExecutionOptions): Promise<ExecutionResult> {
    const rid = options?.requestId;
    const tag = rid ? `[feishu:sdk:${rid}]` : "[HappyClawSDK]";
    console.log(`${tag} Executing: "${prompt.substring(0, 100)}..."`);

    if (!existsSync(this.workingDirectory)) {
      this.workingDirectory = this.workingDirectory || "/tmp/happy-claw-sdk";
      spawn("mkdir", ["-p", this.workingDirectory]);
    }

    // Resolve effective callbacks (per-execution overrides take precedence)
    const effectiveOnPermission = options?.onPermission ?? this.onPermission;
    const effectiveOnStreamEvent = options?.onStreamEvent ?? this.onStreamEvent;

    // Use streaming if all conditions met
    if (this.sdkAvailable && effectiveOnPermission && effectiveOnStreamEvent) {
      console.log(`${tag} Using streaming with permission handling`);
      return this.executeStream(prompt, options);
    }

    // Otherwise use non-streaming SDK if available
    if (this.sdkAvailable && effectiveOnPermission) {
      console.log(`${tag} Using Agent SDK with permission handling`);
      return this.executeWithSDK(prompt, options);
    }

    // Fallback to CLI
    console.log(`${tag} Using CLI (no permission handling)`);
    return this.executeWithCLI(prompt);
  }

  /**
   * Execute command with streaming events
   * @param prompt - Command prompt to execute
   * @returns Execution result
   */
  async executeStream(prompt: string, options?: ExecutionOptions): Promise<ExecutionResult> {
    const rid = options?.requestId;
    const tag = rid ? `[feishu:sdk:${rid}]` : "[HappyClawSDK]";
    console.log(`${tag} Executing stream: "${prompt.substring(0, 100)}..."`);

    // Ensure working directory exists
    if (!existsSync(this.workingDirectory)) {
      console.log(`${tag} Creating working directory: ${this.workingDirectory}`);
      spawn("mkdir", ["-p", this.workingDirectory]);
    }

    // Resolve effective callbacks (per-execution overrides take precedence)
    const effectiveOnPermission = options?.onPermission ?? this.onPermission;
    const effectiveOnStreamEvent = options?.onStreamEvent ?? this.onStreamEvent;

    // Fall back to non-streaming if SDK unavailable or no callbacks
    if (!this.sdkAvailable || !effectiveOnStreamEvent || !effectiveOnPermission) {
      console.log(`${tag} Falling back to non-streaming execute`);
      return this.execute(prompt, options);
    }

    return this.executeWithSDKStream(prompt, options);
  }

  /**
   * Execute using Claude Agent SDK
   */
  private async executeWithSDK(
    prompt: string,
    options?: ExecutionOptions,
  ): Promise<ExecutionResult> {
    try {
      const { unstable_v2_prompt } = this.agentSdk;

      console.log("[HappyClawSDK] Starting SDK execution...");
      if (options?.claudeSessionId) {
        console.log(`[HappyClawSDK] Resuming Claude session: ${options.claudeSessionId}`);
      }

      // Create an abort controller for this execution
      const abortController = new AbortController();

      // Resolve effective permission callback (per-execution override takes precedence)
      const effectiveOnPermission = options?.onPermission ?? this.onPermission;

      // Build options with optional resume
      const sdkOptions: Record<string, unknown> = {};
      if (options?.claudeSessionId) {
        sdkOptions.resume = options.claudeSessionId;
      }

      const result = await unstable_v2_prompt(prompt, {
        model: this.model,
        cwd: this.workingDirectory,
        permissionMode: this.permissionMode,
        signal: abortController.signal,
        options: sdkOptions,
        canUseTool: async (
          toolName: string,
          input: Record<string, unknown>,
          toolOpts: { signal: AbortSignal },
        ) => {
          console.log(`[HappyClawSDK] SDK tool use requested: ${toolName}`);

          if (!effectiveOnPermission) {
            return { behavior: "allow" as const };
          }

          const permissionId = `perm-${randomBytes(16).toString("hex")}`;
          const request = {
            toolName,
            toolInput: input,
            permissionId,
            signal: toolOpts.signal,
            toolType: this.getToolType(toolName) as ToolType,
          };

          const permissionResult = await effectiveOnPermission(request);

          if (!permissionResult.approved) {
            console.log(`[HappyClawSDK] Tool use denied: ${toolName}`);
            return {
              behavior: "deny" as const,
              message: permissionResult.reason || `User denied: ${toolName}`,
            };
          }

          console.log(`[HappyClawSDK] Tool use approved: ${toolName}`);
          return {
            behavior: "allow" as const,
            updatedInput: permissionResult.modifiedInput || input,
          };
        },
      });

      console.log("[HappyClawSDK] SDK execution completed");
      console.log("[HappyClawSDK] Result type:", result.type, "subtype:", result.subtype);

      // Capture session_id from result
      const capturedSessionId = result.session_id as string | undefined;

      let output = "Execution completed";
      if (result.type === "result") {
        if (result.subtype === "success") {
          output = result.result || result.text || "Execution completed successfully";
        } else {
          output = result.text || JSON.stringify(result);
        }
      } else if (result.text) {
        output = result.text;
      }

      console.log("[HappyClawSDK] Output length:", output.length);

      return {
        success: true,
        output,
        mode: "sdk" as const,
        claudeSessionId: capturedSessionId,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Handle abort errors
      if (errorMsg.includes("aborted") || errorMsg.includes("AbortError")) {
        console.log(`[HappyClawSDK] Execution aborted`);
        return {
          success: false,
          error: "Execution aborted",
          mode: "sdk" as const,
        };
      }

      console.error(`[HappyClawSDK] SDK execution failed: ${errorMsg}`);

      return {
        success: false,
        error: errorMsg,
        mode: "sdk" as const,
      };
    }
  }

  /**
   * Execute with SDK streaming support
   */
  private async executeWithSDKStream(
    prompt: string,
    options?: ExecutionOptions,
  ): Promise<ExecutionResult> {
    // Resolve effective callbacks before try block so they're available in catch
    const effectiveOnStreamEvent = options?.onStreamEvent ?? this.onStreamEvent;
    const effectiveOnAskUserQuestion = options?.onAskUserQuestion ?? this.onAskUserQuestion;
    const rid = options?.requestId;
    const tag = rid ? `[feishu:sdk:${rid}]` : "[HappyClawSDK]";

    let capturedSessionId: string | undefined;
    try {
      const { query } = this.agentSdk;
      this.currentAbortController = new AbortController();

      console.log(`${tag} Starting SDK streaming execution...`);
      if (options?.claudeSessionId) {
        console.log(`${tag} Resuming Claude session: ${options.claudeSessionId}`);
      }

      // Resolve effective callbacks (per-execution overrides take precedence)
      const effectiveOnPermission = options?.onPermission ?? this.onPermission;

      // Track accumulated content
      let fullOutput = "";

      // Build query options — query() expects { prompt, options: { ...allSdkOptions } }
      const queryOptions: Record<string, unknown> = {
        model: this.model,
        cwd: this.workingDirectory,
        permissionMode: this.permissionMode,
        signal: this.currentAbortController.signal,
        includePartialMessages: true,
      };
      if (options?.claudeSessionId) {
        queryOptions.resume = options.claudeSessionId;
      }

      // canUseTool must be inside options for query() API
      queryOptions.canUseTool = async (
        toolName: string,
        input: Record<string, unknown>,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        opts: any,
      ) => {
        console.log(`[DEBUG-SDK] ========== CAN USE TOOL CALLED ==========`);
        console.log(`[DEBUG-SDK] Tool Name: ${toolName}`);
        console.log(`[DEBUG-SDK] Tool Input:`, JSON.stringify(input, null, 2));
        console.log(`[DEBUG-SDK] Has onPermission callback: ${!!effectiveOnPermission}`);
        console.log(`[DEBUG-SDK] Timestamp: ${new Date().toISOString()}`);
        console.log(`[DEBUG-SDK] ==============================================\n`);

        // Handle AskUserQuestion tool specially
        if (toolName === "AskUserQuestion" && effectiveOnAskUserQuestion) {
          console.log(`[DEBUG-SDK] ========== ASK USER QUESTION ==========`);
          // Emit the question event to display the UI
          if (effectiveOnStreamEvent) {
            effectiveOnStreamEvent({
              type: "ask_user_question",
              data: input,
              timestamp: Date.now(),
            });
          }

          // Wait for the user's answer
          try {
            const questionResult = await effectiveOnAskUserQuestion({
              questions: input.questions as Array<{
                header: string;
                question: string;
                options: Array<{
                  label: string;
                  description: string;
                }>;
              }>,
              signal: opts.signal,
            });

            console.log(`[DEBUG-SDK] Question answered: ${questionResult.answered}`);

            if (questionResult.answered && questionResult.answers) {
              // Format the answer as expected by the SDK
              const answersArray = Array.from(questionResult.answers.entries()).map(
                ([idx, answer]) => ({
                  questionIndex: idx,
                  answer,
                }),
              );

              console.log(`[DEBUG-SDK] Answers:`, JSON.stringify(answersArray, null, 2));

              // Build human-readable summary pairing questions with answers
              const questions = Array.isArray(input.questions)
                ? (input.questions as Array<{ header?: string; question?: string }>)
                : [];
              const summaryLines = answersArray.map(({ questionIndex, answer }) => {
                const q = questions[questionIndex];
                const header = q?.header || `Q${questionIndex + 1}`;
                const questionText = q?.question || "";
                return `Q${questionIndex + 1} [${header}]: ${questionText} -> ${answer}`;
              });
              const answerSummary = summaryLines.join("\n");

              console.log(`[DEBUG-SDK] Answer summary:\n${answerSummary}`);

              // Use 'deny' behavior to send the formatted answers directly to Claude
              // as the tool result. Using 'allow' would cause the AskUserQuestion tool
              // to run its own CLI prompt, which fails in a headless Feishu context
              // and causes Claude to not receive the answers.
              return {
                behavior: "deny" as const,
                message: `The user has answered your questions via Feishu:\n\n${answerSummary}\n\nPlease proceed with these answers.`,
              };
            } else {
              // User didn't answer, deny the tool use
              return {
                behavior: "deny" as const,
                message: "No answer provided",
              };
            }
          } catch (error) {
            console.error(`[DEBUG-SDK] Question handling error:`, error);
            return {
              behavior: "deny" as const,
              message: `Question handling failed: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        }

        if (!effectiveOnPermission) {
          console.log(`[DEBUG-SDK] No permission callback, allowing tool use automatically`);
          return { behavior: "allow" as const };
        }

        const permissionId = `perm-${randomBytes(16).toString("hex")}`;
        console.log(`[DEBUG-SDK] Generated Permission ID: ${permissionId}`);

        const request = {
          toolName,
          toolInput: input,
          permissionId,
          signal: opts.signal,
          toolType: this.getToolType(toolName) as ToolType,
        };

        console.log(`[DEBUG-SDK] Calling onPermission callback...`);
        const permissionResult = await effectiveOnPermission(request);

        console.log(`[DEBUG-SDK] ========== PERMISSION RESULT ==========`);
        console.log(`[DEBUG-SDK] Permission ID: ${permissionId}`);
        console.log(`[DEBUG-SDK] Approved: ${permissionResult.approved}`);
        if (permissionResult.reason) {
          console.log(`[DEBUG-SDK] Reason: ${permissionResult.reason}`);
        }
        console.log(`[DEBUG-SDK] Timestamp: ${new Date().toISOString()}`);
        console.log(`[DEBUG-SDK] ========================================\n`);

        if (!permissionResult.approved) {
          console.log(`[DEBUG-SDK] Tool use DENIED: ${toolName}`);
          return {
            behavior: "deny" as const,
            message: permissionResult.reason || `User denied: ${toolName}`,
          };
        }

        console.log(`[DEBUG-SDK] Tool use APPROVED: ${toolName}`);
        return {
          behavior: "allow" as const,
          updatedInput: permissionResult.modifiedInput || input,
        };
      };

      for await (const message of query({
        prompt,
        options: queryOptions,
      })) {
        // Capture session_id from any message (all types include it)
        if (!capturedSessionId && message.session_id) {
          capturedSessionId = message.session_id;
        }

        // Handle different message types
        if (message.type === "stream_event") {
          this.handleStreamEvent(message.event, {
            onTextDelta: (text: string) => {
              fullOutput += text;
              if (effectiveOnStreamEvent) {
                effectiveOnStreamEvent({
                  type: "text_delta",
                  data: { text },
                  timestamp: Date.now(),
                });
              }
            },
            onToolUse: (tool: string, toolInput: string) => {
              if (effectiveOnStreamEvent) {
                effectiveOnStreamEvent({
                  type: "tool_use",
                  data: { toolName: tool, input: toolInput },
                  timestamp: Date.now(),
                });
              }
            },
            onToolResult: (result: string, exitCode: number) => {
              if (effectiveOnStreamEvent) {
                effectiveOnStreamEvent({
                  type: "tool_result",
                  data: { output: result, exitCode },
                  timestamp: Date.now(),
                });
              }
            },
            onThinking: (content: string) => {
              if (effectiveOnStreamEvent) {
                effectiveOnStreamEvent({
                  type: "thinking",
                  data: { content },
                  timestamp: Date.now(),
                });
              }
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onAskUserQuestion: (questions: any) => {
              if (effectiveOnStreamEvent) {
                effectiveOnStreamEvent({
                  type: "ask_user_question",
                  data: questions,
                  timestamp: Date.now(),
                });
              }
            },
          });
        } else if (message.type === "result") {
          // Final result -- also capture session_id from result
          if (message.session_id) {
            capturedSessionId = capturedSessionId || message.session_id;
          }
          if (message.result) {
            fullOutput = message.result || fullOutput;
          }
        }
      }

      console.log(`${tag} SDK streaming completed`);
      if (capturedSessionId) {
        console.log(`${tag} Claude session ID: ${capturedSessionId}`);
      }

      // Emit final status event
      if (effectiveOnStreamEvent) {
        effectiveOnStreamEvent({
          type: "status",
          data: "complete",
          timestamp: Date.now(),
        });
      }

      return {
        success: true,
        output: fullOutput,
        mode: "sdk" as const,
        claudeSessionId: capturedSessionId,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      if (errorMsg.includes("aborted") || errorMsg.includes("AbortError")) {
        console.log(`${tag} Execution aborted`);

        // Emit error status event
        if (effectiveOnStreamEvent) {
          effectiveOnStreamEvent({
            type: "status",
            data: "error",
            timestamp: Date.now(),
          });
        }

        return {
          success: false,
          error: "Execution cancelled",
          mode: "sdk" as const,
          claudeSessionId: capturedSessionId,
        };
      }

      console.error(`${tag} SDK streaming failed: ${errorMsg}`);

      // Emit error status event
      if (effectiveOnStreamEvent) {
        effectiveOnStreamEvent({
          type: "status",
          data: "error",
          timestamp: Date.now(),
        });
      }

      return {
        success: false,
        error: errorMsg,
        mode: "sdk" as const,
        claudeSessionId: capturedSessionId,
      };
    } finally {
      this.currentAbortController = null;
    }
  }

  /**
   * Emit a stream event callback
   */
  private emitStreamEvent(type: import("./types.js").StreamEventType, data: unknown): void {
    if (this.onStreamEvent) {
      this.onStreamEvent({ type, data, timestamp: Date.now() });
    }
  }

  /**
   * Handle raw stream event from SDK
   */
  private handleStreamEvent(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    event: any,
    handlers: {
      onTextDelta: (text: string) => void;
      onToolUse: (tool: string, input: string) => void;
      onToolResult: (result: string, exitCode: number) => void;
      onThinking: (content: string) => void;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onAskUserQuestion?: (questions: any) => void;
    },
  ): void {
    if (!event) {
      return;
    }

    switch (event.type) {
      case "content_block_start":
        if (event.content_block?.type === "tool_use") {
          const toolName = event.content_block.name;
          const toolId = event.index;
          // Initialize accumulator for this tool's input
          if (!this._toolInputAccumulators) {
            this._toolInputAccumulators = new Map();
          }
          this._toolInputAccumulators.set(toolId, { toolName, partialInput: "" });
          // Emit tool_use with empty input initially (will be updated via deltas)
          handlers.onToolUse(toolName, "");
        }
        break;

      case "content_block_delta":
        if (event.delta?.type === "text_delta") {
          handlers.onTextDelta(event.delta.text || "");
        } else if (event.delta?.type === "thinking_delta") {
          handlers.onThinking(event.delta.thinking || "");
        } else if (event.delta?.type === "input_json_delta") {
          // Accumulate partial JSON input for tool calls
          const toolId = event.index;
          const acc = this._toolInputAccumulators?.get(toolId);
          if (acc) {
            acc.partialInput += event.delta.partial_json || "";
          }
        }
        break;

      case "content_block_stop":
        // Tool input is complete - emit with full input
        const stopToolId = event.index;
        const stopAcc = this._toolInputAccumulators?.get(stopToolId);
        if (stopAcc) {
          if (stopAcc.partialInput) {
            // Re-emit tool_use with complete input
            handlers.onToolUse(stopAcc.toolName, stopAcc.partialInput);
          }
          this._toolInputAccumulators?.delete(stopToolId);
        }
        // Tool execution completed - emit completion status
        this.emitStreamEvent("status", {
          content: "Tool execution completed",
        });
        break;

      case "message_start":
        // Handle user messages which may contain tool results
        if (event.message?.role === "user") {
          const content = event.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "tool_result") {
                // Extract tool result output
                let output = "";
                if (typeof block.content === "string") {
                  output = block.content;
                } else if (Array.isArray(block.content)) {
                  output = block.content
                    .map((c: unknown) => (c as { text?: string }).text || "")
                    .join("\n");
                } else {
                  output = JSON.stringify(block.content || "");
                }
                const exitCode = block.is_error ? 1 : 0;
                handlers.onToolResult(output, exitCode);
              }
            }
          }
        }
        break;

      case "message_delta":
        // Message level deltas
        if (event.delta?.stop_reason === "tool_use") {
          // Tool result will come separately
        }
        break;

      case "ask_user_question":
        // Handle AskUserQuestion events from Claude Agent SDK
        if (handlers.onAskUserQuestion && event.questions) {
          handlers.onAskUserQuestion(event.questions);
        }
        break;
    }
  }

  /** Tool input accumulators for streaming */
  private _toolInputAccumulators?: Map<number, { toolName: string; partialInput: string }>;

  /**
   * Execute using CLI (fallback)
   */
  private async executeWithCLI(prompt: string): Promise<ExecutionResult> {
    return new Promise((resolve) => {
      const timeoutTimer = setTimeout(() => {
        resolve({
          success: false,
          error: "Execution timed out",
          mode: "cli" as const, // NEW
        });
      }, this.timeout);

      void (async () => {
        try {
          // Write prompt to temporary file
          const promptFile = join(this.workingDirectory, `prompt-${Date.now()}.txt`);
          await writeFile(promptFile, prompt);

          // Start claude CLI
          const claude = spawn(this.claudePath, [promptFile], {
            cwd: this.workingDirectory,
            env: { ...process.env },
          });

          let output = "";
          let errorOutput = "";

          claude.stdout?.on("data", (data) => {
            output += data.toString();
          });

          claude.stderr?.on("data", (data) => {
            errorOutput += data.toString();
          });

          claude.on("close", (code) => {
            clearTimeout(timeoutTimer);

            if (code === 0) {
              resolve({
                success: true,
                output: output || "Execution completed",
                mode: "cli" as const, // NEW: Track CLI mode
              });
            } else {
              resolve({
                success: false,
                error: errorOutput || `CLI exited with code ${code}`,
                mode: "cli" as const, // NEW
              });
            }
          });
        } catch (error) {
          clearTimeout(timeoutTimer);
          resolve({
            success: false,
            error: error instanceof Error ? error.message : String(error),
            mode: "cli" as const, // NEW
          });
        }
      })();
    });
  }

  /**
   * Abort ongoing execution
   */
  abort(): void {
    if (this.currentAbortController) {
      this.emitStreamEvent("status", { content: "Aborting..." });
      this.currentAbortController.abort();
    }
  }

  /**
   * Check if SDK is available
   */
  isSDKAvailable(): boolean {
    return this.sdkAvailable;
  }

  /**
   * Get model name
   */
  getModel(): string {
    return this.model;
  }

  /**
   * Set permission callback
   */
  setPermissionCallback(callback: PermissionCallback): void {
    this.onPermission = callback;
  }

  /**
   * Set working directory for Claude execution
   */
  setWorkingDirectory(dir: string): void {
    this.workingDirectory = dir;
  }

  /**
   * Check if Claude CLI is available (for debugging/fallback)
   */
  async checkCLIAvailable(): Promise<boolean> {
    const { spawn } = await import("node:child_process");
    return new Promise((resolve) => {
      const proc = spawn(this.claudePath, ["--version"], {
        stdio: "ignore",
        shell: true,
      });
      proc.on("close", (code) => resolve(code === 0));
      proc.on("error", () => resolve(false));
    });
  }
}
