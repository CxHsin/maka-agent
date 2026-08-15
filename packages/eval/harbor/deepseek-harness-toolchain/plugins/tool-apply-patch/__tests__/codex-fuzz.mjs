// Random envelopes, applied by the real `apply_patch` and by this tool.
//
// codex-fixtures.json pins the cases someone thought to write down. This is for
// the ones nobody did: it generates envelopes from random line soup — valid
// hunks, near-miss context, stray markers, misplaced prefixes — and reports
// every input the two disagree on. A divergence found here belongs in
// codex-oracle.mjs as a named case, so that the fixtures keep catching it
// without a `codex` on PATH.
//
// Not a `.test.mjs` file: it needs the binary, and it is a search rather than
// an assertion. Run it from this directory:
//
//   node codex-fuzz.mjs [iterations] [seed]
//
// Every envelope names each path at most once, because the binary composes an
// envelope's operations sequentially and this tool verifies the whole envelope
// first — a difference codex-fixtures.test.mjs covers deliberately and this
// would only rediscover. Where the binary refused, only the refusal is
// compared and not the tree, for the same reason: it writes as it goes and
// stops at the failure, and this writes nothing.

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { harness } from './test-harness.mjs';

const run = promisify(execFile);

const iterations = Number(process.argv[2] ?? 200);
let seed = Number(process.argv[3] ?? 1);
const random = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = (list) => list[Math.floor(random() * list.length)];
const upTo = (n) => Math.floor(random() * n);

// Deliberately awkward: trailing whitespace, tabs, empty lines, typographic
// punctuation and repeated lines are what the four matching passes and the
// trailing-newline rules turn on.
const LINES = [
  'alpha',
  'beta',
  '  indented',
  '\ttabbed',
  'trailing   ',
  '',
  'def f():',
  'class A:',
  'say "hi"',
  'say “hi”',
  'a b',
  'a b',
  'range 1-10',
  'range 1–10',
  'x',
  'x',
  '}',
  '# comment',
];

const randomFile = () => {
  const lines = Array.from({ length: 1 + upTo(8) }, () => pick(LINES));
  // A file without a final newline is the case the trailing-empty-element rules
  // exist for, so it has to occur often enough to be hit.
  return random() < 0.15 ? lines.join('\n') : `${lines.join('\n')}\n`;
};

// A line the model half-remembered. Drawing context verbatim from the file only
// ever exercises the first matching pass; deleting the punctuation pass went
// unnoticed through 400 envelopes until this was added.
function nearMiss(line) {
  const roll = random();
  if (roll < 0.5) return line;
  if (roll < 0.65) return line.trimEnd();
  if (roll < 0.75) return line.trim();
  return [...line]
    .map(
      (character) =>
        ({ '“': '"', '”': '"', '‘': "'", '’': "'", '–': '-', ' ': ' ' })[character] ?? character,
    )
    .join('');
}

function randomHunkBody(fileLines) {
  const body = [];
  for (let i = 0; i < 1 + upTo(5); i += 1) {
    const roll = random();
    if (roll < 0.35) body.push(` ${nearMiss(pick(fileLines))}`);
    else if (roll < 0.6) body.push(`-${nearMiss(pick(fileLines))}`);
    else if (roll < 0.85) body.push(`+${pick(LINES)}`);
    else body.push(pick(['', '@@', '@@ anchor', '*** End of File', 'bare', '  ', '+', '-']));
  }
  return body;
}

function randomPatch(files) {
  const unclaimed = Object.keys(files);
  const body = [];
  for (let section = 0; section < 1 + upTo(3); section += 1) {
    const roll = random();
    if (roll < 0.2 || unclaimed.length === 0) {
      body.push(`*** Add File: new${section}.txt`);
      for (let i = 0; i < upTo(4); i += 1) body.push(`+${pick(LINES)}`);
      continue;
    }
    const path = unclaimed.splice(upTo(unclaimed.length), 1)[0];
    if (roll < 0.3) {
      body.push(`*** Delete File: ${path}`);
      continue;
    }
    body.push(`*** Update File: ${path}`);
    if (random() < 0.15) body.push(`*** Move to: moved${section}.txt`);
    const fileLines = files[path].split('\n');
    for (let chunk = 0; chunk < 1 + upTo(2); chunk += 1) {
      body.push(random() < 0.4 ? `@@ ${pick(fileLines)}` : '@@');
      body.push(...randomHunkBody(fileLines));
    }
  }
  return ['*** Begin Patch', ...body, '*** End Patch', ''].join('\n');
}

// Codex's multitool dispatches to the standalone applier on argv[0].
const binary = join(await mkdtemp(join(tmpdir(), 'codex-argv0-')), 'apply_patch');
const { stdout: which } = await run('sh', ['-c', 'command -v codex']);
await run('ln', ['-s', which.trim(), binary]);

async function oracle(files, patch) {
  const root = await mkdtemp(join(tmpdir(), 'codex-fuzz-'));
  try {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    try {
      const { stdout } = await run(binary, [patch], { cwd: root, encoding: 'utf8' });
      return { refused: false, output: stdout.trimEnd(), tree: await treeOf(root) };
    } catch (error) {
      return { refused: true, output: (error.stderr ?? '').trim() };
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function treeOf(root) {
  const out = {};
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else out[relative(root, path)] = await readFile(path, 'utf8');
    }
  };
  await walk(root);
  return out;
}

let divergences = 0;
for (let i = 0; i < iterations; i += 1) {
  const files = {};
  for (let f = 0; f < 1 + upTo(3); f += 1) files[`f${f}.txt`] = randomFile();
  const patch = randomPatch(files);

  const expected = await oracle(files, patch);
  const mounted = await harness({ files });
  let actual;
  try {
    actual = { refused: false, output: await mounted.run(patch), tree: await mounted.tree() };
  } catch (error) {
    actual = { refused: true, output: error.message };
  }

  const problems = [];
  if (expected.refused !== actual.refused) {
    problems.push(`oracle ${expected.refused ? 'refused' : 'applied'}, tool did not`);
  } else if (!expected.refused) {
    if (expected.output !== actual.output) {
      problems.push(
        `summary: ${JSON.stringify(expected.output)} vs ${JSON.stringify(actual.output)}`,
      );
    }
    if (JSON.stringify(expected.tree) !== JSON.stringify(actual.tree)) {
      problems.push(`tree: ${JSON.stringify(expected.tree)} vs ${JSON.stringify(actual.tree)}`);
    }
  }

  if (problems.length > 0) {
    divergences += 1;
    console.log(`--- divergence #${i} (seed ${process.argv[3] ?? 1}) ---`);
    console.log(`files: ${JSON.stringify(files)}`);
    console.log(`patch:\n${patch}`);
    for (const problem of problems) console.log(`  ${problem}`);
    console.log(`  oracle said: ${expected.output}`);
    console.log(`  tool   said: ${actual.output}`);
  }
  await rm(mounted.root, { recursive: true, force: true });
}

console.log(`${iterations} envelopes, ${divergences} divergences`);
process.exit(divergences === 0 ? 0 : 1);
