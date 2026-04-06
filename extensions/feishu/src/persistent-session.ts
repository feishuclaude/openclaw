// feishu/src/persistent-session.ts

/**
 * Per-chat persistent session state for /happy on / /happy off.
 *
 * When a persistent session is active, all messages from the session-starting
 * user route directly to Claude Code without requiring the /happy prefix.
 * Other users in the same chat are unaffected.
 */

/**
 * Persistent session state for a single chat.
 */
export interface PersistentSession {
  /** Chat ID where the session is active */
  chatId: string;
  /** Sender open_id who started the session via /happy on */
  startedBy: string;
  /** Timestamp when the session was started */
  startedAt: number;
}

/** Active persistent sessions keyed by chatId */
const persistentSessions = new Map<string, PersistentSession>();

/**
 * Start a persistent session for a chat.
 * Only one persistent session can be active per chat at a time.
 */
export function startPersistentSession(chatId: string, senderOpenId: string): void {
  persistentSessions.set(chatId, {
    chatId,
    startedBy: senderOpenId,
    startedAt: Date.now(),
  });
}

/**
 * End the persistent session for a chat.
 * @returns true if a session was actually active and ended
 */
export function endPersistentSession(chatId: string): boolean {
  return persistentSessions.delete(chatId);
}

/**
 * Check if a persistent session is active for a chat.
 */
export function isPersistentSessionActive(chatId: string): boolean {
  return persistentSessions.has(chatId);
}

/**
 * Check if the sender is the owner of the persistent session in a chat.
 * Returns false if no persistent session is active.
 */
export function isPersistentSessionOwner(chatId: string, senderOpenId: string): boolean {
  const session = persistentSessions.get(chatId);
  if (!session) {
    return false;
  }
  return session.startedBy === senderOpenId;
}

/**
 * Get the persistent session for a chat, if active.
 */
export function getPersistentSession(chatId: string): PersistentSession | undefined {
  return persistentSessions.get(chatId);
}
