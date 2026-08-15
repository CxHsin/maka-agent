// Model-facing `apply_patch` over the Harness filesystem seam.
//
// The third edit contract in the Eval arm set. `str_replace_editor` gives the
// model one tool with four commands and a unique-literal match;
// `@deepseek-ai/dsh-tool-fs` gives it read/write/edit with snake_case
// arguments; this gives it one tool that takes a V4A patch envelope and locates
// each change by surrounding context. Every arm mounts the same
// `dsh-fs-local` provider underneath, so the file operations are identical and
// the contract is the variable.
//
// Composed exactly like the other two — `inject: ['tools', 'fs']`, one
// `ctx.tools.register(defineTool(...))` — because a difference in how the tool
// reaches the filesystem would be a second variable.
//
// Sources, both recorded in ../NOTICE:
//   - The patch grammar and the model-facing description are Codex's.
//   - Applying one file's hunks is the OpenAI Agents SDK's `applyDiff`,
//     vendored under vendor/.
//
// The whole grammar is implemented, `*** Delete File:` and `*** Move to:`
// included. Those two are the only operations `ctx.fs` has no primitive for —
// it offers read, write and edit and nothing else — so they run against
// `ctx.fs.processPath(target)`, the path the provider itself publishes as
// "where this file really is, for something outside me to open". Refusing them
// instead was the first thing tried and it was wrong: the point of this arm is
// to measure Codex's contract, and a patch tool that cannot delete or rename is
// not that contract. A model trained on the real one would spend turns
// discovering the difference.
//
// The narrow exception is a provider that confines. `processPath` would then be
// the one way around the sandbox, so both operations refuse up front rather
// than escape quietly. The Eval arm mounts `dsh-sandbox-local` at
// `danger-full-access`, where nothing is confined and the model's own bash can
// already remove any file, so the refusal never fires there.
//
// Operations are applied in order, each one reading the tree the previous one
// left. That is Codex's semantics, and the reason it is worth stating is that
// the obvious improvement on it is wrong here: planning the whole envelope
// against one snapshot and writing afterwards makes a failed hunk cost nothing,
// but it also makes two sections naming one path contradict each other, and it
// gives this arm a recovery the reference does not have. Fidelity is the whole
// value of the arm, in both directions.

