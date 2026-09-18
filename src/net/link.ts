/**
 * The Trystero half of the multiplayer: signalling, the room, and the two
 * actions everything is said through (spec section 21.1).
 *
 * Nothing imports this file at the top level. `control.ts` fetches it when the
 * player opens a game or a link carries a room, and each strategy is fetched
 * again from inside here, so a single-player session downloads neither the
 * WebRTC code nor a relay list.
 *
 * Signalling is Nostr first and MQTT second. A strategy is given until
 * `RELAY_TIMEOUT_MS` to get one socket open; a strategy whose relays are all
 * down or blocked leaves the room and the next one is tried. No server is
 * deployed or paid for by anyone.
 */
import type { DataPayload, MessageAction, Room } from '@trystero-p2p/core';
import { APP_ID, MESSAGE_KINDS, type MessageKind } from './protocol.ts';
import type { NetLink } from './party.ts';

/** How long one strategy has to answer before the next is tried. */
export const RELAY_TIMEOUT_MS = 5_000;

/** How often the wait looks at the sockets while it waits. */
const POLL_MS = 100;

/** As much of a Trystero strategy package as the room needs. */
interface TrysteroStrategy {
  selfId: string;
  joinRoom: (config: { appId: string }, roomId: string) => Room;
  getRelaySockets: () => unknown;
}

/** One way of finding the other browsers: how to join, and which sockets that opened. */
interface Strategy {
  name: string;
  selfId: string;
  joinRoom: (config: { appId: string }, roomId: string) => Room;
  sockets: () => Record<string, WebSocket>;
}

/**
 * The strategies in the order they are tried. Each is fetched only when it is
 * reached, so the MQTT client is downloaded by the sessions that need it.
 */
const STRATEGIES: readonly (() => Promise<Strategy>)[] = [
  async () => strategyOf('nostr', await import('@trystero-p2p/nostr')),
  async () => strategyOf('mqtt', await import('@trystero-p2p/mqtt')),
];

/** One strategy's module read as the three things this file asks of it. */
function strategyOf(name: string, module: TrysteroStrategy): Strategy {
  return {
    name,
    selfId: module.selfId,
    joinRoom: module.joinRoom,
    // The package types this `any`, because the socket of a relay is whatever
    // that relay's client holds. Every one of them is a `WebSocket`.
    sockets: () => module.getRelaySockets() as Record<string, WebSocket>,
  };
}

/**
 * Join `roomId`, through the first strategy whose relays answer. Throws where
 * none of them does, which is how `control.ts` knows to stay single player.
 */
export async function openLink(roomId: string, timeoutMs: number = RELAY_TIMEOUT_MS): Promise<NetLink> {
  for (const load of STRATEGIES) {
    const strategy = await load();
    const room = strategy.joinRoom({ appId: APP_ID }, roomId);
    if (await answered(strategy.sockets, timeoutMs)) return linkOver(room, strategy);
    await room.leave();
  }
  throw new Error('No signalling relay answered.');
}

/** Whether one of the strategy's sockets opened inside the timeout. */
function answered(sockets: () => Record<string, WebSocket>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const look = (): void => {
      if (Object.values(sockets()).some((socket) => socket.readyState === WebSocket.OPEN)) resolve(true);
      else if (Date.now() >= deadline) resolve(false);
      else setTimeout(look, POLL_MS);
    };
    look();
  });
}

/** The room as `party.ts` sees it: two actions, two peer events, and a way out. */
function linkOver(room: Room, strategy: Strategy): NetLink {
  // One action per kind, made in the order `protocol.ts` lists them: Trystero
  // namespaces an action by its name, so both ends must make the same set.
  const actions = {} as Record<MessageKind, MessageAction<DataPayload>>;
  for (const kind of MESSAGE_KINDS) actions[kind] = room.makeAction<DataPayload>(kind);
  const link: NetLink = {
    selfId: strategy.selfId,
    via: strategy.name,
    send: (kind, body, to) => {
      // A peer that left between the frame and the send is not an error worth
      // stopping for: the room notices it left on its own event.
      void actions[kind]
        .send(body as DataPayload, to === undefined ? undefined : { target: to })
        .catch((error: unknown) => console.warn(`multiplayer: ${kind} did not reach ${to ?? 'the room'}`, error));
    },
    onPeerJoin: null,
    onPeerLeave: null,
    onMessage: null,
    close: () => {
      room.onPeerJoin = null;
      room.onPeerLeave = null;
      void room.leave();
    },
  };
  for (const kind of MESSAGE_KINDS) {
    actions[kind].onMessage = (data, context) => link.onMessage?.(kind, data, context.peerId);
  }
  room.onPeerJoin = (id) => link.onPeerJoin?.(id);
  room.onPeerLeave = (id) => link.onPeerLeave?.(id);
  return link;
}
