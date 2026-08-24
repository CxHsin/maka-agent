import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import type { ToolResultContent } from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';
import {
  FOREIGN_SESSION_DIGEST_MAX_READ_BYTES,
  FOREIGN_SESSION_HEAD_BYTES,
  FOREIGN_SESSION_TITLE_WINDOW_BYTES,
  claudeAssistantText,
  claudeToolFilePaths,
  claudeUserAuthoredText,
  collectClaudeMeta,
  collectClaudeTitle,
  createDigestAccumulator,
  finishDigest,
  isSafeForeignId,
  parseForeignJsonLine,
  pickClaudeTitle,
  pushDigestFile,
  pushDigestMessage,
  type ClaudeTitleCandidates,
  type ClaudeTranscriptMeta,
  type ForeignSessionDigest,
  type ForeignSessionSummary,
} from '@maka/core/foreign-session';
import type {
  ExternalMakaSession,
  ExternalSessionAdapter,
  ExternalSessionQuery,
  ExternalSessionSummary,
} from '@maka/core/external-session';
import {
  matchesSourceCatalogQuery,
  readBoundedUtf8File,
  readUtf8Prefix,
  readUtf8Tail,
  type ExternalSourceCatalogEntry,
  type ExternalSourceCatalogQuery,
} from './external-source-catalog.js';

export const CLAUDE_SESSION_ADAPTER_ID = 'claude-code';
const CLAUDE_HEAD_GROWTH_BYTES = 64 * 1024;
const CLAUDE_HEAD_MAX_BYTES = 4 * 1024 * 1024;
const CLAUDE_RECORD_ID_MAX_CHARS = 256;
const CLAUDE_DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

interface ClaudeNativeRecord {
  line: number;
  value: JsonRecord;
}

interface ClaudeNativeTranscript {
  id: string;
  records: readonly ClaudeNativeRecord[];
  malformedLines: number;
  lineageComplete: boolean;
  metadata: {
    name: string;
    cwd: string;
    gitBranch?: string;
    updatedAtMs: number;
  };
}

interface ClaudeCatalogEntry extends ExternalSourceCatalogEntry {
  source: 'claude-code';
}

export interface ClaudeSessionAdapterOptions {
  /** Claude's home directory. Defaults to the user's home directory. */
  homeDir?: string;
  /** Test/host override for the bounded full transcript read. */
  maxTranscriptBytes?: number;
}

/** Catalog plus native parser for Claude Code transcripts. */
export class ClaudeSessionAdapter implements ExternalSessionAdapter {
  readonly id = CLAUDE_SESSION_ADAPTER_ID;

  private readonly homeDir: string;
  private readonly maxTranscriptBytes: number;

