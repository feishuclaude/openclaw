/**
 * Streaming card session manager
 * Manages per-chat card state and handles debounced updates
 */

import { randomBytes } from "node:crypto";
import type { ClawdbotConfig } from "../runtime-api.js";
import { buildCard } from "./card-builder.js";
import type { StreamEvent } from "./sdk/types.js";
import { sendCardFeishu, updateCardFeishu } from "./send.js";
import type {
  CardSession,
  CardState,
  ToolCall,
  PendingQuestion,
  PendingQuestionEntry,
  QuestionAnswer,
  SequentialQuestionState,
} from "./streaming-card-types.js";

/** Debounce delay to avoid Feishu API rate limits (same as metabot) */
const UPDATE_DEBOUNCE_MS = 1500;

/** Session timeout (1 hour) */
const SESSION_TIMEOUT_MS = 60 * 60 * 1000;

/** Question timeout (2 minutes) */
const QUESTION_TIMEOUT_MS = 120_000;

// Global pending questions map - shared between card manager and question handler
// This allows the question handler to access questions created by the card manager
const pendingQuestions = new Map<string, PendingQuestionEntry>();

// Track active question ID per chat (chatId -> questionId)
const activeQuestionsByChat = new Map<string, string>();

// Guard against double-processing during sequential question transitions
const transitioningQuestions = new Set<string>();

/**
 * Get pending question by ID (used by question-handler)
 */
export function getPendingQuestion(questionId: string): PendingQuestionEntry | undefined {
  console.log(`[StreamingCardManager] getPendingQuestion called: ${questionId}`);
  console.log(
    `[StreamingCardManager] Current pending questions:`,
    Array.from(pendingQuestions.keys()),
  );
  return pendingQuestions.get(questionId);
}

/**
 * Get active question ID for a chat
 */
export function getActiveQuestionId(chatId: string): string | undefined {
  const questionId = activeQuestionsByChat.get(chatId);
  console.log(`[StreamingCardManager] getActiveQuestionId for chat ${chatId}: ${questionId}`);
  return questionId;
}

/**
 * Resolve a pending question with an answer (used by card-action handler)
 * For sequential questions, this will show the next question or resolve with all answers
 */
export function resolveQuestion(questionId: string, result: QuestionAnswer): boolean {
  console.log(`[StreamingCardManager] resolveQuestion called: ${questionId}`);

  // Guard against double-processing (e.g., user double-clicks before card refreshes)
  if (transitioningQuestions.has(questionId)) {
    console.log(
      `[StreamingCardManager] Ignoring duplicate resolve for transitioning question: ${questionId}`,
    );
    return false;
  }

  const entry = pendingQuestions.get(questionId);
  if (!entry) {
    console.warn(`[StreamingCardManager] resolveQuestion: question not found: ${questionId}`);
    return false;
  }

  // Check if this is part of a sequential question flow
  if (entry.sequentialState) {
    const seqState = entry.sequentialState;
    console.log(
      `[StreamingCardManager] Sequential question answered. Current index: ${seqState.currentIndex}, Total questions: ${seqState.allQuestions.length}`,
    );

    // Store the answer - map questionIndex 0 to the current sequential index
    if (result.answered && result.answers) {
      for (const [idx, answer] of result.answers) {
        // In sequential mode, idx is always 0 (single question displayed)
        // Map it to the actual question index in the original array
        const actualIndex = seqState.currentIndex;
        seqState.collectedAnswers.set(actualIndex, answer);
        console.log(`[StreamingCardManager] Stored answer for question ${actualIndex}: ${answer}`);
      }
    }

    // Check if there are more questions
    if (seqState.currentIndex < seqState.allQuestions.length - 1) {
      // Lock to prevent double-processing while card transitions
      transitioningQuestions.add(questionId);

      // Move to next question
      seqState.currentIndex++;
      const nextQuestion = seqState.allQuestions[seqState.currentIndex];

      console.log(
        `[StreamingCardManager] Showing next question ${seqState.currentIndex + 1}/${seqState.allQuestions.length}`,
      );

      // Update the pending question in the entry
      entry.question = {
        questionId: seqState.batchId,
        questions: [nextQuestion], // Show only the current question
        // Update progress indicator
        totalQuestions: seqState.allQuestions.length,
        currentQuestionNumber: seqState.currentIndex + 1,
      };

      // Update the card session state
      const session = getCardSession(seqState.chatId);
      if (session) {
        session.state.pendingQuestion = entry.question;
        // Force immediate card update, then unlock transitions
        updateCardSession(seqState.chatId)
          .then(() => {
            transitioningQuestions.delete(questionId);
          })
          .catch((err) => {
            transitioningQuestions.delete(questionId);
            console.error(`[StreamingCardManager] Failed to update card for next question:`, err);
          });
      } else {
        transitioningQuestions.delete(questionId);
      }

      return true; // Don't resolve the promise yet
    }

    // All questions answered - resolve with all collected answers
    console.log(
      `[StreamingCardManager] All questions answered. Collected answers:`,
      Array.from(seqState.collectedAnswers.entries()),
    );

    // Build visual summary of collected Q&A pairs for the Feishu card
    const summaryLines: string[] = [];
    for (const [idx, answer] of seqState.collectedAnswers) {
      const q = seqState.allQuestions[idx];
      const header = q?.header || `Q${idx + 1}`;
      const questionText = q?.question || "";
      summaryLines.push(`[${header}] ${questionText}\n-> ${answer}`);
    }
    const visualSummary = summaryLines.join("\n\n");

    // Update card to show collected answers summary
    const summarySession = getCardSession(seqState.chatId);
    if (summarySession) {
      summarySession.state.pendingQuestion = undefined;
      summarySession.state.answerSummary = visualSummary;
      summarySession.state.status = "running";
      updateCardSession(seqState.chatId).catch((err) => {
        console.error(`[StreamingCardManager] Failed to update card with answer summary:`, err);
      });
    }

    entry.resolve({
      answered: true,
      answers: seqState.collectedAnswers,
    });
  } else {
    // Single question - resolve immediately
    console.log(`[StreamingCardManager] Calling entry.resolve with result:`, result);
    entry.resolve(result);
  }

  pendingQuestions.delete(questionId);
  activeQuestionsByChat.delete(entry.chatId);
  console.log(`[StreamingCardManager] Question ${questionId} resolved and removed from map`);
  return true;
}

