// feishu/src/claude-code-executor.ts

/**
 * Unified Claude Code execution function.
 *
 * Extracts the shared logic from the former handleHappyCommand() and
 * handleSuperpowerCommand() into a single function, parameterized by
 * execution mode (happy vs. skill).
 */

import path from "node:path";
import type { ClawdbotConfig } from "./bot-runtime-api.js";
import { isClaudeSDKAvailable } from "./claude-code-preflight.js";
import { buildSkillPrompt } from "./command-registry.js";
import {
  writeSessionToMemory,
  extractExecutionDetails,
  type ClaudeCodeSession,
  type StreamEventData,
} from "./memory-bridge.js";
import {
  sendPermissionCard,
  waitForPermissionResponse,
  isApproveAllEnabled,
  setApproveAllEnabled,
} from "./permission-handler.js";
import { sendQuestionCard } from "./question-handler.js";
import { HappyClawSDK } from "./sdk/HappyClawSDK.js";
import type {
  StreamEvent,
  PermissionRequest,
  PermissionResult,
  QuestionRequest,
  QuestionResult,
} from "./sdk/types.js";
import { sendMessageFeishu } from "./send.js";
import { StreamingCardManager } from "./streaming-card-manager.js";
import type { ResolvedFeishuAccount } from "./types.js";

// --- Constants ---
const PERMISSION_TIMEOUT_MS = 120_000;
const DEFAULT_HAPPY_WORKING_DIR = "/tmp/happy_feishu";
const SESSION_CACHE_TTL_MS = 3_600_000; // 1 hour

// --- Allowed working directory roots ---
const ALLOWED_ROOTS: readonly string[] = [
  process.env.OPENCLAW_MEMORY_DIR || "/root/.openclaw/workspace/memory",
  process.env.OPENCLAW_WORKSPACE_DIR || process.cwd(),
  DEFAULT_HAPPY_WORKING_DIR,
];

/** Returns true when `dir` resolves to a path within one of the allowed roots. */
export function isWithinAllowedRoot(dir: string): boolean {
  const resolved = path.resolve(path.normalize(dir));
  return ALLOWED_ROOTS.some((root) => {
    const resolvedRoot = path.resolve(path.normalize(root));
    return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
  });
}

// --- Session cache (per-chatId Claude session for multi-turn conversations) ---
const cachedClaudeSession = new Map<string, { sessionId: string; expiresAt: number }>();

export function getCachedSessionId(chatId: string): string | undefined {
  const entry = cachedClaudeSession.get(chatId);
  if (!entry) {
    return undefined;
  }
  if (Date.now() > entry.expiresAt) {
    cachedClaudeSession.delete(chatId);
    return undefined;
  }
  return entry.sessionId;
}

export function setCachedSessionId(chatId: string, sessionId: string): void {
  cachedClaudeSession.set(chatId, {
    sessionId,
    expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
  });
}

export function clearCachedSession(chatId: string): void {
  cachedClaudeSession.delete(chatId);
}

// --- Concurrency guard ---
let activeExecution = false;

export function isExecutionActive(): boolean {
  return activeExecution;
}

// --- Execution mode ---
export type ExecutionMode =
  | { kind: "happy" }
  | { kind: "skill"; skillId: string; commandName: string };

// --- Execution params ---
export interface ClaudeCodeExecutionParams {
  cfg: ClawdbotConfig;
  account: ResolvedFeishuAccount;
  chatId: string;
  senderOpenId: string;
  prompt: string;
  mode: ExecutionMode;
  options?: {
    newSession?: boolean;
    resetApproveAll?: boolean;
  };
  log: (...args: unknown[]) => void;
}

/**
 * Unified Claude Code execution function.
 * Handles both /happy and skill command execution with shared SDK setup,
 * permission handling, streaming, and memory bridge.
 */
