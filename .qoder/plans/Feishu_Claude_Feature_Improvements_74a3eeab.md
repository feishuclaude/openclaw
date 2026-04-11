# Feishu Claude Feature Improvement Plan

## Commit Analysis Summary

**Commit 1422c3831e** ("feat(feishu): Add Claude Code support") introduced 4,100+ lines of new functionality:

- `HappyClawSDK` wrapper for Claude Agent SDK (`extensions/feishu/src/sdk/HappyClawSDK.ts`)
- Streaming card system with throttling (`extensions/feishu/src/streaming-card-manager.ts`, `stream-buffer.ts`)
- Permission and question card flows (`extensions/feishu/src/permission-handler.ts`, `question-handler.ts`)
- OpenClaw memory integration (`extensions/feishu/src/memory-bridge.ts`)

**Commit 664c1c5546** ("refactor(feishu): unify command system with convention-based skill registry") consolidated ~500 lines of duplication:

- Convention-based command registry (`extensions/feishu/src/command-registry.ts`)
- Unified executor (`extensions/feishu/src/claude-code-executor.ts`)
- Persistent session mode (`extensions/feishu/src/persistent-session.ts`)
- Text-based permission commands (`/approve`, `/deny`)

---

## Task 1: Add Unit Tests for New Modules (High Priority)

Three new modules from the refactor commit have zero test coverage.

**Files to create:**

- `extensions/feishu/src/command-registry.test.ts` — Test convention-based skill discovery, alias collision resolution (b, b2, b3), command name derivation, case-insensitive lookup, backward-compatible hardcoded commands, and duplicate registration handling.
- `extensions/feishu/src/claude-code-executor.test.ts` — Mock `HappyClawSDK` and verify the unified `executeClaudeCode()` path for both "happy" and "skill" modes, including permission gating, streaming card lifecycle, and error handling.
- `extensions/feishu/src/persistent-session.test.ts` — Test `/happy on`/`/happy off` toggling, session ownership enforcement (only starter can use without prefix), concurrent session isolation across chat IDs.

**Files to update:**

- `extensions/feishu/src/permission-handler.test.ts` (or coverage in `bot.test.ts`) — Add cases for the new `/approve` and `/deny` text command routing via `resolveLatestPendingPermission()`.

---

## Task 2: Fix Permission Scoping in Group Chats (Security — High Priority)

**Problem:** `resolveLatestPendingPermission(chatId)` in `extensions/feishu/src/permission-handler.ts` resolves the latest pending permission for the entire chat. In group chats, any user's `/approve` resolves any other user's pending permission request — this is a privilege escalation vector.

**Fix:**

- Change the `pendingPermissionByChat` map key from `chatId` to a composite `chatId:senderOpenId`.
- Update `resolveLatestPendingPermission()` to accept both `chatId` and `senderOpenId` parameters.
- Update callers in `extensions/feishu/src/bot.ts` and `extensions/feishu/src/target-utils.ts` to pass the sender identity.
- Add a test case simulating two users in the same group chat with concurrent permission requests.

---

## Task 3: Validate Claude SDK Availability at Startup (Functionality — High Priority)

**Problem:** `extensions/feishu/src/sdk/HappyClawSDK.ts` loads `@anthropic-ai/claude-agent-sdk` via dynamic require at execution time. If the SDK is missing, the user sees a confusing error mid-execution instead of a clear startup diagnostic.

**Fix:**

- Add an SDK availability check during bot initialization in `extensions/feishu/src/bot.ts` (or a new `extensions/feishu/src/claude-code-preflight.ts`).
- Log a clear warning at startup if the Claude Agent SDK is not installed: "Claude Code features require @anthropic-ai/claude-agent-sdk. Install it to enable /happy and skill commands."
- Gate `executeClaudeCode()` with a fast boolean check (`isClaudeSDKAvailable`) to return a user-friendly card instead of throwing.

---

## Task 4: Harden Working Directory Validation (Security — Medium Priority)

**Problem:** `extensions/feishu/src/claude-code-executor.ts` passes a working directory to the SDK with only a prompt-level constraint (`Work exclusively within ${workingDirectory}`). Prompt constraints are not a security boundary.

**Fix:**

- Before passing `workingDirectory` to `HappyClawSDK.execute()`, validate that the resolved path is within an allowed root (e.g., the configured workspace or `OPENCLAW_MEMORY_DIR`).
- Use `path.resolve()` + `path.normalize()` and verify the result starts with the allowed prefix.
- Reject execution with a clear error if the directory falls outside the allowed boundary.

