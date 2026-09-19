/**
 * Keep a preview page open between runs of `render-preview.ts`.
 *
 * A run of its own starts Vite and a browser, generates the world and builds
 * every chunk round the player before it draws: most of ten seconds on a GPU,
 * for a frame that takes one or two. This process holds all of that open. The
 * page keeps the scene of the last seed, so the next picture of the same seed
 * builds only the chunks round a new place.
 *
 * `render-preview.ts` starts it on its first run and talks to it after that;
 * nobody needs to start it by hand. It stops itself after twenty minutes with
 * no request, and `node scripts/render-preview.ts --stop-server` stops it at
 * once. One runs for each checkout, found through a file in the temporary
 * directory named for the checkout's path, so two worktrees never draw each
 * other's code.
 *
 * A source file saved while it runs is picked up: the page is reloaded before
 * the next frame, which builds the scene again.
 *
 * Usage: node scripts/preview-server.ts [--idle=minutes]
 */
import { rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { PreviewRequest } from '../src/render/preview.ts';
import { readState, statePath, type ServerState } from './preview-client.ts';
import { PreviewHost } from './preview-host.ts';

const idleArg = process.argv.find((a) => a.startsWith('--idle='));
const IDLE_MS = Number(idleArg?.slice('--idle='.length) ?? 20) * 60_000;

const host = await PreviewHost.open();
console.log(`preview server: ${host.adapter} adapter`);

/** The frames are drawn one at a time, in the order they were asked for. */
let queue: Promise<unknown> = Promise.resolve();
let idle: NodeJS.Timeout | undefined;

function body(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function reply(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

let stopping = false;
async function stop(reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`preview server: stopping, ${reason}`);
  // Only this server's own file is taken away, never a newer server's.
  if (readState()?.pid === process.pid) rmSync(statePath(), { force: true });
  server.close();
  await host.close();
  process.exit(0);
}

function wake(): void {
  if (idle !== undefined) clearTimeout(idle);
  idle = setTimeout(() => void stop('idle'), IDLE_MS);
}

const server = createServer((request, response) => {
  wake();
  if (request.method === 'GET' && request.url === '/health') {
    reply(response, 200, { pid: process.pid, adapter: host.adapter });
    return;
  }
  if (request.method === 'POST' && request.url === '/stop') {
    reply(response, 200, { stopping: true });
    void stop('asked to');
    return;
  }
  if (request.method === 'POST' && request.url === '/render') {
    const drawn = Promise.all([body(request), queue]).then(async ([text]) => {
      const asked = JSON.parse(text) as PreviewRequest;
      const frame = await host.render(asked);
      const r = frame.result;
      console.log(
        `seed ${asked.seed} at ${r.x.toFixed(0)},${r.y.toFixed(0)}: world ${r.worldMs.toFixed(0)} ms,` +
          ` chunks ${r.chunkMs.toFixed(0)} ms, frame ${r.frameMs.toFixed(0)} ms${r.kept ? ', scene kept' : ''}`,
      );
      return { ...frame, adapter: host.adapter };
    });
    queue = drawn.catch(() => {});
    drawn.then(
      (frame) => reply(response, 200, frame),
      (error: unknown) => reply(response, 500, { error: error instanceof Error ? error.message : String(error) }),
    );
    return;
  }
  reply(response, 404, { error: `no ${request.method} ${request.url}` });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the preview server has no port');
  const state: ServerState = { port: address.port, pid: process.pid, adapter: host.adapter };
  writeFileSync(statePath(), JSON.stringify(state));
  console.log(`preview server: listening on ${address.port}, stops after ${IDLE_MS / 60_000} idle minutes`);
  wake();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void stop(signal));
