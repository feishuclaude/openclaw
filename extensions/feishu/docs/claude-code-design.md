# Feishu Claude Code Integration: System Design Document

## 1. Executive Summary

The Feishu Claude Code integration brings real-time Claude AI agent execution capabilities directly into the Feishu (Lark) messaging platform. Introduced across two major commits and a subsequent hardening pass, this system enables users to invoke Claude Code from Feishu chats with full streaming output, interactive permission flows, persistent sessions, and memory integration with OpenClaw.

**Commit timeline:**

| Commit                | Date       | Scope                          | Net change                   |
| --------------------- | ---------- | ------------------------------ | ---------------------------- |
| `1422c3831e`          | 2026-03-22 | feat: Add Claude Code support  | +4,102 lines across 16 files |
| `664c1c5546`          | 2026-04-06 | refactor: Unify command system | +812 / -695 across 9 files   |
| Uncommitted hardening | 2026-04-08 | Security, resilience, tracing  | +315 / -104 across 8 files   |

The system adds approximately 5,500 lines of new functionality organized into 14 core modules, 5 test suites (925 test lines, 68 test cases), and a dedicated SDK wrapper layer.

---

## 2. Architecture Overview

### 2.1 Layered Architecture

The system follows a four-layer architecture with clear separation of concerns:

```
Layer 4 - Message Routing         bot.ts, target-utils.ts
Layer 3 - Orchestration           claude-code-executor.ts, command-registry.ts, persistent-session.ts
Layer 2 - Interaction             streaming-card-manager.ts, permission-handler.ts, question-handler.ts,
                                  card-builder.ts, stream-buffer.ts
Layer 1 - Execution               sdk/HappyClawSDK.ts, sdk/types.ts, memory-bridge.ts, claude-code-preflight.ts
```

**Layer 1 (Execution)** owns the Claude Agent SDK wrapper, session recording, and SDK availability detection. It has no knowledge of Feishu-specific UI concerns.

**Layer 2 (Interaction)** manages the Feishu card lifecycle: building card JSON, throttling API calls, rendering permission and question prompts, and collecting user responses via card actions.

**Layer 3 (Orchestration)** ties execution to interaction. The unified executor (`executeClaudeCode`) coordinates SDK invocation, permission callbacks, streaming card updates, session caching, and memory persistence. The command registry and persistent session modules handle command resolution and routing state.

**Layer 4 (Message Routing)** is the entry point. `bot.ts` parses incoming Feishu messages, classifies them (built-in command, skill command, permission command, persistent session message, or regular message), and delegates to the appropriate Layer 3 handler.

### 2.2 Data Flow

```
Feishu WebSocket/Webhook Message
    |
    v
bot.handleFeishuMessage()
    |
    +-- [Command Classification] -- target-utils.ts
    |   |
    |   +-- /happy [prompt]      --> executeClaudeCode({ kind: "happy" })
    |   +-- /brain, /plan, /do   --> command-registry.resolveCommand()
    |   |                            --> executeClaudeCode({ kind: "skill" })
    |   +-- /approve, /deny      --> resolveLatestPendingPermission(chatId, senderOpenId)
    |   +-- /happy on | off      --> persistent-session start/end
    |   +-- /help                --> buildHelpCard()
    |   +-- /status, /stop, /reset --> existing OpenClaw handlers
    |   +-- [persistent session] --> executeClaudeCode({ kind: "happy" })
    |
    v
executeClaudeCode()
    |
    +-- [1] isClaudeSDKAvailable()?         -- claude-code-preflight.ts
    +-- [2] Concurrency guard               -- activeExecution flag
    +-- [3] isWithinAllowedRoot()?          -- path validation
    +-- [4] StreamingCardManager.startSession()
    +-- [5] HappyClawSDK.execute(prompt, {
    |       onPermission:     --> sendPermissionCard() + waitForPermissionResponse()
    |       onStreamEvent:    --> cardManager.handleEvent() --> stream-buffer throttle
    |       onAskUserQuestion: --> sendQuestionCard() + waitForQuestionAnswer()
    |   })
    +-- [6] writeSessionToMemory()          -- memory-bridge.ts
    +-- [7] cardManager.destroy()           -- cleanup
```

