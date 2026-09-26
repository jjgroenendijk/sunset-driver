/**
 * Find the preview server of `preview-server.ts`, start it when none runs, and
 * ask it for a frame.
 *
 * This file loads neither Vite nor Playwright, so a run that finds a server
 * running starts in a fraction of a second.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PreviewRequest } from '../src/render/preview/preview.ts';
import type { HostFrame } from './preview-host.ts';

/** Where the server of this checkout says it listens. */
export interface ServerState {
  port: number;
  pid: number;
  adapter: string;
}

/** The checkout this file belongs to. A server serves one checkout's code. */
const ROOT = resolve(import.meta.dirname, '..');
const NAME = `sunset-preview-${createHash('sha1').update(ROOT).digest('hex').slice(0, 12)}`;

/** How long a server may take to start: Vite, the browser and the first page load. */
const START_MS = 180_000;

export function statePath(): string {
  return join(tmpdir(), `${NAME}.json`);
}

/** Where a starting server writes what it prints, for reading when it fails. */
export function logPath(): string {
  return join(tmpdir(), `${NAME}.log`);
}

export function readState(): ServerState | undefined {
  try {
    return JSON.parse(readFileSync(statePath(), 'utf8')) as ServerState;
  } catch {
    return undefined;
  }
}

/** One request to the server, answered as parsed JSON. Not `fetch`: it gives up on a frame after 300 s. */
function call(state: ServerState, path: string, body?: unknown, timeoutMs = 2000): Promise<{ status: number; json: unknown }> {
  return new Promise((done, fail) => {
    const sent = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      { host: '127.0.0.1', port: state.port, path, method: sent === undefined ? 'GET' : 'POST', timeout: timeoutMs },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          try {
            done({ status: response.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          } catch (error) {
            fail(error);
          }
        });
        response.on('error', fail);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`the preview server did not answer ${path} in ${timeoutMs} ms`)));
    req.on('error', fail);
    req.end(sent);
  });
}

/** The running server of this checkout, or undefined. A file left by a dead one is removed. */
export async function runningServer(): Promise<ServerState | undefined> {
  const state = readState();
  if (state === undefined) return undefined;
  try {
    if ((await call(state, '/health')).status === 200) return state;
  } catch {
    // Nothing answered: the server died without taking its file away.
  }
  rmSync(statePath(), { force: true });
  return undefined;
}

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * The server of this checkout, started if none runs. Two runs at once start
 * one server between them: the second waits on the first's lock file.
 */
export async function ensureServer(): Promise<ServerState> {
  const running = await runningServer();
  if (running !== undefined) return running;

  const lock = join(tmpdir(), `${NAME}.lock`);
  let owner = false;
  try {
    closeSync(openSync(lock, 'wx'));
    owner = true;
  } catch {
    // Another run is starting one. A lock older than a start can take is left by a run that died.
    if (Date.now() - statSync(lock).mtimeMs > START_MS) {
      rmSync(lock, { force: true });
      return ensureServer();
    }
  }
  try {
    let exited: number | null | undefined;
    if (owner) {
      const log = openSync(logPath(), 'w');
      const child = spawn(process.execPath, [join(ROOT, 'scripts', 'preview-server.ts')], {
        cwd: ROOT,
        detached: true,
        stdio: ['ignore', log, log],
      });
      child.on('exit', (code) => {
        exited = code;
      });
      child.unref();
      closeSync(log);
    }
    const until = Date.now() + START_MS;
    while (Date.now() < until) {
      const state = await runningServer();
      if (state !== undefined) return state;
      if (exited !== undefined) break;
      await pause(250);
    }
    const printed = existsSync(logPath()) ? readFileSync(logPath(), 'utf8').trim() : '';
    const tail = printed === '' ? '' : `:\n${printed}`;
    throw new Error(`the preview server did not start${tail}`);
  } finally {
    if (owner) rmSync(lock, { force: true });
  }
}

/** Draw a frame on the server. */
export async function askServer(state: ServerState, request: PreviewRequest): Promise<HostFrame & { adapter: string }> {
  const { json } = await call(state, '/render', request, 900_000);
  const answer = json as (HostFrame & { adapter: string }) | { error: string };
  if ('error' in answer) throw new Error(`the preview server failed: ${answer.error}`);
  return answer;
}

/** Stop the server of this checkout, and answer whether one was running. */
export async function stopServer(): Promise<boolean> {
  const state = await runningServer();
  if (state === undefined) return false;
  await call(state, '/stop', {});
  return true;
}
