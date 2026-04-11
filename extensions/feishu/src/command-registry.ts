// feishu/src/command-registry.ts

/**
 * Convention-based skill-to-command auto-discovery registry.
 * Replaces the hardcoded SUPERPOWER_COMMANDS with a dynamic registry
 * that derives commands from skill names automatically.
 */

/**
 * Definition for a registered skill command.
 */
export interface CommandDefinition {
  /** Base command name (e.g. "brain") */
  name: string;
  /** Short alias (e.g. "b") */
  alias: string;
  /** Full skill id (e.g. "superpowers:brainstorming") */
  skill: string;
  /** Whether the command requires arguments */
  requiresArgs: boolean;
  /** Description for help card */
  description: string;
  /** Usage example for error messages */
  usageExample: string;
}

/**
 * Abbreviation map for backward-compatible command names.
 * Maps the last segment of a skill id to a short command name.
 */
const ABBREVIATION_MAP: Record<string, string> = {
  brainstorming: "brain",
  "writing-plans": "plan",
  "executing-plans": "do",
};

/**
 * Description map for known skills (used in help card).
 */
const DESCRIPTION_MAP: Record<string, string> = {
  brainstorming: "Brainstorm ideas",
  "writing-plans": "Create implementation plan",
  "executing-plans": "Execute a plan",
};

/** Registry keyed by command name */
const commandsByName = new Map<string, CommandDefinition>();
/** Registry keyed by alias */
const commandsByAlias = new Map<string, CommandDefinition>();
/** Set of all used aliases for collision resolution */
const usedAliases = new Set<string>();

/**
 * Derive a command name from a skill id segment.
 * Uses the abbreviation map for known skills, otherwise uses the full segment.
 */
function deriveCommandName(segment: string): string {
  return ABBREVIATION_MAP[segment] ?? segment;
}

/**
 * Derive a unique alias for a command name.
 * Uses the first character, with collision resolution via numeric suffix.
 */
function deriveAlias(commandName: string): string {
  const base = commandName.charAt(0).toLowerCase();
  if (!usedAliases.has(base)) {
    return base;
  }
  // Collision resolution: append incrementing suffix
  let suffix = 2;
  while (usedAliases.has(`${base}${suffix}`)) {
    suffix++;
  }
  return `${base}${suffix}`;
}

/**
 * Extract the last segment from a skill id.
 * e.g. "superpowers:brainstorming" -> "brainstorming"
 */
function extractSegment(skillId: string): string {
  const parts = skillId.split(":");
  return parts[parts.length - 1];
}

/**
 * Register a skill as a command.
 * @param skillId - Full skill id (e.g. "superpowers:brainstorming")
 * @param opts - Optional overrides for command properties
 */
export function registerSkill(
  skillId: string,
  opts?: Partial<
    Pick<CommandDefinition, "name" | "alias" | "requiresArgs" | "description" | "usageExample">
  >,
): void {
  const segment = extractSegment(skillId);
  const name = opts?.name ?? deriveCommandName(segment);
  const alias = opts?.alias ?? deriveAlias(name);

  // Prevent duplicate registrations
  if (commandsByName.has(name)) {
    console.debug(
      `[feishu:command-registry] Skipping duplicate registration: command "${name}" (skill: ${skillId}) already registered`,
    );
    return;
  }

  // Log alias collisions when deriveAlias returned a suffixed variant
  if (!opts?.alias) {
    const baseAlias = name.charAt(0).toLowerCase();
    if (alias !== baseAlias) {
      console.debug(
        `[feishu:command-registry] Alias collision for "${baseAlias}", using "${alias}" instead (skill: ${skillId})`,
      );
    }
  }

  const definition: CommandDefinition = {
    name,
    alias,
    skill: skillId,
    requiresArgs: opts?.requiresArgs ?? true,
    description: opts?.description ?? DESCRIPTION_MAP[segment] ?? `Run ${segment}`,
    usageExample: opts?.usageExample ?? `/${name} <args>`,
  };

  commandsByName.set(name, definition);
  commandsByAlias.set(alias, definition);
  usedAliases.add(alias);
}

/**
 * Resolve a command string (name or alias) to its definition.
 * Accepts with or without leading slash.
 */
export function resolveCommand(input: string): CommandDefinition | null {
  const cmd = input.startsWith("/") ? input.slice(1).toLowerCase() : input.toLowerCase();
  return commandsByName.get(cmd) ?? commandsByAlias.get(cmd) ?? null;
}

/**
 * Check if an input string is a registered skill command.
 */
export function isRegisteredCommand(input: string): boolean {
  return resolveCommand(input) !== null;
}

/**
 * Get all registered commands, sorted by name for deterministic output.
 */
export function getAllCommands(): CommandDefinition[] {
  return Array.from(commandsByName.values()).toSorted((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build the prompt for invoking a skill.
 * @param skill - The skill name (e.g. "superpowers:brainstorming")
 * @param userPrompt - The user's input prompt
 */
export function buildSkillPrompt(skill: string, userPrompt: string): string {
  return `Follow and apply the ${skill} methodology exactly as presented to you for this request: ${userPrompt}. Do NOT try to invoke this as a tool - instead, follow the skill's instructions as a process.`;
}

/**
 * Get usage help text for a command.
 */
export function getCommandUsageHelp(input: string): string {
  const def = resolveCommand(input);
  if (!def) {
    return "Unknown command";
  }
  const aliasText = def.alias ? ` (alias: /${def.alias})` : "";
  return `${def.description}: ${def.usageExample}${aliasText}`;
}

// --- Initialize built-in skills ---
registerSkill("superpowers:brainstorming", {
  name: "brain",
  alias: "b",
  requiresArgs: true,
  description: "Brainstorm ideas",
  usageExample: "/brain <topic>",
});

registerSkill("superpowers:writing-plans", {
  name: "plan",
  alias: "p",
  requiresArgs: true,
  description: "Create implementation plan",
  usageExample: "/plan <task>",
});

registerSkill("superpowers:executing-plans", {
  name: "do",
  alias: "d",
  requiresArgs: true,
  description: "Execute a plan",
  usageExample: "/do <plan>",
});
