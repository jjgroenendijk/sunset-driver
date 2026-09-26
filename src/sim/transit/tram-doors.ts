/**
 * How a tram is put together, as far as its passengers care: which module
 * each car is and where its doorways stand. The renderer draws the cars from
 * this (`render/transit/tram-mesh.ts`), and the people at a stop walk to the
 * same doorways (`stop-crowd.ts`).
 */
import type { TramDesign } from './tram.ts';

/** Which module of a tram a geometry is: an end module with a cab, or the one between them. */
export type TramModule = 'end' | 'middle';

/** Where the doorways of a module stand along it, in the car's own frame. */
export function tramDoors(design: TramDesign, module: TramModule): number[] {
  if (design === 'heritage') return [-2.2, 2.2];
  return module === 'end' ? [-3.0, 1.2] : [-1.8, 1.8];
}

/**
 * How a tram of a design is put together: which module each car is drawn as,
 * and whether it is turned about. The rear module of a modern tram is the front
 * one reversed; a heritage car is the same either way round.
 */
export function tramCarPlan(design: TramDesign, car: number, cars: number): { module: TramModule; reversed: boolean } {
  if (design === 'heritage') return { module: 'middle', reversed: false };
  if (car === 0) return { module: 'end', reversed: false };
  if (car === cars - 1) return { module: 'end', reversed: true };
  return { module: 'middle', reversed: false };
}
