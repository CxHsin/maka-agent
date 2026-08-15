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
// Everything the model can observe about the contract comes from Codex, all of
// it recorded in ../NOTICE: the model-facing description, the envelope parser
// (parse-patch.mjs) and the hunk applier (codex-apply.mjs). An earlier version
// used the OpenAI Agents SDK's `applyDiff` for the last of these, on the
// assumption that one V4A implementation is like another; it is not, and the
// differences are exactly the kind this arm measures.
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

import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { FsError } from '@deepseek-ai/dsh-fs';
import { sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { deriveNewContents } from './codex-apply.mjs';
import { parsePatch } from './parse-patch.mjs';

// The model-facing text of this contract, and the whole of it.
//
// It is not transcribed here. `upstream-apply-patch-instructions.md` beside
// this file is a byte-for-byte slice of an upstream artifact — lines 277-351 of
// codex-rs/core/prompt_with_apply_patch_instructions.md at openai/codex
// a7edf37cb46b5fc4d50bd03df8e5999a86f602eb, Apache-2.0 (see ../NOTICE) — and
// the adaptations below are the only thing this repository adds to it. A test
// pins the file's digest and asserts the built description differs from it in
// exactly these substitutions and nowhere else, so the list is checkable rather
// than a claim in a comment.
//
// Why that artifact and not the tool description upstream registers: at this
// commit `create_apply_patch_freeform_tool` registers a 105-character
// description plus `apply_patch.lark` as a grammar the decoder is constrained
// to. A model on that path cannot emit a malformed envelope. `defineTool` has
// no freeform or grammar seam — the harness registers JSON function tools and
// nothing else — so this arm is the unconstrained case, and the file above is
// upstream's own text for exactly that case: what Codex puts in the system
// prompt when apply_patch is reached without a grammar. Taking the freeform
// description instead would give the model 105 characters and no grammar at
// all, which is not Codex's contract minus a feature but a different and much
// weaker one.
//
// That leaves the tool shape as the one deviation this arm cannot remove, and
// it is stated as such in ../../../../README.md rather than papered over.
const DESCRIPTION_SOURCE = 'upstream-apply-patch-instructions.md';

// Each entry is applied exactly once. `why` is the reason the upstream text
// would be false as written here, not a preference.
const DESCRIPTION_ADAPTATIONS = [
  {
    why: 'a tool description is not a section of a document',
    from: '## `apply_patch`\n\n',
    to: '',
  },
  {
    why: 'this is a function tool, not a command on the shell path',
    from: 'Use the `apply_patch` shell command to edit files.',
    to: 'Use the `apply_patch` tool to edit files.',
  },
  {
    // Left in, this would send the model to bash for a binary no arm installs.
    why: 'the shell invocation example describes a delivery this arm does not have',
    from: '\n\nYou can invoke apply_patch like:\n\n```\nshell {"command":["apply_patch","*** Begin Patch\\n*** Add File: hello.txt\\n+Hello, world!\\n*** End Patch\\n"]}\n```',
    to: '',
  },
];

export function buildDescription(upstream) {
  let text = upstream;
  for (const { from, to } of DESCRIPTION_ADAPTATIONS) {
    const at = text.indexOf(from);
    if (at < 0 || text.indexOf(from, at + from.length) >= 0) {
      throw new Error(`tool-apply-patch: description adaptation does not apply exactly once`);
    }
    text = text.slice(0, at) + to + text.slice(at + from.length);
  }
  return text.trim();
}

export const UPSTREAM_DESCRIPTION = await readFile(
  new URL(DESCRIPTION_SOURCE, import.meta.url),
  'utf8',
);
const DESCRIPTION = buildDescription(UPSTREAM_DESCRIPTION);

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

// Two passes over the envelope, which is the shape of Codex's own `apply_patch`
// tool call and not an optimisation of it.
//
// The first is `try_verify_apply_patch_args` (`invocation.rs:214`): every hunk
// is collected into a `HashMap` keyed by its resolved path, each target is read,
// and each update's new contents are computed — all against the pre-patch
// snapshot, all before anything is written. Two consequences the model can
// observe: a second operation on a path is refused outright rather than composed
// onto the first, because the map rejects a duplicate key; and a hunk whose
// context does not match costs nothing, because the failure happens while the
// map is being built.
//
// The second pass throws that result away. `ApplyPatchRuntime::run`
// (`runtimes/apply_patch.rs:176`) hands `req.action.patch` — the raw text the
// model sent — back to `apply_patch_with_mode`, which re-parses it and applies
// it sequentially against the live filesystem; the verified `changes` map is
// carried for approval and telemetry only. So a section reads what the sections
// before it left behind, and the two passes disagree exactly when an operation
// changes what a later one will find.
//
// An earlier version wrote the verified plan instead, on the reasoning that
// having computed the contents once there was no reason to compute them twice.
// That is not a smaller version of this contract, it is a different one, and
// the reference binary shows the difference in two lines: a rename onto a path
// a later section also updates leaves that section failing against the renamed
// file, and `*** Move to:` naming its own source writes the destination and then
// unlinks it, deleting the file and reporting success.
async function applyOperations(ctx, policy, operations, exec) {
  const options = resolveOptions(exec);
  const sandboxPolicy = policy.resolve(exec);
  await verifyOperations(ctx, policy, operations, options, exec);
  return applySequentially(ctx, policy, operations, { options, sandboxPolicy, exec });
}

// Pass one. Reads and computes; writes nothing, and returns nothing but the
// guarantee that it did not throw.
async function verifyOperations(ctx, policy, operations, options, exec) {
  const claimed = new Map();
  for (const operation of operations) {
    const target = await ctx.fs.resolve(operation.path, options);
    // Keyed on the source path alone. Upstream carries `move_path` as a value
    // of the entry, never as a second key (`invocation.rs:232-280`), so a
    // rename onto a path another section also names is not a duplicate here —
    // it is resolved by the order pass two applies in.
    const key = String(ctx.fs.processPath(target));
    const existing = claimed.get(key);
    if (existing !== undefined) {
      throw new FsError(`multiple operations target ${existing}`, 'FS_IO_ERROR');
    }
    claimed.set(key, operation.path);

    const info = await ctx.fs.stat(target, exec.signal);
    if (operation.type === 'add_file') {
      // Codex reads whatever is there, records it as overwritten, and writes
      // anyway (`lib.rs:493-504`); it has no already-exists refusal. Refusing
      // was this tool's own invention, and it charged the contract for every
      // patch where a model rewrites a file from scratch.
      ctx.emit('fs/observed', target, observed(info), exec);
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
    ctx.emit('fs/observed', target, observed(info), exec);

    if (operation.type === 'delete_file') {
      policy.requireDirectFilesystem('`*** Delete File:`');
      continue;
    }
    if (operation.movePath !== undefined) policy.requireDirectFilesystem('`*** Move to:`');

    // Where a mismatched hunk fails, before anything is on disk. The message
    // already names the file and quotes the lines it could not place, which is
    // what the model has to rewrite.
    deriveOrThrow(await ctx.fs.readText(target, exec.signal), operation);
  }
}

// Pass two. Re-resolves, re-reads and re-derives against whatever the sections
// before it left on disk.
async function applySequentially(ctx, policy, operations, run) {
  const { options, exec } = run;
  const affected = { A: [], M: [], D: [] };

  for (const operation of operations) {
    // `ctx.fs.writeText` takes the signal, but `rm` and `mkdir` do not, and a
    // cancelled turn should stop between operations rather than run the rest of
    // the envelope. Upstream is sequential too, so stopping here leaves the same
    // partial state a failed operation would.
    exec.signal?.throwIfAborted();
    const target = await ctx.fs.resolve(operation.path, options);
    const info = await ctx.fs.stat(target, exec.signal);

    if (operation.type === 'add_file') {
      await writeTarget(ctx, policy, { target, content: operation.contents, info }, run);
      affected.A.push(operation.path);
      continue;
    }

    if (info === undefined) {
      throw new FsError(
        `Cannot ${operation.type === 'delete_file' ? 'delete' : 'update'} ${operation.path}: it does not exist.`,
        'FS_NOT_FOUND',
      );
    }
    if (info.type !== 'file') {
      throw new FsError(`${operation.path} is not a regular file`, 'FS_NOT_REGULAR_FILE');
    }

    if (operation.type === 'delete_file') {
      await removeFile(ctx, target);
      ctx.emit('fs/observed', target, { kind: 'absent' }, exec);
      affected.D.push(operation.path);
      continue;
    }

    const content = deriveOrThrow(await ctx.fs.readText(target, exec.signal), operation);
    if (operation.movePath === undefined) {
      await writeTarget(ctx, policy, { target, content, info }, run);
      affected.M.push(operation.path);
      continue;
    }

    const destination = await ctx.fs.resolve(operation.movePath, options);
    // Codex overwrites an existing destination rather than refusing, so the
    // write is unconditional; recording what was there first keeps the
    // observation trail honest about the file about to be replaced.
    ctx.emit(
      'fs/observed',
      destination,
      observed(await ctx.fs.stat(destination, exec.signal)),
      exec,
    );
    // Destination first, source second — the order Codex applies. When the two
    // are the same path that unlinks what was just written, which is upstream's
    // behaviour for `*** Move to:` naming its own source and is reproduced here
    // rather than refused.
    await writeTarget(ctx, policy, { target: destination, content, unconditional: true }, run);
    await removeFile(ctx, target);
    ctx.emit('fs/observed', target, { kind: 'absent' }, exec);
    // A rename is reported as a modification of its destination, the way
    // `AffectedPaths` records it (`lib.rs:634`).
    affected.M.push(operation.movePath);
  }

  // `print_summary` (`lib.rs:766-781`): added, then modified, then deleted.
  return [
    'Success. Updated the following files:',
    ...affected.A.map((path) => `A ${path}`),
    ...affected.M.map((path) => `M ${path}`),
    ...affected.D.map((path) => `D ${path}`),
  ].join('\n');
}

// `deriveNewContents` reports a context miss as a plain Error; the harness
// vocabulary for "the lines you named are not in the file" is `FS_EDIT_NOT_FOUND`
// and only that failure is rewrapped, so a bug in the applier still surfaces as
// itself.
function deriveOrThrow(before, operation) {
  try {
    return deriveNewContents(before, operation.chunks, operation.path);
  } catch (error) {
    throw new FsError(error.message, 'FS_EDIT_NOT_FOUND', { cause: error });
  }
}

async function writeTarget(ctx, policy, { target, content, info, unconditional }, run) {
  const { sandboxPolicy, exec } = run;
  const creating = info === undefined;
  // The two waterfalls do not return the same shape. `fs/write-intent` yields
  // an `FsWriteIntent`, guard and all; `fs/edit-intent` yields `{version}` and
  // no `kind` (`dsh-fs/lib/types/index.d.ts:36-42`), so passing it straight to
  // `writeText` matched neither guard and wrote unconditionally — a decider's
  // version check was accepted and then dropped on the floor.
  const intent = creating
    ? await ctx.waterfall('fs/write-intent', target, exec, () => ({ kind: 'createIfAbsent' }))
    : await ctx
        .waterfall('fs/edit-intent', target, exec, () => undefined)
        .then((edit) =>
          edit === undefined ? undefined : { kind: 'replaceIfVersion', version: edit.version },
        );
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
// `force` stays off: verification already established the file was there, so a
// missing path here means it went away underneath the turn. Codex's `fs.remove`
// reports that; swallowing it would report `D <path>` for a delete that did not
// happen.
function removeFile(ctx, target) {
  return rm(String(target.displayPath ?? ctx.fs.processPath(target)), { force: false });
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
          description: 'The patch to apply, as one `*** Begin Patch` / `*** End Patch` envelope.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const operations = parsePatch(args.input);
        // Returned as Codex writes it (`print_summary`, `lib.rs:766-781`),
        // because the summary is part of the contract the model is scored
        // against: it is how it learns a rename landed as `M <new path>`.
        return applyOperations(ctx, policy, operations, exec);
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