  constructor(options: ClaudeSessionAdapterOptions = {}) {
    this.homeDir = resolve(options.homeDir ?? homedir());
    this.maxTranscriptBytes = options.maxTranscriptBytes ?? CLAUDE_DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(this.maxTranscriptBytes) || this.maxTranscriptBytes <= 0) {
      throw new Error('Claude transcript byte limit must be a positive safe integer');
    }
  }

  async detect(): Promise<boolean> {
    return isDirectory(this.claudeRoot);
  }

  async listSessions(query: ExternalSessionQuery = {}): Promise<readonly ExternalSessionSummary[]> {
    const entries = await this.listCatalogEntries(query);
    return entries.map((entry) => ({
      id: entry.id,
      name: entry.title,
      cwd: entry.cwd,
      ...(entry.createdAtMs !== undefined ? { createdAt: entry.createdAtMs } : {}),
      updatedAt: entry.updatedAtMs,
      ...(entry.archived !== undefined ? { archived: entry.archived } : {}),
    }));
  }

  async readSession(sessionId: string): Promise<ExternalMakaSession> {
    const entry = await this.findCatalogEntry(sessionId);
    if (!entry) throw new Error(`Claude Session not found: ${sessionId}`);
    const text = await readBoundedUtf8File(
      await this.resolveTranscriptPath(entry.transcriptPath, sessionId),
      this.maxTranscriptBytes,
    );
    const transcript = parseClaudeTranscript(text, entry);
    return projectClaudeSession(transcript, entry);
  }

  async listCatalogEntries(
    query: ExternalSourceCatalogQuery = {},
  ): Promise<readonly ClaudeCatalogEntry[]> {
    if (query.limit !== undefined && query.limit <= 0) return [];
    const candidates = await this.listTranscriptCandidates();
    const entries: ClaudeCatalogEntry[] = [];
    const seenIds = new Set<string>();
    for (const candidate of candidates) {
      const id = basename(candidate.path, '.jsonl');
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      const entry = await catalogEntryFromTranscript(candidate.path, candidate.mtimeMs);
      if (!entry || !matchesSourceCatalogQuery(entry, query)) continue;
      entries.push(entry);
    }
    entries.sort(compareClaudeCatalogEntries);
    return query.limit === undefined ? entries : entries.slice(0, query.limit);
  }

  async readDigest(summary: ForeignSessionSummary): Promise<ForeignSessionDigest> {
    if (summary.source !== 'claude-code') throw new Error('Claude adapter received another source');
    const path = await this.resolveTranscriptPath(summary.transcriptPath, summary.id);
    const { text, truncated } = await readUtf8Tail(path, FOREIGN_SESSION_DIGEST_MAX_READ_BYTES);
    const entry: ClaudeCatalogEntry = {
      source: 'claude-code',
      id: summary.id,
      title: summary.title,
      cwd: summary.cwd,
      updatedAtMs: summary.updatedAtMs,
      gitBranch: summary.gitBranch,
      transcriptPath: path,
    };
    const transcript = parseClaudeTranscript(text, entry);
    const acc = createDigestAccumulator();
    for (const record of transcript.records) {
      const value = record.value;
      if (value.isSidechain === true) continue;
      if (value.type === 'user') {
        const userText = claudeUserAuthoredText(value);
        if (userText !== undefined) pushDigestMessage(acc, 'user', userText);
      } else if (value.type === 'assistant') {
        const assistantText = claudeAssistantText(value);
        if (assistantText !== undefined) pushDigestMessage(acc, 'assistant', assistantText);
        for (const filePath of claudeToolFilePaths(value)) pushDigestFile(acc, filePath);
      }
    }
    if (truncated) {
      acc.warnings.push(
        `transcript exceeded ${FOREIGN_SESSION_DIGEST_MAX_READ_BYTES} bytes; only its tail was read`,
      );
    }
    if (!transcript.lineageComplete) {
      acc.warnings.push(
        'Claude transcript lineage may be incomplete because rewind and compaction ancestors are outside the available transcript window',
      );
    }
    if (transcript.malformedLines > 0) {
      acc.warnings.push(`${transcript.malformedLines} malformed transcript lines were skipped`);
    }
    return finishDigest(acc, {
      source: summary.source,
      id: summary.id,
      title: summary.title,
      cwd: summary.cwd,
      gitBranch: summary.gitBranch,
      updatedAtMs: summary.updatedAtMs,
    });
  }

  private get claudeRoot(): string {
    return join(this.homeDir, '.claude', 'projects');
  }

  private async findCatalogEntry(sessionId: string): Promise<ClaudeCatalogEntry | undefined> {
    if (!isSafeForeignId(sessionId)) return undefined;
    return (await this.listCatalogEntries({ includeArchived: true })).find(
      (entry) => entry.id === sessionId,
    );
  }

  private async listTranscriptCandidates(): Promise<{ path: string; mtimeMs: number }[]> {
    const candidates: { path: string; mtimeMs: number }[] = [];
    for (const projectDir of await listSubdirectories(this.claudeRoot)) {
      for (const candidate of await listJsonlFiles(projectDir)) candidates.push(candidate);
    }
    return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  }

  private async resolveTranscriptPath(path: string, expectedId: string): Promise<string> {
    const root = await realpath(this.claudeRoot);
    const real = await realpath(resolve(path));
    if (real !== root && !real.startsWith(root + sep)) {
      throw new Error('Foreign transcript escaped its source root');
    }
    if (basename(real, '.jsonl') !== expectedId || !(await isFile(real))) {
      throw new Error(`Claude transcript is unavailable: ${expectedId}`);
    }
    return real;
  }
}

