/**
 * A session in progress: the record, the world it is played in, and everything
 * on top of both.
 *
 * It is the one bag `main.ts` hands to the frame, and it is here rather than
 * there because it names every half of the game at once — the record, the
 * scene, the physics, each panel and each view. `main.ts` builds the pieces and
 * runs the frame; this says what a session is made of.
 */
import type { PostChain } from './render/post.ts';
import type { QualityMonitor, QualityChange } from './render/quality.ts';
import type { RenderSmoother } from './render/smooth.ts';
import type { ParkedView } from './render/parked.ts';
import type { PedestrianView } from './render/pedestrians.ts';
import type { PoliceView } from './render/police.ts';
import type { TrafficView } from './render/traffic.ts';
import type { TramView } from './render/tram.ts';
import type { WorldScene } from './render/world-scene.ts';
import type { SimPhysics } from './sim/physics.ts';
import type { SimState } from './sim/simulation.ts';
import type { MetroPlace } from './sim/metro.ts';
import type { SafehousePlace } from './sim/safehouse.ts';
import type { ShopPlace } from './sim/shop.ts';
import type { DealerPlace } from './sim/dealer.ts';
import type { TerritoryMap } from './sim/territory.ts';
import type { DealerMarks } from './ui/dealers.ts';
import type { EnforcerMarks } from './ui/enforcers.ts';
import type { HomePanel } from './ui/home-panel.ts';
import type { TradePanel } from './ui/trade-panel.ts';
import type { HotwireBar } from './ui/hotwire.ts';
import type { Hud } from './ui/hud.ts';
import type { MapScreen } from './ui/map-screen.ts';
import type { Minimap } from './ui/minimap.ts';
import type { PauseMenu } from './ui/pause.ts';
import type { ShopPanel } from './ui/shop-panel.ts';
import type { TravelPanel } from './ui/travel.ts';
import type { WeaponPicker } from './ui/weapon-picker.ts';

export interface Session {
  state: SimState;
  world: WorldScene;
  physics: SimPhysics;
  /** The effects the world is drawn through (spec section 10.6). */
  post: PostChain;
  /** What watches the frame and steps the quality tiers (spec section 9.2). */
  quality: QualityMonitor;
  hud: Hud;
  /** The corner map of spec section 12, following the player. */
  minimap: Minimap;
  /** The full map of spec section 12: pan, zoom and waypoint. */
  map: MapScreen;
  /** The hotwire minigame of spec section 11.4, drawn while a lock is being worked at. */
  hotwire: HotwireBar;
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
  /** The enforcers of spec section 17.2 on the maps and in the crowd, with the dealers behind them. */
  enforcerMarks: EnforcerMarks;
  /** Whose block is whose (spec section 17.2), which the HUD line and the map overlay read. */
  turf: TerritoryMap;
  /** The safehouse panel of spec section 16.3, drawn at a front door. */
  homePanel: HomePanel;
  /** The properties the panel names and the broker sells, in the order they are numbered. */
  safehouses: readonly SafehousePlace[];
  /** What draws the frame between two ticks, so the motion is smooth (spec section 9.2). */
  smooth: RenderSmoother;
  /** The debug picker of the arsenal, which shows the weapon in hand. */
  weapons: WeaponPicker;
  /** The ambient traffic of spec section 13.1, drawn. */
  traffic: TrafficView;
  /** The police units of spec section 14, drawn. */
  police: PoliceView;
  /** The parked cars of spec section 13.1, drawn; undefined where no worker laid out the bays. */
  parked: ParkedView | undefined;
  /** The trams of spec section 13.2, drawn. */
  tram: TramView;
  /** The pedestrians of spec section 13.1, drawn. */
  crowd: PedestrianView;
  /** The pause menu of spec section 12. While it is open the simulation does not step. */
  pause: PauseMenu;
}

/**
 * Hand a tier to the two halves that draw at it, and say so (spec section 9.2).
 *
 * The line in the console is how a tier change is read back after the fact:
 * the player sees a frame that holds its rate, and the log says what it cost.
 */
export function applyQuality(session: Session, change: QualityChange): void {
  session.world.quality = change.to;
  session.post.quality = change.to.post;
  console.info(
    `quality: ${change.from.name} -> ${change.to.name} at ${change.frameMs.toFixed(1)} ms a frame ` +
      `(budget ${session.quality.budget} ms)`,
  );
}
