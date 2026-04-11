import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Feishu client before importing the module under test
vi.mock("./client.js", () => ({
  createFeishuClient: vi.fn(() => ({
    im: {
      message: {
        create: vi.fn(async () => ({ code: 0 })),
      },
    },
  })),
}));

import {
  resolveLatestPendingPermission,
  waitForPermissionResponse,
  handleCardAction,
  isApproveAllEnabled,
  setApproveAllEnabled,
} from "./permission-handler.js";

describe("permission-handler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setApproveAllEnabled(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("resolveLatestPendingPermission()", () => {
    it("requires both chatId AND senderOpenId to match", async () => {
      const chatId = "chat_1";
      const userA = "ou_userA";
      const userB = "ou_userB";
      const permId = "perm_1";

      // Start waiting (non-blocking since we use fake timers)
      const promise = waitForPermissionResponse(permId, 60_000, chatId, userA);

      // User A can resolve their own permission
      expect(resolveLatestPendingPermission(chatId, userA)).toBe(permId);

      // User B cannot resolve User A's permission
      expect(resolveLatestPendingPermission(chatId, userB)).toBeNull();

      // Clean up: resolve the pending permission
      handleCardAction({ permissionId: permId, action: "approve" });
      await promise;
    });

    it("returns null when no permission is pending", () => {
      expect(resolveLatestPendingPermission("chat_1", "ou_user")).toBeNull();
    });

    it("returns null after permission has been resolved", async () => {
      const chatId = "chat_2";
      const user = "ou_user";
      const permId = "perm_2";

      const promise = waitForPermissionResponse(permId, 60_000, chatId, user);
      handleCardAction({ permissionId: permId, action: "approve" });
      await promise;

      expect(resolveLatestPendingPermission(chatId, user)).toBeNull();
    });
  });

  describe("group chat isolation", () => {
    it("user A's /approve does NOT resolve user B's pending permission", async () => {
      const chatId = "group_chat";
      const userA = "ou_userA";
      const userB = "ou_userB";
      const permA = "perm_A";
      const permB = "perm_B";

      // Both users have pending permissions in the same chat
      const promiseA = waitForPermissionResponse(permA, 60_000, chatId, userA);
      const promiseB = waitForPermissionResponse(permB, 60_000, chatId, userB);

      // User A can only see their own pending permission
      expect(resolveLatestPendingPermission(chatId, userA)).toBe(permA);
      expect(resolveLatestPendingPermission(chatId, userB)).toBe(permB);

      // Resolve A's permission — B's remains pending
      handleCardAction({ permissionId: permA, action: "approve" });
      const resultA = await promiseA;
      expect(resultA.approved).toBe(true);

      expect(resolveLatestPendingPermission(chatId, userA)).toBeNull();
      expect(resolveLatestPendingPermission(chatId, userB)).toBe(permB);

      // Clean up
      handleCardAction({ permissionId: permB, action: "deny" });
      await promiseB;
    });
  });

  describe("correct resolution", () => {
    it("user A's /approve resolves user A's pending permission", async () => {
      const chatId = "chat_3";
      const user = "ou_userA";
      const permId = "perm_resolve";

      const promise = waitForPermissionResponse(permId, 60_000, chatId, user);

      // Resolve via the looked-up permission id
      const resolved = resolveLatestPendingPermission(chatId, user);
      expect(resolved).toBe(permId);
      handleCardAction({ permissionId: resolved!, action: "approve" });

      const result = await promise;
      expect(result.approved).toBe(true);
    });
  });

  describe("handleCardAction()", () => {
    it("approve_all sets the approve-all flag", async () => {
      const permId = "perm_aa";
      const promise = waitForPermissionResponse(permId, 60_000, "chat", "user");

      expect(isApproveAllEnabled()).toBe(false);
      handleCardAction({ permissionId: permId, action: "approve_all" });
      expect(isApproveAllEnabled()).toBe(true);

      const result = await promise;
      expect(result.approved).toBe(true);
    });

    it("deny resolves with approved=false", async () => {
      const permId = "perm_deny";
      const promise = waitForPermissionResponse(permId, 60_000, "chat", "user");

      handleCardAction({ permissionId: permId, action: "deny" });
      const result = await promise;
      expect(result.approved).toBe(false);
      expect(result.reason).toContain("denied");
    });

    it("is a no-op for an unknown permission id", () => {
      // Should not throw
      handleCardAction({ permissionId: "nonexistent", action: "approve" });
    });
  });

  describe("timeout", () => {
    it("resolves with approved=false after timeout", async () => {
      const permId = "perm_timeout";
      const promise = waitForPermissionResponse(permId, 5_000, "chat", "user");

      vi.advanceTimersByTime(5_001);

      const result = await promise;
      expect(result.approved).toBe(false);
      expect(result.reason).toContain("timed out");
    });
  });
});