async function catalogEntryFromTranscript(
  path: string,
  mtimeMs: number,
): Promise<ClaudeCatalogEntry | undefined> {
  const id = basename(path, '.jsonl');
  if (!isSafeForeignId(id)) return undefined;
  const meta: ClaudeTranscriptMeta = {};
  const titles: ClaudeTitleCandidates = {};
  for (const window of [
    await readClaudeHead(path),
    await readTranscriptWindow(path, 'tail', CLAUDE_HEAD_GROWTH_BYTES),
  ]) {
    if (window === undefined) continue;
    for (const line of window.split('\n')) {
      const record = parseForeignJsonLine(line);
      if (!record) continue;
      collectClaudeMeta(record, meta);
      collectClaudeTitle(record, titles);
    }
  }
  if (meta.isSidechain === true || meta.cwd === undefined) return undefined;
  return {
    source: 'claude-code',
    id,
    title: pickClaudeTitle(titles) || id,
    cwd: meta.cwd,
    updatedAtMs: meta.timestampMs ?? mtimeMs,
    ...(meta.gitBranch !== undefined ? { gitBranch: meta.gitBranch } : {}),
    transcriptPath: path,
  };
}

function parseClaudeTranscript(
  text: string,
  entry: Pick<ClaudeCatalogEntry, 'id' | 'title' | 'cwd' | 'updatedAtMs' | 'gitBranch'>,
): ClaudeNativeTranscript {
  const records: ClaudeNativeRecord[] = [];
  const seenIds = new Set<string>();
  let malformedLines = 0;
  let updatedAtMs = entry.updatedAtMs;
  let cwd = entry.cwd;
  let gitBranch = entry.gitBranch;
  const titles: ClaudeTitleCandidates = {};
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim().length === 0) continue;
    const value = parseForeignJsonLine(line);
    if (!value) {
      malformedLines += 1;
      continue;
    }
    const sourceId = stringField(value, 'uuid');
    if (sourceId !== undefined) {
      if (sourceId.length > CLAUDE_RECORD_ID_MAX_CHARS || seenIds.has(sourceId)) continue;
      seenIds.add(sourceId);
    }
    const meta: ClaudeTranscriptMeta = { cwd, gitBranch, timestampMs: updatedAtMs };
    collectClaudeMeta(value, meta);
    cwd = meta.cwd ?? cwd;
    gitBranch = meta.gitBranch ?? gitBranch;
    updatedAtMs = Math.max(updatedAtMs, meta.timestampMs ?? updatedAtMs);
    collectClaudeTitle(value, titles);
    records.push({ line: index + 1, value });
  }
  if (!isSafeForeignId(entry.id)) throw new Error(`Invalid Claude Session id: ${entry.id}`);
  const lineage = resolveClaudeLineage(records);
  return {
    id: entry.id,
    records: lineage.records,
    malformedLines,
    lineageComplete: lineage.complete,
    metadata: {
      name: pickClaudeTitle(titles) || entry.title,
      cwd,
      ...(gitBranch !== undefined ? { gitBranch } : {}),
      updatedAtMs,
    },
  };
}

