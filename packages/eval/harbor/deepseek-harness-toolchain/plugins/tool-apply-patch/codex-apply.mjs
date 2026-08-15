// Applying one file's update chunks, ported from Codex.
//
// This replaces a vendored copy of the OpenAI Agents SDK's `applyDiff`, which
// was used here on the assumption that one V4A implementation is like another.
// It is not: the SDK wrote its own, and the two disagree on where a
// context-free `+` hunk lands, whether an updated file gains a trailing
// newline, how CRLF is treated, and how far a near-miss context line may drift
// before it is rejected. An arm that exists to measure Codex's contract cannot
// be running someone else's implementation of it, so this is a direct port of
// the reference rather than an equivalent-looking rewrite.
//
// Source: openai/codex at a7edf37cb46b5fc4d50bd03df8e5999a86f602eb, Apache-2.0
// (see ../NOTICE).
//   codex-rs/apply-patch/src/seek_sequence.rs — `seek_sequence`
//   codex-rs/apply-patch/src/file_update.rs   — `derive_new_contents_from_chunks`,
//                                               `compute_replacements`,
//                                               `apply_replacements`
//
// Checked against the released binary rather than against a reading of the
// Rust: codex-fixtures.json records what `codex` itself did to a tree for each
// case in codex-oracle.mjs, and codex-fixtures.test.mjs replays them.
//
// Only the `NormalizeToLf` update mode is ported, which is what a shipped Codex
// uses. It is the `#[default]` for `ApplyPatchFileUpdateMode`; the function tool
// selects `PreserveLineEndings` from `Feature::ApplyPatchPreserveLineEndings`,
// which the feature registry declares `Stage::UnderDevelopment,
// default_enabled: false`, and the standalone binary selects it from an
// environment variable. That mode is the reason the upstream functions carry
// `context_line_indices`; nothing here needs it, so chunks do not record it.
// Upstream's two line-ending scenarios are run under it and are named as
// divergences in __tests__/upstream-scenarios.test.mjs.

/**
 * Find `pattern` within `lines` at or after `start`, in four passes of
 * decreasing strictness.
 *
 * The passes are the whole point: a model writes context from memory, and
 * upstream would rather place a hunk that differs in trailing whitespace than
 * refuse it. The fourth pass folds typographic punctuation to ASCII, so a diff
 * written with plain quotes still applies to a file containing curly ones.
 */
export function seekSequence(lines, pattern, start, eof) {
  if (pattern.length === 0) return start;
  // A pattern longer than the file cannot match, and the loops below would
  // otherwise read past the end.
  if (pattern.length > lines.length) return undefined;

  // `is_end_of_file` means the hunk claimed to sit at the end, so the search
  // starts there and falls back to a full scan through the passes below.
  const searchStart = eof && lines.length >= pattern.length ? lines.length - pattern.length : start;
  const last = lines.length - pattern.length;

  // Each pass compares a projection of the line against the same projection of
  // the pattern, so it is applied once per string rather than once per
  // candidate position. Comparing on the fly recomputed `normalise` for every
  // (position, pattern line) pair, which on a large file and a long hunk is
  // quadratic in the file's length for no change in what matches.
  for (const project of [exact, trimEnd, trimBoth, normalise]) {
    const haystack = project === exact ? lines : lines.map(project);
    const needle = project === exact ? pattern : pattern.map(project);
    for (let i = searchStart; i <= last; i += 1) {
      let ok = true;
      for (let p = 0; p < needle.length; p += 1) {
        if (haystack[i + p] !== needle[p]) {
          ok = false;
          break;
        }
      }
      if (ok) return i;
    }
  }
  return undefined;
}

const exact = (line) => line;
const trimEnd = (line) => line.trimEnd();
const trimBoth = (line) => line.trim();

// The same code points upstream folds, in the same directions.
const PUNCTUATION = new Map([
  ...['‐', '‑', '‒', '–', '—', '―', '−'].map((c) => [c, '-']),
  ...['‘', '’', '‚', '‛'].map((c) => [c, "'"]),
  ...['“', '”', '„', '‟'].map((c) => [c, '"']),
  ...[' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', '　'].map((c) => [c, ' ']),
]);

