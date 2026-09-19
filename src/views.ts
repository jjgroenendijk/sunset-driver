/**
 * The views of one session: the meshes that draw what the city is doing, and
 * the scene they are put into.
 *
 * `city.ts` builds the city — the traffic, the crowd, the tram, the wildlife —
 * as plans evaluated from the tick. This builds the one mesh each of them is
 * drawn in and adds it to the scene. It is here rather than in `main.ts` for
 * the reason the city is: it is one subject, and `main.ts` is the boot.
 *
 * The order matters in one place only. Every view has to be in the scene
 * before the shaders are warmed (`warm.ts`), because WebGPU compiles a
 * pipeline for the object it draws with rather than for the material alone.
 */
import type { City } from './city.ts';
import { EmergencyView } from './render/emergency.ts';
import { ParkedView } from './render/parked.ts';
import { PedestrianView } from './render/pedestrians.ts';
import { PoliceView } from './render/police.ts';
import { TrafficView } from './render/traffic.ts';
import { TramView } from './render/tram.ts';
import { WildlifeView } from './render/wildlife.ts';
import type { WorldScene } from './render/world-scene.ts';
import type { ParkedCars } from './sim/parked.ts';
import type { StandingPerson } from './render/pedestrians.ts';

/** The views of a session, in the order they are drawn. */
export interface SessionViews {
  traffic: TrafficView;
  police: PoliceView;
  emergency: EmergencyView;
  wildlife: WildlifeView;
  /** Undefined where no chunk worker laid out the parking bays. */
  parked: ParkedView | undefined;
  tram: TramView;
  crowd: PedestrianView;
}

/**
 * Build every view of a session and add it to the scene. `standing` is the
 * list of people somebody else owns who are drawn in the crowd's own mesh —
 * the dealers, the enforcers and whoever an event or an incident has put on
 * the street (spec sections 16.2, 17.2, 20.5). It is handed over once and
 * never again: the list is written in place every tick.
 */
export function buildViews(
  world: WorldScene,
  city: Pick<City, 'traffic' | 'crowd' | 'tram' | 'wildlife'>,
  parked: ParkedCars | undefined,
  standing: readonly StandingPerson[],
): SessionViews {
  const views: SessionViews = {
    traffic: new TrafficView(city.traffic),
    police: new PoliceView(),
    emergency: new EmergencyView(),
    wildlife: new WildlifeView(city.wildlife),
    parked: parked === undefined ? undefined : new ParkedView(parked),
    tram: new TramView(city.tram),
    crowd: new PedestrianView(city.crowd, city.tram),
  };
  views.crowd.standing = standing;
  world.scene.add(
    views.traffic.group,
    views.police.group,
    views.emergency.group,
    views.wildlife.group,
    views.tram.group,
    views.crowd.group,
  );
  if (views.parked !== undefined) world.scene.add(views.parked.group);
  return views;
}