function resolveClaudeLineage(records: readonly ClaudeNativeRecord[]): {
  records: readonly ClaudeNativeRecord[];
  complete: boolean;
} {
  const byId = new Map<string, ClaudeNativeRecord>();
  const childIds = new Set<string>();
  let hasParentLinks = false;
  for (const record of records) {
    const id = recordId(record.value);
    if (id.length > 0) byId.set(id, record);
    if (parentId(record.value) !== undefined) hasParentLinks = true;
    const parent = parentId(record.value);
    if (parent !== undefined) childIds.add(parent);
  }
  if (!hasParentLinks) return { records, complete: true };

  const leaf =
    [...records].reverse().find((record) => {
      const id = recordId(record.value);
      return id.length > 0 && !childIds.has(id) && !isClaudeLineageBoundary(record.value);
    }) ?? [...records].reverse().find((record) => recordId(record.value).length > 0);
  if (!leaf) return { records, complete: false };

  const activeIds = new Set<string>();
  let complete = true;
  let currentId: string | undefined = recordId(leaf.value);
  while (currentId !== undefined) {
    if (activeIds.has(currentId)) {
      complete = false;
      break;
    }
    activeIds.add(currentId);
    const record = byId.get(currentId);
    if (!record) {
      complete = false;
      break;
    }
    currentId = parentId(record.value);
  }

  return {
    records: records.filter((record) => {
      const value = record.value;
      return activeIds.has(recordId(value)) || isClaudeLineageBoundary(value);
    }),
    complete,
  };
}

function parentId(record: JsonRecord): string | undefined {
  return (
    stringField(record, 'parentUuid') ??
    stringField(record, 'parent_uuid') ??
    stringField(record, 'logicalParentUuid') ??
    stringField(record, 'logical_parent_uuid')
  );
}

function isClaudeLineageBoundary(record: JsonRecord): boolean {
  const type = stringField(record, 'type')?.toLowerCase();
  const subtype = stringField(record, 'subtype')?.toLowerCase();
  return (
    type === 'summary' ||
    record.isCompactSummary === true ||
    record.isRewind === true ||
    type === 'rewind' ||
    subtype?.includes('rewind') === true ||
    subtype?.includes('compact') === true
  );
}

