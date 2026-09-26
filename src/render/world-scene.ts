/**
 * The scene the game is played in (spec sections 9.1, 10.1, 10.5).
 *
 * A world is generated once and streamed as chunks around the player. The
 * chunks are built in workers (`chunk-pool.ts`), and `chunk-tiles.ts` puts
 * them into the scene a slice of each frame at a time.
 *
 * Two rings stand around the player (`streaming.ts`). The near ring is the
 * city in full. The far ring is the same ground at a simpler detail, so the
 * skyline holds where the near ring ends.
 *
 * What the hour decides — the sky, the sun, the haze, the lit windows and the
 * street lamps — comes from `daylight.ts` through `WorldScene.time`.
 *
 * The scene reads the world description and never mutates it.
 */
import { Scene, type Material, type Mesh, type Vector3 } from 'three';
import type { MeshStandardNodeMaterial } from 'three/webgpu';
import type { CharacterAppearance } from '../sim/character.ts';
import { airfieldMesh } from './airfield-mesh.ts';
import type { Blaze } from '../sim/fire.ts';
import type { Casualty } from '../sim/casualty.ts';
import type { MeleeHit } from '../sim/melee.ts';
import type { Tracer } from '../sim/tracer.ts';
import type { BoardingState } from '../sim/boarding.ts';
import type { PlayerState } from '../sim/on-foot.ts';
import { START_TICK } from '../sim/simulation.ts';
import { specOf, type VehicleState } from '../sim/vehicle.ts';
import { CLEAR_WEATHER, weatherAt, type Weather } from '../sim/weather.ts';
import { buildCarve, type RoadCarve } from '../world/carve.ts';
import { buildRoadGraph } from '../world/graph.ts';
import { buildJunctions } from '../world/junctions.ts';
import type { MetroStation } from '../world/metro.ts';
import type { Shop, ShopKind, ShopRoom } from '../world/shops.ts';
import type { ParkingBays } from '../world/parking.ts';
import type { Surface } from '../world/surface.ts';
import type { Point, WorldDescription } from '../world/types.ts';
import { BuildingScenery } from './buildings.ts';
import { BuildingCutaway, CAMERA_ROOF_MARGIN } from './cutaway.ts';
import { CharacterModel } from './character.ts';
import type { Hold } from './character-hold.ts';
import { ChunkPool, type ChunkStream } from './chunk-pool.ts';
import { ChunkTiles } from './chunk-tiles.ts';
import { BloodView } from './blood.ts';
import { DamageFx } from './damage-fx.ts';
import { beaconPhase, daylightAt, type Daylight } from './daylight.ts';
import { EntityFade } from './fade.ts';
import { createGroundMaterial } from './ground-material.ts';
import { Headlights } from './headlights.ts';
import { ShopInterior } from './interior.ts';
import type { ChunkContents } from './frame-contents.ts';
import { LampLights, LampScenery } from './lamps.ts';
import type { Gore } from './gore.ts';
import { MeleeFx } from './melee-fx.ts';
import { MetroScenery } from './metro.ts';
import { ShotFx } from './shot-fx.ts';
import { reflectLights } from './mirror.ts';
import { PickupModels } from './pickups.ts';
import { PosterScenery } from './posters.ts';
import { entityDistance, FULL_TIER, shadowDistance, type QualityTier } from './quality.ts';
import { RemotePlayerViews } from './remote-players.ts';
import { RoadScenery } from './roads.ts';
import { roofOver, type RoofBox } from './roofs.ts';
import { SignScenery } from './signs.ts';
import { SkidMarks } from './skid.ts';
import { SkyLighting } from './sky.ts';
import { placeBoarder } from './boarder.ts';
import { seatRider } from './rider.ts';
import { hullOf } from './vehicle-hull.ts';
import type { DrawnPlayer } from './smooth.ts';
import { STREAM_BUDGET_MS } from './streaming.ts';
import { PlantScenery } from './vegetation.ts';
import { VehicleModel } from './vehicle.ts';
import { HeldWeapon, WeaponArt } from './weapon.ts';
import { WeaponFx } from './weapon-fx.ts';
import { ViewModel } from './viewmodel.ts';
import type { Blast } from '../sim/blast.ts';
import type { ProjectileState } from '../sim/weapon.ts';
import { WeatherFx } from './weather-fx.ts';
import { fogOf, overcast, overcastOf } from './weather-look.ts';
import { createWaterSurface, type WaterSurface } from './water-surface.ts';

