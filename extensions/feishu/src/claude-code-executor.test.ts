import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mock dependencies before imports ---
vi.mock("./claude-code-preflight.js", () => ({
  isClaudeSDKAvailable: vi.fn(() => true),
}));

const mockExecute = vi.fn(async () => ({
  success: true,
  claudeSessionId: "session_abc",
}));

vi.mock("./sdk/HappyClawSDK.js", () => ({
  HappyClawSDK: class MockHappyClawSDK {
    execute = mockExecute;
  },
}));

vi.mock("./streaming-card-manager.js", () => ({
  StreamingCardManager: class MockStreamingCardManager {
    startSession = vi.fn(async () => {});
    handleEvent = vi.fn();
    endSession = vi.fn(async () => {});
    destroy = vi.fn();
  },
}));

vi.mock("./permission-handler.js", () => ({
  sendPermissionCard: vi.fn(async () => {}),
  waitForPermissionResponse: vi.fn(async () => ({ approved: true })),
  isApproveAllEnabled: vi.fn(() => false),
  setApproveAllEnabled: vi.fn(),
}));

vi.mock("./memory-bridge.js", () => ({
  writeSessionToMemory: vi.fn(async () => {}),
  extractExecutionDetails: vi.fn(() => ({
    actions: [],
    toolsUsed: [],
    filesModified: [],
    commandsExecuted: [],
  })),
}));

vi.mock("./question-handler.js", () => ({
  sendQuestionCard: vi.fn(async () => ({
    questionId: "q1",
    answerPromise: Promise.resolve({ answered: true, answer: "yes" }),
  })),
}));

vi.mock("./send.js", () => ({
  sendMessageFeishu: vi.fn(async () => {}),
}));

vi.mock("./command-registry.js", () => ({
  buildSkillPrompt: vi.fn((skill: string, prompt: string) => `[SKILL:${skill}] ${prompt}`),
}));

import {
  executeClaudeCode,
  isExecutionActive,
  getCachedSessionId,
  clearCachedSession,
  isWithinAllowedRoot,
  type ClaudeCodeExecutionParams,
} from "./claude-code-executor.js";
import { isClaudeSDKAvailable } from "./claude-code-preflight.js";
import { buildSkillPrompt } from "./command-registry.js";
import { sendMessageFeishu } from "./send.js";

function makeParams(overrides?: Partial<ClaudeCodeExecutionParams>): ClaudeCodeExecutionParams {
  return {
    cfg: {} as ClaudeCodeExecutionParams["cfg"],
    account: { accountId: "acc_1", config: {} } as unknown as ClaudeCodeExecutionParams["account"],
    chatId: "chat_test",
    senderOpenId: "ou_sender",
    prompt: "list files",
    mode: { kind: "happy" },
    log: vi.fn(),
    ...overrides,
  };
}

describe("claude-code-executor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isClaudeSDKAvailable).mockReturnValue(true);
    mockExecute.mockResolvedValue({ success: true, claudeSessionId: "session_abc" });
    clearCachedSession("chat_test");
  });

  describe("SDK preflight gate", () => {
    it("returns early with user message when SDK is unavailable", async () => {
      vi.mocked(isClaudeSDKAvailable).mockReturnValue(false);

      await executeClaudeCode(makeParams());

      expect(sendMessageFeishu).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("not available"),
        }),
      );
      expect(mockExecute).not.toHaveBeenCalled();
    });
  });

  describe("concurrency guard", () => {
    it("rejects when another execution is already active", async () => {
      // Make the first execution hang indefinitely
      let resolveFirst!: (v: { success: boolean; claudeSessionId: string }) => void;
      mockExecute.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      );

      const first = executeClaudeCode(makeParams());

      // Yield to let first execution reach activeExecution = true
      await new Promise((r) => setTimeout(r, 10));

      // Second call should be rejected
      await executeClaudeCode(makeParams({ chatId: "chat_2" }));

      expect(sendMessageFeishu).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Another command is currently running"),
        }),
      );

      // Clean up first execution
      resolveFirst({ success: true, claudeSessionId: "s1" });
      await first;
    });
  });

  describe("working directory validation", () => {
    it("isWithinAllowedRoot rejects paths outside allowed roots", () => {
      expect(isWithinAllowedRoot("/etc/passwd")).toBe(false);
      expect(isWithinAllowedRoot("/var/log")).toBe(false);
    });

    it("isWithinAllowedRoot accepts the default working directory", () => {
      expect(isWithinAllowedRoot("/tmp/happy_feishu")).toBe(true);
      expect(isWithinAllowedRoot("/tmp/happy_feishu/subdir")).toBe(true);
    });

    it("rejects execution when working directory is outside allowed roots", async () => {
      const params = makeParams({
        account: {
          accountId: "acc_1",
          config: { happyWorkingDirectory: "/etc/evil" },
        } as unknown as ClaudeCodeExecutionParams["account"],
      });

      await executeClaudeCode(params);

      expect(sendMessageFeishu).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("outside the allowed roots"),
        }),
      );
      expect(mockExecute).not.toHaveBeenCalled();
    });
  });

  describe("happy mode", () => {
    it("passes prompt directly without skill wrapping", async () => {
      await executeClaudeCode(makeParams({ prompt: "hello world" }));

      expect(buildSkillPrompt).not.toHaveBeenCalled();
      expect(mockExecute).toHaveBeenCalledWith(
        expect.stringContaining("hello world"),
        expect.any(Object),
      );
    });
  });

  describe("skill mode", () => {
    it("wraps prompt via buildSkillPrompt()", async () => {
      await executeClaudeCode(
        makeParams({
          prompt: "design a system",
          mode: { kind: "skill", skillId: "superpowers:brainstorming", commandName: "brain" },
        }),
      );

      expect(buildSkillPrompt).toHaveBeenCalledWith("superpowers:brainstorming", "design a system");
      expect(mockExecute).toHaveBeenCalledWith(
        expect.stringContaining("[SKILL:superpowers:brainstorming]"),
        expect.any(Object),
      );
    });
  });

  describe("request ID generation", () => {
    it("generates a requestId and threads it through to SDK execute", async () => {
      await executeClaudeCode(makeParams());

      expect(mockExecute).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          requestId: expect.any(String),
        }),
      );
    });
  });

  describe("session caching", () => {
    it("caches the session ID after successful execution", async () => {
      await executeClaudeCode(makeParams());

      expect(getCachedSessionId("chat_test")).toBe("session_abc");
    });

    it("clears cached session when newSession option is set", async () => {
      // Pre-populate cache
      await executeClaudeCode(makeParams());
      expect(getCachedSessionId("chat_test")).toBe("session_abc");

      // Execute with newSession flag
      mockExecute.mockResolvedValueOnce({ success: true, claudeSessionId: "session_new" });
      await executeClaudeCode(
        makeParams({
          options: { newSession: true },
        }),
      );

      expect(getCachedSessionId("chat_test")).toBe("session_new");
    });
  });

  describe("error handling", () => {
    it("produces error card instead of unhandled exception on SDK failure", async () => {
      mockExecute.mockRejectedValueOnce(new Error("SDK crash"));

      // Should not throw
      await expect(executeClaudeCode(makeParams())).resolves.toBeUndefined();

      // After error, execution should not be active
      expect(isExecutionActive()).toBe(false);
    });
  });

  describe("empty prompt", () => {
    it("sends usage message when prompt is empty", async () => {
      await executeClaudeCode(makeParams({ prompt: "" }));

      expect(sendMessageFeishu).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Please provide a prompt"),
        }),
      );
      expect(mockExecute).not.toHaveBeenCalled();
    });
  });
});
