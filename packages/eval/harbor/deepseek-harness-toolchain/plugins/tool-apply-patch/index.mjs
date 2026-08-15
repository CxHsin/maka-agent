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
// Work is split into a planning pass and a writing pass. Every path is
// resolved, every precondition checked, and every hunk applied — `applyDiff` is
// pure — before the first byte is written, so the common failure, a hunk whose
// context the model guessed at, leaves the tree untouched. Once writing starts
// a patch can still be interrupted part-way; that is also true of Codex, and
// the tool does not claim otherwise to the model.

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
// Verbatim from openai/codex, codex-rs/apply-patch/apply_patch_tool_instructions.md
// at commit 88c7a4ff074df9e2161c947ca6d91bf824b9d6e6 (Apache-2.0), with one
// removal: the trailing `shell {"command":["apply_patch", ...]}` example, which
// would be false here — this is a function tool taking one `input` string, not
// a shell command. Every operation the grammar defines is implemented, so
// nothing else in this text describes something the tool will refuse.
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

// Every operation is resolved, checked, and — where it writes — turned into the
// exact bytes it would write, before anything is touched. A hunk that does not
// match is the common failure here, the model having guessed at context it had
// not read, and it has to fail while the tree is still whole.
async function planOperations(ctx, policy, operations, exec) {
  const options = resolveOptions(exec);
  const planned = [];
  for (const operation of operations) {
    const target = await ctx.fs.resolve(operation.path, options);
    const info = await ctx.fs.stat(target, exec.signal);

    if (operation.type === 'create_file') {
      if (info !== undefined) {
        throw new FsError(
          `Cannot add ${operation.path}: it already exists. Use \`*** Update File:\` instead.`,
          'FS_ALREADY_EXISTS',
        );
      }
      // Absence is recorded whether or not the write later happens: the model
      // observed it, and a policy that gates creation on a prior observation
      // reads this event, not the write.
      ctx.emit('fs/observed', target, { kind: 'absent' }, exec);
      planned.push({
        kind: 'create',
        target,
        path: operation.path,
        content: applyDiff('', operation.diff, 'create'),
        info,
      });
      continue;
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

    if (operation.type === 'delete_file') {
      policy.requireDirectFilesystem('`*** Delete File:`');
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
      planned.push({ kind: 'delete', target, path: operation.path, info });
      continue;
    }

    // A rename with no hunks leaves the content alone, which the grammar allows
    // and `applyDiff` has no way to express — an empty diff is not a no-op to
    // it, it is a parse error.
    const before = await ctx.fs.readText(target, exec.signal);
    ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
    const content = operation.diff === undefined ? before : applyDiff(before, operation.diff);

    if (operation.movePath === undefined) {
      planned.push({ kind: 'update', target, path: operation.path, content, info });
      continue;
    }

    policy.requireDirectFilesystem('`*** Move to:`');
    const destination = await ctx.fs.resolve(operation.movePath, options);
    if (ctx.fs.contains?.(target, destination) === true) {
      throw new FsError(`Cannot move ${operation.path} onto itself`, 'FS_INVALID_TARGET');
    }
    // Codex overwrites an existing destination rather than refusing, so the
    // write is unconditional; recording what was there first keeps the
    // observation trail honest about the file that is about to be replaced.
    const destinationInfo = await ctx.fs.stat(destination, exec.signal);
    ctx.emit(
      'fs/observed',
      destination,
      destinationInfo === undefined
        ? { kind: 'absent' }
        : { kind: 'present', version: destinationInfo.version },
      exec,
    );
    planned.push({
      kind: 'move',
      target,
      path: operation.path,
      content,
      info,
      destination,
      destinationPath: operation.movePath,
    });
  }
  return planned;
}

async function writePlan(ctx, policy, planned, exec) {
  const sandboxPolicy = policy.resolve(exec);
  const applied = [];
  for (const step of planned) {
    if (step.kind === 'delete') {
      await removeFile(ctx, step.target);
      ctx.emit('fs/observed', step.target, { kind: 'absent' }, exec);
      applied.push(`D ${step.path}`);
      continue;
    }

    const creating = step.kind === 'create';
    // A move writes its destination unconditionally: the guard belongs to the
    // source file's version, which the destination does not have.
    const written = step.kind === 'move' ? step.destination : step.target;
    const intent = creating
      ? await ctx.waterfall('fs/write-intent', written, exec, () => ({ kind: 'createIfAbsent' }))
      : await ctx.waterfall('fs/edit-intent', written, exec, () => undefined);
    const expected =
      step.kind === 'move'
        ? undefined
        : intent === undefined
          ? { kind: 'replaceIfVersion', version: step.info.version }
          : intent;

    let outcome;
    try {
      // Codex creates a missing parent rather than refusing the patch, and a
      // model adding a file to a directory it also just created relies on it.
      await ensureParent(ctx, written);
      outcome = await ctx.fs.writeText(written, step.content, expected, exec.signal, sandboxPolicy);
    } catch (error) {
      throw policy.mapError(error, sandboxPolicy);
    }
    ctx.emit('fs/observed', written, { kind: 'present', version: outcome.version }, exec);

    if (step.kind === 'move') {
      // Destination first, source second — the same order Codex applies, so a
      // failure between them leaves the content present twice rather than not
      // at all.
      await removeFile(ctx, step.target);
      ctx.emit('fs/observed', step.target, { kind: 'absent' }, exec);
      applied.push(`R ${step.path} -> ${step.destinationPath}`);
      continue;
    }
    applied.push(`${creating ? 'A' : 'M'} ${step.path}`);
  }
  return applied;
}

// `ctx.fs` exposes no delete and no mkdir, so both go through the path the
// provider publishes for its own execution world — the same path its bash tool
// would open. `processPath` exists for exactly this: it is the provider's
// answer to "where is this file, really", rather than a path this tool derived
// on its own.
function removeFile(ctx, target) {
  return rm(ctx.fs.processPath(target), { force: true });
}

function ensureParent(ctx, target) {
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
        const planned = await planOperations(ctx, policy, operations, exec);
        const applied = await writePlan(ctx, policy, planned, exec);
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
