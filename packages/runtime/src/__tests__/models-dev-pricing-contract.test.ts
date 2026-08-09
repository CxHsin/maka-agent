import assert from 'node:assert/strict';
import test from 'node:test';
import { lookupModelMetadata } from '@maka/core';
import type { ProviderType } from '@maka/core';
import { GENERATED_MODEL_PRICING } from '../telemetry/model-pricing.generated.js';

const LOCAL_SUPPLEMENT_PROVIDER_TYPES = new Set(['zai-coding-plan', 'MiniMax-cn']);

test('generated pricing stays keyed to generated model facts', () => {
  const gaps: string[] = [];

  for (const pricing of GENERATED_MODEL_PRICING) {
    const separator = pricing.modelKey.indexOf(':');
    if (separator <= 0) {
      gaps.push(`${pricing.modelKey} has no provider/model separator`);
      continue;
    }
    const providerType = pricing.modelKey.slice(0, separator) as ProviderType;
    const modelId = pricing.modelKey.slice(separator + 1);
    const metadata = lookupModelMetadata(providerType, modelId);
    if (!metadata.displayName) {
      gaps.push(`${pricing.modelKey} has pricing but no generated model metadata`);
    }
    for (const field of [
      'inputUsdPer1M',
      'outputUsdPer1M',
      'cacheReadUsdPer1M',
      'cacheWriteUsdPer1M',
    ] as const) {
      const value = pricing[field];
      if (
        value !== undefined &&
        (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      ) {
        gaps.push(`${pricing.modelKey} has invalid ${field}`);
      }
    }
    if (LOCAL_SUPPLEMENT_PROVIDER_TYPES.has(providerType)) {
      gaps.push(`${pricing.modelKey} must remain in the local supplement`);
    }
  }

  assert.deepEqual(gaps, []);
});

test('subscription access paths have no generated API pricing', () => {
  for (const providerType of ['github-copilot', 'gemini-cli'] as const) {
    assert.equal(
      GENERATED_MODEL_PRICING.some(({ modelKey }) => modelKey.startsWith(`${providerType}:`)),
      false,
      `${providerType} must not inherit public API prices`,
    );
  }
});

test('known tiered models have no generated base pricing', () => {
  for (const modelKey of ['google:gemini-2.5-pro', 'openai:gpt-5.5'] as const) {
    assert.equal(
      GENERATED_MODEL_PRICING.some((pricing) => pricing.modelKey === modelKey),
      false,
      `${modelKey} must not publish a base rate while tier selection is unsupported`,
    );
  }
});
