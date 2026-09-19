/**
 * The frame of a session in progress: the steps the simulation takes, and
 * everything drawn off the record it leaves.
 *
 * `main.ts` builds a session and asks for a frame on every animation frame;
 * this is what one frame does. It is here rather than there because it is one
 * subject — the order a frame reads the record in — and `main.ts` is the boot.
 * The title screen's frame is not here: it draws the preview scene alone.
 */
import { Raycaster, Vector2 } from 'three';
import type { GameAudio } from './audio/game-audio.ts';
import { PULL_MARGIN, type FollowCamera, type RoofHeight } from './render/camera.ts';
import type { FixedStepClock } from './sim/clock.ts';
import { EMPTY_INPUT, type InputFrame } from './sim/input.ts';
import { stationAt } from './sim/metro.ts';
import { swingOf } from './sim/melee.ts';
import { visiting } from './sim/shop.ts';
import { stepSim } from './sim/simulation.ts';
import { turfLine } from './sim/territory.ts';
import type { FreeCameraControls } from './ui/free-camera.ts';
import type { Keyboard } from './ui/keyboard.ts';
import type { Settings } from './ui/settings.ts';
import { applyQuality, type Session } from './session.ts';

/** What a frame reads beside the session: the camera, the clock, the keys and the mix. */
export interface FrameParts {
  camera: FollowCamera;
  clock: FixedStepClock;
  keyboard: Keyboard;
  free: FreeCameraControls;
  audio: GameAudio;
  settings: Settings;
}

/** Where a frame is drawn from: the player, or the free camera while it is detached. */
interface Viewpoint {
  x: number;
  y: number;
}

/** The frame loop of a session, and the little it carries from one frame to the next. */
export class SessionFrame {
  private readonly parts: FrameParts;
  /** Where the mouse is over the canvas, in the camera's -1 to 1 frame, which is what picks the pickup under it. */
  private readonly pointer = { at: new Vector2(), over: false };
  private readonly ray = new Raycaster();
  /** The session being drawn, which the roof lookup reads. */
  private session: Session | null = null;
  /** Whether the camera was detached last frame, so a release is noticed once. */
  private flew = false;
  /** The last frame of input the simulation was stepped with, which the mix reads. */
  private heard: InputFrame = EMPTY_INPUT;

  constructor(canvas: HTMLCanvasElement, parts: FrameParts) {
    this.parts = parts;
    canvas.addEventListener('pointermove', (event) => {
      const rect = canvas.getBoundingClientRect();
      this.pointer.at.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      this.pointer.over = true;
    });
    canvas.addEventListener('pointerleave', () => {
      this.pointer.over = false;
    });
  }

  /** The roof over a ground point, which the camera pulls back over when the player asks it to. */
  private readonly roofTop: RoofHeight = (x, z) => this.session?.world.roofOver(x, z, PULL_MARGIN)?.top;

  /** Step the session by the time the last frame took, and draw it. */
  draw(session: Session, elapsed: number): void {
    this.session = session;
    const { camera, clock, keyboard, free, audio } = this.parts;
    // While the camera is detached the keys drive it alone, so the simulation
    // is stepped with an empty frame: `W` must not also drive the car left
    // behind. The simulation itself keeps running either way.
    const flying = free.detached;
    // A paused session takes no steps and keeps its place between two ticks,
    // so it resumes on the frame it stopped on. The city is still drawn. A
    // session in a room is never paused: the other players' city does not
    // stop (`docs/multiplayer.md`). The menu takes the keys either way.
    const menu = session.pause.open;
    const paused = menu && !session.party.live;
    const steps = session.party.frame(session.state, this.heard, paused ? 0 : clock.advance(elapsed));
    const respawned = session.state.respawn;
    const trips = session.state.metro.trips;
    for (let i = 0; i < steps; i++) {
      // The pose the step starts from is kept before it is taken, so the
      // frame is drawn between the last two ticks rather than on the last.
      session.smooth.capture(session.state);
      this.heard = flying || menu ? EMPTY_INPUT : keyboard.sample();
      stepSim(session.state, this.heard, session.physics);
    }
    // A respawn and a metro trip both put the player down somewhere else on
    // the map (spec sections 11.7, 13.3), so the frame stands the camera
    // there rather than sliding it over the city.
    if (session.state.respawn !== respawned || session.state.metro.trips !== trips) {
      session.smooth.reset();
      camera.snap();
      // The record has jumped across the map, and the difference between two
      // records is not a crash (spec section 15).
      audio.resync(session.state);
    }
    const p = this.drawCity(session, elapsed, flying);
    if (this.flew && !flying) {
      // The flight ended, whichever frame the key came on: the camera slides
      // back to the player rather than jumping, and the quality monitor
      // starts judging frames again.
      camera.snap();
      session.quality.settle();
    }
    this.flew = flying;
    // What the frame took is what decides the quality tier of spec section
    // 9.2. It is measured over the whole frame, drawing included, so it is
    // the frame before this one that is being judged. A frame drawn with the
    // free camera is never a performance measurement, so it is not counted.
    const change = flying || paused ? undefined : session.quality.sample(elapsed);
    if (change !== undefined) applyQuality(session, change);
    this.drawPanels(session, p.inShop);
    // The maps of spec section 12. Both follow the player from the record,
    // and both redraw only when something on them has moved, so a session
    // standing still pays for neither. The minimap follows the free camera
    // while it is detached, because that is what the player is looking at,
    // and it turns with the camera's view rather than the player's facing.
    const at = flying
      ? { x: free.camera.x, y: free.camera.z, heading: free.camera.heading }
      : { x: p.x, y: p.y, heading: p.heading };
    session.minimap.update(at, session.state.waypoint);
    session.map.update(at, session.state.waypoint);
    // The mix of spec section 15 stands where the frame is drawn from, which
    // is the player or the free camera. A paused session holds no note.
    if (paused) audio.hush();
    else audio.update(session.state, this.heard, p.round);
    // Not `renderer.render`: the post chain draws the scene itself and the
    // effects of spec section 10.6 over it.
    session.post.render();
  }

