# Command System Optimization for Feishu Extension

## Context

The Feishu extension's command system (last commit `82c7f48`) has several pain points:

1. **Hardcoded commands** -- only 3 superpowers (brain/plan/do) defined statically in `superpower-commands.ts`
2. **No text-based approve/deny** -- users can only approve/deny via card buttons
3. **Repetitive `/happy` prefix** -- every message to Claude Code requires `/happy <prompt>`
4. **~250 lines of duplicated code** -- `handleHappyCommand()` and `handleSuperpowerCommand()` in `bot.ts` are ~90% identical

This plan addresses all four issues with minimal churn.

---

## Changes

### 1. NEW: `extensions/feishu/src/command-registry.ts` (~120 LOC)

Replaces the hardcoded `SUPERPOWER_COMMANDS` map with a convention-based auto-discovery registry.

**Types:**

```ts
interface CommandDefinition {
  name: string; // e.g. "brain"
  alias: string; // e.g. "b"
  skill: string; // e.g. "superpowers:brainstorming"
  requiresArgs: boolean;
  description: string; // for help card
  usageExample: string; // for error messages
}
```

**Convention mapping logic:**

- Input skill id: `superpowers:brainstorming`
- Extract last segment: `brainstorming`
- Check abbreviation map (for backward compat: `brainstorming->brain`, `writing-plans->plan`, `executing-plans->do`)
- No abbreviation hit => use full segment as command name
- Alias = first character (collision resolution: append `2`, `3`, etc.)

**Exported API:**

- `registerSkill(skillId, opts?)` -- register a new skill command
- `resolveCommand(input)` -- resolve `/brain` or `/b` to a `CommandDefinition`
- `isRegisteredCommand(input)` -- check if a command is a registered skill
- `getAllCommands()` -- for help card generation (sorted deterministically)
- `buildSkillPrompt(skill, userPrompt)` -- moved from `superpower-commands.ts`

The 3 existing commands are registered at module init time for backward compat.

### 2. NEW: `extensions/feishu/src/persistent-session.ts` (~80 LOC)

Manages per-chat persistent session state.

**State:** `Map<chatId, PersistentSession>`

```ts
interface PersistentSession {
  chatId: string;
  startedBy: string; // senderOpenId who ran /happy on
  startedAt: number;
}
```

**Exported API:**

- `startPersistentSession(chatId, senderOpenId)`
- `endPersistentSession(chatId): boolean`
- `isPersistentSessionActive(chatId): boolean`
- `isPersistentSessionOwner(chatId, senderOpenId): boolean`

Only the session-starting user's messages route to Claude Code. Other users in the chat are unaffected.

### 3. NEW: `extensions/feishu/src/claude-code-executor.ts` (~250 LOC)

Extracts the shared execution logic from `handleHappyCommand()` and `handleSuperpowerCommand()` into a single function.

```ts
interface ClaudeCodeExecutionParams {
  cfg: ClawdbotConfig;
  account: ResolvedFeishuAccount;
  chatId: string;
  prompt: string;
  mode: { kind: "happy" } | { kind: "skill"; skillId: string; commandName: string };
  options?: { newSession?: boolean; resetApproveAll?: boolean };
  log: (...args: unknown[]) => void;
}

async function executeClaudeCode(params: ClaudeCodeExecutionParams): Promise<void>;
```

This file also takes ownership of:

- `activeHappyExecution` concurrency guard
- `cachedClaudeSession` map + helpers (`getCachedSessionId`, `setCachedSessionId`)
- Constants: `PERMISSION_TIMEOUT_MS`, `DEFAULT_HAPPY_WORKING_DIR`, `SESSION_CACHE_TTL_MS`

The only divergence between happy/skill mode is prompt construction:

- happy: `Work exclusively within ${workDir}. ${prompt}`
- skill: `Work exclusively within ${workDir}. ${buildSkillPrompt(skillId, prompt)}`

### 4. MODIFY: `extensions/feishu/src/permission-handler.ts`

Add chat-scoped pending permission lookup so `/approve` and `/deny` text commands work.

**Add:**

- `pendingPermissionByChat: Map<string, string>` -- maps `chatId -> permissionId`
- Update `waitForPermissionResponse()` to accept `chatId` and store the mapping
- `resolveLatestPendingPermission(chatId): string | null` -- returns the active `permissionId` for a chat
- Clean up `pendingPermissionByChat` entry when permission resolves

### 5. MODIFY: `extensions/feishu/src/target-utils.ts`

- Add `/approve` and `/deny` to `BUILTIN_COMMANDS` set
- Remove `isSuperpowerCommand()` (it uses `require()` -- a CJS pattern in ESM code)
- Add `isPermissionCommand(messageText): boolean` -- returns true for `/approve` and `/deny`

