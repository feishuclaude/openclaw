/**
 * Card builder for streaming response cards
 * Ported from metabot with minor adaptations for OpenClaw architecture
 */

import type { CardState, CardStatus } from "./streaming-card-types.js";

/** Status configuration: color, title, icon */
const STATUS_CONFIG: Record<
  CardStatus,
  {
    color: string;
    title: string;
    icon: string;
  }
> = {
  thinking: { color: "blue", title: "Thinking...", icon: "🔵" },
  running: { color: "blue", title: "Running...", icon: "🔵" },
  complete: { color: "green", title: "Complete", icon: "🟢" },
  error: { color: "red", title: "Error", icon: "🔴" },
  waiting_for_input: { color: "yellow", title: "Waiting for Input", icon: "🟡" },
};

/** Question card action types */
const QUESTION_ACTIONS = {
  ANSWER: "answer_question",
  CUSTOM: "answer_question_custom",
} as const;

/** Feishu card content limit (slightly under 32KB) */
const MAX_CONTENT_LENGTH = 28000;

/**
 * Truncate content if too long, with marker in middle
 */
function truncateContent(text: string): string {
  if (text.length <= MAX_CONTENT_LENGTH) return text;
  const half = Math.floor(MAX_CONTENT_LENGTH / 2) - 50;
  return text.slice(0, half) + "\n\n... (content truncated) ...\n\n" + text.slice(-half);
}

/**
 * Build a streaming card JSON from card state
 * Uses Schema 1.0 when there are interactive buttons (pendingQuestion),
 * Schema 2.0 otherwise for better display.
 */
export function buildCard(state: CardState): string {
  const config = STATUS_CONFIG[state.status];
  const elements: unknown[] = [];

  // Tool calls section
  if (state.toolCalls.length > 0) {
    const toolLines = state.toolCalls.map((t) => {
      const icon = t.status === "running" ? "⏳" : "✅";
      return `${icon} **${t.name}** ${t.detail}`;
    });
    elements.push({
      tag: "markdown",
      content: toolLines.join("\n"),
    });
    elements.push({ tag: "hr" });
  }

  // Response content (with truncation)
  if (state.responseText) {
    elements.push({
      tag: "markdown",
      content: truncateContent(state.responseText),
    });
  } else if (state.status === "thinking") {
    elements.push({
      tag: "markdown",
      content: "_Claude is thinking..._",
    });
  }

  // Pending question section
  if (state.pendingQuestion) {
    elements.push({ tag: "hr" });

    // Add progress indicator for sequential questions
    if (state.pendingQuestion.totalQuestions && state.pendingQuestion.totalQuestions > 1) {
      const current = state.pendingQuestion.currentQuestionNumber || 1;
      const total = state.pendingQuestion.totalQuestions;
      elements.push({
        tag: "markdown",
        content: `📋 **Question ${current} of ${total}**`,
      });
    }

    for (const q of state.pendingQuestion.questions) {
      const questionIndex = state.pendingQuestion.questions.indexOf(q);

      // Add question text
      elements.push({
        tag: "markdown",
        content: `**[${q.header}] ${q.question}**`,
      });

      // Add action buttons for each option
      const buttonActions: Array<{
        tag: string;
        text: { tag: string; content: string };
        type: string;
        value: {
          questionId: string;
          questionIndex: number;
          optionIndex: number;
          action: string;
          label: string;
        };
      }> = q.options.map((opt, i) => ({
        tag: "button",
        text: { tag: "plain_text", content: opt.label },
        type: "default",
        value: {
          questionId: state.pendingQuestion!.questionId,
          questionIndex,
          optionIndex: i,
          action: QUESTION_ACTIONS.ANSWER,
          label: opt.label,
        },
      }));

      // Add "Other" button for custom input
      buttonActions.push({
        tag: "button",
        text: { tag: "plain_text", content: "Other (custom answer)" },
        type: "default",
        value: {
          questionId: state.pendingQuestion!.questionId,
          questionIndex,
          optionIndex: -1,
          action: QUESTION_ACTIONS.CUSTOM,
          label: "Other",
        },
      });

      elements.push({
        tag: "action",
        actions: buttonActions,
      });

      // Add descriptions below buttons
      const descriptions = q.options.map((opt, i) => `${i + 1}. ${opt.description}`).join("\n");
      elements.push({
        tag: "markdown",
        content: `_Option descriptions:\n${descriptions}\n\nClick a button to select, or type a custom answer._`,
      });
    }
  }

  // Answer summary section (shown after all sequential questions are answered)
  if (state.answerSummary && !state.pendingQuestion) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "markdown",
      content: `**Answers Collected:**\n\n${state.answerSummary}`,
    });
    elements.push({
      tag: "markdown",
      content: "_Continuing execution..._",
    });
  }

  // Error message
  if (state.errorMessage) {
    elements.push({
      tag: "markdown",
      content: `**Error:** ${state.errorMessage}`,
    });
  }

  // Stats note (complete/error only)
  if (state.status === "complete" || state.status === "error") {
    const parts: string[] = [];
    if (state.durationMs !== undefined) {
      parts.push(`Duration: ${(state.durationMs / 1000).toFixed(1)}s`);
    }
    if (parts.length > 0) {
      elements.push({
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: parts.join(" | "),
          },
        ],
      });
    }
  }

  // Schema 1.0 card format - required for interactive action buttons
  // (Schema 2.0 does NOT support the "action" tag)
  if (state.pendingQuestion) {
    return JSON.stringify({
      header: {
        title: {
          tag: "plain_text",
          content: `${config.icon} ${config.title}`,
        },
        template: config.color,
      },
      elements,
    });
  }

  // Schema 2.0 for non-interactive cards (better display)
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: config.color,
      title: {
        content: `${config.icon} ${config.title}`,
        tag: "plain_text",
      },
    },
    elements,
  });
}

/**
 * Build a help card with command reference
 */
export function buildHelpCard(): string {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: "blue",
      title: {
        content: "📖 Help",
        tag: "plain_text",
      },
    },
    elements: [
      {
        tag: "markdown",
        content: [
          "**Claude Code:**",
          "`/happy <prompt>` - Execute Claude Code with streaming output",
          "`/happy --new` - Start a new session",
          "`/happy --reset` - Reset approve-all mode",
          "",
          "**Superpowers:**",
          "`/brain <topic>` `/b` - Brainstorm ideas",
          "`/plan <task>` `/p` - Create implementation plan",
          "`/do <plan>` `/d` - Execute a plan",
          "",
          "**Session:**",
          "`/status` - Show current session info",
          "`/stop` - Abort current running task",
          "`/reset` - Clear session, start fresh",
          "`/help` - Show this help message",
          "",
          "**Usage:**",
          "Use `/happy <prompt>` to start a conversation with Claude Code.",
          "Each chat has an independent session with a fixed working directory.",
        ].join("\n"),
      },
    ],
  };
  return JSON.stringify(card);
}

/**
 * Build a simple text card with custom content
 */
export function buildTextCard(
  title: string,
  content: string,
  color: "blue" | "green" | "red" | "yellow" = "blue",
): string {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: color,
      title: {
        content: title,
        tag: "plain_text",
      },
    },
    elements: [
      {
        tag: "markdown",
        content,
      },
    ],
  };
  return JSON.stringify(card);
}
