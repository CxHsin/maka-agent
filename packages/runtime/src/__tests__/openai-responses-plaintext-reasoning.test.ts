import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core';
import { getAIModel } from '@maka/runtime';

function conn(providerType: LlmConnection['providerType']): LlmConnection {
  return {
    slug: 'test',
    name: 'test',
    providerType,
    defaultModel: 'm',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

const ITEM_ID = 'd2fb9f45-39e8-4f9e-9cc3-999d591a27ab';
const REASONING = 'The user asks if 91 is prime. 91 = 7 x 13, so it is composite.';

/**
 * Recorded from a live `deepseek-v4-flash` streaming call: a reasoning item is
 * opened and closed by the same `output_item` events the SDK already reads,
 * while the text itself arrives on `response.reasoning_text.delta`. That is why
 * the reasoning part used to survive the round trip carrying nothing.
 */
function deepseekReasoningStream(deltas: string[]): string {
  const events: Array<Record<string, unknown>> = [
    { type: 'response.created', response: { id: 'r' } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'reasoning', id: ITEM_ID, status: 'in_progress', content: [], summary: [] },
    },
    ...deltas.map((delta, index) => ({
      type: 'response.reasoning_text.delta',
      content_index: 0,
      delta,
      item_id: ITEM_ID,
      output_index: 0,
      sequence_number: 4 + index,
    })),
    {
      type: 'response.reasoning_text.done',
      content_index: 0,
      item_id: ITEM_ID,
      output_index: 0,
      text: deltas.join(''),
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'reasoning',
        id: ITEM_ID,
        status: 'completed',
        content: [{ type: 'reasoning_text', text: deltas.join('') }],
        summary: [],
      },
    },
    {
      type: 'response.completed',
      response: {
        id: 'r',
        object: 'response',
        created_at: 0,
        model: 'deepseek-v4-flash',
        status: 'completed',
        output: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ];
  return `${events.map((event) => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\ndata: [DONE]\n\n`;
}

function sseFetch(body: string, chunkSize = Number.MAX_SAFE_INTEGER): typeof globalThis.fetch {
  return (async () => {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let at = 0; at < body.length; at += chunkSize) {
            controller.enqueue(encoder.encode(body.slice(at, at + chunkSize)));
          }
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as unknown as typeof globalThis.fetch;
}

async function streamReasoning(
  providerType: LlmConnection['providerType'],
  fetch: typeof globalThis.fetch,
): Promise<string> {
  const model = getAIModel({
    connection: conn(providerType),
    apiKey: 'test-key',
    modelId: providerType === 'deepseek' ? 'deepseek-v4-flash' : 'grok-4.5',
    fetch,
  });
  const { stream } = await model.doStream({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    providerOptions: { openai: { store: false, forceReasoning: true } },
  });
  let text = '';
  for await (const part of stream) {
    if (part.type === 'reasoning-delta') text += part.delta;
  }
  return text;
}

describe('open responses plaintext reasoning', () => {
  test('streamed reasoning text reaches the model stream', async () => {
    const deltas = ['The user asks if 91 is prime. ', '91 = 7 x 13, ', 'so it is composite.'];
    const text = await streamReasoning('deepseek', sseFetch(deepseekReasoningStream(deltas)));
    assert.equal(text, deltas.join(''));
  });

  test('reasoning survives frames split across chunk boundaries', async () => {
    // SSE frames arrive on arbitrary byte boundaries, so a translator that
    // assumes one whole event per chunk loses text without failing loudly.
    const deltas = ['The user asks if 91 is prime. ', '91 = 7 x 13, ', 'so it is composite.'];
    const text = await streamReasoning('deepseek', sseFetch(deepseekReasoningStream(deltas), 7));
    assert.equal(text, deltas.join(''));
  });

  test('a provider we have not measured is left untranslated', async () => {
    // The transport is mounted per provider, not per wire. xAI reaches the same
    // Responses wire but its reasoning shape has not been measured, so nothing
    // should rewrite its stream on the strength of the wire alone.
    const text = await streamReasoning('xai', sseFetch(deepseekReasoningStream(['ignored'])));
    assert.equal(text, '');
  });

  test('non-streaming reasoning content is read', async () => {
    let body: string | undefined;
    const fetch = (async () => {
      body = JSON.stringify({
        id: 'r',
        object: 'response',
        created_at: 0,
        model: 'deepseek-v4-flash',
        status: 'completed',
        output: [
          {
            type: 'reasoning',
            id: ITEM_ID,
            summary: [],
            content: [{ type: 'reasoning_text', text: REASONING }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;
    const model = getAIModel({
      connection: conn('deepseek'),
      apiKey: 'test-key',
      modelId: 'deepseek-v4-flash',
      fetch,
    });
    const result = await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      providerOptions: { openai: { store: false, forceReasoning: true } },
    });
    const reasoning = result.content.filter((part) => part.type === 'reasoning');
    assert.equal(reasoning.length, 1);
    assert.equal(reasoning[0].text, REASONING);
  });

  test('a summary the provider populated itself is left alone', async () => {
    // Filling a gap is safe; overwriting is not. A provider that speaks both
    // shapes keeps whatever it chose to put in the summary.
    const fetch = (async () =>
      new Response(
        JSON.stringify({
          id: 'r',
          object: 'response',
          created_at: 0,
          model: 'deepseek-v4-flash',
          status: 'completed',
          output: [
            {
              type: 'reasoning',
              id: ITEM_ID,
              summary: [{ type: 'summary_text', text: 'provider summary' }],
              content: [{ type: 'reasoning_text', text: REASONING }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof globalThis.fetch;
    const model = getAIModel({
      connection: conn('deepseek'),
      apiKey: 'test-key',
      modelId: 'deepseek-v4-flash',
      fetch,
    });
    const result = await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      providerOptions: { openai: { store: false, forceReasoning: true } },
    });
    const reasoning = result.content.filter((part) => part.type === 'reasoning');
    assert.deepEqual(
      reasoning.map((part) => part.text),
      ['provider summary'],
    );
  });
});