/**
 * Get card session by chatId (helper for sequential questions)
 */
function getCardSession(chatId: string): CardSession | undefined {
  // This will be set by the StreamingCardManager class
  return cardSessions.get(chatId);
}

/**
 * Update card session (helper for sequential questions)
 */
async function updateCardSession(chatId: string): Promise<void> {
  const session = cardSessions.get(chatId);
  if (!session?.messageId) return;

  try {
    const cardJson = buildCard(session.state);
    const card = JSON.parse(cardJson);
    await updateCardFeishu({
      cfg: cardConfig,
      messageId: session.messageId,
      card,
      accountId: cardAccountId,
    });
  } catch (error) {
    console.error(`[StreamingCardManager] Card update failed:`, error);
  }
}

// Static references for helper functions (set by StreamingCardManager constructor)
let cardSessions: Map<string, CardSession>;
let cardConfig: ClawdbotConfig;
let cardAccountId: string | undefined;

/**
 * Wait for a question answer (used by onAskUserQuestion callback)
 */
export function waitForQuestionAnswer(
  questionId: string,
  timeout: number = QUESTION_TIMEOUT_MS,
): Promise<QuestionAnswer> {
  console.log(`[StreamingCardManager] waitForQuestionAnswer called for: ${questionId}`);
  return new Promise((resolve) => {
    const entry = pendingQuestions.get(questionId);
    if (!entry) {
      console.warn(
        `[StreamingCardManager] waitForQuestionAnswer: question not found: ${questionId}`,
      );
      resolve({ answered: false, reason: "Question not found" });
      return;
    }

    console.log(
      `[StreamingCardManager] Setting up timeout and resolver for question: ${questionId}`,
    );

    // Set up timeout
    const timer = setTimeout(() => {
      console.log(`[StreamingCardManager] Question ${questionId} timed out`);
      pendingQuestions.delete(questionId);
      activeQuestionsByChat.delete(entry.chatId);
      resolve({ answered: false, reason: "Question timed out" });
    }, timeout);

    // Update the resolver to clear timeout
    const originalResolve = entry.resolve;
    entry.resolve = (result: QuestionAnswer) => {
      console.log(
        `[StreamingCardManager] entry.resolve called for ${questionId} with result:`,
        result,
      );
      clearTimeout(timer);
      originalResolve(result);
      resolve(result);
    };

    console.log(`[StreamingCardManager] Resolver updated for question: ${questionId}`);
  });
}

/**
 * Manages streaming card sessions for @happy command
 */