/** Generate a short request ID for cross-layer tracing. */
function generateRequestId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export async function executeClaudeCode(params: ClaudeCodeExecutionParams): Promise<void> {
  const { cfg, account, chatId, senderOpenId, prompt, mode, options, log } = params;
  const label = mode.kind === "skill" ? `/${mode.commandName}` : "/happy";
  const requestId = generateRequestId();
  const rlog = (...args: unknown[]) => log(`[feishu:exec:${requestId}]`, ...args);

  // --- SDK availability gate ---
  if (!isClaudeSDKAvailable()) {
    rlog(`SDK not available for ${label}`);
    await sendMessageFeishu({
      cfg,
      to: `chat:${chatId}`,
      text: `[${label}] Claude Code is not available. Please install @anthropic-ai/claude-agent-sdk to use this feature.`,
      accountId: account.accountId,
    });
    return;
  }

  // --- Concurrency guard ---
  if (activeExecution) {
    rlog(`Rejected — another execution is active`);
    await sendMessageFeishu({
      cfg,
      to: `chat:${chatId}`,
      text: `[${label}] Another command is currently running. Please wait.`,
      accountId: account.accountId,
    });
    return;
  }

  // --- Reset approve-all if requested ---
  if (options?.resetApproveAll) {
    setApproveAllEnabled(false);
    rlog(`approve-all reset`);
    if (!prompt) {
      await sendMessageFeishu({
        cfg,
        to: `chat:${chatId}`,
        text: `[${label}] Approve-all mode has been reset. Future tool use will require individual approval.`,
        accountId: account.accountId,
      });
      return;
    }
  }

  // --- New session if requested ---
  if (options?.newSession) {
    cachedClaudeSession.delete(chatId);
    rlog(`new session requested`);
  }

  // --- Validate prompt ---
  if (!prompt) {
    await sendMessageFeishu({
      cfg,
      to: `chat:${chatId}`,
      text: `[${label}] Please provide a prompt. Example: ${label} what files are in this directory?`,
      accountId: account.accountId,
    });
    return;
  }

  activeExecution = true;

  const feishuCfg = account.config as Record<string, unknown> | undefined;
  const workingDirectory =
    (feishuCfg?.happyWorkingDirectory as string) || DEFAULT_HAPPY_WORKING_DIR;

  // --- Working directory validation ---
  if (!isWithinAllowedRoot(workingDirectory)) {
    console.warn(
      `[feishu:exec:${requestId}] Rejected working directory outside allowed roots:`,
      workingDirectory,
    );
    activeExecution = false;
    await sendMessageFeishu({
      cfg,
      to: `chat:${chatId}`,
      text: `[${label}] Error: The configured working directory is outside the allowed roots. Execution aborted.`,
      accountId: account.accountId,
    });
    return;
  }

  const cardManager = new StreamingCardManager(cfg, account.accountId, requestId);

  const streamEvents: StreamEventData[] = [];

  // Build mode-specific session metadata
  const taskDescription =
    mode.kind === "skill" ? `/${mode.commandName} ${prompt}` : prompt.substring(0, 200);
  const initialAction =
    mode.kind === "skill"
      ? `Executed skill command: /${mode.commandName}`
      : `Executed /happy command in ${workingDirectory}`;
  const initialInsights: string[] = mode.kind === "skill" ? [`Skill: ${mode.skillId}`] : [];
  const initialContext =
    mode.kind === "skill"
      ? `Command: /${mode.commandName} ${prompt}\nSkill: ${mode.skillId}`
      : `Prompt: ${prompt}`;

  let sessionData: ClaudeCodeSession = {
    userId: account.accountId,
    chatId,
    task: taskDescription,
    actions: [initialAction],
    toolsUsed: [],
    filesModified: [],
    result: "failure",
    insights: initialInsights,
    fullContext: initialContext,
    error: undefined,
  };

  try {
    await cardManager.startSession(chatId, requestId);

    // --- Permission callback ---
    const onPermission = async (request: PermissionRequest): Promise<PermissionResult> => {
      if (isApproveAllEnabled()) {
        rlog(`auto-approved tool: ${request.toolName}`);
        return { approved: true };
      }
      await sendPermissionCard({
        account,
        chatId,
        permissionId: request.permissionId,
        toolName: request.toolName,
        toolInput: request.toolInput,
      });
      return waitForPermissionResponse(
        request.permissionId,
        PERMISSION_TIMEOUT_MS,
        chatId,
        senderOpenId,
      );
    };

    // --- Stream event handler ---
    const onStreamEvent = (event: StreamEvent): void => {
      streamEvents.push({
        type: event.type,
        data: event.data,
        timestamp: event.timestamp || Date.now(),
      });
      cardManager.handleEvent(chatId, event);
    };

    // --- Question callback ---
    const onAskUserQuestion = async (request: QuestionRequest): Promise<QuestionResult> => {
      rlog(`AskUserQuestion called with ${request.questions.length} question(s)`);
      const { questionId, answerPromise } = await sendQuestionCard(
        { questionId: "pending", questions: request.questions },
        PERMISSION_TIMEOUT_MS,
        chatId,
      );
      rlog(`waiting for question answer (ID: ${questionId})`);
      const answer = await answerPromise;
      rlog(`question answered: ${answer.answered}`);
      return answer;
    };

    // --- Session resume ---
    const claudeSessionId = getCachedSessionId(chatId);
    if (claudeSessionId) {
      rlog(`resuming session ${claudeSessionId}`);
    }

    // --- Build prompt ---
    let constrainedPrompt: string;
    if (mode.kind === "skill") {
      const skillPrompt = buildSkillPrompt(mode.skillId, prompt);
      constrainedPrompt = `Work exclusively within ${workingDirectory}. ${skillPrompt}`;
    } else {
      constrainedPrompt = `Work exclusively within ${workingDirectory}. ${prompt}`;
    }

    // --- Execute ---
    const sdk = new HappyClawSDK({
      workingDirectory,
      permissionMode: "default",
      onPermission,
      onStreamEvent,
      onAskUserQuestion,
    });
    const result = await sdk.execute(constrainedPrompt, { claudeSessionId, requestId });

    if (result.claudeSessionId) {
      setCachedSessionId(chatId, result.claudeSessionId);
    }

    await cardManager.endSession(chatId);
    rlog(`command completed (success=${result.success})`);

    // --- Build execution details for memory ---
    const executionDetails = extractExecutionDetails(streamEvents);
    const insights: string[] = [
      ...initialInsights,
      result.success ? "Command completed successfully" : "Command encountered errors",
      `Working directory: ${workingDirectory}`,
    ];
    if (executionDetails.toolsUsed.length > 0) {
      insights.push(`Tools used: ${executionDetails.toolsUsed.join(", ")}`);
    }
    if (executionDetails.filesModified.length > 0) {
      insights.push(`Modified ${executionDetails.filesModified.length} file(s)`);
    }
    if (executionDetails.commandsExecuted.length > 0) {
      insights.push(`Executed ${executionDetails.commandsExecuted.length} command(s)`);
    }

    let fullContext = `${initialContext}\n\n`;
    if (executionDetails.toolsUsed.length > 0) {
      fullContext += `Tools Used: ${executionDetails.toolsUsed.join(", ")}\n`;
    }
    if (executionDetails.filesModified.length > 0) {
      fullContext += `Files Modified:\n${executionDetails.filesModified.map((f) => `  - ${f}`).join("\n")}\n`;
    }
    if (executionDetails.commandsExecuted.length > 0) {
      fullContext += `Commands Executed:\n${executionDetails.commandsExecuted.map((c) => `  - ${c}`).join("\n")}\n`;
    }
    fullContext += `\nResult: ${result.success ? "Success" : result.error || "Failed"}`;

    sessionData = {
      ...sessionData,
      actions: executionDetails.actions.length > 0 ? executionDetails.actions : sessionData.actions,
      toolsUsed: executionDetails.toolsUsed,
      filesModified: executionDetails.filesModified,
      result: result.success ? "success" : "failure",
      insights,
      fullContext,
      error: result.error,
      requestId,
    };
  } catch (err) {
    rlog(`command failed: ${String(err)}`);

    sessionData = {
      ...sessionData,
      result: "failure",
      insights: [...initialInsights, "Command failed with error"],
      fullContext: `${initialContext}\n\nError: ${String(err)}`,
      error: String(err),
      requestId,
    };

    const errorManager = new StreamingCardManager(cfg, account.accountId, requestId);
    try {
      await errorManager.startSession(chatId);
      errorManager.handleEvent(chatId, {
        type: "status",
        data: "error",
        timestamp: Date.now(),
      });
      await errorManager.endSession(chatId);
    } catch {
      await sendMessageFeishu({
        cfg,
        to: `chat:${chatId}`,
        text: `[${label}] Error: ${String(err)}`,
        accountId: account.accountId,
      });
    } finally {
      errorManager.destroy();
    }
  } finally {
    writeSessionToMemory(sessionData).catch((memErr) => {
      console.error(`[feishu:exec:${requestId}] Failed to write session: ${memErr}`);
    });
    cardManager.destroy();
    activeExecution = false;
  }
}