/** What the damage of a frame is drawn from, beyond the vehicle itself. */
export interface DrawnDamage {
  seed: number;
  /** The tick the record stands at. */
  tick: number;
  hits: readonly MeleeHit[];
  /** The paths of the rounds fired lately. */
  tracers: readonly Tracer[];
  /** The rockets, grenades and bottles in the air, and where they went off. */
  projectiles: readonly ProjectileState[];
  blasts: readonly Blast[];
  /** What the wrecks have left burning on the ground (spec section 20.3). */
  fires: { blazes: readonly Blaze[] };
  /** The people who have been hit, whose blood is on the ground. */
  pedestrians: { casualties: readonly Casualty[] };
}

/** The end of a move into the driver's seat, which is how a driver is sat while driving. */
const SEATED: BoardingState = { way: 'in', start: 0, side: -1, walk: 0 };

/** Milliseconds {@link WorldScene.settle} waits before giving up on the workers. */
const SETTLE_TIMEOUT_MS = 120_000;

/** The world, drawn. */
export class WorldScene {
  readonly scene = new Scene();
  readonly character: CharacterModel;
  readonly vehicle = new VehicleModel();
  /** The other players of a multiplayer room (spec section 21.5). Empty in single player. */
  readonly remotes: RemotePlayerViews;
  /** The geometry every drawn weapon shares (spec section 11.6). */
  private readonly weaponArt = new WeaponArt();
  /** The weapon in the player's hands. */
  readonly held = new HeldWeapon(this.weaponArt);
  /** The weapon and the forearms in view in first person (spec section 10.7). */
  readonly viewModel = new ViewModel(this.weaponArt);
  /** The weapons lying in the world to be picked up. */
  readonly pickups = new PickupModels(this.weaponArt);
  /** The room of the shop the player is standing in (spec section 16.1). */
  readonly interior = new ShopInterior();
  /** The smoke, fire and blast of the vehicle's damage (spec section 11.3). */
  readonly fx = new DamageFx();
  /** The bursts a melee weapon throws off what it lands on (spec section 11.6). */
  readonly melee = new MeleeFx();
  /** The flash, the streak and the burst of every round fired (spec section 11.6). */
  readonly shots = new ShotFx();
  /** The rockets, grenades and bottles in the air, their bursts, and the flamethrower's stream. */
  readonly weapons = new WeaponFx();
  /** The rubber it leaves on the road (spec section 11.3). */
  readonly skid = new SkidMarks();
  /** The blood on the ground: pools, smears and spatter (spec section 11.6). */
  readonly blood = new BloodView();
  readonly world: WorldDescription;
  private readonly stream: ChunkStream;
  private readonly heights: RoadCarve;
  private readonly material: MeshStandardNodeMaterial;
  /** The streamed chunks, and the queue that uploads them (`chunk-tiles.ts`). */
  private readonly tiles: ChunkTiles;
  private readonly scenery = new RoadScenery();
  /** What cuts away a building that hides the player (spec section 10.7). */
  readonly cutaway = new BuildingCutaway();
  private readonly buildings = new BuildingScenery(this.cutaway);
  /**
   * How far the plants and the street lamps are drawn, and the dither that
   * takes them away at that edge (spec section 9.2). It is made before the two
   * sceneries that read it, because their materials are dressed with it.
   */
  private readonly fade = new EntityFade(entityDistance(FULL_TIER));
  private readonly vegetation = new PlantScenery(this.fade);
  private readonly lamps = new LampScenery(this.fade);
  /** The stairs down to a metro station (spec section 13.3). */
  private readonly metroStairs = new MetroScenery(this.fade);
  private readonly airfields: Mesh;
  /** The harm-reduction posters on the walls (spec section 19). */
  private readonly posters = new PosterScenery(this.fade);
  /** The shop signage and the billboards over it, and the neon that lights a few of them. */
  private readonly signs = new SignScenery(this.fade, this.scene);
  private readonly lampLights: LampLights;
  /** The beams the player's vehicle throws (spec section 13.4). */
  private readonly headlights: Headlights;
  private readonly water: WaterSurface;
  private readonly sky: SkyLighting;
  /** The light of the tick the scene was last set to, before the weather is laid over it. */
  private light: Daylight;
  /** That light with the weather over it, which is what the scene is actually lit by. */
  private lit: Daylight;
  /** The weather of that same tick (spec section 13.4), and the tick itself. */
  private weather: Weather = CLEAR_WEATHER;
  private tick = START_TICK;
  /**
   * A weather to draw instead of the seed's, whatever the tick. Only a preview
   * sets it; the game always draws the weather of spec section 13.4.
   */
  fixedWeather: Weather | undefined = undefined;
  /** The rain, the puddles and the litter that weather is drawn as. */
  private readonly weatherFx: WeatherFx;
  /** The quality tier the scene is drawn at (spec section 9.2). */
  private tier: QualityTier = FULL_TIER;
  /** The carved ground, as the skid marks read it: bound once, not made every frame. */
  private readonly height = (x: number, y: number): number => this.heights.heightAt(x, y);

