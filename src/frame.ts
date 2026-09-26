/**
 * The frame of a session in progress: the steps the simulation takes, and
 * everything drawn off the record it leaves.
 *
 * `main.ts` builds a session and asks for a frame on every animation frame;
 * this is what one frame does. It is here rather than there because it is one
 * subject — the order a frame reads the record in — and `main.ts` is the boot.
 * The title screen's frame is not here: it draws the preview scene alone.
 */
import { Vector3 } from 'three';
import type { GameAudio } from './audio/game-audio.ts';
import { holdOf } from './render/character-hold.ts';
import { PULL_MARGIN, TURN_MARGIN, type FollowCamera, type RoofHeight } from './render/camera.ts';
import type { FixedStepClock } from './sim/clock.ts';
import { EMPTY_INPUT, type InputFrame } from './sim/input.ts';
import { boardingProgress } from './sim/boarding.ts';
import { stationAt } from './sim/metro.ts';
import { swingOf } from './sim/melee.ts';
import { visiting } from './sim/shop.ts';
import { specOf } from './sim/vehicle.ts';
import { stepSim } from './sim/simulation.ts';
import { turfLine } from './sim/territory.ts';
import { AIM_PLANE_HEIGHT, PointerAim, shotPitch } from './pointer-aim.ts';
import { Crosshair } from './ui/crosshair.ts';
import { aimPoint } from './sim/aim.ts';
import { currentWeapon, spreadOf } from './sim/weapon.ts';
import { zoomOf } from './render/viewmodel.ts';
import type { DrawnPlayer } from './render/smooth.ts';
import type { Tracer } from './sim/tracer.ts';
import type { FreeCameraControls } from './ui/free-camera.ts';
import type { Keyboard } from './ui/keyboard.ts';
import type { MouseLook } from './ui/mouse-look.ts';
import { ARRIVED } from './ui/map-route.ts';
import type { Settings } from './ui/settings.ts';
import { applyQuality, type Session } from './session.ts';

/** What a frame reads beside the session: the camera, the clock, the keys and the mix. */
export interface FrameParts {
  camera: FollowCamera;
  clock: FixedStepClock;
  keyboard: Keyboard;
  free: FreeCameraControls;
  look: MouseLook;
  audio: GameAudio;
  settings: Settings;
}

/** Metres a shot pushes the camera back, before and for the weapon's recoil, and the most. */
const BASE_KICK = 0.08;
const KICK_PER_RECOIL = 6;
const MAX_KICK = 0.5;

/** Where a frame is drawn from: the player, or the free camera while it is detached. */
interface Viewpoint {
  x: number;
  y: number;
}

/**
 * Whether a session is paused: the menu is open and nobody else is playing.
 * A session in a room is never paused, because the other players' city does
 * not stop (`docs/multiplayer.md`).
 */
export function isPaused(session: Session): boolean {
  return session.pause.open && !session.party.live;
}

/** The frame loop of a session, and the little it carries from one frame to the next. */
export class SessionFrame {
  private readonly parts: FrameParts;
  /** The mouse over the canvas: what it aims at, and the pickup under it. */
  private readonly aim: PointerAim;
  /** Where the mouse aims, drawn over the city (spec section 11.5). */
  private readonly crosshair: Crosshair;
  /** Where the player's right fist is, which the gun in it is drawn at. */
  private readonly fist = new Vector3();
  /** The tick of the newest round the camera was kicked for, so each shot kicks once. */
  private kicked = -1;
  /** The tick of the newest hit on a person the camera was jolted for, so each one jolts once. */
  private jolted = -1;
  /** The session being drawn, which the roof lookup reads. */
  private session: Session | null = null;
  /** Whether the camera was detached last frame, so a release is noticed once. */
  private flew = false;
  /** Whether the last frame was paused, so the first one after it steps nothing. */
  private stopped = false;
  /** The last frame of input the simulation was stepped with, which the mix reads. */
  private heard: InputFrame = EMPTY_INPUT;

  constructor(canvas: HTMLCanvasElement, parts: FrameParts) {
    this.parts = parts;
    this.aim = new PointerAim(canvas);
    this.crosshair = new Crosshair(document.body);
  }

