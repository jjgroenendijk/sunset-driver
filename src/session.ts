/**
 * A session in progress: the record, the world it is played in, and everything
 * on top of both.
 *
 * It is the one bag `main.ts` hands to `frame.ts`, and it is here rather than
 * there because it names every half of the game at once — the record, the
 * scene, the physics, each panel and each view. `main.ts` builds the pieces and
 * `frame.ts` runs them; this says what a session is made of.
 */
import type { PostChain } from './render/look/post.ts';
import { tierOf, type GraphicsChoice } from './render/frame/graphics.ts';
import type { QualityTier } from './render/frame/quality.ts';
import type { QualityMonitor, QualityChange } from './render/frame/quality-monitor.ts';
import type { RenderSmoother } from './render/frame/smooth.ts';
import type { ParkedView } from './render/vehicles/parked.ts';
import type { BusStopView } from './render/transit/bus-stops.ts';
import type { CornerPropView } from './render/crime/corners.ts';
import type { PedestrianView } from './render/people/pedestrians.ts';
import type { CasualtyView } from './render/people/casualties.ts';
import type { ContactMarkers } from './render/crime/markers.ts';
import type { OfficerGunView } from './render/services/officer-guns.ts';
import type { EmergencyView } from './render/services/emergency.ts';
import type { WildlifeView } from './render/environment/wildlife.ts';
import type { PoliceView } from './render/services/police.ts';
import type { TrafficView } from './render/vehicles/traffic.ts';
import type { TramView } from './render/transit/tram.ts';
import type { TramStopView } from './render/transit/tram-stops.ts';
import type { TramSignView } from './render/transit/tram-signs.ts';
import type { WorldScene } from './render/world-scene.ts';
import type { SimPhysics } from './sim/physics/physics.ts';
import type { SimState } from './sim/simulation.ts';
import type { Surface } from './world/terrain/surface.ts';
import type { MetroPlace } from './sim/transit/metro.ts';
import type { SafehousePlace } from './sim/places/safehouse.ts';
import type { ShopPlace } from './sim/places/shop.ts';
import type { DealerPlace } from './sim/crime/dealer.ts';
import type { MissionWorld } from './sim/missions/job.ts';
import type { TerritoryMap } from './sim/crime/territory.ts';
import type { DealerMarks } from './ui/hud/dealers.ts';
import type { GiverBodies } from './ui/hud/givers.ts';
import type { EnforcerMarks } from './ui/hud/enforcers.ts';
import type { EmergencyCrews } from './ui/hud/emergency-crews.ts';
import type { OfficerMarks } from './ui/hud/officers.ts';
import type { StreetLife } from './ui/hud/street-life.ts';
import type { HomePanel } from './ui/panels/home-panel.ts';
import type { JobPanel } from './ui/panels/job-panel.ts';
import type { MissionMarks } from './ui/map/missions.ts';
import type { TradePanel } from './ui/panels/trade-panel.ts';
import type { HotwireBar } from './ui/panels/hotwire.ts';
import type { InteractPrompt } from './ui/hud/interact-prompt.ts';
import type { DistrictTitle } from './ui/hud/district-title.ts';
import type { Hud } from './ui/hud/hud.ts';
import type { MapScreen } from './ui/map/map-screen.ts';
import type { Minimap } from './ui/map/minimap.ts';
import type { Navigator } from './ui/map/map-route.ts';
import type { PauseMenu } from './ui/menus/pause.ts';
import type { PartyControl } from './net/control.ts';
import type { ShopPanel } from './ui/panels/shop-panel.ts';
import type { TravelPanel } from './ui/panels/travel.ts';
import type { WeaponPicker } from './ui/panels/weapon-picker.ts';

