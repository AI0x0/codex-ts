/**
 * mirrors codex-rs/tools/src/tool_spec.rs
 *
 * Only the Function variant is needed — browser-safe tools are always
 * plain function tools, never namespace or hosted tools.
 */

import type { JsonSchema } from "./json_schema.js";

export interface ResponsesApiTool {
  name: string;
  description: string;
  parameters: JsonSchema;
  strict: boolean;
}

/** Subset of ToolSpec: Function only */
export type ToolSpec = { type: "function"; tool: ResponsesApiTool };

/** Serialise a ToolSpec to the shape the Responses API expects */
export function toolSpecToRequestJson(spec: ToolSpec): Record<string, unknown> {
  return {
    type: "function",
    name: spec.tool.name,
    description: spec.tool.description,
    parameters: spec.tool.parameters,
    strict: spec.tool.strict,
  };
}