  constructor(world: WorldDescription, appearance: CharacterAppearance, stream: ChunkStream = new ChunkPool(world)) {
    this.world = world;
    this.stream = stream;
    // The carved ground the player and the camera stand on. The chunks carry
    // their own heights from the workers; this is the one place the main
    // thread asks the world itself. The junctions are built for it too, so the
    // ground here is levelled at every junction the way the chunks are.
    this.heights = buildCarve(world.terrain, world.roads, buildJunctions(world.roads, buildRoadGraph(world.roads)));
    this.material = createGroundMaterial(world.water.seaLevel);

    // The sea, the straits, the river and the harbour are one surface at sea
    // level (spec section 7.2), laid over the whole map rather than cut per
    // chunk: its reflection is a second pass over the scene, and one is enough.
    this.water = createWaterSurface(world);
    this.scene.add(this.water.object);
    // The airfields of spec section 8.4 are a handful of boxes, built once.
    this.airfields = airfieldMesh(world.airfields, this.height);
    this.scene.add(this.airfields);

    // The sky, the sun and the shadows it casts. The ground stops at the last
    // chunk of the far ring, and the haze is what stands there until the draw
    // distance of spec section 9.2 does.
    const fog = fogOf(this.tier.rings, this.weather);
    this.sky = new SkyLighting(this.scene, fog.near, fog.far);
    this.lampLights = new LampLights(this.scene);
    this.headlights = new Headlights(this.scene);
    const kit = {
      ground: this.material,
      roads: this.scenery,
      buildings: this.buildings,
      vegetation: this.vegetation,
      lamps: this.lamps,
      metro: this.metroStairs,
      posters: this.posters,
      signs: this.signs,
      lampLights: this.lampLights,
    };
    this.tiles = new ChunkTiles(this.scene, kit, () => this.tier);

    // The rain falls on the carved ground, so it is built after the carve and
    // handed the same height the player stands on.
    this.weatherFx = new WeatherFx(world.seed, this.height);
    this.scene.add(this.weatherFx.group);

    this.remotes = new RemotePlayerViews(world.water.seaLevel);
    this.scene.add(this.remotes.group);
    this.character = new CharacterModel(appearance);
    this.shadeCharacter();
    // The player starts behind the wheel, so the character is built but not
    // drawn; spec section 11.5 is what lets them get out again.
    this.character.group.visible = false;
    this.scene.add(this.character.group);
    this.scene.add(this.vehicle.group);
    this.scene.add(this.held.group);
    this.scene.add(this.viewModel.group);
    this.scene.add(this.pickups.group);
    this.scene.add(this.interior.group);
    this.scene.add(this.fx.group);
    this.scene.add(this.melee.group);
    this.scene.add(this.shots.group);
    this.scene.add(this.weapons.group);
    this.scene.add(this.skid.mesh);
    this.scene.add(this.blood.mesh);
    // Every light stands by now and no pool ever grows, so this is where the
    // water's mirror is handed the whole of the lighting (`mirror.ts`).
    reflectLights(this.scene);

    // A session starts at 08:00, so the first frame is already lit.
    this.light = daylightAt(START_TICK);
    this.lit = this.light;
    this.apply();
  }

