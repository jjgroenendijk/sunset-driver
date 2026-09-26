import { describe, expect, it } from 'vitest';
import { withBeachCulture } from '../../../src/world/terrain/beaches.ts';
import type { Beach, Culture, District } from '../../../src/world/types.ts';

function district(id: number, name: string, culture: Culture): District {
  return { id, name, zone: 'suburban', x: id * 100, y: 0, density: 0.5, wealth: 0.5, culture };
}

function resort(districts: number[]): Beach {
  const shore = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ];
  return {
    id: 0,
    shore,
    back: shore,
    length: 100,
    sand: [],
    shallows: [],
    boardwalk: shore,
    boardwalkRoad: 0,
    pier: undefined,
    carParks: [],
    districts,
  };
}

describe('withBeachCulture', () => {
  it('leaves the culture of a named neighbourhood a resort runs through alone', () => {
    // Spec sections 8.3 and 17.2, issue #348: The Docks keeps its culture, so
    // the Docklands Mob keep their home turf; the districts with none take the beach.
    const districts = [district(0, 'The Docks', 'irish'), district(1, 'The Boardwalk', 'none'), district(2, 'Bayview', 'none')];
    const out = withBeachCulture(districts, [resort([0, 1, 2])]);
    expect(out.map((d) => d.culture)).toEqual(['irish', 'beach', 'beach']);
  });

  it('gives The Boardwalk the beach culture even where the resort does not list it', () => {
    const districts = [district(0, 'Gull Island', 'irish'), district(1, 'The Boardwalk', 'none')];
    const out = withBeachCulture(districts, [resort([0])]);
    expect(out.map((d) => d.culture)).toEqual(['irish', 'beach']);
  });
});
