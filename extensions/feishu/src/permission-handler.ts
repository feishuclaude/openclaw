// feishu/src/permission-handler.ts
// Permission card flow for @happy HappyClawSDK integration.

import { createFeishuClient } from "./client.js";
import type { ResolvedFeishuAccount } from "./types.js";

export interface PermissionResult {
  approved: boolean;
  modifiedInput?: Record<string, unknown>;
  reason?: string;
}

// Store pending permission requests with expiry time
const pendingPermissions = new Map<
  string,
  {
    resolve: (result: PermissionResult) => void;
    timeout: NodeJS.Timeout;
    expiresAt: number;
  }
>();

// User-scoped reverse lookup: `${chatId}:${senderOpenId}` -> most recent pending permissionId.
// Composite key prevents privilege escalation in group chats where any user's
// /approve could previously resolve another user's pending permission.
const pendingPermissionByChat = new Map<string, string>();

// Approve-all state: when enabled, all future permission requests auto-approve
let approveAllEnabled = false;

export function isApproveAllEnabled(): boolean {
  return approveAllEnabled;
}

export function setApproveAllEnabled(enabled: boolean): void {
  approveAllEnabled = enabled;
}

// Periodic cleanup interval (5 minutes)
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

function cleanupExpiredPermissions() {
  const now = Date.now();
  for (const [id, entry] of pendingPermissions.entries()) {
    if (now > entry.expiresAt) {
      entry.resolve({ approved: false, reason: "Permission request expired" });
      clearTimeout(entry.timeout);
      pendingPermissions.delete(id);
    }
  }
}

const cleanupInterval = setInterval(cleanupExpiredPermissions, CLEANUP_INTERVAL_MS);

if (typeof process !== "undefined") {
  process.on("beforeExit", () => {
    clearInterval(cleanupInterval);
    for (const [, entry] of pendingPermissions.entries()) {
      clearTimeout(entry.timeout);
    }
    pendingPermissions.clear();
  });
}

/**
 * Send permission card to Feishu chat.
 */
export async function sendPermissionCard(opts: {
  account: ResolvedFeishuAccount;
  chatId: string;
  permissionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}): Promise<void> {
  const { account, chatId, permissionId, toolName, toolInput } = opts;

  const client = createFeishuClient(account);

  const inputDisplay =
    Object.keys(toolInput).length > 0
      ? "\n\n**Input:**\n```json\n" + JSON.stringify(toolInput, null, 2) + "\n```"
      : "";

  // Schema 1.0 card format - required for interactive action buttons
  // (Schema 2.0 does NOT support the "action" tag)
  const cardContent = {
    config: { wide_screen_mode: true },
    elements: [
      {
        tag: "markdown",
        content: `**Tool Permission Request**\n\n**Tool:** \`${toolName}\`${inputDisplay}`,
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "Approve" },
            type: "primary",
            value: { permissionId, action: "approve" },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "Approve All" },
            type: "primary",
            value: { permissionId, action: "approve_all" },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "Deny" },
            type: "default",
            value: { permissionId, action: "deny" },
          },
        ],
      },
    ],
  };

  // Always create new message for permission card.
  // Replying to interactive cards with another interactive card often fails with 400.
  const response = await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "interactive",
      content: JSON.stringify(cardContent),
    },
  });

  if (response.code !== 0) {
    throw new Error(`Failed to send permission card: ${response.msg || `code ${response.code}`}`);
  }
}

/**
 * Wait for permission response from card button click or /approve / /deny command.
 */
export async function waitForPermissionResponse(
  permissionId: string,
  timeout: number,
  chatId?: string,
  senderOpenId?: string,
): Promise<PermissionResult> {
  // Track the latest pending permission scoped to chat + sender (enables /approve and /deny).
  // The composite key ensures that in group chats only the original requester can
  // approve/deny their own pending permission.
  const compositeKey = chatId && senderOpenId ? `${chatId}:${senderOpenId}` : chatId;
  if (compositeKey) {
    pendingPermissionByChat.set(compositeKey, permissionId);
  }

  return new Promise((resolve) => {
    const expiresAt = Date.now() + timeout;
    const timer = setTimeout(() => {
      cleanup();
      resolve({
        approved: false,
        reason: "Permission request timed out",
      });
    }, timeout);

    function cleanup() {
      clearTimeout(timer);
      pendingPermissions.delete(permissionId);
      // Only remove the chat+sender mapping if it still points to this permission
      if (compositeKey && pendingPermissionByChat.get(compositeKey) === permissionId) {
        pendingPermissionByChat.delete(compositeKey);
      }
    }

    pendingPermissions.set(permissionId, {
      resolve: (result: PermissionResult) => {
        cleanup();
        resolve(result);
      },
      timeout: timer,
      expiresAt,
    });
  });
}

/**
 * Get the most recent pending permission ID for a chat + sender.
 * Used by /approve and /deny text commands to resolve the correct permission.
 * The composite key ensures group chat users can only resolve their own requests.
 * @returns The pending permissionId, or null if none exists
 */
export function resolveLatestPendingPermission(
  chatId: string,
  senderOpenId: string,
): string | null {
  const compositeKey = `${chatId}:${senderOpenId}`;
  const permissionId = pendingPermissionByChat.get(compositeKey);
  if (!permissionId) {
    return null;
  }
  // Verify the permission is still pending
  if (!pendingPermissions.has(permissionId)) {
    pendingPermissionByChat.delete(compositeKey);
    return null;
  }
  return permissionId;
}

/**
 * Handle card action callback.
 * Called from card-action.ts when user clicks a permission button.
 */
export function handleCardAction(cardAction: {
  permissionId: string;
  action: "approve" | "approve_all" | "deny";
}): void {
  const { permissionId, action } = cardAction;

  const pending = pendingPermissions.get(permissionId);
  if (!pending) {
    return;
  }

  if (action === "approve" || action === "approve_all") {
    if (action === "approve_all") {
      approveAllEnabled = true;
    }
    pending.resolve({ approved: true });
  } else {
    pending.resolve({
      approved: false,
      reason: "Permission denied by user",
    });
  }
}
