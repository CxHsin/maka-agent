// The V4A patch envelope, parsed into the operations inside it.
//
// Ported from Codex's own parser rather than written to its grammar. An earlier
// version of this file parsed only the envelope and handed each section's body
// to a vendored applier, on the reasoning that hunk semantics belonged to
// whoever applied them. That was a mistake twice over: the applier was a
// different project's V4A implementation with different semantics, and
// deferring the hunk grammar meant a syntax error in the third section was not
// discovered until the first two had already been written to disk. Codex
// validates every line of every hunk before it touches the filesystem.
//
// Source: openai/codex at a7edf37cb46b5fc4d50bd03df8e5999a86f602eb, Apache-2.0
// (see ../NOTICE).
//   codex-rs/apply-patch/src/streaming_parser.rs — `process_line`, and the
//     `UpdateFile` arm in particular
//   codex-rs/apply-patch/src/parser.rs — the markers and `push_context_line`
//   codex-rs/core/src/tools/handlers/apply_patch.lark — the grammar the model
//     is given:
//
//   start:        begin_patch hunk+ end_patch
//   hunk:         add_hunk | delete_hunk | update_hunk
//   add_hunk:     "*** Add File: " filename LF add_line+
//   delete_hunk:  "*** Delete File: " filename LF
//   update_hunk:  "*** Update File: " filename LF change_move? change?
//   change_move:  "*** Move to: " filename LF
//
// Where the grammar and the implementation disagree, the implementation wins:
// the model is scored against what Codex does, not against what its grammar
// says. `add_line+` is the case that matters — the parser accepts an add hunk
// with no lines at all and creates an empty file.

const BEGIN_PATCH = '*** Begin Patch';
const END_PATCH = '*** End Patch';
const ADD_FILE = '*** Add File: ';
const DELETE_FILE = '*** Delete File: ';
const UPDATE_FILE = '*** Update File: ';
const MOVE_TO = '*** Move to: ';
const EOF_MARKER = '*** End of File';
const CHANGE_CONTEXT = '@@ ';
const EMPTY_CHANGE_CONTEXT = '@@';

const SECTION_HEADERS = [ADD_FILE, DELETE_FILE, UPDATE_FILE];

// How much whitespace a marker line may carry, and the distinction is
// load-bearing. At the top level and inside an add hunk Codex compares
// `line.trim()`, so an indented envelope still parses. Inside an update hunk it
// compares `line.trim_end()`, so a context line that happens to read
// `    *** Update File: x` stays content instead of silently ending the
// section.
const marker = (line) => (line === undefined ? undefined : rustTrim(line));
const bodyMarker = (line) => (line === undefined ? undefined : line.replace(RUST_TRAILING, ''));

// Rust's `str::trim` cuts the Unicode `White_Space` property; JavaScript's cuts
// `WhiteSpace` plus `LineTerminator`. The two agree on everything a patch is
// likely to contain and differ on exactly two code points: U+FEFF, which JS
// strips and Rust does not, and U+0085, which Rust strips and JS does not. The
// first is the one that can happen — a byte-order mark carried into a JSON
// string argument would make a patch parse here and be refused by Codex — so
// the charset is spelled out rather than delegated.
const RUST_SPACE =
  '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const RUST_LEADING = new RegExp(`^[${RUST_SPACE}]+`, 'u');
const RUST_TRAILING = new RegExp(`[${RUST_SPACE}]+$`, 'u');

const rustTrim = (text) => text.replace(RUST_LEADING, '').replace(RUST_TRAILING, '');

/**
 * Split a V4A patch envelope into its file operations.
 *
 * @param {string} text - the patch as the model wrote it.
 * @returns {Array<
 *   | {type: 'add_file', path: string, contents: string}
 *   | {type: 'delete_file', path: string}
 *   | {type: 'update_file', path: string, movePath?: string, chunks: Chunk[]}
 * >}
 * @throws {SyntaxError} when the envelope does not parse. The message names the
 *   offending line, because the model's next attempt is what has to be fixed.
 */
