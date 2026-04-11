/**
 * Preflight check for Claude Code SDK availability.
 * Checks once at first use and caches the result so subsequent calls are free.
 */

import { createRequire } from "node:module";

let sdkAvailable: boolean | null = null;

export function isClaudeSDKAvailable(): boolean {
  if (sdkAvailable !== null) {
    return sdkAvailable;
  }
  try {
    const require = createRequire(import.meta.url);
    require.resolve("@anthropic-ai/claude-agent-sdk");
    sdkAvailable = true;
  } catch {
    sdkAvailable = false;
    console.warn(
      "[feishu:claude-code] Claude Code features require @anthropic-ai/claude-agent-sdk. " +
        "Install it to enable /happy and skill commands.",
    );
  }
  return sdkAvailable;
}

/** Reset cached state (for testing). */
export function resetPreflightCache(): void {
  sdkAvailable = null;
}