function normalise(text) {
  let out = '';
  for (const character of text.trim()) out += PUNCTUATION.get(character) ?? character;
  return out;
}

// The one failure a model can act on: the lines it named are not in the file.
// Distinguished from every other throw so the caller can translate it into the
// harness's vocabulary without also relabelling a bug in this file as the
// model's mistake.
export class ContextNotFound extends Error {}

/**
 * The new contents of one file after its chunks are applied.
 *
 * @param {string} original - the file as it is on disk.
 * @param {Array<{changeContext?: string, oldLines: string[], newLines: string[], isEndOfFile: boolean}>} chunks
 * @param {string} path - named only so a failure says which file it was.
 * @returns {string}
 * @throws {ContextNotFound} when a chunk's context cannot be located. Every other
 *   throw from here is a defect in this file and is not translated by the caller.
 */
export function deriveNewContents(original, chunks, path) {
  const originalLines = original.split('\n');
  // Drop the empty element the final newline produces, so line counts match
  // what `diff` would report.
  if (originalLines.at(-1) === '') originalLines.pop();

  const replacements = computeReplacements(originalLines, path, chunks);
  const newLines = applyReplacements(originalLines, replacements);
  // Every updated file ends in a newline. This is what `NormalizeToLf` means,
  // and it applies whether or not the original had one.
  if (newLines.at(-1) !== '') newLines.push('');
  return newLines.join('\n');
}

function computeReplacements(originalLines, path, chunks) {
  const replacements = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.changeContext !== undefined) {
      const found = seekSequence(originalLines, [chunk.changeContext], lineIndex, false);
      if (found === undefined) {
        throw new ContextNotFound(`Failed to find context '${chunk.changeContext}' in ${path}`);
      }
      lineIndex = found + 1;
    }

    if (chunk.oldLines.length === 0) {
      // A chunk that only adds lines is placed at the end of the file, and the
      // `@@` context located just above is deliberately not used. This looks
      // like a bug and is the reference's behaviour: `insertion_idx` is set
      // from `original_lines.len()` without consulting `line_index`. The tool
      // description teaches anchor-plus-`+` hunks, so this is a routine path,
      // and putting the insertion at the anchor instead — which is what the
      // SDK applier did — silently produces a different file.
      const insertionIndex =
        originalLines.at(-1) === '' ? originalLines.length - 1 : originalLines.length;
      replacements.push([insertionIndex, 0, chunk.newLines]);
      continue;
    }

    // The last element of `old_lines` is often an empty string standing for the
    // newline that terminates the region. The file's own line list has no such
    // element, so a pattern ending in one is retried without it.
    let pattern = chunk.oldLines;
    let replacement = chunk.newLines;
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);

    if (found === undefined && pattern.at(-1) === '') {
      pattern = pattern.slice(0, -1);
      if (replacement.at(-1) === '') replacement = replacement.slice(0, -1);
      found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
    }

    if (found === undefined) {
      throw new ContextNotFound(
        `Failed to find expected lines in ${path}:\n${chunk.oldLines.join('\n')}`,
      );
    }
    replacements.push([found, pattern.length, replacement]);
    lineIndex = found + pattern.length;
  }

  replacements.sort(([a], [b]) => a - b);
  return replacements;
}

// Spread into `splice`, a segment longer than the engine's argument limit — a
// model rewriting a large generated file — throws a `RangeError` instead of
// applying, so it goes in in bounded batches.
const SPLICE_BATCH = 8192;

function applyReplacements(lines, replacements) {
  const out = [...lines];
  // Descending, so an earlier replacement does not shift a later one's index.
  //
  // Splicing in place rather than rebuilding forward is not an implementation
  // detail. `computeReplacements` places a context-free insertion at the end of
  // the file without consulting the search position, so it can land inside a
  // range a later chunk replaces — and then the descending order is what makes
  // the replacement swallow it. A forward rebuild treats the two as disjoint
  // and keeps the insertion; a differential fuzz round against the reference
  // binary is what caught the difference.
  for (const [start, oldLength, segment] of [...replacements].reverse()) {
    out.splice(start, oldLength);
    for (let i = 0; i < segment.length; i += SPLICE_BATCH) {
      out.splice(start + i, 0, ...segment.slice(i, i + SPLICE_BATCH));
    }
  }
  return out;
}