### 2.3 Module Dependency Graph

```
bot.ts
  +-- target-utils.ts
  |     +-- command-registry.ts
  +-- claude-code-executor.ts
  |     +-- claude-code-preflight.ts
  |     +-- sdk/HappyClawSDK.ts
  |     |     +-- sdk/types.ts
  |     +-- streaming-card-manager.ts
  |     |     +-- card-builder.ts
  |     |     +-- stream-buffer.ts (FeishuCardThrottle)
  |     +-- permission-handler.ts
  |     +-- question-handler.ts
  |     +-- memory-bridge.ts
  |     +-- command-registry.ts (for skill prompt building)
  +-- persistent-session.ts
  +-- permission-handler.ts (for /approve, /deny)
```

---

## 3. Core Components

### 3.1 HappyClawSDK (`sdk/HappyClawSDK.ts`, 815 lines)

The lowest-level execution wrapper around the Claude Agent SDK. Provides three execution strategies with automatic fallback:

1. **Streaming with permissions** (preferred) -- Uses the SDK's `query()` async generator API. Iterates stream events in real time, supports `canUseTool` permission callbacks, and captures `claudeSessionId` for multi-turn resumption.

2. **Non-streaming with permissions** -- Falls back to `unstable_v2_prompt()` when streaming is unavailable. Still supports permission callbacks but without incremental output.

3. **CLI fallback** -- Spawns the `claude` CLI binary as a child process. No permission handling; used only when the SDK package is entirely absent.

**Key design decisions:**

- **Dynamic SDK loading**: Uses `createRequire` + `require.resolve` to probe for `@anthropic-ai/claude-agent-sdk` at runtime. This allows the Feishu extension to be installed without the Claude SDK as a hard dependency.

- **Session resumption**: Captures `session_id` from SDK responses and passes it back via `options.claudeSessionId` on subsequent calls. This enables multi-turn conversations within a single Feishu chat thread without re-establishing context.

- **Callback-driven architecture**: Permission, stream event, and question callbacks are injected via options, keeping the SDK wrapper decoupled from Feishu-specific UI concerns.

### 3.2 Unified Executor (`claude-code-executor.ts`, 395 lines)

The central orchestration function `executeClaudeCode()` replaced two previously separate handlers (`handleHappyCommand` and `handleSuperpowerCommand`), eliminating approximately 500 lines of duplicated logic.

**Execution lifecycle:**

```
1. Preflight          -- SDK available? (claude-code-preflight.ts)
2. Concurrency        -- Only one execution per bot instance
3. Request ID         -- Generate tracing ID for cross-layer correlation
4. Working dir        -- Validate against ALLOWED_ROOTS
5. Card manager       -- Create StreamingCardManager for this session
6. SDK execution      -- HappyClawSDK.execute() with callbacks
7. Memory bridge      -- Write session to OpenClaw memory
8. Cleanup            -- Destroy card manager, release concurrency lock
```

**Execution modes:**

- `{ kind: "happy" }` -- Direct Claude Code execution. The user's prompt is passed through with a working directory constraint.
- `{ kind: "skill", skillId, commandName }` -- The prompt is wrapped with skill-specific methodology instructions via `buildSkillPrompt()` from the command registry.

**Session caching:**

Sessions are cached per-chatId with a 1-hour TTL. The `--new` flag clears the cached session, forcing a fresh context. The `--reset` flag disables the `approveAll` mode.

### 3.3 Command Registry (`command-registry.ts`, 202 lines)

Replaces the deleted `superpower-commands.ts` with a convention-based discovery system.

**Registration flow:**

```
Skill ID: "superpowers:brainstorming"
    |
    v
[Extract last segment] --> "brainstorming"
    |
    v
[Check ABBREVIATION_MAP] --> "brain" (mapped)
    |
    v
[Derive alias] --> first letter "b"
    |
    v
[Check collision] --> "b" available? Yes --> register
                  --> "b" taken?    --> try "b2", "b3", ...
```

