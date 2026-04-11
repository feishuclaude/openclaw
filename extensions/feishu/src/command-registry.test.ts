import { describe, expect, it, vi } from "vitest";
import {
  resolveCommand,
  isRegisteredCommand,
  getAllCommands,
  buildSkillPrompt,
  getCommandUsageHelp,
  registerSkill,
} from "./command-registry.js";

describe("command-registry", () => {
  // The registry is module-level and pre-populated with built-in commands.
  // We test against those built-ins and any additional registrations.

  describe("built-in commands", () => {
    it("registers brain, plan, do on module load", () => {
      const names = getAllCommands().map((c) => c.name);
      expect(names).toContain("brain");
      expect(names).toContain("plan");
      expect(names).toContain("do");
    });

    it("brain has alias 'b'", () => {
      const cmd = resolveCommand("brain");
      expect(cmd).not.toBeNull();
      expect(cmd!.alias).toBe("b");
      expect(cmd!.skill).toBe("superpowers:brainstorming");
    });

    it("plan has alias 'p'", () => {
      const cmd = resolveCommand("plan");
      expect(cmd).not.toBeNull();
      expect(cmd!.alias).toBe("p");
    });

    it("do has alias 'd'", () => {
      const cmd = resolveCommand("do");
      expect(cmd).not.toBeNull();
      expect(cmd!.alias).toBe("d");
    });
  });

  describe("resolveCommand()", () => {
    it("resolves by full name", () => {
      const cmd = resolveCommand("brain");
      expect(cmd).not.toBeNull();
      expect(cmd!.name).toBe("brain");
    });

    it("resolves by alias", () => {
      const cmd = resolveCommand("b");
      expect(cmd).not.toBeNull();
      expect(cmd!.name).toBe("brain");
    });

    it("resolves with leading slash", () => {
      const cmd = resolveCommand("/brain");
      expect(cmd).not.toBeNull();
      expect(cmd!.name).toBe("brain");
    });

    it("resolves case-insensitively", () => {
      expect(resolveCommand("BRAIN")).not.toBeNull();
      expect(resolveCommand("Brain")).not.toBeNull();
      expect(resolveCommand("/PLAN")).not.toBeNull();
    });

    it("returns null for unknown commands", () => {
      expect(resolveCommand("unknown")).toBeNull();
      expect(resolveCommand("/nope")).toBeNull();
    });
  });

  describe("isRegisteredCommand()", () => {
    it("returns true for registered commands", () => {
      expect(isRegisteredCommand("brain")).toBe(true);
      expect(isRegisteredCommand("b")).toBe(true);
      expect(isRegisteredCommand("/plan")).toBe(true);
    });

    it("returns false for unknown commands", () => {
      expect(isRegisteredCommand("unknown")).toBe(false);
    });
  });

  describe("getAllCommands()", () => {
    it("returns commands sorted by name", () => {
      const commands = getAllCommands();
      const names = commands.map((c) => c.name);
      const sorted = [...names].toSorted();
      expect(names).toEqual(sorted);
    });

    it("includes at least the 3 built-in commands", () => {
      expect(getAllCommands().length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("alias collision resolution", () => {
    it("assigns a suffixed alias when the base alias is taken", () => {
      // 'b' is already taken by 'brain'. Registering another command
      // starting with 'b' should get 'b2'.
      registerSkill("test:bloop", { requiresArgs: false, description: "Test bloop" });

      const cmd = resolveCommand("bloop");
      expect(cmd).not.toBeNull();
      expect(cmd!.alias).toBe("b2");
    });
  });

  describe("duplicate registration", () => {
    it("is a no-op for an already registered command name", () => {
      const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
      const before = getAllCommands().length;
      registerSkill("superpowers:brainstorming", { name: "brain" });
      const after = getAllCommands().length;
      expect(after).toBe(before);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("Skipping duplicate registration"));
      spy.mockRestore();
    });
  });

  describe("buildSkillPrompt()", () => {
    it("wraps user prompt with skill methodology instructions", () => {
      const result = buildSkillPrompt("superpowers:brainstorming", "build a CLI");
      expect(result).toContain("superpowers:brainstorming");
      expect(result).toContain("build a CLI");
      expect(result).toContain("methodology");
    });
  });

  describe("getCommandUsageHelp()", () => {
    it("returns formatted help with alias info", () => {
      const help = getCommandUsageHelp("brain");
      expect(help).toContain("Brainstorm ideas");
      expect(help).toContain("/brain");
      expect(help).toContain("alias: /b");
    });

    it("returns 'Unknown command' for unregistered input", () => {
      expect(getCommandUsageHelp("nonexistent")).toBe("Unknown command");
    });
  });
});