function projectClaudeSession(
  transcript: ClaudeNativeTranscript,
  entry: Pick<ClaudeCatalogEntry, 'id' | 'title' | 'cwd'>,
): ExternalMakaSession {
  const messages: StoredMessage[] = [];
  const usedIds = new Set<string>();
  const toolIds = new Map<string, string[]>();
  const resolvedToolIds = new Set<string>();
  const turns = new Set<string>();
  let activeTurnId: string | undefined;
  let lastTimestamp = 0;
  let turnCounter = 0;

  const timestampFor = (record: ClaudeNativeRecord): number => {
    const parsed = parseTimestampMs(record.value.timestamp);
    if (parsed !== undefined) lastTimestamp = Math.max(lastTimestamp, parsed);
    else lastTimestamp += 1;
    return parsed ?? lastTimestamp;
  };
  const uniqueId = (base: string, line: number): string => {
    const safeBase = base.length > 0 ? base : `claude-${transcript.id}-${line}`;
    if (!usedIds.has(safeBase)) {
      usedIds.add(safeBase);
      return safeBase;
    }
    let candidate = `${safeBase}-${line}`;
    let suffix = 2;
    while (usedIds.has(candidate)) candidate = `${safeBase}-${line}-${suffix++}`;
    usedIds.add(candidate);
    return candidate;
  };
  const ensureTurn = (line: number): string => {
    activeTurnId ??= `claude-${transcript.id}-turn-${++turnCounter}-${line}`;
    turns.add(activeTurnId);
    return activeTurnId;
  };
  const closeTurn = (turnId: string, ts: number): void => {
    messages.push({
      type: 'turn_state',
      id: uniqueId(`${turnId}-state`, ts),
      turnId,
      ts,
      status: 'completed',
      partialOutputRetained: true,
    });
  };

  for (const record of transcript.records) {
    const value = record.value;
    if (value.isSidechain === true) continue;
    const ts = timestampFor(record);
    if (value.type === 'user') {
      const resultBlocks = claudeToolResultBlocks(value);
      for (const block of resultBlocks) {
        const originalToolId =
          stringField(block, 'tool_use_id') ?? `${recordId(value) || 'claude'}-orphan-tool`;
        const toolUseId = resolveToolId(originalToolId, toolIds, resolvedToolIds);
        messages.push({
          type: 'tool_result',
          id: uniqueId(`${recordId(value) || 'claude-result'}-result`, record.line),
          turnId: ensureTurn(record.line),
          ts,
          toolUseId,
          isError: block.is_error === true,
          content: claudeToolResultContent(block.content),
        });
        resolvedToolIds.add(toolUseId);
      }
      const userText = claudeUserAuthoredText(value);
      if (userText !== undefined) {
        if (activeTurnId !== undefined) closeTurn(activeTurnId, ts);
        activeTurnId = `claude-${transcript.id}-turn-${++turnCounter}-${record.line}`;
        turns.add(activeTurnId);
        messages.push({
          type: 'user',
          id: uniqueId(recordId(value) || `claude-user-${record.line}`, record.line),
          turnId: activeTurnId,
          ts,
          text: userText,
        });
      }
      continue;
    }
    if (value.type === 'assistant') {
      const turnId = ensureTurn(record.line);
      const blocks = claudeContentBlocks(value);
      const textParts: string[] = [];
      const thinkingParts: { text: string; signature?: string }[] = [];
      const contentOrder: ('thinking' | 'text' | 'tools')[] = [];
      for (const block of blocks) {
        const type = stringField(block, 'type');
        if (type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text);
          if (!contentOrder.includes('text')) contentOrder.push('text');
        } else if (type === 'thinking' && typeof block.thinking === 'string') {
          thinkingParts.push({
            text: block.thinking,
            ...(typeof block.signature === 'string' ? { signature: block.signature } : {}),
          });
          if (!contentOrder.includes('thinking')) contentOrder.push('thinking');
        } else if (type === 'tool_use') {
          if (!contentOrder.includes('tools')) contentOrder.push('tools');
        }
      }
      if (textParts.length > 0 || thinkingParts.length > 0) {
        const thinking =
          thinkingParts.length > 0
            ? {
                text: thinkingParts.map((part) => part.text).join(''),
                ...(thinkingParts.length > 1 ? { parts: thinkingParts } : {}),
              }
            : undefined;
        messages.push({
          type: 'assistant',
          id: uniqueId(recordId(value) || `claude-assistant-${record.line}`, record.line),
          turnId,
          ts,
          text: textParts.join('\n'),
          ...(thinking ? { thinking } : {}),
          contentOrder,
          modelId:
            stringField(asRecord(value.message), 'model') ??
            stringField(value, 'model') ??
            'claude',
        });
      }
      for (const block of blocks.filter((item) => item.type === 'tool_use')) {
        const rawToolId = stringField(block, 'id') ?? `claude-tool-${record.line}`;
        const toolId = uniqueId(rawToolId, record.line);
        const list = toolIds.get(rawToolId) ?? [];
        list.push(toolId);
        toolIds.set(rawToolId, list);
        messages.push({
          type: 'tool_call',
          id: toolId,
          turnId,
          ts,
          toolName: stringField(block, 'name') ?? 'unknown',
          args: block.input ?? {},
        });
      }
      continue;
    }
    if (value.type === 'summary' || value.isCompactSummary === true) {
      messages.push({
        type: 'system_note',
        id: uniqueId(`${recordId(value) || 'claude-summary'}-compact`, record.line),
        turnId: activeTurnId,
        ts,
        kind: 'context_compacted',
        data: typeof value.summary === 'string' ? value.summary : undefined,
      });
      continue;
    }
    if (isClaudeRewindRecord(value)) {
      messages.push({
        type: 'system_note',
        id: uniqueId(`${recordId(value) || 'claude-rewind'}-rewind`, record.line),
        turnId: activeTurnId,
        ts,
        kind: 'session_resume',
        data: { source: 'claude', record: JSON.parse(JSON.stringify(value)) as unknown },
      });
    }
  }
  if (activeTurnId !== undefined && turns.has(activeTurnId)) closeTurn(activeTurnId, lastTimestamp);
  return {
    sourceSessionId: transcript.id,
    metadata: {
      name: entry.title,
      cwd: entry.cwd,
    },
    messages,
  };
}

