// What the metering proxy observed, and nothing that can be worked out from it.
//
// These counts cross a process boundary twice: the wrapper reports them in its
// result frame, and writes them to a checkpoint the host reads when the wrapper
// was killed before it could report. Anything derivable — settled requests,
// missing usage, whether the figure is complete, what it cost — is computed by
// `deriveMetering` on whichever side needs it, so the two sides cannot hold two
// versions of a value neither of them owns.
//
// `inFlightRequests` is the only field that separates the two readers: it is
// zero by construction once the proxy has settled, and may be positive in a
// checkpoint written mid-request.
export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface ProviderMeteringCounts {
  readonly usage: ProviderUsage | null;
  readonly requests: number;
  readonly inFlightRequests: number;
  readonly admittedRequests: number;
  readonly usageRequests: number;
  readonly removedWebTools: number;
  readonly models: readonly string[];
  readonly toolNames: readonly string[];
}

export interface DerivedMetering {
  readonly settledRequests: number;
  readonly missingUsageRequests: number;
  readonly usageComplete: boolean;
  readonly costUsd: number | null;
  readonly tokenBasis: 'complete' | 'lower-bound';
}

// Cost is reported only for a complete figure. A partial token count is still
// worth recording as a lower bound, but a cost derived from it would enter the
// result kernel as a number indistinguishable from a settled one.
export function deriveMetering(counts: ProviderMeteringCounts): DerivedMetering {
  const usageComplete =
    counts.inFlightRequests === 0 &&
    counts.admittedRequests > 0 &&
    counts.usageRequests === counts.admittedRequests;
  return {
    settledRequests: counts.requests - counts.inFlightRequests,
    missingUsageRequests: counts.admittedRequests - counts.usageRequests,
    usageComplete,
    costUsd: counts.usage && usageComplete ? estimateCost(counts.usage) : null,
    tokenBasis: usageComplete ? 'complete' : 'lower-bound',
  };
}

export function estimateCost(value: ProviderUsage): number {
  const uncached = Math.max(0, value.inputTokens - value.cacheReadTokens - value.cacheWriteTokens);
  return (
    (uncached * 0.145 + value.cacheReadTokens * 0.0029 + value.outputTokens * 0.29) / 1_000_000
  );
}
