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
// mirrors MAX_DEFAULT_CONTEXT_SKILL_DESCRIPTION_CHARS / the "..." suffix
// (render.rs:20-21): a single skill can't monopolise the catalog with a
// thousands-of-chars description.
const MAX_DEFAULT_CONTEXT_SKILL_DESCRIPTION_CHARS = 1_024;
const TRUNCATED_SKILL_DESCRIPTION_SUFFIX = "...";
// mirrors SKILL_DESCRIPTION_TRUNCATION_WARNING_THRESHOLD_CHARS (render.rs:22)
const SKILL_DESCRIPTION_TRUNCATION_WARNING_THRESHOLD_CHARS = 100;

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

/**
 * Cap a description before it ever reaches the budget allocator.
 * mirrors truncate_default_context_skill_description (render.rs:537), applied in
 * SkillLine::with_path — the ORIGINAL SkillMetadata is never mutated.
 */
export function truncateDefaultContextSkillDescription(
  description: string,
): string {
  const codePoints = Array.from(description);
  if (codePoints.length <= MAX_DEFAULT_CONTEXT_SKILL_DESCRIPTION_CHARS) {
    return description;
  }
  const prefixChars =
    MAX_DEFAULT_CONTEXT_SKILL_DESCRIPTION_CHARS -
    Array.from(TRUNCATED_SKILL_DESCRIPTION_SUFFIX).length;
  return (
    codePoints.slice(0, prefixChars).join("") +
    TRUNCATED_SKILL_DESCRIPTION_SUFFIX
  );
}

// render.rs SkillLine::render_full
function renderSkillLineFull(skill: SkillMetadata): string {
  return renderSkillLineWithDescriptionChars(
    skill,
    Array.from(catalogDescription(skill)).length,
  );
}

// The description as it appears in the catalog (render.rs SkillLine.description:
// a Cow that is the capped form when the raw description is over the cap).
function catalogDescription(skill: SkillMetadata): string {
  return truncateDefaultContextSkillDescription(skill.description);
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
  const description = Array.from(catalogDescription(skill))
    .slice(0, descriptionChars)
    .join("");
  return `- ${skill.name}: ${description} (file: ${path})`;
}

// ─── Layer 1: budget allocation (mirrors render.rs render_skill_lines) ────────

/** mirrors RenderedSkillLine (render.rs:448) */
interface RenderedSkillLine {
  line: string;
  truncatedChars: number;
}

/** mirrors SkillRenderReport (render.rs:430) */
export interface SkillRenderReport {
  totalCount: number;
  includedCount: number;
  omittedCount: number;
  truncatedDescriptionChars: number;
  truncatedDescriptionCount: number;
}

/** mirrors SkillRenderReport::average_truncated_description_chars (render.rs:431) */
function averageTruncatedDescriptionChars(report: SkillRenderReport): number {
  if (report.totalCount === 0 || report.truncatedDescriptionChars === 0) {
    return 0;
  }
  return Math.floor(
    (report.truncatedDescriptionChars + report.totalCount - 1) /
      report.totalCount,
  );
}

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
  const minimumLine = renderSkillLineWithDescriptionChars(skill, /*descriptionChars*/ 0);
  const minimumChars = Array.from(minimumLine).length + 1; // +1 for "\n"
  const minimumBytes = byteLength(minimumLine) + 1;
  const minimumCost = budgetCostFromCounts(budget, minimumChars, minimumBytes);

  const descriptionCodePoints = Array.from(catalogDescription(skill));
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
): RenderedSkillLine[] {
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

  // mirrors the RenderedSkillLine mapping at the tail of
  // render_lines_with_description_budget (render.rs:639): truncated_chars is how
  // much of the (already capped) description had to be dropped.
  return budgetLines.map((line, index) => ({
    line: renderSkillLineWithDescriptionChars(line.skill, charAllocations[index]!),
    truncatedChars: Math.max(
      0,
      line.descriptionCharCount - charAllocations[index]!,
    ),
  }));
}

