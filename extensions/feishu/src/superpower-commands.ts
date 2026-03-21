// feishu/src/superpower-commands.ts

/**
 * Superpower command configuration and detection utilities.
 * Maps short commands to Claude Code superpower skills.
 */

/**
 * Configuration for a superpower command
 */
export interface SuperpowerCommandConfig {
  /** Skill name to invoke (e.g., 'superpowers:brainstorming') */
  skill: string;
  /** Short alias for the command (e.g., 'b' for 'brain') */
  alias: string;
  /** Whether the command requires arguments */
  requiresArgs: boolean;
}

/**
 * Mapping of superpower commands to their configurations.
 * Commands are accessed by their base name (e.g., 'brain', 'plan', 'do').
 */
export const SUPERPOWER_COMMANDS: Record<string, SuperpowerCommandConfig> = {
  brain: { skill: "superpowers:brainstorming", alias: "b", requiresArgs: true },
  plan: { skill: "superpowers:writing-plans", alias: "p", requiresArgs: true },
  do: { skill: "superpowers:executing-plans", alias: "d", requiresArgs: true },
} as const;

/**
 * Set of all superpower command names (including aliases)
 */
export const SUPERPOWER_COMMAND_NAMES: Set<string> = new Set([
  ...Object.keys(SUPERPOWER_COMMANDS),
  ...Object.values(SUPERPOWER_COMMANDS).map((c) => c.alias),
]);

/**
 * Check if a command string is a superpower command.
 * @param command - The command string (e.g., '/brain', '/b', '/plan')
 * @returns True if the command is a superpower command
 */
export function isSuperpowerCommandName(command: string): boolean {
  const cmd = command.startsWith("/") ? command.slice(1).toLowerCase() : command.toLowerCase();
  return SUPERPOWER_COMMAND_NAMES.has(cmd);
}

/**
 * Resolve a command or alias to its base command name.
 * @param command - The command string (e.g., '/brain', '/b', 'brain', 'b')
 * @returns The base command name (e.g., 'brain'), or null if not found
 */
export function resolveSuperpowerCommand(command: string): string | null {
  const cmd = command.startsWith("/") ? command.slice(1).toLowerCase() : command.toLowerCase();

  // Check if it's a direct command name
  if (SUPERPOWER_COMMANDS[cmd]) {
    return cmd;
  }

  // Check if it's an alias
  for (const [name, config] of Object.entries(SUPERPOWER_COMMANDS)) {
    if (config.alias === cmd) {
      return name;
    }
  }

  return null;
}

/**
 * Get the skill name for a superpower command.
 * @param command - The command string (e.g., '/brain', '/b')
 * @returns The skill name (e.g., 'superpowers:brainstorming'), or null if not found
 */
export function getSkillForCommand(command: string): string | null {
  const baseCommand = resolveSuperpowerCommand(command);
  if (!baseCommand) {
    return null;
  }
  return SUPERPOWER_COMMANDS[baseCommand].skill;
}

/**
 * Get the command configuration for a superpower command.
 * @param command - The command string (e.g., '/brain', '/b')
 * @returns The command configuration, or null if not found
 */
export function getSuperpowerCommandConfig(command: string): SuperpowerCommandConfig | null {
  const baseCommand = resolveSuperpowerCommand(command);
  if (!baseCommand) {
    return null;
  }
  return SUPERPOWER_COMMANDS[baseCommand];
}

/**
 * Build the prompt for invoking a superpower skill.
 * @param skill - The skill name (e.g., 'superpowers:brainstorming')
 * @param userPrompt - The user's input prompt
 * @returns The formatted prompt for Claude
 */
export function buildSkillPrompt(skill: string, userPrompt: string): string {
  return `Follow and apply the ${skill} methodology exactly as presented to you for this request: ${userPrompt}. Do NOT try to invoke this as a tool - instead, follow the skill's instructions as a process.`;
}

/**
 * Get usage help text for a superpower command.
 * @param command - The command string (e.g., '/brain')
 * @returns Usage help text
 */
export function getCommandUsageHelp(command: string): string {
  const baseCommand = resolveSuperpowerCommand(command);
  if (!baseCommand) {
    return "Unknown command";
  }

  const config = SUPERPOWER_COMMANDS[baseCommand];
  const aliasText = config.alias ? ` (alias: /${config.alias})` : "";

  switch (baseCommand) {
    case "brain":
      return `Please provide a topic to brainstorm: /brain <topic>${aliasText}`;
    case "plan":
      return `Please provide a task to plan: /plan <task>${aliasText}`;
    case "do":
      return `Please provide a plan to execute: /do <plan>${aliasText}`;
    default:
      return `Please provide arguments: /${baseCommand} <args>${aliasText}`;
  }
}
