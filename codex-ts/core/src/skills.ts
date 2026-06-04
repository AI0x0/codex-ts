/**
 * mirrors codex-rs/core-skills/src/render.rs + injection.rs + skill_instructions.rs
 *
 * Two-layer skill injection — the layer codex-ts originally dropped, so the
 * model had to grope around with list_dir/read_file every turn:
 *   - Layer 1 (catalog): renderSkillsCatalog() builds the always-on `## Skills`
 *     index, budget-trimmed so it never blows the context window.
 *   - Layer 2 (full body): extractSkillMentions() finds `$skill-name` mentions in
 *     the user's input so the host can inject the full SKILL.md on demand, and
 *     renderSkillInjection() wraps it in the codex-rs `<skill>` envelope.
 *
 * Discovery (scanning `.agents/skills` + parsing SKILL.md frontmatter) is the
 * HOST's job — a browser has no filesystem — so the host passes already-found
 * SkillMetadata[] plus a loadSkillContent() reader. This mirrors how codex-ts
 * already injects IoBackend/ThreadStore from the environment. The codex-rs
 * skill-roots/alias variant is omitted: a single `.agents/skills` root means
 * plain absolute/relative paths, never aliases.
 */

export interface SkillMetadata {
  /** Skill name from SKILL.md frontmatter (e.g. "song-analyzer"). */
  name: string;
  /** One-line description: what it does + when to use it. */
  description: string;
  /** Path to the SKILL.md, shown in the catalog and read on demand. */
  path: string;
}

// ─── Budget (mirrors render.rs SkillMetadataBudget) ───────────────────────────

/**
 * Context budget for the skills catalog. Tokens are approximated as bytes/4
 * (codex-rs APPROX_BYTES_PER_TOKEN); characters count Unicode code points.
 */
export type SkillMetadataBudget =
  | { kind: "tokens"; limit: number }
  | { kind: "characters"; limit: number };

const DEFAULT_SKILL_METADATA_CHAR_BUDGET = 8_000;
const SKILL_METADATA_CONTEXT_WINDOW_PERCENT = 2;
const APPROX_BYTES_PER_TOKEN = 4;

const TEXT_ENCODER = new TextEncoder();

function byteLength(text: string): number {
  return TEXT_ENCODER.encode(text).length;
}

function approxTokensFromBytes(bytes: number): number {
  return Math.floor((bytes + APPROX_BYTES_PER_TOKEN - 1) / APPROX_BYTES_PER_TOKEN);
}

function budgetCost(budget: SkillMetadataBudget, text: string): number {
  return budget.kind === "tokens"
    ? approxTokensFromBytes(byteLength(text))
    : Array.from(text).length;
}

function budgetCostFromCounts(
  budget: SkillMetadataBudget,
  chars: number,
  bytes: number,
): number {
  return budget.kind === "tokens" ? approxTokensFromBytes(bytes) : chars;
}

// Each rendered line is followed by a newline in the catalog body.
function lineCost(budget: SkillMetadataBudget, line: string): number {
  return budgetCost(budget, `${line}\n`);
}

/**
 * Default budget: 2% of the model's context window in tokens when known,
 * otherwise a flat 8000-character cap. Mirrors render.rs default_skill_metadata_budget.
 */
export function defaultSkillMetadataBudget(
  contextWindow?: number,
): SkillMetadataBudget {
  if (contextWindow && contextWindow > 0) {
    const limit = Math.max(
      1,
      Math.floor((contextWindow * SKILL_METADATA_CONTEXT_WINDOW_PERCENT) / 100),
    );
    return { kind: "tokens", limit };
  }
  return { kind: "characters", limit: DEFAULT_SKILL_METADATA_CHAR_BUDGET };
}

// ─── Layer 1: line rendering (mirrors render.rs SkillLine) ────────────────────

function normalizedPath(skill: SkillMetadata): string {
  return skill.path.replace(/\\/g, "/");
}

// render.rs SkillLine::render_full
function renderSkillLineFull(skill: SkillMetadata): string {
  return renderSkillLineWithDescriptionChars(
    skill,
    Array.from(skill.description).length,
  );
}