export interface Session {
  state: SimState;
  world: WorldScene;
  physics: SimPhysics;
  /**
   * What the ground is made of at a place, as the city laid it out. The physics
   * grips through this, and the skid marks of spec section 11.3 are laid on it,
   * so both halves read one answer.
   */
  surfaceAt: (x: number, y: number) => Surface;
  /** The effects the world is drawn through (spec section 10.6). */
  post: PostChain;
  /**
   * What watches the frame and steps the quality tiers (spec section 9.2).
   * It is asked only while the Graphics setting is Auto.
   */
  quality: QualityMonitor;
  hud: Hud;
  /** The corner map of spec section 12, following the player. */
  minimap: Minimap;
  /** The full map of spec section 12: pan, zoom and waypoint. */
  map: MapScreen;
  /** The road route from the player to the waypoint, drawn on both maps. */
  navigator: Navigator;
  /** The hotwire minigame of spec section 11.4, drawn while a lock is being worked at. */
  hotwire: HotwireBar;
  /** What the interact key would do to a vehicle now: get in, hotwire, get out. */
  interact: InteractPrompt;
  /** The name of a district the player has just crossed into. */
  districtTitle: DistrictTitle;
  /** The metro station panel and the fade of a trip (spec section 13.3). */
  travel: TravelPanel;
  /** The station entrances the panel names, in the order the record numbers them. */
  metro: readonly MetroPlace[];
  /** The shop counter of spec section 16.1, drawn at a door and inside a shop. */
  shopPanel: ShopPanel;
  /** The shops the panel names, in the order the record numbers them. */
  shops: readonly ShopPlace[];
  /** The trading panel of spec section 16.2, drawn at a dealer's corner and in a deal. */
  tradePanel: TradePanel;
  /** The dealers the panel names, in the order the record numbers them. */
  dealers: readonly DealerPlace[];
  /** Their marks on the maps and their bodies in the crowd, moved when they move. */
  dealerMarks: DealerMarks;
  /** The contacts of spec section 18 standing on their corners, who begin that same list. */
  giverBodies: GiverBodies;
  /** The enforcers of spec section 17.2 on the maps and in the crowd, with the dealers behind them. */
  enforcerMarks: EnforcerMarks;
  /** The events and the street crime of spec section 20.5, as people and marks. */
  streetLife: StreetLife;
  /** The police on foot of spec section 14, as people in uniform and marks, after everybody above. */
  officerMarks: OfficerMarks;
  /** The crews of the fire engines at work (spec section 20.3), after the police in the same list. */
  emergencyCrews: EmergencyCrews;
  /** Whose block is whose (spec section 17.2), which the HUD line and the map overlay read. */
  turf: TerritoryMap;
  /** The safehouse panel of spec section 16.3, drawn at a front door. */
  homePanel: HomePanel;
  /** The properties the panel names and the broker sells, in the order they are numbered. */
  safehouses: readonly SafehousePlace[];
  /** The board at a contact's corner (spec section 18), drawn where the shop counter is. */
  jobPanel: JobPanel;
  /** The contacts the board names and the corners their work runs between. */
  missions: MissionWorld;
  /** The mark on wherever the job in hand is going, moved as its legs are worked through. */
  missionMarks: MissionMarks;
  /** What draws the frame between two ticks, so the motion is smooth (spec section 9.2). */
  smooth: RenderSmoother;
  /** The debug picker of the arsenal, which shows the weapon in hand. */
  weapons: WeaponPicker;
  /** The ambient traffic of spec section 13.1, drawn. */
  traffic: TrafficView;
  /** The police units of spec section 14, drawn. */
  police: PoliceView;
  /** The fire engines and the ambulances of spec section 20.3, drawn. */
  emergency: EmergencyView;
  /** The animals of spec section 20.4, drawn. */
  wildlife: WildlifeView;
  /** The parked cars of spec section 13.1, drawn; undefined where no worker laid out the bays. */
  parked: ParkedView | undefined;
  /** The trams of spec section 13.2, drawn. */
  tram: TramView;
  /** The island platforms and shelters of their stops. */
  tramStops: TramStopView;
  tramSigns: TramSignView;
  /** The bus stops of spec section 20.2, drawn. */
  busStops: BusStopView;
  /** The amps, carts, stalls and dogs of the occupied corners of spec section 20.1. */
  corners: CornerPropView;
  /** The pedestrians of spec section 13.1, drawn. */
  crowd: PedestrianView;
  /** The people who have been hit, lying, limping or crawling, and the medics at them (spec section 11.6). */
  casualties: CasualtyView;
  /** The guns in the hands of the police on foot who have them out (spec section 14). */
  guns: OfficerGunView;
  /** The marker over each mission contact in view (spec section 18). */
  markers: ContactMarkers;
  /** The pause menu of spec section 12. While it is open a single-player session does not step. */
  pause: PauseMenu;
  /** The room of spec section 21, offline until a game is opened or a link names one. */
  party: PartyControl;
}

/** The tier the frame is drawn at: the monitor's while Auto is on, else the player's own. */
export function drawnTier(graphics: GraphicsChoice, monitor: QualityMonitor): QualityTier {
  return graphics.auto ? monitor.tier : tierOf(graphics);
}

/** Hand a tier to the two halves that draw at it. */
export function drawAt(world: WorldScene, post: PostChain, tier: QualityTier): void {
  world.quality = tier;
  post.quality = tier.post;
}

/**
 * Hand a tier the monitor moved to to the two halves that draw at it, and say
 * so (spec section 9.2).
 *
 * The line in the console is how a tier change is read back after the fact:
 * the player sees a frame that holds its rate, and the log says what it cost.
 */
export function applyQuality(session: Session, change: QualityChange): void {
  drawAt(session.world, session.post, change.to);
  console.info(
    `quality: ${change.from.name} -> ${change.to.name} at ${change.frameMs.toFixed(1)} ms a frame ` +
      `(budget ${session.quality.budget} ms)`,
  );
}
