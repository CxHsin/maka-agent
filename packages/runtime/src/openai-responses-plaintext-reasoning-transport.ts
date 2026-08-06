/**
 * Responses providers disagree about where reasoning text lives.
 *
 * The Open Responses shape carries it as `content[].reasoning_text`, streamed
 * as `response.reasoning_text.delta`. OpenAI's own extension carries it as
 * `summary[].summary_text`, streamed as `response.reasoning_summary_text.delta`,
 * and `@ai-sdk/openai` — the only provider that speaks this wire for us — reads
 * that one alone. Against a provider using the standard shape it produces a
 * reasoning part that opens and closes around nothing: `output_item.added` and
 * `output_item.done` already name a reasoning item, so start and end arrive,
 * while every delta lands on a field nobody reads. That is where the empty
 * reasoning in stored sessions comes from.
 *
 * This translates the response side only. Nothing here changes what we send,
 * so it cannot alter a request the provider already accepts.
 *
 * The two channels differ in how much they can defer to the provider. A whole
 * JSON body shows both fields at once, so that path fills a gap and nothing
 * more: a summary the provider populated itself is left alone. A stream is read
 * one line at a time and a plaintext delta carries no evidence about what some
 * later summary delta will say, so that path translates unconditionally. A
 * provider that streamed both shapes at the same index would end up with the
 * two concatenated. None does today — DeepSeek, the only one measured, streams
 * plaintext alone — and buffering a whole reasoning item to find out would cost
 * the streaming that is the point of the wire.
 */
import { responseWithBody } from './http-response.js';

const PLAINTEXT_DELTA = 'response.reasoning_text.delta';
const SUMMARY_DELTA = 'response.reasoning_summary_text.delta';

export function createOpenAiResponsesPlaintextReasoningTransport(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => translateResponse(await fetchImpl(input, init));
}

function translateResponse(response: Response): Response {
  if (!response.ok || !response.body) return response;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    return responseWithBody(response, response.body.pipeThrough(translateEventStream()));
  }
  if (!contentType.includes('application/json')) return response;
  return responseWithBody(
    response,
    new ReadableStream<Uint8Array>({
      async start(controller) {
        const body = await response.text();
        controller.enqueue(new TextEncoder().encode(translateJsonBody(body)));
        controller.close();
      },
    }),
  );
}

/**
 * SSE frames are newline-delimited but arrive on arbitrary chunk boundaries, so
 * the tail of a chunk is held back until its line terminator shows up. Every
 * line that is not a reasoning-text delta is passed through byte for byte.
 */
function translateEventStream(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = '';
  return new TransformStream({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${translateEventLine(line)}\n`));
      }
    },
    flush(controller) {
      // Bytes the decoder is still holding belong to a character split across
      // the last chunk boundary; without this final decode they are dropped.
      pending += decoder.decode();
      if (pending) controller.enqueue(encoder.encode(translateEventLine(pending)));
    },
  });
}

function translateEventLine(line: string): string {
  if (!line.startsWith('data:')) return line;
  const payload = line.slice('data:'.length).trim();
  if (!payload || payload === '[DONE]') return line;
  let event: unknown;
  try {
    event = JSON.parse(payload);
  } catch {
    return line;
  }
  if (!isRecord(event) || event.type !== PLAINTEXT_DELTA) return line;
  // The SDK keys an in-flight reasoning part by `${item_id}:${summary_index}`,
  // and the part it opened on `output_item.added` is index 0. The standard
  // shape indexes the same position as `content_index`, so carrying it across
  // keeps multiple reasoning items — and multiple parts within one — apart.
  const { content_index: contentIndex, ...rest } = event;
  return `data: ${JSON.stringify({
    ...rest,
    type: SUMMARY_DELTA,
    summary_index: typeof contentIndex === 'number' ? contentIndex : 0,
  })}`;
}

/**
 * The non-streaming path reads `summary[]` only, so a reasoning item arrives
 * with an empty string in it. Only the top-level output items are touched:
 * a `reasoning_text` appearing anywhere else — inside tool arguments, say — is
 * not a reasoning item and is left alone.
 */
function translateJsonBody(body: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return body;
  }
  if (!isRecord(payload) || !Array.isArray(payload.output)) return body;
  let changed = false;
  const output = payload.output.map((item) => {
    if (!isRecord(item) || item.type !== 'reasoning') return item;
    if (Array.isArray(item.summary) && item.summary.length > 0) return item;
    if (!Array.isArray(item.content)) return item;
    const summary = item.content.flatMap((part) =>
      isRecord(part) && part.type === 'reasoning_text' && typeof part.text === 'string'
        ? [{ type: 'summary_text', text: part.text }]
        : [],
    );
    if (summary.length === 0) return item;
    changed = true;
    return { ...item, summary };
  });
  return changed ? JSON.stringify({ ...payload, output }) : body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
