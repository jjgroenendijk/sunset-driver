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
import { CasualtyView } from './render/casualties.ts';
import { BusStopView } from './render/bus-stops.ts';
import { CornerPropView } from './render/corners.ts';
import { ContactMarkers, type ContactMark } from './render/markers.ts';
import { EmergencyView } from './render/emergency.ts';
import { OfficerGunView } from './render/officer-guns.ts';
import { ParkedView } from './render/parked.ts';
import { PedestrianView } from './render/pedestrians.ts';
import { PoliceView } from './render/police.ts';
import { TrafficView } from './render/traffic.ts';
import { TramView } from './render/tram.ts';
import { TramSignView } from './render/tram-signs.ts';
import { TramStopView } from './render/tram-stops.ts';
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
  /** The island platforms, shelters and flags of the tram stops of spec section 13.2. */
  tramStops: TramStopView;
  tramSigns: TramSignView;
  /** The posts and the shelters of the bus stops of spec section 20.2. */
  busStops: BusStopView;
  /** The amps, carts, stalls and dogs of the occupied corners of spec section 20.1. */
  corners: CornerPropView;
  crowd: PedestrianView;
  /** The people who have been hit, and the medics at them. */
  casualties: CasualtyView;
  /** The guns in the hands of the police on foot who have them out. */
  guns: OfficerGunView;
  /** The marker over each mission contact in view (spec section 18). */
  markers: ContactMarkers;
}

/**
 * Build every view of a session and add it to the scene. `standing` is the
 * list of people somebody else owns who are drawn in the crowd's own mesh —
 * the dealers, the enforcers and whoever an event or an incident has put on
 * the street (spec sections 16.2, 17.2, 20.5). It is handed over once and
 * never again: the list is written in place every tick. `contacts` is the
 * markers over the mission contacts, handed over the same way.
 */
export function buildViews(
  world: WorldScene,
  city: Pick<City, 'traffic' | 'busStops' | 'corners' | 'crowd' | 'tram' | 'wildlife'>,
  parked: ParkedCars | undefined,
  standing: readonly StandingPerson[],
  contacts: readonly ContactMark[],
): SessionViews {
  const views: SessionViews = {
    traffic: new TrafficView(city.traffic),
    police: new PoliceView(),
    emergency: new EmergencyView(),
    wildlife: new WildlifeView(city.wildlife),
    parked: parked === undefined ? undefined : new ParkedView(parked),
    tram: new TramView(city.tram),
    tramStops: new TramStopView(city.tram),
    tramSigns: new TramSignView(city.tram),
    busStops: new BusStopView(city.busStops),
    corners: new CornerPropView(city.corners),
    crowd: new PedestrianView(city.crowd, city.tram, city.busStops, city.corners),
    casualties: new CasualtyView(city.crowd),
    guns: new OfficerGunView(),
    markers: new ContactMarkers(contacts.length),
  };
  views.crowd.standing = standing;
  views.markers.marks = contacts;
  world.scene.add(
    views.traffic.group,
    views.police.group,
    views.emergency.group,
    views.wildlife.group,
    views.tram.group,
    views.tramStops.group,
    views.tramSigns.group,
    views.busStops.group,
    views.corners.group,
    views.crowd.group,
    views.casualties.group,
    views.guns.group,
    views.markers.group,
  );
  if (views.parked !== undefined) world.scene.add(views.parked.group);
  return views;
}
