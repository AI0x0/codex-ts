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
    const body = JSON.parse(init.body as string) as { instructions: string };
    expect(body.instructions).toContain("## Skills");
    expect(body.instructions).toContain("- song-analyzer:");
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
    // The skill body rides at the front of the input.
    expect(JSON.stringify(body.input[0])).toContain("<skill>");
    expect(JSON.stringify(body.input[0])).toContain("BODY:song-analyzer");
    // The real user message stays last (skill body is turn-scoped context).
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
    expect(defaultSkillMetadataBudget(128_000)).toEqual({
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

  it("appends truncation warning when descriptions are shortened (mirrors render.rs)", () => {
    const out = renderSkillsCatalog(many, { kind: "characters", limit: 350 });
    // At least one description must be shortened → truncation warning appears
    expect(out).toContain("Skill descriptions were shortened to fit the skills context budget.");
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
   * Mirrors agents_md_tests.rs — the separator is "\n\n--- project-doc ---\n\n"
   * (codex-rs AGENTS_MD_SEPARATOR const in agents_md.rs:42).
   * When agentsMd is absent the separator must NOT appear in the instructions.
   */
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("merges agentsMd into instructions with the project-doc separator", async () => {
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
    const body = JSON.parse(init.body as string) as { instructions: string };
    expect(body.instructions).toContain("DEV_INSTRUCTIONS");
    expect(body.instructions).toContain("--- project-doc ---");
    expect(body.instructions).toContain("PROJECT_DOC_BODY");
  });

  it("uses agentsMd alone (no instructions) without a leading separator", async () => {
    // mirrors agents_md_tests.rs: no user_instructions + doc → just the doc
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
    const body = JSON.parse(init.body as string) as { instructions: string };
    expect(body.instructions).toContain("ONLY_PROJECT_DOC");
    // No orphaned separator at the start
    expect(body.instructions).not.toMatch(/^--- project-doc ---/);
  });

  it("omits the separator entirely when no agentsMd is provided", async () => {
    // mirrors agents_md_tests.rs: instructions + no doc → no separator
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
    const body = JSON.parse(init.body as string) as { instructions: string };
    expect(body.instructions).toContain("DEV_INSTRUCTIONS");
    expect(body.instructions).not.toContain("--- project-doc ---");
  });
});
