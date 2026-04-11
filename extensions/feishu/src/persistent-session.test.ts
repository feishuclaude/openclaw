import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startPersistentSession,
  endPersistentSession,
  isPersistentSessionActive,
  isPersistentSessionOwner,
  getPersistentSession,
} from "./persistent-session.js";

describe("persistent-session", () => {
  const CHAT_A = "chat_a";
  const CHAT_B = "chat_b";
  const USER_1 = "ou_user1";
  const USER_2 = "ou_user2";

  afterEach(() => {
    // Clean up any sessions created during tests
    endPersistentSession(CHAT_A);
    endPersistentSession(CHAT_B);
  });

  describe("startPersistentSession()", () => {
    it("creates a session with correct chatId, senderOpenId, and timestamp", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));

      startPersistentSession(CHAT_A, USER_1);
      const session = getPersistentSession(CHAT_A);

      expect(session).toBeDefined();
      expect(session!.chatId).toBe(CHAT_A);
      expect(session!.startedBy).toBe(USER_1);
      expect(session!.startedAt).toBe(new Date("2026-01-15T12:00:00Z").getTime());

      vi.useRealTimers();
    });
  });

  describe("isPersistentSessionActive()", () => {
    it("returns true after start", () => {
      startPersistentSession(CHAT_A, USER_1);
      expect(isPersistentSessionActive(CHAT_A)).toBe(true);
    });

    it("returns false after end", () => {
      startPersistentSession(CHAT_A, USER_1);
      endPersistentSession(CHAT_A);
      expect(isPersistentSessionActive(CHAT_A)).toBe(false);
    });

    it("returns false for a chat that was never started", () => {
      expect(isPersistentSessionActive("chat_nonexistent")).toBe(false);
    });
  });

  describe("isPersistentSessionOwner()", () => {
    it("returns true for the user who started the session", () => {
      startPersistentSession(CHAT_A, USER_1);
      expect(isPersistentSessionOwner(CHAT_A, USER_1)).toBe(true);
    });

    it("returns false for a different user", () => {
      startPersistentSession(CHAT_A, USER_1);
      expect(isPersistentSessionOwner(CHAT_A, USER_2)).toBe(false);
    });

    it("returns false when no session is active", () => {
      expect(isPersistentSessionOwner(CHAT_A, USER_1)).toBe(false);
    });
  });

  describe("endPersistentSession()", () => {
    it("returns true if a session was active", () => {
      startPersistentSession(CHAT_A, USER_1);
      expect(endPersistentSession(CHAT_A)).toBe(true);
    });

    it("returns false if no session was active", () => {
      expect(endPersistentSession(CHAT_A)).toBe(false);
    });
  });

  describe("getPersistentSession()", () => {
    it("returns the session object when active", () => {
      startPersistentSession(CHAT_A, USER_1);
      const session = getPersistentSession(CHAT_A);
      expect(session).toBeDefined();
      expect(session!.chatId).toBe(CHAT_A);
    });

    it("returns undefined when no session is active", () => {
      expect(getPersistentSession("nonexistent")).toBeUndefined();
    });
  });

  describe("multiple chats", () => {
    it("sessions in different chats are isolated", () => {
      startPersistentSession(CHAT_A, USER_1);
      startPersistentSession(CHAT_B, USER_2);

      expect(isPersistentSessionOwner(CHAT_A, USER_1)).toBe(true);
      expect(isPersistentSessionOwner(CHAT_A, USER_2)).toBe(false);
      expect(isPersistentSessionOwner(CHAT_B, USER_2)).toBe(true);
      expect(isPersistentSessionOwner(CHAT_B, USER_1)).toBe(false);
    });

    it("ending one chat does not affect the other", () => {
      startPersistentSession(CHAT_A, USER_1);
      startPersistentSession(CHAT_B, USER_2);

      endPersistentSession(CHAT_A);
      expect(isPersistentSessionActive(CHAT_A)).toBe(false);
      expect(isPersistentSessionActive(CHAT_B)).toBe(true);
    });
  });

  describe("overwrite", () => {
    it("starting a new session replaces the previous one", () => {
      startPersistentSession(CHAT_A, USER_1);
      expect(isPersistentSessionOwner(CHAT_A, USER_1)).toBe(true);

      startPersistentSession(CHAT_A, USER_2);
      expect(isPersistentSessionOwner(CHAT_A, USER_1)).toBe(false);
      expect(isPersistentSessionOwner(CHAT_A, USER_2)).toBe(true);
    });
  });
});
