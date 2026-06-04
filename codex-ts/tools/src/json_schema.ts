/** mirrors codex-rs/tools/src/json_schema helpers */

export interface JsonSchema {
  type?: string | string[] | undefined;
  description?: string | undefined;
  properties?: Record<string, JsonSchema> | undefined;
  required?: string[] | undefined;
  additionalProperties?: boolean | JsonSchema | undefined;
  items?: JsonSchema | undefined;
  enum?: unknown[] | undefined;
}

export function object(
  properties: Record<string, JsonSchema>,
  required?: string[],
  additionalProperties?: boolean,
): JsonSchema {
  return {
    type: "object",
    properties,
    ...(required !== undefined ? { required } : {}),
    ...(additionalProperties !== undefined ? { additionalProperties } : {}),
  };
}

export function string(description?: string): JsonSchema {
  return { type: "string", ...(description ? { description } : {}) };
}

export function integer(description?: string): JsonSchema {
  return { type: "integer", ...(description ? { description } : {}) };
}

export function stringEnum(values: string[], description?: string): JsonSchema {
  return {
    type: "string",
    enum: values,
    ...(description ? { description } : {}),
  };
}

export function array(items: JsonSchema, description?: string): JsonSchema {
  return { type: "array", items, ...(description ? { description } : {}) };
}