// render.rs SkillLine::render_with_description_chars
function renderSkillLineWithDescriptionChars(
  skill: SkillMetadata,
  descriptionChars: number,
): string {
  const path = normalizedPath(skill);
  if (descriptionChars === 0) {
    return `- ${skill.name}: (file: ${path})`;
  }
  const description = Array.from(skill.description)
    .slice(0, descriptionChars)
    .join("");
  return `- ${skill.name}: ${description} (file: ${path})`;
}

// ─── Layer 1: budget allocation (mirrors render.rs render_skill_lines) ────────

interface DescriptionBudgetLine {
  skill: SkillMetadata;
  descriptionCharCount: number;
  // extraCosts[k] = budget cost of showing k description chars, relative to the
  // minimum (no-description) line. extraCosts[0] === 0.
  extraCosts: number[];
}

function descriptionBudgetLine(
  skill: SkillMetadata,
  budget: SkillMetadataBudget,
): DescriptionBudgetLine {
  const minimumLine = renderSkillLineWithDescriptionChars(skill, 0);
  const minimumChars = Array.from(minimumLine).length + 1; // +1 for "\n"
  const minimumBytes = byteLength(minimumLine) + 1;
  const minimumCost = budgetCostFromCounts(budget, minimumChars, minimumBytes);

  const descriptionCodePoints = Array.from(skill.description);
  const extraCosts: number[] = [0];
  let prefixChars = 0;
  let prefixBytes = 0;
  for (const ch of descriptionCodePoints) {
    prefixChars += 1;
    prefixBytes += byteLength(ch);
    // A k-char description adds the chars plus one separating space.
    const renderedChars = minimumChars + prefixChars + 1;
    const renderedBytes = minimumBytes + prefixBytes + 1;
    const cost =
      budgetCostFromCounts(budget, renderedChars, renderedBytes) - minimumCost;
    extraCosts.push(Math.max(0, cost));
  }
  return { skill, descriptionCharCount: descriptionCodePoints.length, extraCosts };
}

// render.rs render_lines_with_description_budget — hand out description space one
// char at a time across all skills so a short description's slack flows to longer
// ones instead of being stranded in a fixed per-skill quota.
function renderLinesWithDescriptionBudget(
  skills: SkillMetadata[],
  budget: SkillMetadataBudget,
  limit: number,
): string[] {
  const budgetLines = skills.map((skill) =>
    descriptionBudgetLine(skill, budget),
  );
  const charAllocations = budgetLines.map(() => 0);
  const currentExtraCosts = budgetLines.map(() => 0);
  let remaining = limit;

  for (;;) {
    let changed = false;
    budgetLines.forEach((line, index) => {
      if (charAllocations[index]! >= line.descriptionCharCount) {
        return;
      }
      const nextChars = charAllocations[index]! + 1;
      const nextCost = line.extraCosts[nextChars]!;
      const delta = nextCost - currentExtraCosts[index]!;
      if (delta <= remaining) {
        charAllocations[index] = nextChars;
        currentExtraCosts[index] = nextCost;
        remaining -= delta;
        changed = true;
      }
    });
    if (!changed) {
      break;
    }
  }

  return budgetLines.map((line, index) =>
    renderSkillLineWithDescriptionChars(line.skill, charAllocations[index]!),
  );
}

// render.rs render_minimum_skill_lines_until_budget — when even the no-description
// lines overflow, keep adding minimum lines until the budget is spent; the rest
// are omitted.
function renderMinimumUntilBudget(
  skills: SkillMetadata[],
  budget: SkillMetadataBudget,
): { lines: string[]; omitted: number } {
  const lines: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const skill of skills) {
    const minimumLine = renderSkillLineWithDescriptionChars(skill, 0);
    const cost = lineCost(budget, minimumLine);
    if (used + cost <= budget.limit) {
      used += cost;
      lines.push(minimumLine);
    } else {
      omitted += 1;
    }
  }
  return { lines, omitted };
}

