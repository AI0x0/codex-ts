/**
 * mirrors codex-rs/core-skills/src/render.rs + injection.rs + skill_instructions.rs
 *
 * Two-layer skill injection — the layer codex-ts originally dropped, so the
 * model had to grope around with list_dir/read_file every turn:
 *   - Layer 1 (catalog): renderSkillsCatalog() builds the always-on `## Skills`
 *     index (name + description + path + how-to-use) the host prepends to its
 *     instructions, so the model sees every skill up front.
 *   - Layer 2 (full body): extractSkillMentions() finds `$skill-name` mentions in
 *     the user's input so the host can inject the full SKILL.md on demand, and
 *     renderSkillInjection() wraps it in the codex-rs `<skill>` envelope.
 *
 * Discovery (scanning `.agents/skills` + parsing SKILL.md frontmatter) is the
 * HOST's job — a browser has no filesystem — so the host passes already-found
 * SkillMetadata[] plus a loadSkillContent() reader. This mirrors how codex-ts
 * already injects IoBackend/ThreadStore from the environment.
 */

export interface SkillMetadata {
  /** Skill name from SKILL.md frontmatter (e.g. "song-analyzer"). */
  name: string;
  /** One-line description: what it does + when to use it. */
  description: string;
  /** Path to the SKILL.md, shown in the catalog and read on demand. */
  path: string;
}

// ─── Layer 1: catalog (mirrors render.rs render_available_skills_body) ────────

// render.rs SKILLS_INTRO_WITH_ABSOLUTE_PATHS (verbatim)
const SKILLS_INTRO =
  "A skill is a set of local instructions to follow that is stored in a `SKILL.md` file. Below is the list of skills that can be used. Each entry includes a name, description, and file path so you can open the source for full instructions when using a specific skill.";

// render.rs SKILLS_HOW_TO_USE_WITH_ABSOLUTE_PATHS (verbatim)
const SKILLS_HOW_TO_USE = `- Discovery: The list above is the skills available in this session (name + description + file path). Skill bodies live on disk at the listed paths.
- Trigger rules: If the user names a skill (with \`$SkillName\` or plain text) OR the task clearly matches a skill's description shown above, you must use that skill for that turn. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned.
- Missing/blocked: If a named skill isn't in the list or the path can't be read, say so briefly and continue with the best fallback.
- How to use a skill (progressive disclosure):
  1) After deciding to use a skill, open its \`SKILL.md\`. Read only enough to follow the workflow.
  2) When \`SKILL.md\` references relative paths (e.g., \`scripts/foo.py\`), resolve them relative to the skill directory listed above first, and only consider other paths if needed.
  3) If \`SKILL.md\` points to extra folders such as \`references/\`, load only the specific files needed for the request; don't bulk-load everything.
  4) If \`scripts/\` exist, prefer running or patching them instead of retyping large code blocks.
  5) If \`assets/\` or templates exist, reuse them instead of recreating from scratch.
- Coordination and sequencing:
  - If multiple skills apply, choose the minimal set that covers the request and state the order you'll use them.
  - Announce which skill(s) you're using and why (one short line). If you skip an obvious skill, say why.
- Context hygiene:
  - Keep context small: summarize long sections instead of pasting them; only load extra files when needed.
  - Avoid deep reference-chasing: prefer opening only files directly linked from \`SKILL.md\` unless you're blocked.
  - When variants exist (frameworks, providers, domains), pick only the relevant reference file(s) and note that choice.
- Safety and fallback: If a skill can't be applied cleanly (missing files, unclear instructions), state the issue, pick the next-best approach, and continue.`;

/**
 * Render the always-on skills catalog (Layer 1).
 * Mirrors render.rs render_available_skills_body (absolute-paths variant; the
 * "skill roots / aliases" variant is omitted — the host passes plain paths).
 * Returns "" when there are no skills so callers can skip injection entirely.
 */
export function renderSkillsCatalog(skills: SkillMetadata[]): string {
  if (skills.length === 0) return "";
  const lines: string[] = ["## Skills", SKILLS_INTRO, "### Available skills"];
  for (const skill of skills) {
    lines.push(renderSkillLine(skill));
  }
  lines.push("### How to use skills", SKILLS_HOW_TO_USE);
  return `\n${lines.join("\n")}\n`;
}

// render.rs SkillLine::render_with_description
function renderSkillLine(skill: SkillMetadata): string {
  const path = skill.path.replace(/\\/g, "/");
  return skill.description
    ? `- ${skill.name}: ${skill.description} (file: ${path})`
    : `- ${skill.name}: (file: ${path})`;
}

// ─── Layer 2: mention detection (mirrors injection.rs) ────────────────────────

// injection.rs is_common_env_var — skip `$HOME` etc. so env vars in prose don't
// masquerade as skill mentions.
const COMMON_ENV_VARS = new Set<string>([
  "HOME",
  "PATH",
  "PWD",
  "USER",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
  "EDITOR",
  "HOSTNAME",
  "LOGNAME",
  "OLDPWD",
]);

/**
 * Extract `$skill-name` mentions from text (Layer 2).
 * Mirrors injection.rs extract_tool_mentions + select_skills_from_mentions:
 * a plain `$name` only resolves when exactly one skill carries that name.
 * Results preserve `skills` order and are de-duplicated.
 *
 * The codex-rs `[$name](path)` linked form and structured `UserInput::Skill`
 * selection are intentionally not mirrored — ace-mv mentions skills by plain
 * name only.
 */
export function extractSkillMentions(
  text: string,
  skills: SkillMetadata[],
): SkillMetadata[] {
  const mentioned = collectMentionNames(text);
  if (mentioned.size === 0) return [];

  const nameCounts = new Map<string, number>();
  for (const skill of skills) {
    nameCounts.set(skill.name, (nameCounts.get(skill.name) ?? 0) + 1);
  }

  const selected: SkillMetadata[] = [];
  const seen = new Set<string>();
  for (const skill of skills) {
    if (seen.has(skill.name)) continue;
    if (mentioned.has(skill.name) && nameCounts.get(skill.name) === 1) {
      selected.push(skill);
      seen.add(skill.name);
    }
  }
  return selected;
}

// injection.rs extract_tool_mentions_with_sigil — `$` followed by one or more
// mention-name chars (ASCII alnum plus '-' '_').
function collectMentionNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(/\$([a-zA-Z0-9_-]+)/g)) {
    const name = match[1];
    if (name && !COMMON_ENV_VARS.has(name)) names.add(name);
  }
  return names;
}

// ─── Layer 2: full-body envelope (mirrors skill_instructions.rs) ──────────────

/**
 * Wrap a skill's full SKILL.md body for injection as a turn-scoped user message.
 * Mirrors skill_instructions.rs SkillInstructions::body + the `<skill>` markers.
 */
export function renderSkillInjection(
  skill: SkillMetadata,
  contents: string,
): string {
  return `<skill>\n<name>${skill.name}</name>\n<path>${skill.path}</path>\n${contents}\n</skill>`;
}
