/**
 * Tests for the two-layer skill injection (mirrors codex-rs core-skills):
 *   - Layer 1: renderSkillsCatalog() — always-on "## Skills" index
 *   - Layer 2: extractSkillMentions() / loadSkillContent — `$skill-name` → full body
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { CodexThread } from "../../src/codex_thread.js";
import {
  defaultSkillMetadataBudget,
  extractSkillMentions,
  renderSkillInjection,
  renderSkillsCatalog,
  type SkillMetadata,
} from "../../src/skills.js";
import {
  evAssistantMessage,
  evCompleted,
  evResponseCreated,
  makeSseResponse,
  sseFlat,
  waitForEvent,
} from "../common/lib.js";

const SKILLS: SkillMetadata[] = [
  {
    name: "song-analyzer",
    description: "Analyze a song.",
    path: ".agents/skills/song-analyzer/SKILL.md",
  },
  {
    name: "mv-workflow",
    description: "End-to-end MV workflow.",
    path: ".agents/skills/mv-workflow/SKILL.md",
  },
];

describe("renderSkillsCatalog", () => {
  it("returns an empty string when there are no skills", () => {
    expect(renderSkillsCatalog([])).toBe("");
  });

  it("renders header, one line per skill, and the how-to-use section", () => {
    const out = renderSkillsCatalog(SKILLS);
    expect(out).toContain("## Skills");
    expect(out).toContain("### Available skills");
    expect(out).toContain(
      "- song-analyzer: Analyze a song. (file: .agents/skills/song-analyzer/SKILL.md)",
    );
    expect(out).toContain("### How to use skills");
  });
});

describe("extractSkillMentions", () => {
  it("matches a $skill-name mention", () => {
    const result = extractSkillMentions("please run $song-analyzer now", SKILLS);
    expect(result.map((s) => s.name)).toEqual(["song-analyzer"]);
  });

  it("ignores unknown mentions and common env vars", () => {
    expect(extractSkillMentions("echo $HOME and $nope", SKILLS)).toEqual([]);
  });

  it("preserves skills order and de-dupes repeats", () => {
    const result = extractSkillMentions(
      "$mv-workflow then $song-analyzer and $song-analyzer again",
      SKILLS,
    );
    expect(result.map((s) => s.name)).toEqual(["song-analyzer", "mv-workflow"]);
  });

  it("only matches a plain name when it is unique", () => {
    const dup: SkillMetadata[] = [
      ...SKILLS,
      { name: "song-analyzer", description: "dup", path: "other/SKILL.md" },
    ];
    expect(extractSkillMentions("$song-analyzer", dup)).toEqual([]);
  });
});

describe("renderSkillInjection", () => {
  it("wraps the body in the <skill> envelope", () => {
    const out = renderSkillInjection(SKILLS[0]!, "BODY");
    expect(out).toBe(
      "<skill>\n<name>song-analyzer</name>\n<path>.agents/skills/song-analyzer/SKILL.md</path>\nBODY\n</skill>",
    );
  });
});

describe("skill injection inside a turn", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("injects the catalog into the request instructions (Layer 1)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeSseResponse(
        sseFlat([
          evResponseCreated("r1"),
          evAssistantMessage("ok"),
          evCompleted("r1"),
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const codex = new CodexThread({ apiKey: "k", model: "m", skills: SKILLS });
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "hi" }],
    });
    await waitForEvent(codex, (m) => m.type === "TurnComplete");

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      instructions?: string;
      input: unknown[];
    };
    // Catalog rides as a discrete input message, NOT in the instructions field.
    expect(body.instructions ?? "").not.toContain("## Skills");
    expect(JSON.stringify(body.input)).toContain("## Skills");
    expect(JSON.stringify(body.input)).toContain("- song-analyzer:");
  });

  it("injects the full skill body on $mention, ahead of history (Layer 2)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeSseResponse(
        sseFlat([
          evResponseCreated("r1"),
          evAssistantMessage("ok"),
          evCompleted("r1"),
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const loaded: string[] = [];
    const codex = new CodexThread({
      apiKey: "k",
      model: "m",
      skills: SKILLS,
      loadSkillContent: async (s) => {
        loaded.push(s.name);
        return `BODY:${s.name}`;
      },
    });
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "use $song-analyzer please" }],
    });
    await waitForEvent(codex, (m) => m.type === "TurnComplete");

    // Only the mentioned skill's body is loaded.
    expect(loaded).toEqual(["song-analyzer"]);

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as { input: unknown[] };
    // The skill body rides in input as a turn-scoped message (after the catalog).
    const inputStr = JSON.stringify(body.input);
    expect(inputStr).toContain("<skill>");
    expect(inputStr).toContain("BODY:song-analyzer");
    // The real user message stays last (context messages are prepended).
    expect(JSON.stringify(body.input[body.input.length - 1])).toContain(
      "use $song-analyzer please",
    );
  });

  it("does not load any skill body without a mention", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeSseResponse(
        sseFlat([
          evResponseCreated("r1"),
          evAssistantMessage("ok"),
          evCompleted("r1"),
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const loaded: string[] = [];
    const codex = new CodexThread({
      apiKey: "k",
      model: "m",
      skills: SKILLS,
      loadSkillContent: async (s) => {
        loaded.push(s.name);
        return "BODY";
      },
    });
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "just chatting" }],
    });
    await waitForEvent(codex, (m) => m.type === "TurnComplete");

    expect(loaded).toEqual([]);
  });
});

describe("catalog budget (mirrors render.rs)", () => {
  const many: SkillMetadata[] = Array.from({ length: 5 }, (_, i) => ({
    name: `skill-${i}`,
    description:
      "A fairly long description that will need trimming when the budget is tight.",
    path: `.agents/skills/skill-${i}/SKILL.md`,
  }));

  it("defaultSkillMetadataBudget: 2% tokens with a context window, else 8000 chars", () => {
    expect(defaultSkillMetadataBudget(/*contextWindow*/ 128_000)).toEqual({
      kind: "tokens",
      limit: 2_560,
    });
    expect(defaultSkillMetadataBudget()).toEqual({
      kind: "characters",
      limit: 8_000,
    });
  });

  it("keeps full descriptions under a generous budget", () => {
    const out = renderSkillsCatalog(many, {
      kind: "characters",
      limit: 100_000,
    });
    expect(out).toContain(
      "A fairly long description that will need trimming when the budget is tight.",
    );
    for (let i = 0; i < 5; i += 1) {
      expect(out).toContain(`skill-${i}`);
    }
  });

  it("trims descriptions but keeps every skill when the budget is tight", () => {
    const out = renderSkillsCatalog(many, { kind: "characters", limit: 350 });
    for (let i = 0; i < 5; i += 1) {
      expect(out).toContain(`skill-${i}`);
    }
    // The full description no longer fits verbatim.
    expect(out).not.toContain(
      "A fairly long description that will need trimming when the budget is tight.",
    );
  });

  it("stays silent when only a little description text is dropped (mirrors render.rs threshold)", () => {
    // mirrors SKILL_DESCRIPTION_TRUNCATION_WARNING_THRESHOLD_CHARS (render.rs:22)
    // via average_truncated_description_chars: these 74-char descriptions lose
    // ~54 chars each, under the 100-char average, so rs emits NO warning.
    const out = renderSkillsCatalog(many, { kind: "characters", limit: 350 });
    expect(out).not.toContain("shortened to fit");
  });

  it("appends truncation warning once the average dropped description exceeds the threshold", () => {
    const verbose: SkillMetadata[] = many.map((skill) => ({
      ...skill,
      description: "x".repeat(400),
    }));
    const out = renderSkillsCatalog(verbose, { kind: "characters", limit: 350 });
    expect(out).toContain("Skill descriptions were shortened to fit the skills context budget.");
  });

  it("caps a single description at MAX_DEFAULT_CONTEXT_SKILL_DESCRIPTION_CHARS", () => {
    // mirrors truncate_default_context_skill_description (render.rs:537): the
    // catalog never shows more than 1024 description chars, and the source
    // metadata is left untouched.
    const description = "y".repeat(2_000);
    const skill: SkillMetadata = {
      name: "long-skill",
      description,
      path: ".agents/skills/long-skill/SKILL.md",
    };
    const out = renderSkillsCatalog([skill], {
      kind: "characters",
      limit: 100_000,
    });
    expect(out).toContain(`${"y".repeat(1_021)}...`);
    expect(out).not.toContain("y".repeat(1_025));
    expect(skill.description).toBe(description);
  });

  it("appends omission warning when skills are dropped (mirrors render.rs)", () => {
    const out = renderSkillsCatalog(many, { kind: "characters", limit: 80 });
    const shown = many.filter((skill) => out.includes(skill.name)).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(5);
    // Omission warning must appear
    expect(out).toContain("not included in the model-visible skills list.");
  });

  it("no warning when all skills and descriptions fit", () => {
    const out = renderSkillsCatalog(many, { kind: "characters", limit: 100_000 });
    expect(out).not.toContain("shortened to fit");
    expect(out).not.toContain("not included in the model-visible skills list.");
  });
});