// render.rs render_minimum_skill_lines_until_budget (render.rs:664) — when even
// the no-description lines overflow, keep adding minimum lines until the budget
// is spent; the rest are omitted. Every dropped description counts as fully
// truncated in the report.
function renderMinimumUntilBudget(
  skills: SkillMetadata[],
  budget: SkillMetadataBudget,
): { lines: string[]; report: SkillRenderReport } {
  const lines: string[] = [];
  let used = 0;
  let omitted = 0;
  let truncatedDescriptionChars = 0;
  let truncatedDescriptionCount = 0;
  for (const skill of skills) {
    const minimumLine = renderSkillLineWithDescriptionChars(skill, /*descriptionChars*/ 0);
    const cost = lineCost(budget, minimumLine);
    if (used + cost <= budget.limit) {
      used += cost;
      lines.push(minimumLine);
    } else {
      omitted += 1;
    }
    const descriptionCharCount = Array.from(catalogDescription(skill)).length;
    truncatedDescriptionChars += descriptionCharCount;
    if (descriptionCharCount > 0) {
      truncatedDescriptionCount += 1;
    }
  }
  return {
    lines,
    report: {
      totalCount: skills.length,
      includedCount: lines.length,
      omittedCount: omitted,
      truncatedDescriptionChars,
      truncatedDescriptionCount,
    },
  };
}

// render.rs render_skill_lines_from_lines — three tiers: full → trimmed
// descriptions → minimum-until-budget.
function renderSkillLines(
  skills: SkillMetadata[],
  budget: SkillMetadataBudget,
): { lines: string[]; report: SkillRenderReport } {
  const noTruncation = (lines: string[]): SkillRenderReport => ({
    totalCount: skills.length,
    includedCount: lines.length,
    omittedCount: 0,
    truncatedDescriptionChars: 0,
    truncatedDescriptionCount: 0,
  });

  const fullCost = skills.reduce(
    (used, skill) => used + lineCost(budget, renderSkillLineFull(skill)),
    0,
  );
  if (fullCost <= budget.limit) {
    const lines = skills.map(renderSkillLineFull);
    return { lines, report: noTruncation(lines) };
  }

  const minimumCost = skills.reduce(
    (used, skill) =>
      used + lineCost(budget, renderSkillLineWithDescriptionChars(skill, /*descriptionChars*/ 0)),
    0,
  );
  if (minimumCost <= budget.limit) {
    const rendered = renderLinesWithDescriptionBudget(
      skills,
      budget,
      budget.limit - minimumCost,
    );
    // mirrors sum_description_truncation (render.rs:459)
    const truncated = rendered.filter((line) => line.truncatedChars > 0);
    const lines = rendered.map((line) => line.line);
    return {
      lines,
      report: {
        totalCount: skills.length,
        includedCount: lines.length,
        omittedCount: 0,
        truncatedDescriptionChars: truncated.reduce(
          (sum, line) => sum + line.truncatedChars,
          0,
        ),
        truncatedDescriptionCount: truncated.length,
      },
    };
  }

  return renderMinimumUntilBudget(skills, budget);
}

// ─── Layer 1: catalog (mirrors render.rs render_available_skills_body) ────────

// render.rs SKILLS_INTRO_WITH_ABSOLUTE_PATHS (verbatim). Upstream reworded this
// for non-filesystem skill sources (environment / orchestrator / custom
// resources); codex-ts only ever renders `file` locators, but the text is kept
// verbatim so the model sees exactly what codex-rs sends.
const SKILLS_INTRO =
  "A skill is a set of instructions provided through a `SKILL.md` source. Below is the list of skills that can be used. Each entry includes a name, description, and source locator. `file` locators are on the host filesystem, `environment resource` locators are owned by an execution environment, `orchestrator resource` locators are opaque non-filesystem resources, and `custom resource` locators use their provider's access mechanism.";

