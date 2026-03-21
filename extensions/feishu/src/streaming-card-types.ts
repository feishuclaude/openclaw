/**
 * Card status determines the header color and icon
 */
export type CardStatus =
  | "thinking" // Blue: Claude is thinking
  | "running" // Blue: Tool is executing
  | "complete" // Green: Execution finished
  | "error" // Red: Error occurred
  | "waiting_for_input"; // Yellow: Waiting for user input

/**
 * Tool execution status
 */
export type ToolCallStatus = "running" | "success" | "error";

/**
 * Single tool call record
 */
export interface ToolCall {
  /** Tool name (Read, Write, Bash, etc.) */
  name: string;
  /** Parameter summary (truncated to ~50 chars) */
  detail: string;
  /** Current status */
  status: ToolCallStatus;
}

/**
 * Pending question from AskUserQuestion
 */
export interface PendingQuestion {
  /** Generated question ID for tracking answers */
  questionId: string;
  questions: Array<{
    header: string;
    question: string;
    options: Array<{
      label: string;
      description: string;
    }>;
  }>;
  /** Total number of questions in batch (for sequential flow progress indicator) */
  totalQuestions?: number;
  /** Current question number (1-based, for sequential flow progress indicator) */
  currentQuestionNumber?: number;
}

/**
 * Question answer result (matches QuestionResult from SDK types)
 */
export interface QuestionAnswer {
  answered: boolean;
  answers?: Map<number, string>; // questionIndex -> answer
  reason?: string;
}

/**
 * Sequential question state for tracking multi-question flow
 */
export interface SequentialQuestionState {
  /** Original question ID for the batch */
  batchId: string;
  /** All questions in the batch */
  allQuestions: Array<{
    header: string;
    question: string;
    options: Array<{
      label: string;
      description: string;
    }>;
  }>;
  /** Current question index (0-based) */
  currentIndex: number;
  /** Collected answers (questionIndex -> answer) */
  collectedAnswers: Map<number, string>;
  /** Chat ID this batch belongs to */
  chatId: string;
}

/**
 * Pending question entry with resolver for answer handling
 */
export interface PendingQuestionEntry {
  question: PendingQuestion;
  resolve: (result: QuestionAnswer) => void;
  chatId: string;
  timestamp: number;
  /** Sequential state for multi-question flow */
  sequentialState?: SequentialQuestionState;
}

/**
 * Complete card state
 */
export interface CardState {
  status: CardStatus;
  toolCalls: ToolCall[];
  responseText?: string;
  errorMessage?: string;
  pendingQuestion?: PendingQuestion;
  /** Human-readable summary of collected Q&A answers, shown after sequential questions complete */
  answerSummary?: string;
  durationMs?: number;
}

/**
 * Session context for tracking card state per chat
 */
export interface CardSession {
  chatId: string;
  messageId?: string; // Current card message ID for updates
  state: CardState;
  startTime: number;
}