**Built-in skills:**

| Skill ID                      | Command  | Alias | Description        |
| ----------------------------- | -------- | ----- | ------------------ |
| `superpowers:brainstorming`   | `/brain` | `/b`  | Brainstorming mode |
| `superpowers:writing-plans`   | `/plan`  | `/p`  | Writing plans      |
| `superpowers:executing-plans` | `/do`    | `/d`  | Executing plans    |

The registry is extensible: additional skills from the `./skills` directory can register themselves at module load time. `getAllCommands()` provides a sorted snapshot for dynamic help card generation.

### 3.4 Streaming Card Manager (`streaming-card-manager.ts`, 622 lines)

Manages per-chat card state during execution with debounced updates to respect Feishu API rate limits.

**Card state machine:**

```
[thinking] --> [running] --> [complete]
                  |               |
                  v               v
           [waiting_for_input]  [error]
```

**Stream event handling:**

| Event type          | Action                                                            |
| ------------------- | ----------------------------------------------------------------- |
| `text_delta`        | Accumulate response text, schedule debounced update               |
| `tool_use`          | Add tool to card with spinner icon, truncate detail at threshold  |
| `tool_result`       | Mark tool complete with checkmark icon                            |
| `thinking`          | Update status to "thinking"                                       |
| `status`            | Update status and duration                                        |
| `ask_user_question` | Create pending question, render question card with option buttons |

**Sequential question flow:**

When the SDK emits multiple questions in batch, the manager detects this pattern and shows them one at a time with a progress indicator ("Question 1 of 3"). Answers are collected in an ordered Map and displayed as a summary after all questions are answered. A `transitioningQuestions` Set guards against double-processing during transitions.

### 3.5 Stream Buffer (`stream-buffer.ts`, 103 lines)

Throttles card update API calls to prevent Feishu 429 rate limit errors.

**Parameters:**

- `MIN_UPDATE_INTERVAL`: 700ms (higher than the 500ms used in AgentChat due to Feishu API latency)
- `IMMEDIATE_THRESHOLD`: 2000 characters accumulated triggers an immediate flush

**Concurrency guard:** An `_isFlushing` flag prevents overlapping flush operations. If a new update arrives during a flush, it sets `_pendingFlushAfterCurrent` which triggers a follow-up flush after the current one completes.

### 3.6 Permission Handler (`permission-handler.ts`, 230 lines)

Manages the interactive permission flow for tool execution approval.

**Permission lifecycle:**

```
1. SDK requests permission (onPermission callback)
2. sendPermissionCard() --> Feishu interactive card with Approve/Approve All/Deny
3. waitForPermissionResponse() --> Promise with 120s timeout
4. User clicks button OR types /approve or /deny
5. handleCardAction() or resolveLatestPendingPermission() resolves the Promise
6. Result returned to SDK's canUseTool callback
```

**Group chat isolation (security hardening):**

The `pendingPermissionByChat` map uses composite keys `${chatId}:${senderOpenId}` to ensure that in group chats, only the user who initiated the execution can approve or deny their own pending permissions. This prevents a privilege escalation attack where any group member could approve another user's tool execution.

### 3.7 Memory Bridge (`memory-bridge.ts`, 657 lines)

Integrates with the OpenClaw memory system to persist execution records as searchable markdown files.

**Session data model:**

```typescript
interface ClaudeCodeSession {
  userId: string;
  chatId: string;
  task: string;
  actions: string[];
  toolsUsed: string[];
  filesModified: string[];
  result: "success" | "failure" | "partial";
  insights: string[];
  fullContext: string;
  duration: number;
  error?: string;
  requestId?: string;
}
```

**Output format:** Timestamped markdown files in `${OPENCLAW_MEMORY_DIR}`:

```
YYYY-MM-DD-claude-code-{task-abbrev}-{session-id-8-chars}.md
```

**Resilience features (hardening pass):**

- CLI availability probing with cached result
- `FEISHU_MEMORY_BRIDGE_ENABLED` environment variable to disable bridge
- `spawnWithRetry` helper for transient spawn failures (1 retry, 2s delay, ENOENT excluded)
- Structured logging with `[feishu:memory-bridge]` prefix

