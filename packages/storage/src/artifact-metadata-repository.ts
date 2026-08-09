import type { ArtifactRecord } from '@maka/core';

export interface ArtifactMetadataRepository {
  ready(): Promise<void>;
  readAll(): ArtifactRecord[];
  replaceAll(records: readonly ArtifactRecord[]): void;
  close(): void;
}
