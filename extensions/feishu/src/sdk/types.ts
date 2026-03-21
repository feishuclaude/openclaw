// src/types.ts

export interface HappyClawSDKOptions {
  /**
   * Working directory
   * @default '/tmp/happy-claw-sdk'
   */
  workingDirectory?: string;

  /**
   * Execution timeout in milliseconds
   * @default 120000 (2 minutes)
   */
  timeout?: number;

  /**
   * Permission mode (matches Claude Agent SDK PermissionMode)
   * @default 'default'
   */
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";

  /**
   * Permission callback
   * Called when Claude needs to use a tool
   */
  onPermission?: PermissionCallback;

  /**
   * Model name
   * @default 'claude-sonnet-4-6'
   */
  model?: string;

  /**
   * Claude path (CLI fallback)
   * @default 'claude'
   */
  claudePath?: string;

  /**
   * Stream event callback for real-time output
   */
  onStreamEvent?: StreamEventHandler;

  /**
   * Question callback for AskUserQuestion
   * Called when Claude needs to ask the user a question
   */
  onAskUserQuestion?: QuestionCallback;
}

/**
 * Question request from AskUserQuestion
 */
export interface QuestionRequest {
  /**
   * Questions to ask the user
   */
  questions: Array<{
    header: string;
    question: string;
    options: Array<{
      label: string;
      description: string;
    }>;
  }>;
  /**
   * Signal for aborting the request
   */
  signal: AbortSignal;
}

/**
 * Question result from user
 */
export interface QuestionResult {
  /**
   * User's answers (question index -> answer)
   */
  answers?: Map<number, string>;
  /**
   * Whether the user provided answers
   */
  answered: boolean;
}

/**
 * Question callback function
 */
export type QuestionCallback = (request: QuestionRequest) => Promise<QuestionResult>;

// Tool type categorization
export type ToolType = "file_read" | "file_write" | "command" | "web_search" | "unknown";

// Error codes
export enum HappyClawError {
  SDK_NOT_AVAILABLE = "SDK_NOT_AVAILABLE",
  CLI_NOT_AVAILABLE = "CLI_NOT_AVAILABLE",
  EXECUTION_TIMEOUT = "EXECUTION_TIMEOUT",
  PERMISSION_DENIED = "PERMISSION_DENIED",
  EXECUTION_FAILED = "EXECUTION_FAILED",
}

export interface ExecutionError {
  code: HappyClawError;
  message: string;
  details?: unknown;
}

/**
 * Options for execute/executeStream calls
 */
export interface ExecutionOptions {
  /** Claude session ID to resume. Continues the previous conversation. */
  claudeSessionId?: string;
  /** Per-execution permission callback override. Takes precedence over SDK-level callback. */
  onPermission?: PermissionCallback;
  /** Per-execution stream event callback override. Takes precedence over SDK-level callback. */
  onStreamEvent?: StreamEventHandler;
  /** Per-execution question callback override. Takes precedence over SDK-level callback. */
  onAskUserQuestion?: QuestionCallback;
}

/**
 * Permission request
 */
export interface PermissionRequest {
  /**
   * Tool name
   */
  toolName: string;

  /**
   * Tool input parameters
   */
  toolInput: Record<string, unknown>;

  /**
   * Permission ID
   */
  permissionId: string;

  /**
   * Abort signal (for cancelling the request)
   */
  signal: AbortSignal;

  /**
   * Tool type (pre-categorized for convenience)
   */
  toolType?: ToolType;
}

/**
 * Permission result
 */
export interface PermissionResult {
  /**
   * Whether approved
   */
  approved: boolean;

  /**
   * Modified input
   */
  modifiedInput?: Record<string, unknown>;

  /**
   * Rejection reason
   */
  reason?: string;
}

/**
 * Permission callback function
 */
export type PermissionCallback = (request: PermissionRequest) => Promise<PermissionResult>;

/**
 * Execution result
 */
export interface ExecutionResult {
  /**
   * Whether successful
   */
  success: boolean;

  /**
   * Output text
   */
  output?: string;

  /**
   * Error message
   */
  error?: string;

  /**
   * Whether permission was required
   */
  permissionRequired?: boolean;

  /**
   * Mode used (SDK or CLI)
   */
  mode?: "sdk" | "cli";

  /**
   * Claude session UUID. Store and pass back via ExecutionOptions to continue conversation.
   */
  claudeSessionId?: string;
}

/**
 * Stream event types for real-time output during Claude execution
 *
 * @remarks
 * These event types are emitted when using the streaming API:
 * - `text_delta`: Partial text content during generation
 * - `tool_use`: Tool invocation starting
 * - `tool_result`: Tool execution completed
 * - `thinking`: Extended thinking content
 * - `status`: Status updates
 * - `usage`: Token usage information
 */
export type StreamEventType =
  | "text_delta" // Partial text content during generation
  | "tool_use" // Tool call starting
  | "tool_result" // Tool execution result
  | "thinking" // Extended thinking content
  | "status" // Status updates
  | "usage" // Token usage information
  | "ask_user_question"; // User question prompt (AskUserQuestion)

/**
 * Stream event emitted during execution when onStreamEvent callback is provided
 *
 * @property type - The event type from StreamEventType
 * @property data - Event data - structure depends on type
 * @property timestamp - Unix timestamp in milliseconds (optional)
 */
export interface StreamEvent {
  /** Event type */
  type: StreamEventType;
  /** Event data - structure depends on type */
  data: unknown;
  /** Unix timestamp in milliseconds */
  timestamp?: number;
}

/**
 * Callback type for handling stream events
 *
 * @param event - The stream event to handle
 */
export type StreamEventHandler = (event: StreamEvent) => void;