### 3.8 Persistent Session (`persistent-session.ts`, 71 lines)

Manages `/happy on` and `/happy off` state for individual chats.

When active, all messages from the session owner route directly to Claude Code without requiring the `/happy` prefix. Other users in the same chat are unaffected. State is per-chat, in-memory, and does not survive bot restarts.

### 3.9 Claude Code Preflight (`claude-code-preflight.ts`, 30 lines)

One-time availability check for `@anthropic-ai/claude-agent-sdk`. Uses `createRequire` + `require.resolve` to probe the package, caches the result, and logs a warning if unavailable. `executeClaudeCode()` gates on this check to provide a clear user message instead of a confusing runtime error.

---

## 4. Security Model

### 4.1 Permission Isolation

**Threat:** In group chats, any user typing `/approve` could resolve another user's pending permission, granting tool access without the original requestor's consent.

**Mitigation:** Composite key `${chatId}:${senderOpenId}` in the `pendingPermissionByChat` map. Both `waitForPermissionResponse()` and `resolveLatestPendingPermission()` require the sender's identity, ensuring only the execution initiator can resolve their own permissions.

### 4.2 Working Directory Confinement

**Threat:** A misconfigured or user-controlled working directory could allow Claude Code to operate outside intended boundaries.

**Mitigation:** `isWithinAllowedRoot()` validates the resolved and normalized directory path against `ALLOWED_ROOTS` before any SDK execution. Allowed roots are derived from:

- `OPENCLAW_MEMORY_DIR` environment variable
- `OPENCLAW_WORKSPACE_DIR` environment variable
- `DEFAULT_HAPPY_WORKING_DIR` (`/tmp/happy_feishu`)

Rejection produces a user-visible error message and a warning log.

### 4.3 Concurrency Guard

**Threat:** Multiple concurrent Claude Code executions could produce conflicting state, interleaved card updates, or resource exhaustion.

**Mitigation:** A module-level `activeExecution` boolean flag ensures only one execution runs at a time per bot instance. Additional requests receive a user-friendly "busy" message.

### 4.4 Permission Timeout

All pending permissions expire after 120 seconds. A periodic cleanup (every 5 minutes) removes stale entries from the `pendingPermissions` Map to prevent memory accumulation.

### 4.5 Session TTL

Cached Claude sessions expire after 1 hour. The session cache is a simple Map with TTL checks on access, preventing indefinite session accumulation.

---

## 5. Request Tracing

A `requestId` is generated at the entry of `executeClaudeCode()` using a compact format (`Date.now().toString(36) + random`). This ID flows through all layers:

| Layer        | Log prefix                    | Component                 |
| ------------ | ----------------------------- | ------------------------- |
| Executor     | `[feishu:exec:{id}]`          | claude-code-executor.ts   |
| Card Manager | `[feishu:stream:{id}]`        | streaming-card-manager.ts |
| SDK          | `[feishu:sdk:{id}]`           | HappyClawSDK.ts           |
| Memory       | `[feishu:memory-bridge:{id}]` | memory-bridge.ts          |

The `requestId` is also persisted in the memory bridge session file as metadata, enabling post-hoc correlation between logs and recorded sessions.

---

## 6. Evolution from Commit 1 to Commit 2

### 6.1 Commit 1: Foundation (`1422c3831e`)

The initial commit established the full execution pipeline as a monolithic integration within `bot.ts`:

- `handleHappyCommand()` -- Happy mode execution with inline SDK setup, permission handling, streaming card management, and memory writing
- `handleSuperpowerCommand()` -- Skill mode execution duplicating most of the above logic with skill-specific prompt wrapping
- `superpower-commands.ts` -- Hardcoded command definitions for `/brain`, `/plan`, `/do`

This produced a functional system but with significant duplication (~500 lines of nearly identical execution logic in two separate handlers) and rigid command definitions.

### 6.2 Commit 2: Unification (`664c1c5546`)