describe("AGENTS.md injection (mirrors AgentsMdManager)", () => {
  /**
   * Mirrors codex-rs AgentsMdManager / user_instructions fragment behaviour.
   * Architecture: agentsMd rides as a discrete user_instructions `input`
   * message (format: "# AGENTS.md instructions\n\n<INSTRUCTIONS>…</INSTRUCTIONS>"),
   * NOT merged into the `instructions` field — this keeps developer instructions
   * and project docs as separate model-visible boundaries (codex-rs contextItems).
   * When agentsMd is absent, no AGENTS.md message is injected.
   */
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("rides agentsMd as a discrete user_instructions input message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeSseResponse(
        sseFlat([
          evResponseCreated("r1"),
          evAssistantMessage("ok"),
          evCompleted("r1"),
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const codex = new CodexThread({
      apiKey: "k",
      model: "m",
      instructions: "DEV_INSTRUCTIONS",
      agentsMd: "PROJECT_DOC_BODY",
    });
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "hi" }],
    });
    await waitForEvent(codex, (m) => m.type === "TurnComplete");

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      instructions?: string;
      input: unknown[];
    };
    // Developer instructions stay in the instructions field (base + developer);
    // AGENTS.md rides as a discrete user_instructions input message.
    expect(body.instructions ?? "").toContain("DEV_INSTRUCTIONS");
    const inputStr = JSON.stringify(body.input);
    expect(inputStr).toContain("# AGENTS.md instructions");
    expect(inputStr).toContain("PROJECT_DOC_BODY");
    expect(body.instructions ?? "").not.toContain("PROJECT_DOC_BODY");
  });

  it("rides agentsMd in an input message even when base is empty", async () => {
    // base "" → empty instructions; agentsMd still rides as an input message
    const fetchMock = vi.fn().mockResolvedValue(
      makeSseResponse(
        sseFlat([
          evResponseCreated("r1"),
          evAssistantMessage("ok"),
          evCompleted("r1"),
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const codex = new CodexThread({
      apiKey: "k",
      model: "m",
      baseInstructions: "",   // suppress default so only agentsMd appears
      agentsMd: "ONLY_PROJECT_DOC",
    });
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "hi" }],
    });
    await waitForEvent(codex, (m) => m.type === "TurnComplete");

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      instructions?: string;
      input: unknown[];
    };
    expect(JSON.stringify(body.input)).toContain("ONLY_PROJECT_DOC");
    expect(body.instructions ?? "").not.toContain("ONLY_PROJECT_DOC");
  });

  it("emits no AGENTS.md input message when none is provided", async () => {
    // instructions + no doc → developer text in instructions, no AGENTS.md msg
    const fetchMock = vi.fn().mockResolvedValue(
      makeSseResponse(
        sseFlat([
          evResponseCreated("r1"),
          evAssistantMessage("ok"),
          evCompleted("r1"),
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const codex = new CodexThread({
      apiKey: "k",
      model: "m",
      instructions: "DEV_INSTRUCTIONS",
      // no agentsMd
    });
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "hi" }],
    });
    await waitForEvent(codex, (m) => m.type === "TurnComplete");

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      instructions?: string;
      input: unknown[];
    };
    // Developer instructions ride in the instructions field; no AGENTS.md message.
    expect(body.instructions ?? "").toContain("DEV_INSTRUCTIONS");
    expect(JSON.stringify(body.input)).not.toContain("# AGENTS.md instructions");
  });

  it("orders context items: agentsMd → catalog → $mention body → user message", async () => {
    // Verifies the full input ordering mirrors codex-rs TurnContext:
    //   contextItems (agentsMd, catalog) → skillInjectionItems ($mention) → history
    const fetchMock = vi.fn().mockResolvedValue(
      makeSseResponse(
        sseFlat([
          evResponseCreated("r1"),
          evAssistantMessage("ok"),
          evCompleted("r1"),
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const codex = new CodexThread({
      apiKey: "k",
      model: "m",
      baseInstructions: "",
      agentsMd: "PROJECT_DOC",
      skills: SKILLS,
      loadSkillContent: async () => "SKILL_BODY",
    });
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "use $song-analyzer please" }],
    });
    await waitForEvent(codex, (m) => m.type === "TurnComplete");

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as { input: unknown[] };
    const inputStr = JSON.stringify(body.input);

    // All four layers must be present
    expect(inputStr).toContain("# AGENTS.md instructions"); // agentsMd
    expect(inputStr).toContain("## Skills");               // catalog
    expect(inputStr).toContain("<skill>");                  // $mention body
    expect(inputStr).toContain("use $song-analyzer please"); // user message

    // Ordering: agentsMd before catalog before $mention before user message
    const posAgentsMd = inputStr.indexOf("# AGENTS.md instructions");
    const posCatalog  = inputStr.indexOf("## Skills");
    const posSkill    = inputStr.indexOf("<skill>");
    const posUser     = inputStr.indexOf("use $song-analyzer please");
    expect(posAgentsMd).toBeLessThan(posCatalog);
    expect(posCatalog).toBeLessThan(posSkill);
    expect(posSkill).toBeLessThan(posUser);
  });
});
