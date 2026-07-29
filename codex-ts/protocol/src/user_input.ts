/** mirrors codex-rs/protocol/src/user_input.rs */

export type UserInput =
  | { type: "text"; text: string }
  | { type: "image"; image_url: string }
  /**
   * Pre-encoded audio data URI forwarded to the Responses API — mirrors
   * `UserInput::Audio { audio_url }` (user_input.rs:41), serialized as
   * `ContentItem::InputAudio { audio_url }` (models.rs:1778). The rs
   * `LocalAudio`/`LocalImage` variants read from disk, so they have no browser
   * equivalent: a host records audio and passes the data URI here directly.
   */
  | { type: "audio"; audio_url: string };