  /**
   * Light the scene as it stands at a tick (spec section 10.5). One in-game day
   * is 86 400 ticks, so the whole cycle runs in 24 real minutes. Everything the
   * hour decides is set here: the sky, the sun, the haze, the lit windows and
   * the street lamps.
   */
  set time(tick: number) {
    this.tick = tick;
    this.light = daylightAt(tick);
    this.weather = this.fixedWeather ?? weatherAt(this.world.seed, tick);
    this.apply();
  }

  /**
   * Put the player's vehicle where the record says it is, and light it for the
   * hour: the lamps of the model itself, and the beams it lays on the road.
   * This is the door onto the model, because a car drawn without it is a car
   * driving through the night with its lights off.
   */
  setVehicle(v: VehicleState): void {
    this.vehicle.set(v);
    this.vehicle.lamps = this.lit.lamps;
    this.headlights.aim(v, this.vehicle.vehicle, this.lit.lamps);
  }

  /**
   * How far on the street lamps are, 0 by day and 1 after dark, with the
   * weather over them. Everything that lights up at dusk and is not drawn by
   * this scene — the traffic and the police — runs off this one number.
   */
  get lampsNow(): number {
    return this.lit.lamps;
  }

  /** The weather at the tick the scene was last set to. The HUD reads it. */
  get weatherNow(): Weather {
    return this.weather;
  }

  /** The carved height of the ground at a place, so things stand on it. */
  heightAt(x: number, y: number): number {
    return this.heights.heightAt(x, y);
  }

  /**
   * Draw what the vehicle's damage calls for (spec section 11.3): the smoke and
   * the flames over it, and the rubber its sliding tyres leave on the road.
   * Called once a frame, after the model has been set from the same record.
   *
   * The blows a melee weapon has landed are drawn here too (spec section
   * 11.6), because they are the same thing: a burst thrown off the record at a
   * tick, coloured by what it says was struck. So are the rounds fired.
   *
   * `surfaceAt` is the city's own answer for what the ground is made of, the
   * one the physics gripped through, so rubber is left exactly where a tyre
   * could have left it.
   */
  damage(v: VehicleState, record: DrawnDamage, tick: number, surfaceAt: (x: number, y: number) => Surface): void {
    // The blazes stand on the ground, and how high the ground is here is
    // something only the scene knows.
    this.fx.watch(record.fires.blazes, (x, y) => this.heightAt(x, y));
    this.fx.update(v, this.vehicle.vehicle, record.seed, tick);
    this.skid.update(v, this.vehicle.vehicle, this.height, surfaceAt);
    this.melee.update(record.hits, record.seed, tick);
    this.shots.update(record.tracers, record.seed, tick);
    this.weapons.update(record, record.seed, tick);
    this.blood.update(record.pedestrians.casualties, record.hits, record.tracers, tick, this.height);
  }

  /**
   * How much blood is drawn (`gore.ts`): the bursts off a person, the blood a
   * round throws and the marks on the ground. It changes the picture only.
   */
  set gore(level: Gore) {
    this.melee.gore = level;
    this.shots.gore = level;
    this.blood.gore = level;
  }

