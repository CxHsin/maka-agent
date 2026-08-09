import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function packageManifest(name) {
  return JSON.parse(await readFile(new URL(`../packages/${name}/package.json`, import.meta.url)));
}

test('@maka/core exposes one product API plus one non-overlapping Node adapter', async () => {
  const manifest = await packageManifest('core');
  assert.deepEqual(manifest.exports, {
    '.': './dist/index.js',
    './node': './dist/node.js',
  });
});

test('@maka/runtime keeps product API at root and isolates its test helper', async () => {
  const manifest = await packageManifest('runtime');
  assert.deepEqual(manifest.exports, {
    '.': './dist/index.js',
    './test-only/observation-text-reader': './dist/__tests__/observation-text-reader.js',
  });
});
