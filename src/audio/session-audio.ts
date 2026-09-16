/**
 * The audio of one session, as the frame loop uses it (spec section 15).
 *
 * `audio.ts` is the graph and `director.ts` what is heard; this is the small
 * amount of bookkeeping a frame needs around them, kept here so `main.ts` says
 * one line about sound: the tram bells of every tick the frame stepped, which
 * are not in the record, and the ear itself.
 */
import type { InputFrame } from '../sim/input.ts';
import type { SimState } from '../sim/simulation.ts';
import type { TramBell, TramLine } from '../sim/tram.ts';
import { GameAudio } from './audio.ts';
import type { WorldSounds } from './cues.ts';
import type { Ear } from './mix.ts';

/**
 * Ticks of bells one frame will read. A frame that fell behind by more than
 * this is a stall, and the bells it missed are not worth catching up on.
 */
const MAX_BELL_TICKS = 8;

export class SessionAudio {
  private readonly audio: GameAudio;
  private trams: TramLine | null = null;
  /** Reused between frames, so a frame allocates nothing. */
  private readonly ringing: TramBell[] = [];
  private readonly sounds: { bells: TramBell[] } = { bells: [] };

  constructor(volume: number) {
    this.audio = new GameAudio(volume);
  }

  /** Start on the player's first gesture on `target`, as a browser requires. */
  arm(target: Window): void {
    this.audio.arm(target);
  }

  /** The trams of spec section 13.2, whose bells are a function of the tick. */
  attach(trams: TramLine): void {
    this.trams = trams;
  }

  set volume(value: number) {
    this.audio.volume = value;
  }

  /**
   * One frame. `input` is the frame the last tick was stepped with, `ear` where
   * the player is listening from, and `since` the tick the frame started on, so
   * the bells of every tick it stepped are rung.
   */
  frame(state: SimState, input: InputFrame, ear: Ear, since: number): void {
    this.audio.update(state, input, ear, this.bells(state.tick, since));
  }

  /** Let everything go: a pause, or the end of the session. */
  hush(): void {
    this.audio.hush();
  }

  dispose(): void {
    this.audio.dispose();
  }

  private bells(tick: number, since: number): WorldSounds {
    const out = this.sounds;
    out.bells.length = 0;
    const trams = this.trams;
    if (trams === null) return out;
    for (let at = Math.max(since + 1, tick - MAX_BELL_TICKS); at <= tick; at++) {
      for (const bell of trams.bells(at, this.ringing)) out.bells.push(bell);
    }
    return out;
  }
}