export class StreamingCardManager {
  private sessions = new Map<string, CardSession>();
  private updateQueue = new Map<string, NodeJS.Timeout>();
  private cleanupTimer: NodeJS.Timeout;

  constructor(
    private cfg: ClawdbotConfig,
    private accountId?: string,
  ) {
    // Set static references for helper functions
    cardSessions = this.sessions;
    cardConfig = this.cfg;
    cardAccountId = this.accountId;

    // Start periodic cleanup of stale sessions
    this.cleanupTimer = setInterval(
      () => {
        this.cleanupStaleSessions();
      },
      5 * 60 * 1000,
    ); // Every 5 minutes
  }

  /**
   * Start a new streaming session for a chat
   * @returns The initial card message ID
   */
  async startSession(chatId: string): Promise<string> {
    const session: CardSession = {
      chatId,
      state: {
        status: "thinking",
        toolCalls: [],
      },
      startTime: Date.now(),
    };
    this.sessions.set(chatId, session);

    // Send initial card
    const cardJson = buildCard(session.state);
    const card = JSON.parse(cardJson);

    const result = await sendCardFeishu({
      cfg: this.cfg,
      to: `chat:${chatId}`,
      card,
      accountId: this.accountId,
    });

    session.messageId = result.messageId;
    return result.messageId;
  }

  /**
   * Handle a stream event from happy-claw-sdk
   */
  handleEvent(chatId: string, event: StreamEvent): void {
    const session = this.sessions.get(chatId);
    if (!session) return;

    switch (event.type) {
      case "text_delta": {
        // Clear answer summary when new content arrives
        if (session.state.answerSummary) {
          session.state.answerSummary = undefined;
        }
        const data = event.data as Record<string, unknown> | string | undefined;
        const text =
          typeof data === "string"
            ? data
            : (((data as Record<string, unknown>)?.text as string) ?? "");

        session.state.responseText = (session.state.responseText || "") + text;
        session.state.status = "running";
        break;
      }

      case "tool_use": {
        // Clear answer summary when new tool activity arrives
        if (session.state.answerSummary) {
          session.state.answerSummary = undefined;
        }
        const data = event.data as Record<string, unknown> | undefined;
        const toolName = String(data?.toolName ?? data?.name ?? "unknown");

        // Skip AskUserQuestion - it's handled separately as a question UI
        if (toolName === "AskUserQuestion") {
          console.log(`[StreamingCardManager] Skipping AskUserQuestion from tool_calls display`);
          break;
        }

        // Format detail (truncate to ~50 chars)
        // input can be either string (from SDK) or object (for complex tools)
        const rawInput = data?.input;
        let detail = "";
        if (rawInput) {
          let str: string;
          if (typeof rawInput === "string") {
            // input is already a string (e.g., command args)
            str = rawInput;
          } else if (typeof rawInput === "object" && rawInput !== null) {
            // input is an object, stringify it
            str = JSON.stringify(rawInput);
          } else {
            str = String(rawInput);
          }
          // Don't show empty objects/strings as detail
          if (str !== "{}" && str !== "" && str !== "null" && str !== "undefined") {
            detail = str.length > 50 ? str.slice(0, 50) + "..." : str;
          }
        }

        // Check if this tool already exists (SDK may emit twice: start + complete)
        const existingTool = session.state.toolCalls.find(
          (t) => t.name === toolName && t.status === "running",
        );

        if (existingTool) {
          // Update existing tool with new detail if we have one
          if (detail) {
            existingTool.detail = detail;
          }
        } else {
          // Add new tool call
          session.state.toolCalls.push({
            name: toolName,
            detail,
            status: "running",
          });
        }
        session.state.status = "running";
        break;
      }

      case "tool_result": {
        // Mark the last running tool as success
        const lastRunning = [...session.state.toolCalls]
          .reverse()
          .find((t) => t.status === "running");
        if (lastRunning) {
          lastRunning.status = "success";
        }
        break;
      }

      case "status": {
        const status = String(event.data);
        if (status === "complete") {
          session.state.status = "complete";
          session.state.durationMs = Date.now() - session.startTime;
        } else if (status === "error") {
          session.state.status = "error";
          session.state.durationMs = Date.now() - session.startTime;
        }
        break;
      }

      case "thinking": {
        // Thinking content - could be displayed separately
        // For now, just keep running status
        break;
      }

      case "ask_user_question": {
        // Store pending question for card rendering
        const data = event.data as Record<string, unknown> | undefined;
        if (
          data &&
          typeof data === "object" &&
          "questions" in data &&
          Array.isArray(data.questions)
        ) {
          const allQuestions = data.questions as Array<{
            header: string;
            question: string;
            options: Array<{
              label: string;
              description: string;
            }>;
          }>;

          // Generate a unique question ID for tracking answers
          const questionId = `q-${Date.now()}-${randomBytes(8).toString("hex")}`;

          // Check if we have multiple questions - use sequential flow
          const hasMultipleQuestions = allQuestions.length > 1;

          // For sequential flow, show only the first question initially
          const displayQuestions = hasMultipleQuestions ? [allQuestions[0]] : allQuestions;

          const pendingQuestion: PendingQuestion = {
            questionId,
            questions: displayQuestions,
            // Add progress indicator for sequential questions
            totalQuestions: hasMultipleQuestions ? allQuestions.length : undefined,
            currentQuestionNumber: hasMultipleQuestions ? 1 : undefined,
          };

          session.state.pendingQuestion = pendingQuestion;
          session.state.status = "waiting_for_input";

          // Create the entry with optional sequential state
          const entry: PendingQuestionEntry = {
            question: pendingQuestion,
            resolve: () => {}, // Placeholder, will be replaced by waitForQuestionAnswer
            chatId,
            timestamp: Date.now(),
          };

          // If multiple questions, set up sequential state
          if (hasMultipleQuestions) {
            entry.sequentialState = {
              batchId: questionId,
              allQuestions,
              currentIndex: 0,
              collectedAnswers: new Map(),
              chatId,
            };
            console.log(
              `[StreamingCardManager] Sequential question flow: ${allQuestions.length} questions, showing question 1`,
            );
          }

          // Store in global map
          pendingQuestions.set(questionId, entry);

          // Track as active question for this chat
          activeQuestionsByChat.set(chatId, questionId);

          console.log(
            `[StreamingCardManager] Created pending question: ${questionId} for chat: ${chatId} (${hasMultipleQuestions ? "sequential" : "single"})`,
          );

          // IMPORTANT: Force immediate card update for questions
          // The SDK blocks waiting for the answer, so we must update the card NOW
          // Don't use debounced update - it would be too late
          this.updateCard(chatId).catch((err) => {
            console.error(`[StreamingCardManager] Failed to update card for question:`, err);
          });
          return; // Skip the debounced update at the end
        }
        break;
      }
    }

    // Schedule debounced update
    this.scheduleUpdate(chatId);
  }

