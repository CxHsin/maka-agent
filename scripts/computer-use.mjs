#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const commands = Object.freeze({
  real: command('cu-real-ax-model-e2e-launcher.mjs'),
  'process-restart': command('cu-real-ax-model-e2e-launcher.mjs', {
    MAKA_CU_AX_MODEL_SCENARIO: 'restart-recovery',
  }),
  'process-restart-soak': command('cu-process-restart-e2e-launcher.mjs'),
  'real-model': command('cu-real-model-launcher.mjs'),
  'real-ax-model': command('cu-real-ax-model-e2e-launcher.mjs'),
  'real-ax-observe': command('cu-real-ax-model-e2e-launcher.mjs', {
    MAKA_CU_AX_MODEL_SCENARIO: 'observe-only',
  }),
  'real-ax-recovery': command('cu-real-ax-model-e2e-launcher.mjs', {
    MAKA_CU_AX_MODEL_SCENARIO: 'intervention-recovery',
  }),
  'real-ax-restart': command('cu-real-ax-model-e2e-launcher.mjs', {
    MAKA_CU_AX_MODEL_SCENARIO: 'restart-recovery',
  }),
  'real-ax-anthropic': command('cu-real-ax-model-e2e-launcher.mjs', {
    MAKA_CU_MODEL_PROVIDER: 'anthropic',
  }),
  'real-ax-anthropic-recovery': command('cu-real-ax-model-e2e-launcher.mjs', {
    MAKA_CU_MODEL_PROVIDER: 'anthropic',
    MAKA_CU_AX_MODEL_SCENARIO: 'intervention-recovery',
  }),
  'real-ax-click': command('cu-real-ax-model-e2e-launcher.mjs', {
    MAKA_CU_AX_MODEL_SCENARIO: 'ax-click',
  }),
  'real-ax-ambiguity': command('cu-real-ax-model-e2e-launcher.mjs', {
    MAKA_CU_AX_MODEL_SCENARIO: 'ambiguity',
  }),
  'real-ax-multi-step': command('cu-real-ax-model-e2e-launcher.mjs', {
    MAKA_CU_AX_MODEL_SCENARIO: 'ax-multi-step',
  }),
  'real-ax-anthropic-multi-step': command('cu-real-ax-model-e2e-launcher.mjs', {
    MAKA_CU_MODEL_PROVIDER: 'anthropic',
    MAKA_CU_AX_MODEL_SCENARIO: 'ax-multi-step',
  }),
  'function-model': command('cu-real-function-model-e2e.mjs'),
  'real-anthropic': command('cu-real-anthropic-model-e2e.mjs'),
  'real-runtime': command('cu-real-runtime-model-e2e.mjs'),
});

export function resolveComputerUseCommand(name) {
  const resolved = commands[name];
  if (!resolved) {
    throw new Error(
      `Unknown computer-use command '${name ?? ''}'. Available commands: ${Object.keys(commands).join(', ')}`,
    );
  }
  return resolved;
}

export async function runComputerUseCli(argv = process.argv.slice(2)) {
  const [name, ...args] = argv;
  if (!name || name === '--help' || name === '-h') {
    process.stdout.write(
      `Usage: node scripts/computer-use.mjs <command> [args...]\n\nCommands:\n${Object.keys(
        commands,
      )
        .map((value) => `  ${value}`)
        .join('\n')}\n`,
    );
    return 0;
  }

  const selected = resolveComputerUseCommand(name);
  const child = spawn(process.execPath, [fileURLToPath(selected.script), ...args], {
    env: { ...process.env, ...selected.env },
    stdio: 'inherit',
  });
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

function command(file, env = {}) {
  return Object.freeze({ script: new URL(file, import.meta.url), env: Object.freeze(env) });
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    process.exitCode = await runComputerUseCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
