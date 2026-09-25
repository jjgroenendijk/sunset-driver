/**
 * The ambient beds of spec section 15: the sound of the place itself, under
 * everything else the mix is doing.
 *
 * A bed is not an event. Nothing in the record says the tide is in or that it
 * is dawn in a park, so a bed is read off where the player stands, what the
 * weather is doing and what hour it is. This file is the whole of that rule and
 * it is pure: it holds no Tone.js, takes a {@link Site} rather than the world,
 * and answers gains. `beds.ts` turns those gains into noise, and `site.ts`
 * answers the site from the world description.
 *
 * Birds and gulls are not beds. A bird is a call with a silence after it, so it
 * is fired as a one-shot at a rate this file also decides; a bed is what is
 * there between the calls. {@link callsFor} answers that rate, per tick, so the
 * planner can ask about every tick a frame stepped and a slow frame loses
 * nothing.
 *
 * The numbers here are what is heard where, not how any of it sounds. A change
 * of voice belongs in `beds.ts`; a change of rule belongs here, where
 * `test/audio.test.ts` reads it without a browser.
 */
import { clamp, smoothstep } from '../core/math.ts';
import { TICK_RATE } from '../sim/clock.ts';
import type { Weather } from '../sim/weather.ts';

/**
 * What the ground around the listener is like. Three numbers, each 0 to 1,
 * because that is all a bed needs to know: `site.ts` reads them off the zones,
 * the districts and the beaches of the world description.
 */
export interface Site {
  /** How built up it is: 0 open country, 1 the middle of the core. */
  built: number;
  /** How much green there is: 0 pavement, 1 wilderness. */
  green: number;
  /** How near the sea is: 0 out of earshot, 1 standing at the waterline. */
  shore: number;
}

/** A site with nothing in it, which is what a session without a world gets. */
export const NOWHERE: Site = Object.freeze({ built: 0, green: 0, shore: 0 });

/** Where the planner asks what the ground around a point is like. */
export interface SiteSource {
  siteAt(x: number, y: number): Site;
}

/** The beds and how loud each one stands, 0 to 1. */
export interface BedPlan {
  /** The hum of a city: tyres, plant and distance, with no one vehicle in it. */
  traffic: number;
  /** Surf, breathing in and out on its own. */
  surf: number;
  /** Wind, which the open ground carries and the streets break up. */
  wind: number;
  /** Rain falling. */
  rain: number;
  /** The ring the rain has on metal: roofs, gantries and parked cars. */
  metal: number;
}

/** How often a bird and a gull call, as a chance per tick. */
export interface CallRates {
  bird: number;
  gull: number;
}

/** Beds that ask for nothing, which is what a paused or muted session gets. */
export function silentBeds(): BedPlan {
  return { traffic: 0, surf: 0, wind: 0, rain: 0, metal: 0 };
}

/** Calls at full strength, per second, before the site and the weather take their share. */
const BIRD_CALLS = 0.8;
const GULL_CALLS = 0.5;

/** Metres a call is placed within, around the listener. */
export const CALL_NEAR = 8;
export const CALL_FAR = 60;

/**
 * The beds at one moment. `hour` runs 0 to 24 and is the game's own clock of
 * spec section 13.4, not the wall clock.
 */
export function bedsFor(site: Site, weather: Weather, hour: number): BedPlan {
  const awake = townAwake(hour);
  return {
    // A quiet street at four in the morning is still a street, so the hum
    // thins rather than stops. Bad weather takes the traffic off the road
    // (spec section 13.4), and `weather.crowd` is how much of it is left.
    traffic: site.built * (0.25 + 0.75 * awake) * (0.4 + 0.6 * weather.crowd),
    // Surf is there whatever the hour; wind is what makes it heavy.
    surf: site.shore * (0.75 + 0.25 * weather.wind),
    // Wind is heard where there is nothing to break it: open ground and trees.
    // A street of towers is sheltered, and hears the same gale as a mutter.
    wind: weather.wind * (0.3 + 0.7 * clamp(1 - site.built + 0.3 * site.green, 0, 1)),
    rain: weather.rain,
    // Rain on metal is a city sound: it wants roofs and parked cars under it.
    metal: weather.rain * (0.2 + 0.8 * site.built),
  };
}

/**
 * How often a bird and a gull call here, as a chance per tick. Both go quiet
 * in the rain, because they shelter as the crowd does.
 */
export function callsFor(site: Site, weather: Weather, hour: number): CallRates {
  const dry = clamp(1 - weather.rain, 0, 1);
  return {
    bird: (BIRD_CALLS / TICK_RATE) * site.green * chorusAt(hour) * dry,
    gull: (GULL_CALLS / TICK_RATE) * site.shore * (0.35 + 0.65 * sunUp(hour)) * dry,
  };
}

/**
 * How far up the sun is, 0 at night and 1 by day. It is the hour alone: the
 * sun of `render/daylight.ts` is a vector for the light, and the audio wants a
 * number and no three.js.
 */
export function sunUp(hour: number): number {
  return clamp(smoothstep(5, 7.5, hour) - smoothstep(19, 21.5, hour), 0, 1);
}

/**
 * How awake the town is, 0 to 1. It wakes over the early morning, holds
 * through the working day and falls away through the evening, reaching nothing
 * in the small hours. The hum a street keeps even then is the floor
 * {@link bedsFor} adds under this.
 */
export function townAwake(hour: number): number {
  return clamp(smoothstep(4, 8, hour) * (1 - smoothstep(20, 26, hour)), 0, 1);
}

/**
 * How hard the birds are singing, 0 to 1. They sing through the day and loudest
 * at first light, which is the window either side of six; the night is silent
 * rather than nearly silent, because a call at three in the morning is a bug
 * somebody would have to go looking for.
 */
export function chorusAt(hour: number): number {
  const dawn = clamp(smoothstep(4.2, 5.4, hour) - smoothstep(6.5, 8.5, hour), 0, 1);
  return clamp(Math.max(0.55 * sunUp(hour), dawn), 0, 1);
}