### 6. MODIFY: `extensions/feishu/src/bot.ts` (major refactor, net ~500 LOC reduction)

**Remove:**

- `handleHappyCommand()` function (lines 491-735) -- replaced by `executeClaudeCode()`
- `handleSuperpowerCommand()` function (lines 738-987) -- replaced by `executeClaudeCode()`
- Session cache state/helpers -- moved to `claude-code-executor.ts`
- `activeHappyExecution` -- moved to `claude-code-executor.ts`

**Add new command routing in `handleFeishuMessage()`:**

```
Updated routing order:
1. Persistent session intercept (BEFORE question handler)
   - if persistent session active AND sender is owner:
     - if /happy off -> end session, send confirmation, return
     - if builtin command (/help, /status, /stop, /reset, /approve, /deny) -> handle, return
     - otherwise -> executeClaudeCode(content, mode: "happy"), return
   - else -> continue to normal routing

2. Active question text answer routing (existing)

3. isCommand() check:
   a. /help, /status, /stop, /reset -> handleBuiltinCommand()
   b. /approve -> resolveLatestPendingPermission(chatId) -> approve or "no pending request"
   c. /deny -> resolveLatestPendingPermission(chatId) -> deny or "no pending request"
   d. /happy on -> startPersistentSession(chatId, senderOpenId), send confirmation
   e. /happy off -> endPersistentSession(chatId), send confirmation
   f. /happy <prompt> -> executeClaudeCode(happy mode)
   g. /<registered-skill> <args> -> executeClaudeCode(skill mode)
   h. Unknown slash -> fall through to OpenClaw dispatch

4. Regular message -> OpenClaw dispatch
```

**Integration details for /approve and /deny:**

```ts
// In the command routing section
if (isPermissionCommand(ctx.content)) {
  const cmd = extractCommand(ctx.content); // "/approve" or "/deny"
  const permId = resolveLatestPendingPermission(ctx.chatId);
  if (permId) {
    handleCardAction({
      permissionId: permId,
      action: cmd === "/approve" ? "approve" : "deny",
    });
    // Send confirmation
  } else {
    // Send "No pending permission request"
  }
  return;
}
```

### 7. MODIFY: `extensions/feishu/src/card-builder.ts`

Update `buildHelpCard()` to dynamically generate the "Superpowers" section from `commandRegistry.getAllCommands()` instead of hardcoded text.

Add new help entries:

- `/approve` -- Approve pending permission request
- `/deny` -- Deny pending permission request
- `/happy on` -- Start persistent Claude Code session
- `/happy off` -- End persistent session

### 8. DELETE: `extensions/feishu/src/superpower-commands.ts`

All functionality moved to `command-registry.ts`. This file is no longer needed.

---

## Files Summary

| File                      | Action | ~LOC Change                                    |
| ------------------------- | ------ | ---------------------------------------------- |
| `command-registry.ts`     | CREATE | +120                                           |
| `persistent-session.ts`   | CREATE | +80                                            |
| `claude-code-executor.ts` | CREATE | +250                                           |
| `superpower-commands.ts`  | DELETE | -131                                           |
| `bot.ts`                  | MODIFY | -500 (remove duplicated handlers, add routing) |
| `permission-handler.ts`   | MODIFY | +30                                            |
| `target-utils.ts`         | MODIFY | +10, -10                                       |
| `card-builder.ts`         | MODIFY | +20, -15                                       |
| **Net**                   |        | **~-150 LOC**                                  |

---

## Implementation Order

1. `command-registry.ts` -- no dependencies on other new code
2. `persistent-session.ts` -- standalone state module
3. `claude-code-executor.ts` -- extract from bot.ts (references command-registry)
4. `target-utils.ts` -- update builtin commands, remove `isSuperpowerCommand()`
5. `permission-handler.ts` -- add chat-scoped lookup
6. `bot.ts` -- integrate all new modules, remove old handlers
7. `card-builder.ts` -- dynamic help card
8. Delete `superpower-commands.ts` -- last step after all imports migrated

---

## Verification

1. **Type check**: `pnpm tsgo` (or `pnpm build`) from repo root
2. **Lint**: `pnpm check`
3. **Tests**: Run existing Feishu tests: `pnpm test extensions/feishu`
4. **Manual verification scenarios**:
   - `/brain test topic` and `/b test topic` still work (backward compat)
   - `/plan a feature` and `/p a feature` still work
   - `/help` shows dynamic command list including new commands
   - `/approve` when no pending permission -> "No pending permission request"
   - `/happy on` -> confirmation message, then plain text routes to Claude Code
   - `/happy off` -> ends session, plain text goes back to normal
   - During persistent session, `/help` and `/status` still work
   - In group chat, only the session starter's messages are intercepted
