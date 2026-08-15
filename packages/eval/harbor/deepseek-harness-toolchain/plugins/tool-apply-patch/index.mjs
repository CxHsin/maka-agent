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
// Two deliberate deviations from Codex's contract, described to the model in
// DESCRIPTION below rather than discovered by it:
//
//   1. No `*** Delete File:` and no `*** Move to:`. `ctx.fs` is the Harness's
//      only filesystem authority and it has no delete or rename primitive —
//      neither does any other DSH file tool, so in every arm the model removes
//      and renames files through bash. Reaching around the seam with node:fs
//      here would put a second filesystem authority in one arm only, and it is
//      the arm being measured.
//
//   2. A patch either applies completely or changes nothing. `applyDiff` is a
//      pure function, so every file's new content is computed before the first
//      write. The other two contracts touch one file per call and cannot
//      half-apply; letting this one leave a partly-patched tree would be a
//      difference in failure modes rather than in edit format.

import z from '@deepseek-ai/schemastery';
import { FsError } from '@deepseek-ai/dsh-fs';
import { sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { parsePatch } from './parse-patch.mjs';
import { applyDiff } from './vendor/apply-diff.mjs';

// Codex's own `apply_patch` tool instructions, carried across so the model gets
// the text the contract is actually deployed with rather than a paraphrase.
// Verbatim from openai/codex, codex-rs/apply-patch/apply_patch_tool_instructions.md
// at commit 88c7a4ff074df9e2161c947ca6d91bf824b9d6e6 (Apache-2.0), with three
// changes, all of them removals of things that would be false here: the
// `*** Delete File:` and `*** Move to:` lines, the trailing `shell {...}`
// invocation example (this is a function tool, not a shell command), and the
// grammar's corresponding productions. The closing paragraph names what was
// removed, so the model is told the boundary instead of finding it by failing.
const DESCRIPTION = `
Use the \`apply_patch\` tool to edit files.
Your patch language is a stripped-down, file-oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high-level envelope:

*** Begin Patch
[ one or more file sections ]
*** End Patch

Within that envelope, you get a sequence of file operations.
You MUST include a header to specify the action you are taking.
Each operation starts with one of two headers:

*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).
*** Update File: <path> - patch an existing file in place.

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
FileOp := AddFile | UpdateFile
AddFile := "*** Add File: " path NEWLINE { "+" line NEWLINE }
UpdateFile := "*** Update File: " path NEWLINE { Hunk }
Hunk := "@@" [ header ] NEWLINE { HunkLine } [ "*** End of File" NEWLINE ]
HunkLine := (" " | "-" | "+") text NEWLINE

A full patch can combine several operations:

*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** End Patch

It is important to remember:

- You must include a header with your intended action (Add/Update)
- You must prefix new lines with \`+\` even when creating a new file
- File references can only be relative, NEVER ABSOLUTE.

Deleting and renaming files are not part of this tool; use the shell for those. A patch that fails to apply changes nothing, so no file is left half-edited.
`.trim();

// Lifted from `@deepseek-ai/dsh-tool-str-replace-editor`, which resolves the
// same question the same way: a confining provider needs the shared policy, and
// a denial has to reach the model in the policy's own vocabulary rather than as
// a raw filesystem error.
class MutationPolicy {
  constructor(ctx) {
    this.policy = ctx.fs.sandboxMode === undefined ? undefined : ctx.get('sandboxPolicy');
    if (ctx.fs.sandboxMode !== undefined && this.policy === undefined) {
      throw new Error(
        'tool-apply-patch: the mounted filesystem confines but ctx.sandboxPolicy is missing',
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

// Every operation is turned into the exact bytes it would write, before
// anything is written. A hunk that does not match is the common failure here —
// the model guessed at context it had not read — and it has to fail while the
// tree is still untouched.
async function planOperations(ctx, operations, exec) {
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
        `Cannot update ${operation.path}: it does not exist. Use \`*** Add File:\` to create it.`,
        'FS_NOT_FOUND',
      );
    }
    if (info.type !== 'file') {
      throw new FsError(
        `Cannot update ${operation.path}: not a regular file`,
        'FS_NOT_REGULAR_FILE',
      );
    }
    const before = await ctx.fs.readText(target, exec.signal);
    ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
    planned.push({
      target,
      path: operation.path,
      content: applyDiff(before, operation.diff),
      info,
    });
  }
  return planned;
}

async function writePlan(ctx, policy, planned, exec) {
  const sandboxPolicy = policy.resolve(exec);
  const written = [];
  for (const { target, path, content, info } of planned) {
    const creating = info === undefined;
    const intent = creating
      ? await ctx.waterfall('fs/write-intent', target, exec, () => ({ kind: 'createIfAbsent' }))
      : await ctx.waterfall('fs/edit-intent', target, exec, () => undefined);
    const expected =
      intent === undefined ? { kind: 'replaceIfVersion', version: info.version } : intent;
    let outcome;
    try {
      outcome = await ctx.fs.writeText(target, content, expected, exec.signal, sandboxPolicy);
    } catch (error) {
      throw policy.mapError(error, sandboxPolicy);
    }
    ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec);
    written.push(`${creating ? 'A' : 'M'} ${path}`);
  }
  return written;
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
        // Refused before anything is planned: the grammar accepts these, and a
        // model that sends one has to learn that this deployment does not,
        // rather than see part of its patch applied.
        for (const operation of operations) {
          if (operation.type === 'delete_file') {
            throw new Error(
              `\`*** Delete File: ${operation.path}\` is not supported by this tool; remove the file with the shell instead.`,
            );
          }
          if (operation.movePath !== undefined) {
            throw new Error(
              `\`*** Move to: ${operation.movePath}\` is not supported by this tool; rename the file with the shell instead.`,
            );
          }
        }
        const planned = await planOperations(ctx, operations, exec);
        const written = await writePlan(ctx, policy, planned, exec);
        return `Applied patch:\n${written.join('\n')}`;
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
