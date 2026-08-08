import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FETCH_PROXY_SNAPSHOT, proxiedFetch, setActiveProxy } from '@maka/runtime';
import { PROXY_DEFAULTS } from '@maka/core/settings/network-settings';
import { createSubscriptionModelFetch } from '../subscription-model-fetch.js';

describe('desktop model fetch', () => {
  test('provider requests use the active Maka proxy transport', () => {
    const buildModelFetch = createSubscriptionModelFetch({
      claudeSubscription: {} as never,
      openAiCodex: {} as never,
      xaiOAuth: {} as never,
    });

    const modelFetch = buildModelFetch(
      {
        slug: 'openai-test',
        name: 'OpenAI test',
        providerType: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-test',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
      'session-test',
      'gpt-test',
    );

    assert.equal(modelFetch, proxiedFetch);
    setActiveProxy({
      ...PROXY_DEFAULTS,
      enabled: true,
      host: '127.0.0.1',
      port: 7890,
    });
    try {
      const snapshot = (
        modelFetch as typeof fetch & {
          [FETCH_PROXY_SNAPSHOT]?: { host?: string; port?: number };
        }
      )[FETCH_PROXY_SNAPSHOT];
      assert.equal(snapshot?.host, '127.0.0.1');
      assert.equal(snapshot?.port, 7890);

      const subscriptionFetch = buildModelFetch(
        {
          slug: 'codex-test',
          name: 'Codex test',
          providerType: 'openai-codex',
          baseUrl: 'https://chatgpt.com/backend-api/codex',
          defaultModel: 'gpt-test',
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
        'session-test',
        'gpt-test',
      );
      const subscriptionSnapshot = (
        subscriptionFetch as typeof fetch & {
          [FETCH_PROXY_SNAPSHOT]?: { host?: string; port?: number };
        }
      )[FETCH_PROXY_SNAPSHOT];
      assert.equal(subscriptionSnapshot?.host, '127.0.0.1');
      assert.equal(subscriptionSnapshot?.port, 7890);
    } finally {
      setActiveProxy(null);
    }
  });
});
