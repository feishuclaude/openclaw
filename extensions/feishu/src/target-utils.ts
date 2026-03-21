// feishu/src/target-utils.ts

/**
 * Check if a message text is a command (starts with /)
 */
export function isCommand(messageText: string): boolean {
  return messageText.trim().startsWith("/");
}

/**
 * Extract the command part from a message (e.g., "/happy what files" -> "/happy")
 */
export function extractCommand(messageText: string): string {
  const trimmed = messageText.trim();
  const match = trimmed.match(/^\/[a-zA-Z0-9_-]+/);
  return match ? match[0] : "";
}

/**
 * Extract the arguments from a command message (e.g., "/happy what files" -> "what files")
 */
export function extractCommandArgs(messageText: string): string {
  const trimmed = messageText.trim();
  const cmd = extractCommand(trimmed);
  if (!cmd) return trimmed;
  return trimmed.slice(cmd.length).trim();
}

/**
 * Check if a message is a /happy command
 */
export function isHappyMessage(messageText: string): boolean {
  const cmd = extractCommand(messageText);
  return cmd === "/happy" || cmd === "/happy-claude-code";
}

/**
 * Check if a /happy message requests a new session (--new or @new for backward compat)
 */
export function isNewSessionRequest(messageText: string): boolean {
  const args = extractCommandArgs(messageText);
  return args.startsWith("--new") || args.startsWith("@new");
}

/**
 * Check if a /happy message requests resetting approve-all (--reset or @reset for backward compat)
 */
export function isResetRequest(messageText: string): boolean {
  const args = extractCommandArgs(messageText);
  return args.startsWith("--reset") || args.startsWith("@reset");
}

/**
 * Strip /happy prefix and flags from message text
 */
export function stripHappyPrefix(messageText: string): string {
  const args = extractCommandArgs(messageText);
  return args
    .replace(/^--new\s*/i, "")
    .replace(/^@new\s*/i, "")
    .replace(/^--reset\s*/i, "")
    .replace(/^@reset\s*/i, "")
    .replace(/use happy-claude-code skill[：:]\s*/i, "")
    .replace(/using happy-claude-code skill[：:]\s*/i, "")
    .trim();
}

/**
 * Built-in commands that don't require @mention
 */
export const BUILTIN_COMMANDS = new Set([
  "/help",
  "/status",
  "/stop",
  "/reset",
  "/happy",
  "/happy-claude-code",
]);

/**
 * Check if a message is a built-in command
 */
export function isBuiltinCommand(messageText: string): boolean {
  const cmd = extractCommand(messageText);
  return BUILTIN_COMMANDS.has(cmd);
}

/**
 * Check if a message is a superpower command (e.g., /brain, /plan, /do, /b, /p, /d)
 */
export function isSuperpowerCommand(messageText: string): boolean {
  const cmd = extractCommand(messageText);
  if (!cmd) return false;
  const { isSuperpowerCommandName } = require("./superpower-commands");
  return isSuperpowerCommandName(cmd);
}