import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { FsError } from '@deepseek-ai/dsh-fs';
import { sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { parsePatch } from './parse-patch.mjs';
import { applyDiff } from './vendor/apply-diff.mjs';

// Codex's own `apply_patch` tool instructions, carried across so the model gets
// the text the contract is actually deployed with rather than a paraphrase.
// From openai/codex, codex-rs/apply-patch/apply_patch_tool_instructions.md at
// commit 88c7a4ff074df9e2161c947ca6d91bf824b9d6e6 (Apache-2.0).
//
// Four differences from upstream, and no others — the full list is in
// ../NOTICE, which is where a licence reader will look:
//   1. the `## apply_patch` heading and its blank line are gone;
//   2. "shell command" reads "tool", this being a function tool taking one
//      `input` string;
//   3. the trailing `shell {"command":[...]}` example is gone, same reason;
//   4. non-ASCII punctuation is flattened to ASCII on three lines.
//
// Every operation the grammar defines is implemented, so nothing in this text
// describes something the tool will refuse.
const DESCRIPTION = `
Use the \`apply_patch\` tool to edit files.
Your patch language is a stripped-down, file-oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high-level envelope:

*** Begin Patch
[ one or more file sections ]
*** End Patch

Within that envelope, you get a sequence of file operations.
You MUST include a header to specify the action you are taking.
Each operation starts with one of three headers:

*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).
*** Delete File: <path> - remove an existing file. Nothing follows.
*** Update File: <path> - patch an existing file in place (optionally with a rename).

May be immediately followed by *** Move to: <new path> if you want to rename the file.
Then one or more "hunks", each introduced by @@ (optionally followed by a hunk header).
Within a hunk each line starts with:

For instructions on [context_before] and [context_after]:
- By default, show 3 lines of code immediately above and 3 lines immediately below each change. If a change is within 3 lines of a previous change, do NOT duplicate the first change's [context_after] lines in the second change's [context_before] lines.
- If 3 lines of context is insufficient to uniquely identify the snippet of code within the file, use the @@ operator to indicate the class or function to which the snippet belongs. For instance, we might have:
@@ class BaseClass
[3 lines of pre-context]
- [old_code]
+ [new_code]
[3 lines of post-context]

- If a code block is repeated so many times in a class or function such that even a single \`@@\` statement and 3 lines of context cannot uniquely identify the snippet of code, you can use multiple \`@@\` statements to jump to the right context. For instance:

@@ class BaseClass
@@ 	 def method():
[3 lines of pre-context]
- [old_code]
+ [new_code]
[3 lines of post-context]

The full grammar definition is below:
Patch := Begin { FileOp } End
Begin := "*** Begin Patch" NEWLINE
End := "*** End Patch" NEWLINE
FileOp := AddFile | DeleteFile | UpdateFile
AddFile := "*** Add File: " path NEWLINE { "+" line NEWLINE }
DeleteFile := "*** Delete File: " path NEWLINE
UpdateFile := "*** Update File: " path NEWLINE [ MoveTo ] { Hunk }
MoveTo := "*** Move to: " newPath NEWLINE
Hunk := "@@" [ header ] NEWLINE { HunkLine } [ "*** End of File" NEWLINE ]
HunkLine := (" " | "-" | "+") text NEWLINE

A full patch can combine several operations:

*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch

It is important to remember:

- You must include a header with your intended action (Add/Delete/Update)
- You must prefix new lines with \`+\` even when creating a new file
- File references can only be relative, NEVER ABSOLUTE.
`.trim();

// Lifted from `@deepseek-ai/dsh-tool-str-replace-editor`, which resolves the
// same question the same way: a confining provider needs the shared policy, and
// a denial has to reach the model in the policy's own vocabulary rather than as
// a raw filesystem error.
class MutationPolicy {
  constructor(ctx) {
    // Whether the provider confines. `ctx.fs` has no delete or rename, so those
    // two operations run against `processPath` — the path the provider itself
    // publishes for its execution world. Under a confining provider that would
    // be the one way out of the sandbox, so it is refused instead: a benchmark
    // arm that quietly escapes its own policy is worse than one that cannot
    // rename a file.
    this.confines = ctx.fs.sandboxMode !== undefined;
    this.policy = this.confines ? ctx.get('sandboxPolicy') : undefined;
    if (this.confines && this.policy === undefined) {
      throw new Error(
        'tool-apply-patch: the mounted filesystem confines but ctx.sandboxPolicy is missing',
      );
    }
  }

  requireDirectFilesystem(what) {
    if (this.confines) {
      throw new Error(
        `tool-apply-patch: ${what} is unavailable under a confining filesystem provider`,
      );
    }
  }

  resolve(exec) {
    return this.policy?.resolve({
      ...(exec.agent === undefined ? {} : { session: exec.agent.session }),
    });
  }

  mapError(error, policy) {
    if (!(error instanceof FsError) || error.code !== 'FS_SANDBOX_DENIED') return error;
    return new FsError(sandboxDenialMarker(policy.mode), 'FS_SANDBOX_DENIED', { cause: error });
  }
}

// Codex's patch language is relative-path-only, so a bare `src/app.py` has to
// mean the same directory bash would land in. That is the session's own cwd,
// read the way `@deepseek-ai/dsh-tool-fs` reads it; an absolute path ignores it
// at the provider and is left for the sandbox policy to accept or refuse.
function resolveOptions(exec) {
  const cwd = exec.agent?.session?.header?.cwd;
  return { ...(cwd === undefined ? {} : { cwd }), signal: exec.signal };
}

// Codex applies an envelope one operation at a time: read the file, apply that
// operation's hunks, write it, then look at the next operation
// (`lib.rs:393-460`). Two sections naming one path therefore compose, the second
// reading what the first wrote.
//
// This planned every operation against a single up-front snapshot and wrote
// afterwards, so that a hunk whose context the model guessed at left the tree
// untouched. That is the nicer property and it was still wrong: two updates to
// one file made the second fail against a version the first had already
// replaced, and a delete followed by an update removed the file and then failed,
// leaving neither. Being safer than the reference is not free either — this arm
// exists to measure the reference, and a tool that recovers from failures Codex
// does not recover from moves the score just as surely as one that is worse.
async function applyOperations(ctx, policy, operations, exec) {
  const options = resolveOptions(exec);
  const sandboxPolicy = policy.resolve(exec);
  const applied = [];
  for (const operation of operations) {
    applied.push(await applyOperation(ctx, policy, operation, { options, sandboxPolicy, exec }));
  }
  return applied;
}

async function applyOperation(ctx, policy, operation, run) {
  const { options, exec } = run;
  const target = await ctx.fs.resolve(operation.path, options);
  const info = await ctx.fs.stat(target, exec.signal);

  if (operation.type === 'create_file') {
    // Codex reads whatever is there, records it as overwritten, and writes
    // anyway (`lib.rs:397-406`); it has no already-exists refusal. Refusing was
    // this tool's own invention, and it charged the contract for every patch
    // where a model rewrites a file from scratch.
    ctx.emit('fs/observed', target, observed(info), exec);
    const content = located(operation, () => applyDiff('', operation.diff, 'create'));
    await writeTarget(ctx, policy, { target, content, info }, run);
    return `A ${operation.path}`;
  }

  if (info === undefined) {
    ctx.emit('fs/observed', target, { kind: 'absent' }, exec);
    throw new FsError(
      `Cannot ${operation.type === 'delete_file' ? 'delete' : 'update'} ${operation.path}: it does not exist.`,
      'FS_NOT_FOUND',
    );
  }
  if (info.type !== 'file') {
    throw new FsError(`${operation.path} is not a regular file`, 'FS_NOT_REGULAR_FILE');
  }
  ctx.emit('fs/observed', target, observed(info), exec);

  if (operation.type === 'delete_file') {
    policy.requireDirectFilesystem('`*** Delete File:`');
    await removeFile(ctx, target);
    ctx.emit('fs/observed', target, { kind: 'absent' }, exec);
    return `D ${operation.path}`;
  }

  const before = await ctx.fs.readText(target, exec.signal);
  const content = located(operation, () => applyDiff(before, operation.diff));

  if (operation.movePath === undefined) {
    await writeTarget(ctx, policy, { target, content, info }, run);
    return `M ${operation.path}`;
  }

  policy.requireDirectFilesystem('`*** Move to:`');
  const destination = await ctx.fs.resolve(operation.movePath, options);
  if (ctx.fs.contains?.(target, destination) === true) {
    throw new FsError(`Cannot move ${operation.path} onto itself`, 'FS_IO_ERROR');
  }
  // Codex overwrites an existing destination rather than refusing, so the write
  // is unconditional; recording what was there first keeps the observation trail
  // honest about the file that is about to be replaced.
  const destinationInfo = await ctx.fs.stat(destination, exec.signal);
  ctx.emit('fs/observed', destination, observed(destinationInfo), exec);
  // Destination first, source second — the same order Codex applies, so a
  // failure between them leaves the content present twice rather than not at all.
  await writeTarget(ctx, policy, { target: destination, content, unconditional: true }, run);
  await removeFile(ctx, target);
  ctx.emit('fs/observed', target, { kind: 'absent' }, exec);
  return `R ${operation.path} -> ${operation.movePath}`;
}

async function writeTarget(ctx, policy, { target, content, info, unconditional }, run) {
  const { sandboxPolicy, exec } = run;
  const creating = info === undefined;
  const intent = creating
    ? await ctx.waterfall('fs/write-intent', target, exec, () => ({ kind: 'createIfAbsent' }))
    : await ctx.waterfall('fs/edit-intent', target, exec, () => undefined);
  // A move's guard would belong to the source file's version, which the
  // destination does not have.
  const expected = unconditional
    ? undefined
    : (intent ??
      (creating
        ? { kind: 'createIfAbsent' }
        : { kind: 'replaceIfVersion', version: info.version }));

  let outcome;
  try {
    await ensureParent(ctx, policy, target);
    outcome = await ctx.fs.writeText(target, content, expected, exec.signal, sandboxPolicy);
  } catch (error) {
    throw policy.mapError(error, sandboxPolicy);
  }
  ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec);
}