// render.rs render_skill_lines_from_lines — three tiers: full → trimmed
// descriptions → minimum-until-budget.
function renderSkillLines(
  skills: SkillMetadata[],
  budget: SkillMetadataBudget,
): { lines: string[]; omitted: number } {
  const fullCost = skills.reduce(
    (used, skill) => used + lineCost(budget, renderSkillLineFull(skill)),
    0,
  );
  if (fullCost <= budget.limit) {
    return { lines: skills.map(renderSkillLineFull), omitted: 0 };
  }

  const minimumCost = skills.reduce(
    (used, skill) =>
      used + lineCost(budget, renderSkillLineWithDescriptionChars(skill, 0)),
    0,
  );
  if (minimumCost <= budget.limit) {
    return {
      lines: renderLinesWithDescriptionBudget(
        skills,
        budget,
        budget.limit - minimumCost,
      ),
      omitted: 0,
    };
  }

  return renderMinimumUntilBudget(skills, budget);
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

// render.rs warning constants (verbatim)
const SKILL_DESCRIPTIONS_REMOVED_WARNING_PREFIX =
  "Exceeded skills context budget. All skill descriptions were removed and";
const SKILL_DESCRIPTION_TRUNCATED_WARNING =
  "Skill descriptions were shortened to fit the skills context budget. " +
  "Codex can still see every skill, but some descriptions are shorter. " +
  "Disable unused skills or plugins to leave more room for the rest.";
const SKILL_DESCRIPTION_TRUNCATED_WARNING_WITH_PERCENT =
  "Skill descriptions were shortened to fit the 2% skills context budget. " +
  "Codex can still see every skill, but some descriptions are shorter. " +
  "Disable unused skills or plugins to leave more room for the rest.";

/**
 * Build the omission / truncation warning appended to the catalog.
 * mirrors render.rs build_available_skills_from_lines warning_message logic.
 */
function buildCatalogWarning(
  omitted: number,
  truncated: boolean,
  budget: SkillMetadataBudget,
): string | null {
  if (omitted > 0) {
    const skillWord = omitted === 1 ? "skill" : "skills";
    const verb = omitted === 1 ? "was" : "were";
    const prefix =
      budget.kind === "tokens"
        ? SKILL_DESCRIPTIONS_REMOVED_WARNING_PREFIX.replace(
            "skills context budget",
            "2% skills context budget",
          )
        : SKILL_DESCRIPTIONS_REMOVED_WARNING_PREFIX;
    return `${prefix} ${omitted} additional ${skillWord} ${verb} not included in the model-visible skills list.`;
  }
  if (truncated) {
    return budget.kind === "tokens"
      ? SKILL_DESCRIPTION_TRUNCATED_WARNING_WITH_PERCENT
      : SKILL_DESCRIPTION_TRUNCATED_WARNING;
  }
  return null;
}

/**
 * Render the always-on skills catalog (Layer 1), trimmed to fit `budget`.
 * Mirrors render.rs render_available_skills_body (absolute-paths variant)
 * including the omission / truncation warning appended when the budget is tight.
 * Returns "" when there are no skills so callers can skip injection entirely.
 */
export function renderSkillsCatalog(
  skills: SkillMetadata[],
  budget: SkillMetadataBudget = defaultSkillMetadataBudget(),
): string {
  if (skills.length === 0) {
    return "";
  }
  const { lines, omitted } = renderSkillLines(skills, budget);

  // Detect whether any description was truncated by comparing rendered lengths
  // to full descriptions (cheap proxy — good enough for the warning threshold).
  const anyTruncated = skills.some((skill, i) => {
    const rendered = lines[i] ?? "";
    return skill.description.length > 0 && !rendered.includes(skill.description);
  });

  const warning = buildCatalogWarning(omitted, anyTruncated, budget);

  const out: string[] = [
    "## Skills",
    SKILLS_INTRO,
    "### Available skills",
    ...lines,
    ...(warning ? [warning] : []),
    "### How to use skills",
    SKILLS_HOW_TO_USE,
  ];
  return `\n${out.join("\n")}\n`;
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
  if (mentioned.size === 0) {
    return [];
  }

  const nameCounts = new Map<string, number>();
  for (const skill of skills) {
    nameCounts.set(skill.name, (nameCounts.get(skill.name) ?? 0) + 1);
  }

  const selected: SkillMetadata[] = [];
  const seen = new Set<string>();
  for (const skill of skills) {
    if (seen.has(skill.name)) {
      continue;
    }
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
    if (name && !COMMON_ENV_VARS.has(name)) {
      names.add(name);
    }
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
