// feishu/src/question-handler.ts
// Question card flow for @happy HappyClawSDK integration.
// Uses centralized question management from streaming-card-manager.ts

import {
  getActiveQuestionId,
  getPendingQuestion,
  resolveQuestion,
  waitForQuestionAnswer,
} from "./streaming-card-manager.js";
import type { PendingQuestion } from "./streaming-card-types.js";

// Re-export QuestionAnswer for compatibility
export interface QuestionAnswer {
  answered: boolean;
  answers?: Map<number, string>;
  reason?: string;
}

/**
 * Send question card to Feishu chat - uses existing question from card manager
 * This function is called by onAskUserQuestion callback after the card manager
 * has already created the pending question via the stream event.
 */
export async function sendQuestionCard(
  question: PendingQuestion,
  timeout: number,
  chatId: string,
): Promise<{
  questionId: string;
  answerPromise: Promise<QuestionAnswer>;
}> {
  // Get the active question ID for this chat (created by card manager)
  const activeQuestionId = getActiveQuestionId(chatId);

  if (activeQuestionId) {
    // Use the existing question created by card manager
    console.log(
      `[QuestionHandler] Using existing question: ${activeQuestionId} for chat: ${chatId}`,
    );
    return {
      questionId: activeQuestionId,
      answerPromise: waitForQuestionAnswer(activeQuestionId, timeout),
    };
  }

  // Fallback: No active question from card manager
  // This shouldn't normally happen, but handle gracefully
  console.warn(`[QuestionHandler] No active question for chat: ${chatId}, using fallback`);

  // Return with the questionId from the input (may be 'pending')
  return {
    questionId: question.questionId,
    answerPromise: Promise.resolve({
      answered: false,
      reason: "No active question found",
    }),
  };
}

/**
 * Handle card action callback for question answers.
 * Called from card-action.ts when user clicks a question button.
 */
export function handleQuestionAction(questionAction: {
  questionId: string;
  questionIndex: number;
  optionIndex: number;
  label?: string;
}): void {
  const { questionId, questionIndex, optionIndex, label } = questionAction;

  console.log(
    `[QuestionHandler] handleQuestionAction called: questionId=${questionId}, optionIndex=${optionIndex}`,
  );

  const entry = getPendingQuestion(questionId);
  if (!entry) {
    console.warn(`[QuestionHandler] No pending question found: ${questionId}`);
    console.log(
      `[QuestionHandler] Available questions:`,
      Array.from({ length: 10 }).map((_, i) =>
        getPendingQuestion(`q-${Date.now() - i * 1000}-test`),
      ),
    );
    return;
  }

  const answers = new Map<number, string>();

  if (optionIndex === -1) {
    // Custom answer - user will type it
    // For now, mark as waiting for text input
    console.log(`[QuestionHandler] Resolving with custom input (optionIndex=-1)`);
    resolveQuestion(questionId, {
      answered: true,
      answers: new Map(), // Empty answers means user needs to type
      reason: "custom_input",
    });
  } else {
    // User selected an option
    answers.set(questionIndex, label || "");
    console.log(`[QuestionHandler] Resolving with option: ${label}`);
    resolveQuestion(questionId, {
      answered: true,
      answers,
    });
  }

  console.log(`[QuestionHandler] Question ${questionId} resolved`);
}

/**
 * Handle custom text answer for a question
 * Called when user types a custom answer instead of clicking a button
 */
export function handleQuestionTextAnswer(
  questionId: string,
  text: string,
  questionIndex = 0,
): void {
  const entry = getPendingQuestion(questionId);
  if (!entry) {
    console.warn(`[QuestionHandler] No pending question found for text answer: ${questionId}`);
    return;
  }

  const answers = new Map<number, string>();
  answers.set(questionIndex, text);

  resolveQuestion(questionId, {
    answered: true,
    answers,
  });

  console.log(`[QuestionHandler] Resolved question ${questionId} with text answer`);
}

/**
 * Get the pending question for a given question ID
 */
export function getPendingQuestionData(questionId: string): PendingQuestion | undefined {
  return getPendingQuestion(questionId)?.question;
}

/**
 * Check if there's a pending question for a given question ID
 */
export function hasPendingQuestion(questionId: string): boolean {
  return getPendingQuestion(questionId) !== undefined;
}

/**
 * Get the active question ID for a given chat
 */
export function getActiveQuestionIdForChat(chatId: string): string | undefined {
  return getActiveQuestionId(chatId);
}

/**
 * Handle text answer for a chat's active question
 * Called when user types a text answer instead of clicking a button
 */
export function handleChatTextAnswer(chatId: string, text: string): boolean {
  const questionId = getActiveQuestionId(chatId);
  if (!questionId) {
    return false; // No active question for this chat
  }

  handleQuestionTextAnswer(questionId, text);
  return true; // Question was found and handled
}