function claudeContentBlocks(record: JsonRecord): JsonRecord[] {
  const message = asRecord(record.message);
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord);
}

function claudeToolResultBlocks(record: JsonRecord): JsonRecord[] {
  return claudeContentBlocks(record).filter((block) => block.type === 'tool_result');
}

function claudeToolResultContent(value: unknown): ToolResultContent {
  if (typeof value === 'string') return { kind: 'text', text: value };
  if (Array.isArray(value)) {
    const text = value
      .filter(isRecord)
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('\n');
    if (text.length > 0) return { kind: 'text', text };
  }
  return { kind: 'json', value: value ?? null };
}

function resolveToolId(
  originalId: string,
  toolIds: Map<string, string[]>,
  resolvedToolIds: Set<string>,
): string {
  const candidates = toolIds.get(originalId) ?? [];
  const unresolved = candidates.find((id) => !resolvedToolIds.has(id));
  return unresolved ?? originalId;
}

function recordId(record: JsonRecord): string {
  return stringField(record, 'uuid') ?? stringField(record, 'id') ?? '';
}

function isClaudeRewindRecord(record: JsonRecord): boolean {
  const type = stringField(record, 'type')?.toLowerCase();
  const subtype = stringField(record, 'subtype')?.toLowerCase();
  return record.isRewind === true || type === 'rewind' || subtype?.includes('rewind') === true;
}

function compareClaudeCatalogEntries(a: ClaudeCatalogEntry, b: ClaudeCatalogEntry): number {
  return b.updatedAtMs - a.updatedAtMs || a.transcriptPath.localeCompare(b.transcriptPath);
}

function asRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: JsonRecord | undefined, field: string): string | undefined {
  const value = record?.[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return parseTimestampMs(numeric);
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

async function readClaudeHead(path: string): Promise<string | undefined> {
  for (const size of [
    FOREIGN_SESSION_HEAD_BYTES,
    CLAUDE_HEAD_GROWTH_BYTES,
    CLAUDE_HEAD_GROWTH_BYTES * 4,
    CLAUDE_HEAD_MAX_BYTES,
  ]) {
    const text = await readUtf8Prefix(path, size).catch(() => undefined);
    if (text === undefined) return undefined;
    const meta: ClaudeTranscriptMeta = {};
    for (const line of text.split('\n')) {
      const record = parseForeignJsonLine(line);
      if (record) collectClaudeMeta(record, meta);
    }
    if (meta.cwd !== undefined && meta.isSidechain !== undefined) return text;
  }
  return readUtf8Prefix(path, CLAUDE_HEAD_MAX_BYTES).catch(() => undefined);
}

async function readTranscriptWindow(
  path: string,
  side: 'head' | 'tail',
  maxBytes: number,
): Promise<string | undefined> {
  if (side === 'head') return readUtf8Prefix(path, maxBytes).catch(() => undefined);
  return readUtf8Tail(path, maxBytes)
    .then(({ text }) => text)
    .catch(() => undefined);
}

async function listSubdirectories(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}

async function listJsonlFiles(dir: string): Promise<{ path: string; mtimeMs: number }[]> {
  const files: { path: string; mtimeMs: number }[] = [];
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const path = join(dir, entry.name);
      files.push({ path, mtimeMs: (await stat(path)).mtimeMs });
    }
  } catch {
    // Foreign stores can change while they are being scanned.
  }
  return files;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
