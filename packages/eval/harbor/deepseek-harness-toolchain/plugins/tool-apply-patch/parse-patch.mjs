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

  if (lines[index] !== BEGIN_PATCH) {
    throw new SyntaxError(
      `patch must start with \`${BEGIN_PATCH}\`, got: ${describe(lines[index])}`,
    );
  }
  index += 1;

  const operations = [];
  while (index < lines.length && lines[index] !== END_PATCH) {
    const line = lines[index];
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
    if (header === UPDATE_FILE && lines[index]?.startsWith(MOVE_TO)) {
      movePath = filename(lines[index].slice(MOVE_TO.length), MOVE_TO);
      index += 1;
    }

    const start = index;
    while (index < lines.length && !isBoundary(lines[index])) index += 1;
    const diff = lines.slice(start, index).join('\n');

    if (header === ADD_FILE) {
      // `add_line+` — a create with no body would write nothing while reporting
      // that it created the file.
      if (diff.length === 0) {
        throw new SyntaxError(`\`${ADD_FILE.trim()} ${path}\` has no content lines`);
      }
      operations.push({ type: 'create_file', path, diff });
      continue;
    }

    // `change?` is optional in the grammar, but only a rename gives an empty
    // update anything to do.
    if (diff.length === 0 && movePath === undefined) {
      throw new SyntaxError(
        `\`${UPDATE_FILE.trim()} ${path}\` has no hunks and no \`${MOVE_TO.trim()}\``,
      );
    }
    operations.push({
      type: 'update_file',
      path,
      ...(movePath === undefined ? {} : { movePath }),
      ...(diff.length === 0 ? {} : { diff }),
    });
  }

  if (lines[index] !== END_PATCH) {
    throw new SyntaxError(`patch must end with \`${END_PATCH}\``);
  }
  // `hunk+`: an empty envelope parses cleanly and would report success over an
  // edit that never happened.
  if (operations.length === 0) throw new SyntaxError('patch contains no file operations');
  return operations;
}

function isBoundary(line) {
  return line === END_PATCH || SECTION_HEADERS.some((header) => line.startsWith(header));
}

// `filename: /(.+)/` — non-empty, and the rest of the line verbatim, so a path
// containing spaces needs no quoting. Whether the path is allowed is not
// decided here: the mounted sandbox policy owns that, and a second opinion in
// this module could only disagree with it.
function filename(rest, header) {
  const path = rest.trim();
  if (path.length === 0) throw new SyntaxError(`\`${header.trim()}\` needs a path`);
  return path;
}

// A model that emits CRLF, or a trailing newline after `*** End Patch`, wrote a
// well-formed patch; neither is worth a refusal the model cannot act on.
function normalize(text) {
  const lines = text.split('\n').map((line) => line.replace(/\r$/u, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function describe(line) {
  return line === undefined ? 'end of input' : `\`${line}\``;
}