  /** The roof over a ground point, which the camera pulls back over when the player asks it to. */
  private readonly roofTop: RoofHeight = (x, z) => this.session?.world.roofOver(x, z, PULL_MARGIN)?.top;
  /** The roof over a ground point, which the camera turns to see past when the player asks it to. */
  private readonly sightTop: RoofHeight = (x, z) => this.session?.world.roofOver(x, z, TURN_MARGIN)?.top;

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
    const paused = isPaused(session);
    // A chase view turns with the mouse under pointer lock, unless a menu, the
    // map, a shop counter or a deal wants the pointer (`ui/mouse-look.ts`).
    const chase = this.parts.settings.view !== 'top-down';
    const counter = session.state.shop !== null || session.state.market.deal !== null;
    this.parts.look.update(chase && !menu && !session.map.open && !counter, flying);
    this.pointMouse(session, flying || menu);
    // Nothing samples the keys while the camera flies or a menu is open, so
    // the wheel turned then must not step the weapon afterwards.
    if (flying || menu) keyboard.forgetWheel();
    // The arrow keys walk a shop's counter or a dealer's while one is open.
    keyboard.menu = counter;
    // A paused frame is drawn at `PAUSED_FPS` (`pace.ts`), so the frame after
    // the menu closes comes up to a tenth of a second later. That time was
    // spent in the menu, and the first frame back takes no step for it.
    const resumed = this.stopped && !paused;
    this.stopped = paused;
    const steps = session.party.frame(session.state, this.heard, paused || resumed ? 0 : clock.advance(elapsed));
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
    // free camera is never a performance measurement, so it is not counted,
    // and nothing is while the player has set the knobs by hand.
    const judged = !flying && !paused && this.parts.settings.graphics.auto;
    const change = judged ? session.quality.sample(elapsed) : undefined;
    if (change !== undefined) applyQuality(session, change);
    this.drawPanels(session, p.inShop);
    this.drawAim(session, flying || menu);
    this.drawMaps(session, p, flying);
    session.world.gore = this.parts.settings.gore;
    // The mix of spec section 15 stands where the frame is drawn from, which
    // is the player or the free camera. A paused session holds no note.
    if (paused) audio.hush();
    else audio.update(session.state, this.heard, p.round);
    // Not `renderer.render`: the post chain draws the scene itself and the
    // effects of spec section 10.6 over it.
    session.post.render();
    // The turning preview of a shop's counter, on its own canvas.
    session.shopPanel.drawPreview(performance.now() / 1000);
    session.tradePanel.drawPreview(performance.now() / 1000);
  }

  /**
   * The maps of spec section 12. Both follow the player from the record, and
   * both redraw only when something on them has moved, so a session standing
   * still pays for neither. The minimap follows the free camera while it is
   * detached, because that is what the player is looking at, and it turns
   * with the camera's view rather than the player's facing.
   */
  private drawMaps(session: Session, p: { x: number; y: number; heading: number }, flying: boolean): void {
    const free = this.parts.free;
    const at = flying
      ? { x: free.camera.x, y: free.camera.z, heading: free.camera.heading }
      : { x: p.x, y: p.y, heading: p.heading };
    // The waypoint is a place to get to, so it is taken away once the player
    // is there. The route to it follows the roads (`map-route.ts`), and starts
    // where the maps put the arrow: in Explore that is the camera, and a route
    // from the player left on the ground would start off the screen.
    const mark = session.state.waypoint;
    if (mark && !flying && Math.hypot(mark.x - p.x, mark.y - p.y) < ARRIVED) session.state.waypoint = null;
    const nav = session.navigator;
    nav.update(at, session.state.waypoint);
    session.minimap.northUp = this.parts.settings.northUp;
    session.minimap.update(at, session.state.waypoint, nav.route, nav.version);
    session.map.update(at, session.state.waypoint, nav.route, nav.version);
  }

  /**
   * Draw the city between the last two ticks and put the camera over it.
   * Answers the drawn player, where the frame is drawn from, and the shop the
   * player is standing in.
   */
  private drawCity(session: Session, elapsed: number, flying: boolean) {
    const { clock, free } = this.parts;
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
    // A gun is held in the arms, raised as the player aims and kicked by a shot.
    const drawnTick = session.state.tick - 1 + alpha;
    const swing = swingOf(session.state.loadout, drawnTick);
    const hold = holdOf(session.state.loadout, drawnTick);
    // A player giving up or being cuffed has their hands up and holds nothing (spec section 14).
    const police = session.state.police;
    const handsUp = police.surrendered || police.cuffs !== null;
    // Getting into the car or out of it is drawn between two ticks as well (`boarding.ts`).
    const boarding = session.state.boarding;
    const board =
      boarding === null
        ? undefined
        : { state: boarding, progress: boardingProgress(boarding, specOf(vehicle.cls), drawnTick) };
    session.world.walkPlayer(p, session.state.player, elapsed / 1000, swing, hold, handsUp, vehicle, board);
    // The weapon in the hands and the weapons on the ground (spec section
    // 11.6), with what is fitted. The one in hand is drawn in the fist that
    // holds it, or follows the arm swinging it.
    const world = session.world;
    const grip = world.character.grip(this.fist);
    world.held.set(session.state.loadout, session.state.player, p, world.character.height, swing, grip, hold.kick);
    if (board !== undefined) world.held.stow();
    // The pickup under the mouse grows, so what lies there can be read before
    // walking to it. Nothing is picked while the camera is detached.
    if (!flying && this.aim.over && session.state.pickups.length > 0) {
      session.world.pickups.pick(this.aim.ray);
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
    session.crowd.rain = session.world.weatherNow.rain;
    session.wildlife.share = session.world.weatherNow.crowd;
    // The headlamps and tail lights of everything the scene does not draw
    // itself come on with the street lamps (spec section 13.4).
    session.traffic.lamps = session.world.lampsNow;
    session.tram.lamps = session.world.lampsNow;
    session.tramStops.lamps = session.world.lampsNow;
    session.tramSigns.lamps = session.world.lampsNow;
    session.police.lamps = session.world.lampsNow;
    session.emergency.lamps = session.world.lampsNow;
    if (flying) this.fly(session, elapsed);
    else this.follow(session, elapsed, p, drawnTick, inShop !== undefined);
    return { x: p.x, y: p.y, heading: p.heading, round, inShop };
  }

  /** Fly the detached camera by the keys, and stream the city round it. */
  private fly(session: Session, elapsed: number): void {
    const { camera, keyboard, free } = this.parts;
    free.camera.update(elapsed / 1000, free.input(keyboard.freeCamera()));
    free.camera.writeTo(camera.camera);
    session.world.viewModel.hide();
    // The streaming rings and the entity fade are measured from wherever
    // the view is, or a flight of a few hundred metres looks at empty
    // ground. Nothing waits for it: the chunks land as they are built.
    session.world.update(free.camera.x, free.camera.z);
    // The cut is aimed at the player, and a flight looks at buildings whole.
    session.world.cutaway.enabled = false;
  }

  /** Put the camera over the drawn player, and stream the city round them. */
  private follow(session: Session, elapsed: number, p: DrawnPlayer, drawnTick: number, inShop: boolean): void {
    const { camera, keyboard, settings } = this.parts;
    session.world.update(p.x, p.y);
    // A building between the camera and the player (spec section 10.7):
    // it is cut to a ghost, and with Pull back the camera first moves over
    // the roofs, or with Turn swings round the player to see past them. Off
    // does none of it. The chase views stand too close to need either move.
    this.kick(session);
    const view = camera.view;
    camera.update(elapsed / 1000, p, {
      view: settings.view,
      pull: settings.buildingView === 'pull-back' ? this.roofTop : undefined,
      turn: settings.buildingView === 'turn' ? this.sightTop : undefined,
      mouse: this.parts.look.active,
      altitude: session.state.player.driving ? p.height - session.world.heightAt(p.x, p.y) : 0,
      zoom: zoomOf(session.state.loadout),
    });
    this.firstPerson(session, p, elapsed / 1000, drawnTick);
    // A chase view has a near plane of its own, and the sun's cascades are
    // cut to the camera's frustum, so they are refitted.
    if (camera.view !== view) session.world.resize();
    // On foot the keys walk relative to the view, so up the screen is
    // forward whichever way the camera faces. A car steers as it did.
    keyboard.turn = session.state.player.driving ? 0 : camera.heading;
    session.world.cutaway.enabled = settings.buildingView !== 'whole';
    session.world.seeThrough(camera.camera.position, p.x, p.height, p.y, inShop);
  }

  /**
   * Lay the mouse on the map and hand the point to the keys, which sample it
   * into every tick this frame steps (spec section 11.5). The ray is cast from
   * where the camera stood last frame, which is where the player saw the
   * pointer. A detached camera or an open menu aims nothing.
   */
  private pointMouse(session: Session, away: boolean): void {
    const { camera, keyboard, look } = this.parts;
    const me = session.state.player;
    // Under mouse look the pointer is locked, and the aim is ahead of the view.
    this.aim.cast(camera.camera, look.active);
    let at: { x: number; y: number } | undefined;
    if (!away) at = look.active ? this.aim.ahead(me.x, me.y, me.height, camera.heading) : this.aim.ground(me.height);
    // First person aims up and down as well, where the middle of the view is.
    const level = !look.active || camera.view !== 'first-person' || me.driving;
    if (at === undefined) keyboard.unpoint();
    else keyboard.pointAt(at.x, at.y, level ? 0 : shotPitch(camera.elevation, this.aim.reach));
  }

  /**
   * First person on foot, drawn as a shooter draws it (spec section 10.7): the
   * body the other views show stands behind the eyes, so it is hidden, and the
   * weapon and the forearms holding it are drawn in the view instead.
   */
  private firstPerson(session: Session, p: DrawnPlayer, dt: number, tick: number): void {
    const { camera } = this.parts;
    const state = session.state;
    const world = session.world;
    const shown = camera.view === 'first-person' && !state.player.driving && state.boarding === null;
    if (!shown) {
      world.viewModel.hide();
      return;
    }
    world.character.group.visible = false;
    world.held.stow();
    world.viewModel.update(camera.camera, state.loadout, state.character, tick, dt, {
      yaw: camera.heading,
      pitch: camera.elevation,
      speed: p.speed,
      grounded: state.player.grounded,
    });
  }

  /** Push the camera back from every shot fired since the last frame. */
  private kick(session: Session): void {
    const tracers = session.state.tracers;
    const spec = currentWeapon(session.state.loadout);
    // A loaded save or a new session starts the count again.
    if (session.state.tick < this.kicked) this.kicked = -1;
    let newest = this.kicked;
    for (let i = 0; i < tracers.length; i++) {
      const t = tracers[i] as Tracer;
      // Only the player's own rounds kick the camera: an officer's shot is not in their hands.
      // A flamethrower pushes nothing back; its stream is steady.
      if (t.by !== 'player' || t.pellet !== 0 || t.flame === true || t.tick <= this.kicked) continue;
      this.parts.camera.kick(t.ex - t.x, t.ey - t.y, Math.min(MAX_KICK, BASE_KICK + spec.recoil * KICK_PER_RECOIL));
      newest = Math.max(newest, t.tick);
    }
    this.kicked = newest;
    this.jolt(session);
  }

  /**
   * Jolt the camera when the player's car hits a person or goes over a body.
   * A blow on foot is the same kind of hit on the record, so it is only read
   * while the player drives. It is the same at every gore level.
   */
  private jolt(session: Session): void {
    const state = session.state;
    if (state.tick < this.jolted) this.jolted = -1;
    let newest = this.jolted;
    for (const hit of state.hits) {
      if (hit.surface !== 'person' || hit.tick <= this.jolted) continue;
      if (state.player.driving) this.parts.camera.jolt(hit.strength, hit.tick);
      newest = Math.max(newest, hit.tick);
    }
    this.jolted = newest;
  }

  /**
   * The crosshair (spec section 11.5): at the mouse while a gun is in hand,
   * opened as wide as the next round may stray at that distance, with a ring
   * on the target the aim was pulled onto.
   */
  private drawAim(session: Session, away: boolean): void {
    const state = session.state;
    const spec = currentWeapon(state.loadout);
    const locked = this.parts.look.active;
    const shown = !away && ((this.aim.over && this.aim.mouse) || locked) && spec.cls !== 'melee';
    this.aim.hideCursor(shown);
    if (!shown) {
      this.crosshair.hide();
      return;
    }
    const camera = this.parts.camera.camera;
    const h = state.player.height + AIM_PLANE_HEIGHT;
    const point = aimPoint(state, this.heard);
    let gap = 0;
    let lock: { x: number; y: number } | undefined;
    if (point !== undefined) {
      // The spread is an angle either side of the aim, so at the aim point it
      // is that angle times the distance, across the line of fire.
      const dx = point.x - state.player.x;
      const dy = point.y - state.player.y;
      const distance = Math.hypot(dx, dy);
      const across = Math.tan(spreadOf(spec, state.loadout.aiming, state.loadout.recoil)) * distance;
      const middle = this.aim.screenOf(camera, point.x, h, point.y);
      const side = distance > 0
        ? this.aim.screenOf(camera, point.x - (dy / distance) * across, h, point.y + (dx / distance) * across)
        : middle;
      gap = Math.hypot(side.x - middle.x, side.y - middle.y);
      if (point.snapped) lock = middle;
    }
    // Under mouse look the crosshair stands on the aim, since the pointer does not move.
    // In first person it stands in the middle of the view, where the round goes.
    const first = this.parts.camera.view === 'first-person' && !state.player.driving;
    let at = this.aim.client;
    if (locked && first) at = this.aim.centre();
    else if (locked && point !== undefined) at = this.aim.screenOf(camera, point.x, h, point.y);
    this.crosshair.update({ at, gap, lock, aiming: state.loadout.aiming }, state.tracers, state.tick, performance.now());
  }

  /** The traffic, the tram, the units, the animals, the parked cars and the crowd, at the frame's moment. */
  private drawLife(session: Session, alpha: number, round: Viewpoint, player: Viewpoint): void {
    const moment = session.state.tick - 1 + alpha;
    session.traffic.update(session.state, moment, round.x, round.y);
    session.tram.update(moment, round.x, round.y);
    session.tramStops.update(round.x, round.y);
    session.tramSigns.update(moment, round.x, round.y);
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
    // A stop does not move, so its posts are written where the frame stands
    // rather than at the moment it stands at.
    session.busStops.update(round.x, round.y);
    session.corners.update(session.state.tick, round.x, round.y);
    session.crowd.update(session.state, moment, round.x, round.y);
    // The marker over each contact in view (spec section 18), which turns and
    // bobs with the frame's moment rather than with the wall clock.
    session.markers.update(moment, round.x, round.y);
    session.casualties.update(session.state, moment, round.x, round.y);
    session.guns.update(session.state);
  }

  /** The HUD and every panel and mark that reads the record. */
  private drawPanels(session: Session, inShop: ReturnType<typeof visiting>): void {
    session.hud.update(
      session.state,
      session.world.drawCallsPerChunk,
      session.world.lightCount,
      session.world.streaming,
      session.world.quality.name,
      this.parts.audio.onAir,
      turfLine(session.state, session.turf),
      session.streetLife.happening,
    );
    // The lock the player is working at (spec section 11.4). The panel reads
    // the record the simulation is playing, so the bar on screen is the bar
    // the presses are judged against.
    session.hotwire.update(session.state.theft, session.state.seed, session.state.tick);
    // What the same key would do to a vehicle before it is pressed.
    session.interact.update(session.state);
    // The name of a district the player has just crossed into.
    session.districtTitle.update(session.state);
    // The metro panel of spec section 13.3: where the player may travel from
    // the station they are standing at, and the fade of a trip in progress.
    session.travel.update(session.state, session.metro, stationAt(session.metro, session.state), session.state.tick);
    // The shop of spec section 16.1: the counter on screen, and the room the
    // player is standing in, which is the only interior the scene ever holds.
    // The counter's keys are read once, since a read spends them, and handed to
    // both panels; only one of the two is ever open.
    const nav = this.parts.keyboard.menuKeys();
    session.shopPanel.update(session.state, session.shops, session.safehouses, nav);
    session.world.shopInside(inShop);
    // The contraband market of spec section 16.2: where the dealers are
    // standing this spell, and the prices of the one the player is with.
    session.dealerMarks.update(session.state.tick, session.world);
    session.tradePanel.update(session.state, session.dealers, nav);
    // The enforcers of spec section 17.2, where the record left them this
    // tick, and the dealers standing behind them in the same list.
    session.enforcerMarks.update(session.state, session.world, session.dealerMarks);
    // The work of spec section 18: the board at the contact the player is
    // standing at, whether each contact's marker says they will talk, and the
    // mark on wherever the job in hand is going.
    session.jobPanel.update(session.state, session.missions);
    session.giverBodies.update(session.state);
    // The events and the street crime of spec section 20.5: the crowd an
    // event has drawn and the people in whatever is going on nearby, standing
    // in the same list as the enforcers, and both marked on the map.
    session.streetLife.update(session.state, session.world, session.enforcerMarks);
    // The police on foot of spec section 14, after all of those in the same list.
    session.officerMarks.update(session.state, session.streetLife);
    // The crews of the fire engines at work (spec section 20.3), which end the list.
    session.emergencyCrews.update(session.state, session.officerMarks);
    session.missionMarks.update(session.state, session.officerMarks);
    // The safehouses of spec section 16.3: what a front door costs, or what
    // the house the player is standing in does for them.
    session.homePanel.update(session.state, session.safehouses);
    session.weapons.sync(session.state.loadout);
  }
}