  /**
   * Schedule a debounced card update
   */
  private scheduleUpdate(chatId: string): void {
    // Cancel any pending update
    const existing = this.updateQueue.get(chatId);
    if (existing) {
      clearTimeout(existing);
    }

    // Schedule new update
    this.updateQueue.set(
      chatId,
      setTimeout(async () => {
        await this.updateCard(chatId);
        this.updateQueue.delete(chatId);
      }, UPDATE_DEBOUNCE_MS),
    );
  }

  /**
   * Execute card update via Feishu API
   */
  private async updateCard(chatId: string): Promise<void> {
    const session = this.sessions.get(chatId);
    if (!session?.messageId) return;

    try {
      const cardJson = buildCard(session.state);
      const card = JSON.parse(cardJson);

      await updateCardFeishu({
        cfg: this.cfg,
        messageId: session.messageId,
        card,
        accountId: this.accountId,
      });
    } catch (error) {
      // Log but don't throw - card update failures shouldn't break execution
      console.error(`[StreamingCardManager] Card update failed:`, error);
    }
  }

  /**
   * End a session with final update
   */
  async endSession(chatId: string): Promise<void> {
    const session = this.sessions.get(chatId);
    if (!session) return;

    // Cancel any pending update
    const pending = this.updateQueue.get(chatId);
    if (pending) {
      clearTimeout(pending);
      this.updateQueue.delete(chatId);
    }

    // Ensure final state is updated
    await this.updateCard(chatId);

    // Delay cleanup to allow final update to complete
    setTimeout(() => {
      this.sessions.delete(chatId);
    }, 2000);
  }

  /**
   * Clean up stale sessions
   */
  private cleanupStaleSessions(): void {
    const now = Date.now();
    for (const [chatId, session] of this.sessions) {
      if (now - session.startTime > SESSION_TIMEOUT_MS) {
        this.endSession(chatId);
      }
    }
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    // End all sessions
    for (const chatId of this.sessions.keys()) {
      this.endSession(chatId);
    }
  }
}
