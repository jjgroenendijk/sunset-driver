/**
 * The room code and the invite link of spec section 21.2.
 *
 * This half of the networking holds no connection and imports nothing that
 * does, so `main.ts` reads the room out of the address bar without loading
 * Trystero: a single-player session stays offline (spec section 21.2, point 4).
 *
 * A code is what one player reads out to another, so the alphabet leaves out
 * the letters and digits that sound or look alike.
 */
import { writeSeedToHash } from '../core/seed.ts';

/** The characters a room code is written in: no `0`/`O`, no `1`/`I`/`L`, no `U`. */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** How many characters a room code carries. Thirty to the sixth is enough for the rooms one city ever opens. */
export const CODE_LENGTH = 6;

/**
 * A fresh room code. Uses crypto entropy, not `rngFor`: a room is a player's
 * choice of company, not part of the simulation, and two sessions on one seed
 * must not land in the same room.
 *
 * Each character is drawn from a 32-bit number, so the bias of folding it onto
 * thirty letters is one part in a hundred million.
 */
export function randomRoomCode(): string {
  const draws = new Uint32Array(CODE_LENGTH);
  crypto.getRandomValues(draws);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[(draws[i] ?? 0) % CODE_ALPHABET.length];
  }
  return code;
}

/**
 * A room code as typed by a player, or null where it is not one. Case and
 * spacing are the player's; the code is neither.
 */
export function readRoomCode(text: string): string | null {
  const code = text.trim().toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== CODE_LENGTH) return null;
  for (const character of code) {
    if (!CODE_ALPHABET.includes(character)) return null;
  }
  return code;
}

/** Read the room from a URL hash (`#seed=…&room=…`), or null where the link carries none. */
export function readRoomFromLocation(hash: string): string | null {
  const room = new URLSearchParams(hash.replace(/^#/, '')).get('room');
  return room === null ? null : readRoomCode(room);
}

/** Write a room into a URL hash, keeping the other parameters. */
export function writeRoomToHash(hash: string, room: string): string {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  params.set('room', room);
  return `#${params.toString()}`;
}

/** Drop the room from a URL hash, so a session that went back to single player shares a plain seed. */
export function clearRoomFromHash(hash: string): string {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  params.delete('room');
  const text = params.toString();
  return text.length > 0 ? `#${text}` : '';
}

/**
 * The link a host copies: this page, on this seed, in this room. Both halves
 * travel in the hash, so a joiner opening it lands in the same city and the
 * same room without asking anything of the server.
 */
export function inviteLink(href: string, seed: string, room: string): string {
  const url = new URL(href);
  url.hash = writeRoomToHash(writeSeedToHash(url.hash, seed), room);
  return url.toString();
}