The refactoring commit introduced three architectural improvements:

1. **Unified executor:** Both execution paths collapsed into `executeClaudeCode()` parameterized by mode (`happy` vs `skill`). The mode determines prompt wrapping and session labeling but shares the entire execution, permission, streaming, and memory pipeline.

2. **Convention-based registry:** `superpower-commands.ts` (deleted) was replaced by `command-registry.ts` with dynamic skill discovery. New skills can be registered without code changes to the router.

3. **Session persistence:** `/happy on` and `/happy off` introduced a lightweight session mode that removes the need for explicit command prefixes in ongoing conversations.

### 6.3 Hardening Pass (Uncommitted)

The post-commit hardening addressed gaps identified through security review and architectural analysis:

| Improvement                           | Module                                   | Lines changed |
| ------------------------------------- | ---------------------------------------- | ------------- |
| Permission isolation (composite keys) | permission-handler.ts, bot.ts, executor  | +33/-10       |
| Working directory validation          | claude-code-executor.ts                  | +40           |
| SDK preflight gating                  | claude-code-preflight.ts (new), executor | +30           |
| Memory bridge resilience              | memory-bridge.ts                         | +214/-100     |
| Request ID tracing                    | executor, card-manager, SDK, memory      | +50           |
| Debug logging for duplicates          | command-registry.ts                      | +13           |
| Resource leak fix                     | claude-code-executor.ts                  | reorder       |

---

## 7. State Management

All runtime state is in-memory (JavaScript Maps). This is a deliberate trade-off:

| State                 | Storage                | TTL                   | Restart behavior          |
| --------------------- | ---------------------- | --------------------- | ------------------------- |
| Claude sessions       | Map (per chatId)       | 1 hour                | Lost; user starts fresh   |
| Pending permissions   | Map (per permissionId) | 120 seconds           | Lost; user re-triggers    |
| Permission-by-chat    | Map (composite key)    | Follows permission    | Lost                      |
| Persistent sessions   | Map (per chatId)       | Indefinite            | Lost; user re-enables     |
| Approve-all flag      | Boolean                | Indefinite            | Resets to false           |
| Active execution      | Boolean                | Duration of execution | Resets to false           |
| Card manager sessions | Map (per chatId)       | 1 hour                | Lost; stale cleanup fires |

**Trade-off rationale:** The Feishu bot typically runs as a single long-lived process. In-memory state provides the lowest latency and simplest implementation. For high-availability deployments requiring state persistence across restarts, a future enhancement could introduce Redis-backed Maps.

---

## 8. Error Handling Strategy

### 8.1 Graceful Degradation

| Failure                       | Behavior                                                                |
| ----------------------------- | ----------------------------------------------------------------------- |
| Claude SDK not installed      | Preflight check returns user-friendly message; no execution attempted   |
| SDK execution fails           | Error card sent to user; session recorded as "failure" in memory bridge |
| Permission timeout            | Promise rejects after 120s; execution aborts with timeout message       |
| Memory bridge CLI unavailable | Single warning logged; bridge operations silently skipped               |
| Memory bridge spawn fails     | One retry after 2s; then skip with warning                              |
| Working directory invalid     | Error message to user; execution aborted                                |
| Concurrent execution          | "Busy" message to user                                                  |
| Card update fails             | Error swallowed by stream-buffer; next update retries implicitly        |

### 8.2 Resource Cleanup

The `executeClaudeCode()` function uses a `try/finally` pattern to ensure:

1. `cardManager.destroy()` is always called (stops cleanup interval, releases sessions)
2. `activeExecution` flag is always reset
3. Memory bridge write is attempted regardless of execution outcome

The `StreamingCardManager` construction was deliberately placed after all validation checks to prevent timer leaks on early-return paths.

---

## 9. Test Coverage

### 9.1 Test Suite Summary