const observed = (info) =>
  info === undefined ? { kind: 'absent' } : { kind: 'present', version: info.version };

// `applyDiff` names the hunk it could not place but not the file it was placing
// it in, and `Invalid Context 0` in a patch that touches four files tells the
// model nothing about which section to rewrite.
function located(operation, run) {
  try {
    return run();
  } catch (error) {
    throw new FsError(`${operation.path}: ${error.message}`, 'FS_IO_ERROR', { cause: error });
  }
}

// `ctx.fs` exposes no delete and no mkdir, so both go through the path the
// provider publishes for its own execution world — the same path its bash tool
// would open. `processPath` exists for exactly this: it is the provider's
// answer to "where is this file, really", rather than a path this tool derived
// on its own.
// The lexical path, not the target key. Codex removes the path the patch named
// — `fs.remove` on `hunk.resolve_path(cwd)`, a plain join — so deleting a
// symlink unlinks the symlink. A provider's target key is realpath-derived
// (`dsh-fs-local` builds it from `realpath(displayPath)`), and removing that
// deletes whatever the link points at while leaving the link behind, dangling.
// `displayPath` is the same string Codex would have used.
function removeFile(ctx, target) {
  return rm(String(target.displayPath ?? ctx.fs.processPath(target)), { force: true });
}