---

## Task 5: Improve Memory Bridge Resilience (Functionality — Medium Priority)

**Problem:** `extensions/feishu/src/memory-bridge.ts` shells out to `openclaw memory index --force` and `openclaw agent --message ...` via `spawn()`. If the `openclaw` CLI is not in PATH, these fail silently (errors logged to console only).

**Fix:**

- Add a one-time `which openclaw` (or `where openclaw` on Windows) check at first use. Cache the result.
- If `openclaw` is unavailable, log a single warning and skip all subsequent spawn calls (avoid repeated spawn failures).
- Add a configuration flag (e.g., `FEISHU_MEMORY_BRIDGE_ENABLED=false`) to explicitly disable memory bridge features.
- Add retry logic (1 retry with 2s delay) for transient `spawn()` failures (e.g., process limit).

---

## Task 6: Add Request ID Tracing (Functionality — Medium Priority)

**Problem:** Execution flows through 4+ layers (bot -> executor -> SDK -> streaming cards -> memory bridge) with no correlation ID, making production debugging difficult.

**Fix:**

- Generate a `requestId` (nanoid or UUID) at the entry point in `executeClaudeCode()`.
- Pass it through to `StreamingCardManager`, `HappyClawSDK`, and `memory-bridge` as a context parameter.
- Include the `requestId` in all log statements and error messages throughout the execution chain.
- Include the `requestId` in the memory bridge session file metadata.

---

## Task 7: Add Streaming Card Throttle Edge Case Tests (Performance — Medium Priority)

**Problem:** `extensions/feishu/src/stream-buffer.ts` throttles card updates with a 700ms interval and 2000-char threshold. Edge cases (rapid completion, empty updates, concurrent flushes) are untested.

**File to create:**

- `extensions/feishu/src/stream-buffer.test.ts` — Cover:
  - Rapid completion (execution finishes within one throttle window)
  - `finishAll()` correctly flushes pending updates
  - Concurrent `update()` calls during flush
  - Empty/whitespace-only updates are skipped
  - Character threshold triggers immediate flush

---

## Task 8: Log Duplicate Command Registration (Low Priority)

**Problem:** `extensions/feishu/src/command-registry.ts` silently returns when a command is already registered. During skill plugin loading, this could hide configuration errors.

**Fix:**

- Add a `debug`-level log when skipping a duplicate registration, including the skill ID and conflicting command name.
- This helps diagnose plugin loading issues without producing noise in production.

---

## Task 9: Document New Commands in Help Text (Low Priority)

**Problem:** The new `/happy on`, `/happy off`, `/approve`, `/deny` commands and the convention-based skill shortcuts (`/brain`, `/plan`, `/do`) may not be reflected in the bot's `/help` output.

**Fix:**

- Update the help text generation in `extensions/feishu/src/bot.ts` or `extensions/feishu/src/card-builder.ts` to include:
  - `/happy on` / `/happy off` — Persistent session mode
  - `/approve` / `/deny` — Text-based permission responses
  - Dynamic skill command listing from the registry
- Consider auto-generating the help card from `commandRegistry` entries to keep it synchronized.

---

## Priority Summary

| Task                              | Area          | Priority | Risk Addressed                      |
| --------------------------------- | ------------- | -------- | ----------------------------------- |
| 1. Unit tests for new modules     | Testing       | High     | Untested refactored code            |
| 2. Fix permission scoping         | Security      | High     | Privilege escalation in group chats |
| 3. Validate Claude SDK at startup | Functionality | High     | Confusing runtime errors            |
| 4. Harden working directory       | Security      | Medium   | Path traversal risk                 |
| 5. Memory bridge resilience       | Functionality | Medium   | Silent failures                     |
| 6. Request ID tracing             | Functionality | Medium   | Production debugging                |
| 7. Throttle edge case tests       | Performance   | Medium   | Untested rate limiting              |
| 8. Log duplicate registrations    | Functionality | Low      | Hidden config errors                |
| 9. Document new commands          | Functionality | Low      | User discoverability                |

---

## Implementation Order

Tasks 1-3 should be addressed first as they cover security and reliability fundamentals. Tasks 4-7 form a second wave focused on hardening. Tasks 8-9 are polish items that can be done opportunistically.

Dependencies: Task 2 should be implemented before Task 1's permission tests (so the tests cover the fixed behavior). Task 6 touches multiple files and should be coordinated to avoid conflicts with Tasks 3 and 5.