  /**
   * Stand the player's model where the frame says they are, and move it (spec
   * sections 11.2, 11.5). `drawn` is the pose between the last two ticks and
   * `player` the record itself, which says whether the feet are on the ground
   * and how fast the body is going up; `dt` is the seconds since the last
   * frame, which carries the cycle along. A player behind the wheel is not
   * drawn, so nothing is animated for them; one on a motorcycle is drawn
   * astride it, from the record of the vehicle they are on.
   */
  walkPlayer(
    drawn: DrawnPlayer,
    player: PlayerState,
    dt: number,
    swing = -1,
    hold?: Hold,
    handsUp = false,
    vehicle?: VehicleState,
    boarding?: { state: BoardingState; progress: number },
  ): void {
    const model = this.character;
    this.vehicle.openDoor(0, 0);
    // An aircraft's blades turn while somebody is flying it.
    this.vehicle.spin(player.driving ? dt : 0);
    // A player getting in or out is drawn doing it, in the vehicle's frame,
    // and the door they go through swings with them (`boarder.ts`).
    if (boarding !== undefined && vehicle !== undefined) {
      const frame = placeBoarder(model, vehicle, specOf(vehicle.cls), boarding.state, boarding.progress, drawn);
      this.vehicle.openDoor(boarding.state.side, frame.door);
      model.group.visible = true;
      return;
    }
    // A player on a motorcycle is on top of it rather than inside it, so the
    // model is seated on the saddle instead of hidden (`rider.ts`).
    if (player.driving && vehicle !== undefined && seatRider(model, vehicle, specOf(vehicle.cls))) {
      model.group.visible = true;
      return;
    }
    // A driver behind glass that is seen through sits in the seat, as the
    // boarding move left them, rather than vanishing (`vehicle-hull.ts`).
    if (player.driving && vehicle !== undefined && hullOf(specOf(vehicle.cls)) !== undefined) {
      placeBoarder(model, vehicle, specOf(vehicle.cls), SEATED, 1, drawn);
      model.group.visible = true;
      return;
    }
    model.group.position.set(drawn.x, drawn.height, drawn.y);
    // Set the whole turn, not the yaw alone: a rider just off a bike carries
    // its roll and its pitch until something writes over them.
    model.group.rotation.set(0, -drawn.heading, 0);
    model.group.visible = !player.driving;
    if (player.driving) return;
    model.animate(
      {
        speed: drawn.speed,
        grounded: player.grounded,
        vy: player.vy,
        depth: Math.max(0, this.world.water.seaLevel - drawn.height),
        stature: model.height,
        swing,
        handsUp,
      },
      dt,
      handsUp ? undefined : hold,
    );
  }

  /** Build the player's model for a look, such as the one a loaded save carries. Every part casts a shadow. */
  dress(appearance: CharacterAppearance): void {
    this.character.set(appearance);
    this.shadeCharacter();
  }

  private shadeCharacter(): void {
    this.character.group.traverse((object) => {
      object.castShadow = true;
    });
  }

  /** Forget the smoke and the marks: a vehicle put down somewhere else, or a loaded save. */
  resetDamage(tick: number): void {
    this.fx.reset(tick);
    this.melee.reset(tick);
    this.shots.reset(tick);
    this.weapons.reset(tick);
    this.blood.reset(tick);
    this.skid.clear();
  }

  /**
   * Follow the player: drop the chunks that are out of reach, ask for the ones
   * that are missing, and put as much of what has arrived into the scene as
   * `budgetMs` allows. Called once a frame.
   */
  update(x: number, y: number, budgetMs = STREAM_BUDGET_MS, now: () => number = performance.now.bind(performance)): void {
    this.tiles.follow(this.stream, x, y, budgetMs, now);
    this.look(x, y);
  }

  /**
   * Draw the world at a quality tier (spec section 9.2). The scene owns five
   * of the tier's knobs: the draw distance, the haze that closes at the end of
   * it, the sun's shadow, how much of each category a chunk places, and the
   * share of the frame the water's mirror is rendered at. `PostChain` owns the
   * rest.
   *
   * Nothing already in the scene is rebuilt. A tier that pulls the rings in
   * drops the chunks past the new far ring at once and asks for the ones that
   * cross between the two details again, which is the change the frame feels;
   * a chunk already standing keeps the plants it was built with until the
   * player drives away from it. Rebuilding the whole city on a tier change
   * would be the hitch the tiers exist to avoid.
   */
  set quality(tier: QualityTier) {
    this.tier = tier;
    const fog = fogOf(tier.rings, this.weather);
    this.sky.setFog(fog.near, fog.far);
    this.sky.shadowMapSize = tier.shadowMapSize;
    this.sky.shadowDistance = shadowDistance(tier);
    this.fade.distance = entityDistance(tier);
    this.water.mirror = tier.mirror;
  }

  get quality(): QualityTier {
    return this.tier;
  }

  /**
   * Draw the water sheet on the next frame wherever the player stands, so that
   * frame compiles the mirror pass. {@link WorldScene.look} hides it again the
   * frame after, off the water that stands near. The one caller is the warm-up
   * behind the loading screen: an inland session that never showed the sheet
   * compiles every material again for the mirror the first time the sea comes
   * into view, which is a frame the player is driving through.
   */
  showWater(): void {
    this.water.show();
  }

