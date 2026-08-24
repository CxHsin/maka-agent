import { ExternalSessionAdapterRegistry } from '@maka/core/external-session';
import {
  ClaudeSessionAdapter,
  type ClaudeSessionAdapterOptions,
} from './claude-session-adapter.js';
import { CodexSessionAdapter, type CodexSessionAdapterOptions } from './codex-session-adapter.js';

export interface ExternalSessionAdapterOptions {
  claude?: ClaudeSessionAdapterOptions;
  codex?: CodexSessionAdapterOptions;
}

/** Default source registry shared by product-facing external Session import surfaces. */
export function createExternalSessionAdapterRegistry(
  options: ExternalSessionAdapterOptions = {},
): ExternalSessionAdapterRegistry {
  return new ExternalSessionAdapterRegistry([
    new ClaudeSessionAdapter(options.claude),
    new CodexSessionAdapter(options.codex),
  ]);
}
