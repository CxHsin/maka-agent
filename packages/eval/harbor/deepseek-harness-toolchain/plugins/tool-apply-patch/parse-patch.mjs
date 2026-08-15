// The V4A patch envelope: `*** Begin Patch` … `*** End Patch` split into the
// file operations inside it.
//
// The envelope is all this module knows. What a hunk means — which lines are
// context, where they match, how much fuzz to tolerate — belongs to the
// vendored applier, and each file section's body is handed to it as written.
// Parsing hunks here as well would make two things responsible for the same
// grammar, and they would drift on exactly the inputs that are hard to get
// right.
//
// The grammar is Codex's, transcribed from the lark definition it hands models
// as a freeform-tool constraint:
//
//   start:        begin_patch hunk+ end_patch
//   hunk:         add_hunk | delete_hunk | update_hunk
//   add_hunk:     "*** Add File: " filename LF add_line+
//   delete_hunk:  "*** Delete File: " filename LF
//   update_hunk:  "*** Update File: " filename LF change_move? change?
//   change_move:  "*** Move to: " filename LF
//
// Source: openai/codex, codex-rs/core/src/tools/handlers/apply_patch.lark,
//   Apache-2.0 (see ../NOTICE).
//
// Operation shape follows the OpenAI Agents SDK's `ApplyPatchOperation`
// (`create_file` / `update_file` / `delete_file`, each carrying the section
// body as `diff`), because the vendored applier is that SDK's and its own
// callers pass it exactly these three shapes.

const BEGIN_PATCH = '*** Begin Patch';
const END_PATCH = '*** End Patch';
const ADD_FILE = '*** Add File: ';
const DELETE_FILE = '*** Delete File: ';
const UPDATE_FILE = '*** Update File: ';
const MOVE_TO = '*** Move to: ';

// `*** End of File` is deliberately absent: it is a marker the applier reads
// inside a section body, not a boundary between sections. Treating it as one
// would cut the body off before the applier ever saw the anchor it names.
const SECTION_HEADERS = [ADD_FILE, DELETE_FILE, UPDATE_FILE];

// How much whitespace a marker line may carry. Codex distinguishes the two,
// and the distinction is load-bearing rather than incidental: at the top level
// and inside an `*** Add File:` body it compares `line.trim()`
// (streaming_parser.rs:161, :186), so an indented envelope still parses; inside
// an `*** Update File:` body it compares `line.trim_end()` (:216), so a context
// line that happens to read `    *** Update File: x` stays content instead of
// silently ending the section. Matching both is what lets this arm accept the
// patches the reference accepts without inventing a new way to be wrong.
const marker = (line) => line?.trim();
const bodyMarker = (line) => line?.trimEnd();

/**
 * Split a V4A patch envelope into its file operations.
 *
 * @param {string} text - the patch as the model wrote it.
 * @returns {Array<{type: 'create_file'|'update_file'|'delete_file', path: string, movePath?: string, diff?: string}>}
 * @throws {SyntaxError} when the envelope does not parse. The message names the
 *   offending line, because the model's next attempt is what has to be fixed.
 */
export function parsePatch(text) {
  const lines = normalize(text);
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
    const path = filename(line.slice(header.length), header);
    index += 1;

    if (header === DELETE_FILE) {
      operations.push({ type: 'delete_file', path });
      continue;
    }

    // Only Update File may be followed by a rename, and only immediately: the
    // grammar puts `change_move?` before the hunks, so a `*** Move to:` further
    // down is a line inside a hunk body and not a rename at all.
    let movePath;
    if (header === UPDATE_FILE && bodyMarker(lines[index])?.startsWith(MOVE_TO)) {
      movePath = filename(bodyMarker(lines[index]).slice(MOVE_TO.length), MOVE_TO);
      index += 1;
    }

    const inBody = header === ADD_FILE ? marker : bodyMarker;
    const start = index;
    while (index < lines.length && !isBoundary(inBody(lines[index]))) index += 1;
    const body = lines.slice(start, index);

    if (header === ADD_FILE) {
      // `add_line+` — a create with no body would write nothing while reporting
      // that it created the file.
      if (body.length === 0) {
        throw new SyntaxError(`\`${ADD_FILE.trim()} ${path}\` has no content lines`);
      }
      // Codex terminates every added line, `contents.push_str(line);
      // contents.push('\n')` (streaming_parser.rs:204-207), so a created file
      // always ends in a newline. The vendored applier joins its `+` lines
      // instead and would leave the last one unterminated, so it is handed one
      // more empty added line to terminate. Getting this wrong is invisible
      // until a grader diffs the file or a linter reports W292 — and it would
      // be charged to the edit contract rather than to this parser.
      operations.push({ type: 'create_file', path, diff: [...body, '+'].join('\n') });
      continue;
    }

    // Codex rejects an update whose chunk list is empty whatever else the
    // section carries, `ensure_update_hunk_is_not_empty` (streaming_parser.rs:55-64),
    // and it checks before it looks at `move_path`. So a bare rename is not a
    // patch here either: the model renames with the shell, which all three arms
    // have on equal terms.
    if (body.length === 0) {
      throw new SyntaxError(`\`${UPDATE_FILE.trim()} ${path}\` has no hunks`);
    }
    operations.push({
      type: 'update_file',
      path,
      ...(movePath === undefined ? {} : { movePath }),
      diff: body.join('\n'),
    });
  }

  if (marker(lines[index]) !== END_PATCH) {
    throw new SyntaxError(`patch must end with \`${END_PATCH}\``);
  }
  // Codex requires the trimmed patch to end there, `parser.rs:255-270`. Letting
  // a second envelope or a trailing sentence through would report success over
  // operations that were parsed away and never applied.
  if (index !== lines.length - 1) {
    throw new SyntaxError(
      `\`${END_PATCH}\` must be the last line, got: ${describe(lines[index + 1])}`,
    );
  }
  // `hunk+`: an empty envelope parses cleanly and would report success over an
  // edit that never happened.
  if (operations.length === 0) throw new SyntaxError('patch contains no file operations');
  return operations;
}

function isBoundary(line) {
  return line === END_PATCH || SECTION_HEADERS.some((header) => line.startsWith(header));
}

// The `*** Move to:` line is read with `bodyMarker` above rather than `marker`
// for the same reason Codex reads it off `update_line` (streaming_parser.rs:227):
// it is already inside the update body, where a leading space belongs to the
// content.

// `filename: /(.+)/` — non-empty, and the rest of the line verbatim, so a path
// containing spaces needs no quoting. Whether the path is allowed is not
// decided here: the mounted sandbox policy owns that, and a second opinion in
// this module could only disagree with it.
function filename(rest, header) {
  const path = rest.trim();
  if (path.length === 0) throw new SyntaxError(`\`${header.trim()}\` needs a path`);
  return path;
}

// A model that emits CRLF, or wraps the envelope in blank lines, wrote a
// well-formed patch; neither is worth a refusal the model cannot act on. Codex
// trims the whole patch before parsing it (`parser.rs:194`), which is what makes
// a leading newline — the most common way a model formats a long string
// argument — parse rather than fail on the first line.
function normalize(text) {
  return text
    .trim()
    .split('\n')
    .map((line) => line.replace(/\r$/u, ''));
}

function describe(line) {
  return line === undefined ? 'end of input' : `\`${line}\``;
}
