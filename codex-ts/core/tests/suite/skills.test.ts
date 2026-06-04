/**
 * Tests for the two-layer skill injection (mirrors codex-rs core-skills):
 *   - Layer 1: renderSkillsCatalog() — always-on "## Skills" index
 *   - Layer 2: extractSkillMentions() / loadSkillContent — `$skill-name` → full body
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { CodexThread } from "../../src/codex_thread.js";
import {
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
