/** mirrors codex-rs/protocol/src/user_input.rs */

export type UserInput =
  | { type: "text"; text: string }
  | { type: "image"; image_url: string };
