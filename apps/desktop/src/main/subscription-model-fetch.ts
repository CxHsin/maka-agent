import type { LlmConnection } from '@maka/core/llm-connections';
import {
  buildSubscriptionModelFetch as buildRuntimeSubscriptionModelFetch,
  inheritFetchProxySnapshot,
  proxiedFetch,
} from '@maka/runtime';
import {
  type ClaudeSubscriptionService,
  isCloakEnabled,
} from './oauth/claude-subscription-service.js';
import type { OpenAiCodexService } from './oauth/openai-codex-service.js';
import type { XaiOAuthService } from './oauth/xai-oauth-service.js';

interface SubscriptionModelFetchDeps {
  claudeSubscription: ClaudeSubscriptionService;
  openAiCodex: OpenAiCodexService;
  xaiOAuth: XaiOAuthService;
}

export function createSubscriptionModelFetch(deps: SubscriptionModelFetchDeps) {
  return function buildSubscriptionModelFetch(
    connection: LlmConnection,
    sessionId: string,
    modelId: string,
  ): typeof fetch {
    if (connection.providerType === 'claude-subscription' && isCloakEnabled()) {
      return inheritFetchProxySnapshot(
        buildClaudeSubscriptionCloakedFetch(
          connection,
          deps.claudeSubscription,
          sessionId,
          modelId,
          proxiedFetch,
        ),
        proxiedFetch,
      );
    }
    if (
      connection.providerType === 'openai-codex'
      || connection.providerType === 'github-copilot'
      || connection.providerType === 'xai-oauth'
    ) {
      const subscriptionFetch = buildRuntimeSubscriptionModelFetch({
        connection,
        sessionId,
        modelId,
        fetchFn: proxiedFetch,
        ...(connection.providerType === 'openai-codex'
          ? {
              refreshOAuthAccessToken: () =>
                deps.openAiCodex.getAccessTokenInternal({ forceRefresh: true }),
            }
          : connection.providerType === 'xai-oauth'
            ? {
                refreshOAuthAccessToken: () =>
                  deps.xaiOAuth.getAccessTokenInternal({ forceRefresh: true }),
              }
            : {}),
      });
      return subscriptionFetch
        ? inheritFetchProxySnapshot(subscriptionFetch, proxiedFetch)
        : proxiedFetch;
    }
    return proxiedFetch;
  };
}

function buildClaudeSubscriptionCloakedFetch(
  connection: LlmConnection,
  claudeSubscription: ClaudeSubscriptionService,
  sessionId: string,
  modelId: string,
  fetchFn: typeof fetch,
): typeof fetch {
  return async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const [deviceId, accountState] = await Promise.all([
      claudeSubscription.getOrCreateDeviceId(),
      claudeSubscription.getAccountState(),
    ]);
    const modelFetch = buildRuntimeSubscriptionModelFetch({
      connection,
      sessionId,
      modelId,
      fetchFn,
      claude: {
        cloakEnabled: true,
        deviceId,
        accountUuid: accountState.profile?.accountUuid ?? '',
      },
    });
    return (modelFetch ?? fetchFn)(url, init);
  };
}