export function parsePatch(text) {
  const lines = stripHeredoc(normalize(text));
  let index = 0;

  if (marker(lines[index]) !== BEGIN_PATCH) {
    throw new SyntaxError(
      `patch must start with \`${BEGIN_PATCH}\`, got: ${describe(lines[index])}`,
    );
  }
  index += 1;

  const operations = [];
  while (index < lines.length && marker(lines[index]) !== END_PATCH) {
    const line = marker(lines[index]);
    const header = SECTION_HEADERS.find((candidate) => line.startsWith(candidate));
    if (header === undefined) {
      throw new SyntaxError(
        `expected a file header (\`${ADD_FILE.trim()}\`, \`${UPDATE_FILE.trim()}\`, or \`${DELETE_FILE.trim()}\`) or \`${END_PATCH}\`, got: ${describe(line)}`,
      );
    }
    // The path is the rest of the line, not trimmed: Codex strips the marker
    // and keeps what follows, so `*** Add File:  x` names a file whose first
    // character is a space.
    const path = line.slice(header.length);
    index += 1;

    if (header === DELETE_FILE) {
      // `delete_hunk` has no body at all — upstream goes straight back to
      // expecting the next header. So a stray line under it is reported as a
      // header the model got wrong, by the loop above, on the next pass.
      operations.push({ type: 'delete_file', path });
      continue;
    }

    // Where this section's body ends. An add body is bounded with `marker` and
    // an update body with `bodyMarker`, matching where each one compares.
    const boundary = header === ADD_FILE ? marker : bodyMarker;
    const start = index;
    while (index < lines.length && !endsSection(lines, index, boundary)) index += 1;
    const body = lines.slice(start, index);

    if (header === ADD_FILE) {
      operations.push({ type: 'add_file', path, contents: addFileContents(body, path) });
      continue;
    }

    operations.push(updateFile(body, path));
  }

  if (marker(lines[index]) !== END_PATCH) {
    throw new SyntaxError(`patch must end with \`${END_PATCH}\``);
  }
  // Codex requires the trimmed patch to end there, allowing only blank lines
  // after. Letting a second envelope or a trailing sentence through would
  // report success over operations that were parsed away and never applied.
  const trailing = lines.slice(index + 1).find((entry) => marker(entry) !== '');
  if (trailing !== undefined) {
    throw new SyntaxError(`\`${END_PATCH}\` must be the last line, got: ${describe(trailing)}`);
  }
  if (operations.length === 0) throw new SyntaxError('patch contains no file operations');
  return operations;
}

// Every line of an add hunk is terminated, `contents.push_str(line);
// contents.push('\n')`, so a created file always ends in a newline — and a hunk
// with no lines creates an empty file rather than being refused. The grammar
// says `add_line+`; the parser does not enforce it, and an empty `__init__.py`
// is a thing models write.
function addFileContents(body, path) {
  let contents = '';
  for (const line of body) {
    if (!line.startsWith('+')) {
      throw new SyntaxError(
        `\`${ADD_FILE.trim()} ${path}\` expects \`+\` lines, got: ${describe(line)}`,
      );
    }
    contents += `${line.slice(1)}\n`;
  }
  return contents;
}

/**
 * @typedef {{changeContext?: string, oldLines: string[], newLines: string[], isEndOfFile: boolean}} Chunk
 */