  /**
   * Draw the sun's shadow maps on the next frame. {@link WorldScene.look} asks
   * for them once a frame, and the warm-up behind the loading screen draws its
   * frames without it: every frame after the first would be drawn with the maps
   * the first one left, and the shadow pass of a material would never be
   * compiled at all. The one caller is that warm-up.
   */
  drawShadow(): void {
    this.sky.drawShadowOnce();
  }

  /**
   * Point what is lit at the player without building anything: the dome is
   * carried rather than laid around the map, and the light pool is handed to
   * the lamps the player has come nearest to. The water sheet is shown or
   * hidden here too, off the water that stands near: its mirror is a second
   * pass over the scene, and where no water is in view the frame pays for
   * none of it.
   */
  look(x: number, y: number): void {
    this.sky.follow(x, y);
    this.sky.drawShadowOnce();
    // The dither fade of spec section 9.2 measures its ring from the player,
    // as the streaming does, and not from the camera behind them.
    this.fade.focus(x, y);
    this.water.follow(x, y);
    this.lampLights.aim(x, y, this.tiles.lampsInReach(), this.lit.lamps);
    this.signs.aim(x, y, this.lit.lamps);
    this.weatherFx.update(this.weather, this.tick, x, y);
  }

  /**
   * The tallest building standing over a ground point, from the chunks around
   * it, or undefined over open ground. The camera of spec section 10.7 reads it
   * to find the building it is in. `margin` grows every footprint.
   */
  roofOver(x: number, z: number, margin = 0): RoofBox | undefined {
    return roofOver(this.tiles.roofsNear(x, z), x, z, margin);
  }

  /**
   * Aim the cutaway for the frame about to be drawn: the camera as it now
   * stands, and the player at the height of their feet.
   */
  seeThrough(camera: Vector3, x: number, height: number, y: number, inShop = false): void {
    // A player inside a shop is under the building that holds it, and the
    // camera is over its roof: it is the shell over the player that has to go,
    // or the room the clip of `interior.ts` opened is roofed over again.
    const overX = inShop ? x : camera.x;
    const overZ = inShop ? y : camera.z;
    const over = this.cutaway.enabled ? this.roofOver(overX, overZ, CAMERA_ROOF_MARGIN) : undefined;
    const inside = inShop || (over !== undefined && over.top + CAMERA_ROOF_MARGIN > camera.y) ? over : undefined;
    this.cutaway.aim(camera, x, height, y, inside);
  }

  /**
   * Draw the inside of the shop the player is standing in (spec section 16.1),
   * and nothing where they are out on the street. The room stands on the carved
   * ground under its own floor.
   */
  shopInside(place: { kind: ShopKind; room: ShopRoom } | undefined): void {
    if (place === undefined) {
      this.interior.hide();
      return;
    }
    this.interior.show(place.room, this.heightAt(place.room.x, place.room.y), place.kind);
  }

  /** Refit the sun's shadow cascades after the camera's shape changes. */
  resize(): void {
    this.sky.resize();
  }