  /**
   * Draw the city between the last two ticks and put the camera over it.
   * Answers the drawn player, where the frame is drawn from, and the shop the
   * player is standing in.
   */
  private drawCity(session: Session, elapsed: number, flying: boolean) {
    const { camera, clock, keyboard, free, settings } = this.parts;
    // A frame falls between two ticks, so what is drawn is the blend of them
    // `smooth.ts` describes. Without it the record steps 0, 1 or 2 ticks a
    // frame while the camera slides every frame, and the city judders.
    const alpha = clock.alpha();
    const p = session.smooth.playerAt(session.state, alpha);
    // The shop the player is standing in (spec section 16.1), or undefined.
    // Two things read it: the room that is drawn, and the shell over it,
    // which has to be cut away or the room is roofed over again.
    const inShop = visiting(session.state, session.shops);
    const vehicle = session.smooth.vehicleAt(session.state, alpha);
    // The player and the car are both drawn from the record the physics
    // wrote. The record says how high the player's feet stand and how fast
    // they are going, so the model follows them over a kerb, through a jump
    // and across the water (spec section 11.5), and the character is shown
    // only while they are out of the car.
    // A swing is drawn between two ticks like the rest of the frame (11.6).
    const swing = swingOf(session.state.loadout, session.state.tick - 1 + alpha);
    session.world.walkPlayer(p, session.state.player, elapsed / 1000, swing);
    // The weapon in the hands and the weapons on the ground (spec section
    // 11.6), with what is fitted. The one in hand follows the arm swinging it.
    session.world.held.set(session.state.loadout, session.state.player, p, session.world.character.height, swing);
    // The pickup under the mouse grows, so what lies there can be read before
    // walking to it. Nothing is picked while the camera is detached.
    if (!flying && this.pointer.over && session.state.pickups.length > 0) {
      this.ray.setFromCamera(this.pointer.at, camera.camera);
      session.world.pickups.pick(this.ray);
    } else {
      session.world.pickups.hovered = undefined;
    }
    session.world.pickups.update(session.state.pickups, session.state.tick, elapsed / 1000);
    session.world.setVehicle(vehicle);
    // The other players of a multiplayer room, drawn where the room says they
    // are between the frames they sent (spec section 21.5).
    session.world.remotes.update(session.party.remotes(session.state.tick), elapsed / 1000, session.world.lampsNow);
    // The traffic is a function of the tick, so it is drawn at the moment the
    // frame stands at: one tick behind the record, as the player is.
    const round: Viewpoint = flying ? { x: free.camera.x, y: free.camera.z } : p;
    this.drawLife(session, alpha, round, p);
    // The damage of spec section 11.3, drawn off the same record: the smoke
    // and flames over the car and the rubber its tyres leave behind. It is
    // given the drawn pose, so the smoke stands where the car is seen to be.
    session.world.damage(vehicle, session.state, session.state.tick, session.surfaceAt);
    // The light of the scene is a function of the tick, so the day runs at
    // the simulation's pace whatever the frame rate (spec section 10.5). The
    // colour grade follows the same tick (spec section 10.6).
    session.world.time = session.state.tick;
    session.post.time = session.state.tick;
    // A storm keeps the ambient life off the street (spec section 13.4). The
    // crowd is laid out once from the seed, so the weather decides who is
    // drawn rather than who exists.
    session.traffic.share = session.world.weatherNow.crowd;
    session.crowd.share = session.world.weatherNow.crowd;
    session.wildlife.share = session.world.weatherNow.crowd;
    // The headlamps and tail lights of everything the scene does not draw
    // itself come on with the street lamps (spec section 13.4).
    session.traffic.lamps = session.world.lampsNow;
    session.police.lamps = session.world.lampsNow;
    session.emergency.lamps = session.world.lampsNow;
    if (flying) {
      free.camera.update(elapsed / 1000, free.input(keyboard.freeCamera()));
      free.camera.writeTo(camera.camera);
      // The streaming rings and the entity fade are measured from wherever
      // the view is, or a flight of a few hundred metres looks at empty
      // ground. Nothing waits for it: the chunks land as they are built.
      session.world.update(free.camera.x, free.camera.z);
      // The cut is aimed at the player, and a flight looks at buildings whole.
      session.world.cutaway.enabled = false;
    } else {
      session.world.update(p.x, p.y);
      // A building between the camera and the player (spec section 10.7):
      // it is cut to a ghost, and with Pull back the camera first moves over
      // the roofs. Off does neither.
      camera.update(elapsed / 1000, p, settings.buildingView === 'pull-back' ? this.roofTop : undefined);
      session.world.cutaway.enabled = settings.buildingView !== 'whole';
      session.world.seeThrough(camera.camera.position, p.x, p.height, p.y, inShop !== undefined);
    }
    return { x: p.x, y: p.y, heading: p.heading, round, inShop };
  }

