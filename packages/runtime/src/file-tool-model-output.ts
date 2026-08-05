import type { ToolResultOutput } from './model-protocol.js';
import { toolResultOutput } from './tool-result-output.js';

/**
 * The diff is for the reader; the model is owed only what happened — a bounded
 * one-line summary. Editing is the hottest tool in the loop, so anything
 * attached to its output compounds across a turn; the full diff stays in the
 * durable result where the UI renders it.
 */
export function fileWriteToolResultToModelOutput(
  toolName: 'Write' | 'Edit' | 'FormatJson',
  output: unknown,
): ToolResultOutput {
  if (isFileDiff(output)) {
    const path = output.paths[0] ?? 'file';
    const { additions, deletions } = diffLineStats(output.diff);
    if (toolName === 'Write' && output.diff.startsWith('--- /dev/null'))
      return { type: 'text', value: `Created ${path} (+${additions})` };
    const verb = toolName === 'Write' ? 'Overwrote' : toolName === 'Edit' ? 'Edited' : 'Formatted';
    return { type: 'text', value: `${verb} ${path} (+${additions} -${deletions})` };
  }
  if (isFileWrite(output))
    return { type: 'text', value: `Wrote ${output.bytes} bytes to ${output.path}` };
  return toolResultOutput(output, false);
}

function isFileDiff(output: unknown): output is { kind: 'file_diff'; paths: string[]; diff: string } {
  return (
    typeof output === 'object' &&
    output !== null &&
    (output as { kind?: unknown }).kind === 'file_diff' &&
    Array.isArray((output as { paths?: unknown }).paths) &&
    typeof (output as { diff?: unknown }).diff === 'string'
  );
}

function isFileWrite(output: unknown): output is { kind: 'file_write'; path: string; bytes: number } {
  return (
    typeof output === 'object' &&
    output !== null &&
    (output as { kind?: unknown }).kind === 'file_write' &&
    typeof (output as { bytes?: unknown }).bytes === 'number'
  );
}

function diffLineStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}