  /**
   * Build every chunk within `radius` of the player and come back when the
   * last of them is in the scene. The frame loop has not started yet when this
   * is called, so the budget is the whole of the time rather than a slice of
   * it: this is the wait before the first frame, not a frame.
   *
   * `onProgress` is told how many chunks are done out of how many are wanted,
   * which is what the loading screen of `loading.ts` draws. The total is the
   * most ever outstanding rather than a count made in advance, because a chunk
   * already in the scene was never outstanding at all.
   */
  async settle(
    x: number,
    y: number,
    radius = this.tier.rings.far,
    timeoutMs = SETTLE_TIMEOUT_MS,
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    const until = performance.now() + timeoutMs;
    let total = 0;
    for (;;) {
      this.update(x, y, Infinity);
      const outstanding = this.tiles.outstanding(x, y, radius);
      total = Math.max(total, outstanding);
      onProgress?.(total - outstanding, total);
      if (outstanding === 0) return;
      if (performance.now() > until) {
        throw new Error(`the chunk workers did not answer: ${outstanding} chunks outstanding`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  /**
   * Draw calls the dearest chunk of the near ring costs, a draw for each cell
   * of each batch. Spec section 9.2 caps the city at a small number of draws,
   * and `CHUNK_DRAW_CALL_CAP` is what a chunk may spend of it; the HUD shows this so a regression is visible while
   * playing rather than only in the test that enforces the cap.
   */
  get drawCallsPerChunk(): number {
    return this.tiles.drawCallsPerChunk;
  }

  /**
   * The police stations of the world (spec section 11.7), or undefined until a
   * chunk worker has built the parcels. {@link WorldScene.settle} waits for a
   * worker, so they are known once it returns.
   */
  get stations(): readonly Point[] | undefined {
    return this.stream.stations;
  }

  /** The metro stations of the world (spec section 13.3), known with the police stations. */
  get metro(): readonly MetroStation[] | undefined {
    return this.stream.metro;
  }

  /** The shops of the world (spec section 16.1), known with the police stations. */
  get shops(): readonly Shop[] | undefined {
    return this.stream.shops;
  }

  /** The parking bays of the world (spec section 13.1), or undefined until a chunk worker has laid them out. */
  get bays(): ParkingBays | undefined {
    return this.stream.bays;
  }

  /** What every chunk in the scene holds, for counting what a frame shows. */
  get contents(): ChunkContents[] {
    return this.tiles.contents();
  }

  /** Chunks asked for and not yet drawn, which the HUD shows as the city fills in. */
  get streaming(): number {
    return this.stream.pending + this.tiles.queued;
  }

  /** How far into the night it is, 0 by day and 1 at midnight, at the tick last set. */
  get night(): number {
    return this.light.night;
  }

  /**
   * Lights the scene holds (spec section 10.5): the sun, the sky fill and the
   * street lamps and the neon that are throwing light, and the headlights. The
   * HUD shows this beside the draw calls, so a light leak is visible while
   * playing.
   */
  get lightCount(): number {
    return this.sky.lightCount + this.lampLights.count + this.headlights.count + this.signs.lightCount;
  }

  /** Shadow maps the sun is split into. The lamps cast none. */
  get shadowCascades(): number {
    return this.sky.shadowCascades;
  }

  /** Release every chunk, the workers that built them and the materials they share. */
  dispose(): void {
    this.tiles.dispose();
    this.stream.dispose();
    this.scene.remove(this.water.object);
    this.water.dispose();
    this.scene.remove(this.airfields);
    this.airfields.geometry.dispose();
    (this.airfields.material as Material).dispose();
    this.sky.dispose();
    this.lampLights.dispose();
    this.headlights.dispose();
    this.material.dispose();
    this.scenery.dispose();
    this.buildings.dispose();
    this.vegetation.dispose();
    this.lamps.dispose();
    this.metroStairs.dispose();
    this.posters.dispose();
    this.signs.dispose();
    this.character.dispose();
    this.scene.remove(this.remotes.group);
    this.remotes.dispose();
    this.scene.remove(this.vehicle.group);
    this.vehicle.dispose();
    this.scene.remove(this.held.group, this.pickups.group, this.viewModel.group);
    this.held.dispose();
    this.pickups.dispose();
    this.weaponArt.dispose();
    this.scene.remove(this.fx.group, this.melee.group, this.shots.group, this.weapons.group);
    this.fx.dispose();
    this.melee.dispose();
    this.shots.dispose();
    this.weapons.dispose();
    this.viewModel.dispose();
    this.scene.remove(this.skid.mesh);
    this.skid.dispose();
    this.scene.remove(this.blood.mesh);
    this.blood.dispose();
    this.scene.remove(this.weatherFx.group);
    this.weatherFx.dispose();
  }

  /**
   * Hand the light of the moment to everything that reads it. The weather is
   * laid over the day's own light first, so the sky, the water and the lamps
   * all read one number and none of them learns a second rule.
   */
  private apply(): void {
    const light = overcast(this.light, this.weather);
    this.lit = light;
    this.sky.set(light);
    this.sky.clouds = overcastOf(this.weather);
    const fog = fogOf(this.tier.rings, this.weather);
    this.sky.setFog(fog.near, fog.far);
    this.water.setDaylight(light);
    this.buildings.night = light.night;
    this.buildings.late = light.late;
    this.buildings.beacon = beaconPhase(this.tick);
    this.lamps.lamps = light.lamps;
    this.metroStairs.lamps = light.lamps;
    this.signs.night = light.lamps;
  }
}
