/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { appendFileSync, readFileSync } from 'node:fs';

export function installStdioFixtureEvents(
  fixture: string,
): (event: string, details?: Record<string, unknown>) => void {
  const path = process.env.MAKA_MCP_STDIO_EVENT_LOG;
  if (!path) return () => {};
  const record = (event: string, details: Record<string, unknown> = {}) => {
    appendFileSync(
      path,
      `${JSON.stringify({
        event,
        fixture,
        pid: process.pid,
        ...details,
      })}\n`,
      'utf8',
    );
  };
  const predecessorPid = latestStartedPid(path);
  record('start', {
    execPath: process.execPath,
    argv: process.argv.slice(1),
    cwd: process.cwd(),
    fixtureEnv: process.env.MAKA_MCP_STDIO_FIXTURE_VALUE ?? null,
    predecessorPid: predecessorPid ?? null,
    predecessorAlive: predecessorPid === undefined ? null : isPidAlive(predecessorPid),
  });
  process.stderr.write(`stdio fixture ${fixture} pid=${process.pid}\n`);
  process.once('SIGTERM', () => {
    record('signal', { signal: 'SIGTERM' });
    process.exit(0);
  });
  process.once('exit', (code) => record('exit', { code }));
  return record;
}

function latestStartedPid(path: string): number | undefined {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const lines = source.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) continue;
    const event = JSON.parse(line) as { event?: unknown; pid?: unknown };
    if (event.event === 'start' && Number.isSafeInteger(event.pid)) return event.pid as number;
  }
  return undefined;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
