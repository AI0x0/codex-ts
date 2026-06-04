/**
 * SSE stream parser for the OpenAI Responses API.
 * Extracted from turn.ts so compact.ts can share it.
 */

export type RawSseEvent = Record<string, unknown>;

export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<RawSseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      let dataLine = "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          dataLine = line.slice(6).trim();
        } else if (line === "" && dataLine) {
          if (dataLine !== "[DONE]") {
            try {
              yield JSON.parse(dataLine) as RawSseEvent;
            } catch {
              /* malformed JSON — skip */
            }
          }
          dataLine = "";
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