// render.rs SKILLS_HOW_TO_USE_WITH_ABSOLUTE_PATHS (verbatim)
const SKILLS_HOW_TO_USE = `- Discovery: The list above is the skills available in this session (name + description + source locator). \`file\` entries live on the host filesystem, \`environment resource\` and \`orchestrator resource\` entries must be accessed through \`skills.list\` and \`skills.read\`, and \`custom resource\` entries use their provider's access mechanism.
- Trigger rules: If the user names a skill (with \`$SkillName\` or plain text) OR the task clearly matches a skill's description shown above, you must use that skill for that turn. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned.
- Missing/blocked: If a named skill isn't in the list or its source can't be read, say so briefly and continue with the best fallback.
- How to use a skill (progressive disclosure):
  1) After deciding to use a skill, the main agent must read its \`SKILL.md\` completely before taking task actions. For a \`file\` entry, open the listed path. For an \`environment resource\`, call \`skills.list\` with \`{"authority":{"kind":"executor"}}\`; for an \`orchestrator resource\`, use \`{"authority":{"kind":"orchestrator"}}\`. Select the matching package and pass its exact authority, package, and \`main_resource\` to \`skills.read\`. Follow \`next_cursor\`; if a read is paginated, continue until EOF.
  2) When \`SKILL.md\` references another resource, use the same access mechanism. Resolve relative references beneath an executor skill's returned package and call \`skills.read\` with the same authority and package. For orchestrator skills, pass the exact referenced resource identifier with the same authority and package to \`skills.read\`; do not treat \`skill://\` identifiers as filesystem paths.
  3) If \`SKILL.md\` points to extra folders such as \`references/\`, use its routing instructions to identify the resources required for the task. The main agent must read each required instruction or reference file itself before acting on it. Do not delegate reading, summarizing, or interpreting skill instructions to a subagent. Subagents may still perform task work when the selected skill allows it.
  4) For filesystem-backed skills, prefer running or patching provided scripts instead of retyping large code blocks. For environment and orchestrator skills, use \`skills.read\` and the available tools; do not invent a local path.
  5) Reuse provided assets or templates through the same source access mechanism instead of recreating them.
- Coordination and sequencing:
  - If multiple skills apply, choose the minimal set that covers the request and state the order you'll use them.
  - Announce which skill(s) you're using and why (one short line). If you skip an obvious skill, say why.
- Context hygiene:
  - Progressive disclosure applies to selecting relevant files, not partially reading a selected instruction file. Do not load unrelated references, scripts, or assets.
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
 * Build the omission / truncation warning for a render report.
 * mirrors build_available_skills_from_lines's warning_message (render.rs:208):
 * omission wins over truncation, and truncation only warns once the AVERAGE
 * dropped description exceeds SKILL_DESCRIPTION_TRUNCATION_WARNING_THRESHOLD_CHARS.
 */
function buildCatalogWarning(
  report: SkillRenderReport,
  budget: SkillMetadataBudget,
): string | null {
  if (report.omittedCount > 0) {
    const omitted = report.omittedCount;
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
  if (
    averageTruncatedDescriptionChars(report) >
    SKILL_DESCRIPTION_TRUNCATION_WARNING_THRESHOLD_CHARS
  ) {
    return budget.kind === "tokens"
      ? SKILL_DESCRIPTION_TRUNCATED_WARNING_WITH_PERCENT
      : SKILL_DESCRIPTION_TRUNCATED_WARNING;
  }
  return null;
}

/** mirrors AvailableSkills (render.rs:131) — the catalog body plus the
 *  out-of-band warning codex-rs surfaces as EventMsg::Warning rather than
 *  embedding in the model-visible body (session/mod.rs:3393-3402). */
export interface AvailableSkills {
  /** Model-visible body, or "" when there are no skills. */
  body: string;
  warningMessage: string | null;
  report: SkillRenderReport;
}

/**
 * Render the always-on skills catalog (Layer 1), trimmed to fit `budget`.
 * mirrors render_available_skills_body (render.rs:65) for the absolute-paths
 * variant, plus AvailableSkillsInstructions::from_available_skills
 * (core/src/context/available_skills_instructions.rs:25), which is where
 * upstream moved the "### How to use skills" section.
 */
export function renderAvailableSkills(
  skills: SkillMetadata[],
  budget: SkillMetadataBudget = defaultSkillMetadataBudget(),
): AvailableSkills {
  if (skills.length === 0) {
    return {
      body: "",
      warningMessage: null,
      report: {
        totalCount: 0,
        includedCount: 0,
        omittedCount: 0,
        truncatedDescriptionChars: 0,
        truncatedDescriptionCount: 0,
      },
    };
  }
  const { lines, report } = renderSkillLines(skills, budget);
  const out: string[] = [
    "## Skills",
    SKILLS_INTRO,
    "### Available skills",
    ...lines,
    "### How to use skills",
    SKILLS_HOW_TO_USE,
  ];
  return {
    body: `\n${out.join("\n")}\n`,
    warningMessage: buildCatalogWarning(report, budget),
    report,
  };
}

/**
 * Browser-specific convenience wrapper — codex-rs has no single-string form.
 * Returns the catalog body with the budget warning appended, for hosts that
 * inject one blob and have nowhere to route a separate warning. CodexThread
 * itself uses renderAvailableSkills() and emits the warning as a `Warning`
 * event, exactly like codex-rs.
 * Returns "" when there are no skills so callers can skip injection entirely.
 */
export function renderSkillsCatalog(
  skills: SkillMetadata[],
  budget: SkillMetadataBudget = defaultSkillMetadataBudget(),
): string {
  const { body, warningMessage } = renderAvailableSkills(skills, budget);
  if (body === "") {
    return "";
  }
  return warningMessage ? `${body}${warningMessage}\n` : body;
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