  /** The traffic, the tram, the units, the animals, the parked cars and the crowd, at the frame's moment. */
  private drawLife(session: Session, alpha: number, round: Viewpoint, player: Viewpoint): void {
    const moment = session.state.tick - 1 + alpha;
    session.traffic.update(session.state, moment, round.x, round.y);
    session.tram.update(moment, round.x, round.y);
    // The units are stepped once a tick like the player, so they are drawn
    // where the last tick left them rather than between two of them.
    session.police.update(session.state, round.x, round.y);
    session.emergency.update(session.state, round.x, round.y);
    // The animals of spec section 20.4 are a function of the tick like the
    // traffic, so they are drawn at the moment the frame stands at. They give
    // way to where the player is rather than to where the camera looks, so a
    // flight over a flock leaves it alone.
    session.wildlife.update(session.state.tick, moment, round.x, round.y, player);
    session.parked?.update(session.state, round.x, round.y);
    session.crowd.update(session.state, moment, round.x, round.y);
  }

  /** The HUD and every panel and mark that reads the record. */
  private drawPanels(session: Session, inShop: ReturnType<typeof visiting>): void {
    session.hud.update(
      session.state,
      session.world.drawCallsPerChunk,
      session.world.lightCount,
      session.world.streaming,
      session.quality.tier.name,
      this.parts.audio.onAir,
      turfLine(session.state, session.turf),
      session.streetLife.happening,
    );
    // The lock the player is working at (spec section 11.4). The panel reads
    // the record the simulation is playing, so the bar on screen is the bar
    // the presses are judged against.
    session.hotwire.update(session.state.theft, session.state.seed, session.state.tick);
    // The metro panel of spec section 13.3: where the player may travel from
    // the station they are standing at, and the fade of a trip in progress.
    session.travel.update(session.state, session.metro, stationAt(session.metro, session.state), session.state.tick);
    // The shop of spec section 16.1: the counter on screen, and the room the
    // player is standing in, which is the only interior the scene ever holds.
    session.shopPanel.update(session.state, session.shops, session.safehouses);
    session.world.shopInside(inShop);
    // The contraband market of spec section 16.2: where the dealers are
    // standing this spell, and the prices of the one the player is with.
    session.dealerMarks.update(session.state.tick, session.world);
    session.tradePanel.update(session.state, session.dealers);
    // The enforcers of spec section 17.2, where the record left them this
    // tick, and the dealers standing behind them in the same list.
    session.enforcerMarks.update(session.state, session.world, session.dealerMarks);
    // The work of spec section 18: the board at the contact the player is
    // standing at, and the mark on wherever the job in hand is going.
    session.jobPanel.update(session.state, session.missions);
    // The events and the street crime of spec section 20.5: the crowd an
    // event has drawn and the people in whatever is going on nearby, standing
    // in the same list as the enforcers, and both marked on the map.
    session.streetLife.update(session.state, session.world, session.enforcerMarks);
    session.missionMarks.update(session.state, session.streetLife);
    // The safehouses of spec section 16.3: what a front door costs, or what
    // the house the player is standing in does for them.
    session.homePanel.update(session.state, session.safehouses);
    session.weapons.sync(session.state.loadout);
  }
}