// Codex creates a missing parent rather than refusing the patch, and a model
// adding a module to a package it is also creating relies on it.
//
// Under a confining provider this does nothing at all. `mkdir` on a
// `processPath` is the same way out of the sandbox that delete and rename are
// refused for, and it ran on every write rather than only on the ones that need
// it: a create outside the workspace had its write denied by the provider and
// still left the directory behind. Leaving the parent to the provider is right
// in any case — a provider that confines is the thing that knows whether the
// directory may exist.
function ensureParent(ctx, policy, target) {
  if (policy.confines) return undefined;
  return mkdir(dirname(ctx.fs.processPath(target)), { recursive: true });
}

function presentApplyPatchCall(args) {
  // Reparsing to render is cheap and cannot fail the call: a patch that does
  // not parse is reported by execute, and the card falls back to the raw text.
  let operations;
  try {
    operations = parsePatch(args.input);
  } catch {
    return { card: 'generic', title: 'apply_patch', kind: 'edit' };
  }
  return {
    card: 'generic',
    title: `apply_patch ${operations.map(({ path }) => path).join(' ')}`,
    kind: 'edit',
    locations: operations.map(({ path }) => ({ path })),
  };
}

/** Register the model-facing `apply_patch` tool. */
function registerApplyPatch(ctx, config) {
  const policy = new MutationPolicy(ctx);
  ctx.tools.register(
    defineTool({
      name: 'apply_patch',
      description: config.description,
      parameters: {
        input: {
          type: 'string',
          required: true,
          description:
            'The patch to apply, as one `*** Begin Patch` / `*** End Patch` envelope. Not JSON-wrapped.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const operations = parsePatch(args.input);
        const applied = await applyOperations(ctx, policy, operations, exec);
        return `Applied patch:\n${applied.join('\n')}`;
      },
      presentCall: presentApplyPatchCall,
    }),
  );
}

export const name = 'tool-apply-patch';
export const inject = ['tools', 'fs'];

/** Runtime configuration schema for the V4A patch tool. */
export const Config = z.object({
  description: z.string().default(DESCRIPTION),
});

/** Register one `apply_patch` tool over `ctx.fs`. */
export function apply(ctx, config) {
  const resolved = { description: config?.description ?? DESCRIPTION };
  if (resolved.description.trim().length === 0) {
    throw new Error('tool-apply-patch: description must be non-empty');
  }
  registerApplyPatch(ctx, resolved);
}