| Test file                      | Tests  | Lines   | Coverage focus                                              |
| ------------------------------ | ------ | ------- | ----------------------------------------------------------- |
| `stream-buffer.test.ts`        | 15     | 230     | Throttle timing, concurrent flushes, thresholds, cleanup    |
| `command-registry.test.ts`     | 18     | 145     | Discovery, aliases, collisions, duplicates, help generation |
| `persistent-session.test.ts`   | 14     | 128     | Lifecycle, ownership, multi-chat isolation                  |
| `permission-handler.test.ts`   | 9      | 160     | Composite keys, group chat isolation, timeout, approve-all  |
| `claude-code-executor.test.ts` | 12     | 262     | Preflight, concurrency, directory validation, modes, errors |
| **Total**                      | **68** | **925** |                                                             |

### 9.2 Testing Approach

- **Mock-heavy isolation:** Dependencies mocked at import time via `vi.mock()` to test each module's logic in isolation
- **Fake timers:** `vi.useFakeTimers()` used extensively for throttle, timeout, and cleanup tests
- **Cleanup discipline:** All tests clean up timers, mocks, and state in `afterEach` for `--isolate=false` compatibility
- **Security-specific tests:** Explicit test cases for group chat permission isolation and working directory rejection

### 9.3 Existing Coverage

The Feishu extension has 25+ pre-existing test files covering the broader channel integration. The new 5 test suites specifically target the Claude Code feature modules that previously had zero coverage.

---

## 10. Configuration and Environment

### 10.1 Environment Variables

| Variable                       | Default                            | Purpose                                        |
| ------------------------------ | ---------------------------------- | ---------------------------------------------- |
| `OPENCLAW_MEMORY_DIR`          | `/root/.openclaw/workspace/memory` | Memory bridge output directory                 |
| `OPENCLAW_WORKSPACE_DIR`       | `process.cwd()`                    | Allowed working directory root                 |
| `FEISHU_MEMORY_BRIDGE_ENABLED` | `true`                             | Set to `false` or `0` to disable memory bridge |
| `FEISHU_APP_ID`                | --                                 | Feishu app credential                          |
| `FEISHU_APP_SECRET`            | --                                 | Feishu app credential                          |
| `FEISHU_VERIFICATION_TOKEN`    | --                                 | Webhook verification                           |
| `FEISHU_ENCRYPT_KEY`           | --                                 | Webhook encryption                             |

### 10.2 Timing Constants

| Constant                        | Value      | Location                  |
| ------------------------------- | ---------- | ------------------------- |
| Card update debounce            | 700ms      | stream-buffer.ts          |
| Immediate flush threshold       | 2000 chars | stream-buffer.ts          |
| Card manager debounce           | 1500ms     | streaming-card-manager.ts |
| Permission timeout              | 120s       | permission-handler.ts     |
| Question timeout                | 120s       | streaming-card-manager.ts |
| Session cache TTL               | 1 hour     | claude-code-executor.ts   |
| Stale session cleanup           | 5 minutes  | streaming-card-manager.ts |
| Permission cleanup              | 5 minutes  | permission-handler.ts     |
| Card content limit              | 28KB       | card-builder.ts           |
| Memory bridge spawn retry delay | 2s         | memory-bridge.ts          |
| CLI availability check timeout  | 5s         | memory-bridge.ts          |

---

## 11. Future Considerations

### 11.1 Near-term

- **Redis-backed state**: Replace in-memory Maps with Redis for persistence across restarts and multi-instance deployments
- **Per-user approve-all**: Scope the `approveAllEnabled` flag per-user or per-chat instead of globally
- **Structured logging**: Replace `console.*` calls with a proper logging framework supporting log levels and structured output

### 11.2 Medium-term

- **Multi-execution support**: Allow concurrent Claude Code executions across different chats (currently limited to one global)
- **Execution history UI**: Surface memory bridge records in a browsable Feishu card interface
- **Custom skill registration**: Allow users to register custom skills via Feishu commands or configuration

### 11.3 Architectural

- **State extraction**: Move all Map-based state into a dedicated `state-store.ts` module with pluggable backends (memory, Redis, SQLite)
- **Event bus**: Replace direct function calls between layers with an event-driven architecture for better testability and extensibility
- **Metrics**: Add execution duration, permission response time, and error rate metrics for monitoring