function updateFile(body, path) {
  let movePath;
  /** @type {Chunk[]} */
  const chunks = [];
  const openChunk = () => {
    if (chunks.length === 0) chunks.push(emptyChunk());
    return chunks.at(-1);
  };
  const blank = (chunk) => chunk.oldLines.length === 0 && chunk.newLines.length === 0;

  for (const raw of body) {
    const line = bodyMarker(raw);

    // Nothing may follow `*** End of File` except another hunk header.
    if (chunks.at(-1)?.isEndOfFile === true) {
      if (line === '') continue;
      if (line !== EMPTY_CHANGE_CONTEXT && !line.startsWith(CHANGE_CONTEXT)) {
        throw new SyntaxError(
          `expected update hunk to start with a @@ context marker, got: ${describe(raw)}`,
        );
      }
    }

    // Only before any hunk, and only once.
    if (chunks.length === 0 && movePath === undefined && line.startsWith(MOVE_TO)) {
      movePath = line.slice(MOVE_TO.length);
      continue;
    }

    const isContextMarker = line === EMPTY_CHANGE_CONTEXT || line.startsWith(CHANGE_CONTEXT);
    if (isContextMarker && chunks.length > 0 && blank(chunks.at(-1))) {
      throw new SyntaxError(
        `unexpected line found in update hunk: ${describe(raw)}. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
      );
    }
    if (line === EMPTY_CHANGE_CONTEXT) {
      chunks.push(emptyChunk());
      continue;
    }
    if (line.startsWith(CHANGE_CONTEXT)) {
      chunks.push({ ...emptyChunk(), changeContext: line.slice(CHANGE_CONTEXT.length) });
      continue;
    }

    if (line === EOF_MARKER) {
      if (chunks.length === 0 || blank(chunks.at(-1))) {
        throw new SyntaxError('update hunk does not contain any lines');
      }
      chunks.at(-1).isEndOfFile = true;
      continue;
    }

    // A context line is pushed to both sides. An empty line is context whose
    // leading space the model dropped, which is common enough that Codex
    // accepts it.
    if (raw === '') {
      pushContext(openChunk(), '');
      continue;
    }
    if (raw.startsWith(' ')) {
      pushContext(openChunk(), raw.slice(1));
      continue;
    }
    if (raw.startsWith('+')) {
      openChunk().newLines.push(raw.slice(1));
      continue;
    }
    if (raw.startsWith('-')) {
      openChunk().oldLines.push(raw.slice(1));
      continue;
    }

    throw new SyntaxError(
      chunks.length > 0 && !blank(chunks.at(-1))
        ? `expected update hunk to start with a @@ context marker, got: ${describe(raw)}`
        : `unexpected line found in update hunk: ${describe(raw)}. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
    );
  }

  // `ensure_update_hunk_is_not_empty`, which Codex runs when a section ends —
  // and it runs before it looks at `move_path`, so a bare rename is not a patch
  // upstream either.
  if (chunks.length === 0) {
    throw new SyntaxError(`\`${UPDATE_FILE.trim()} ${path}\` is empty`);
  }
  if (blank(chunks.at(-1))) {
    throw new SyntaxError('update hunk does not contain any lines');
  }
  return { type: 'update_file', path, ...(movePath === undefined ? {} : { movePath }), chunks };
}

const emptyChunk = () => ({ oldLines: [], newLines: [], isEndOfFile: false });

function pushContext(chunk, line) {
  chunk.oldLines.push(line);
  chunk.newLines.push(line);
}

// A section's body runs to the next header or to `*** End Patch`, compared the
// way that section compares. The last line is the exception: upstream flushes
// whatever is left in its line buffer through `line.trim()` (`finish`), and
// because the whole patch was trimmed first the leftover is always the final
// line. So an indented `*** End Patch` closes an update section — there and
// nowhere else, and an indented header never does.
function endsSection(lines, index, boundary) {
  const line = boundary(lines[index]);
  if (line === END_PATCH || SECTION_HEADERS.some((header) => line.startsWith(header))) return true;
  return index === lines.length - 1 && marker(lines[index]) === END_PATCH;
}

// A patch wrapped in a heredoc is unwrapped rather than refused.
//
// `parse_patch` picks its mode from `PARSE_IN_STRICT_MODE`, which is `false`
// (`parser.rs:53`) — upstream gave up on gating this by model, so every call
// site parses leniently, the function tool included. `ParseMode::Lenient`
// exists because a model asked for a shell invocation may send the heredoc
// itself as the argument, and `check_patch_boundaries_lenient`
// (`parser.rs:229-254`) drops the first and last line when the first is exactly
// one of these three and the last ends in `EOF`, provided there are at least
// four lines and what is left is a well-formed envelope.
//
// Only when the text does not already parse as an envelope: upstream tries the
// strict boundaries first and returns them untouched if they hold, so a patch
// whose own first line happens to read `<<EOF` is never stripped.
const HEREDOC_OPENERS = ['<<EOF', "<<'EOF'", '<<"EOF"'];

function stripHeredoc(lines) {
  if (isEnvelope(lines)) return lines;
  if (lines.length < 4) return lines;
  if (!HEREDOC_OPENERS.includes(lines[0]) || !lines.at(-1).endsWith('EOF')) return lines;
  const inner = lines.slice(1, -1);
  // Not an envelope either: hand back the original so the failure names the
  // line the model wrote rather than one this function invented.
  return isEnvelope(inner) ? inner : lines;
}

const isEnvelope = (lines) =>
  lines.length > 0 && marker(lines[0]) === BEGIN_PATCH && marker(lines.at(-1)) === END_PATCH;

// A model that emits CRLF, or wraps the envelope in blank lines, wrote a
// well-formed patch; neither is worth a refusal it cannot act on. Codex trims
// the whole patch before parsing (`parser.rs`), which is what makes a leading
// newline — the most common way a model formats a long string argument — parse
// rather than fail on the first line.
function normalize(text) {
  return rustTrim(text)
    .split('\n')
    .map((line) => line.replace(/\r$/u, ''));
}

function describe(line) {
  return line === undefined ? 'end of input' : `\`${line}\``;
}
