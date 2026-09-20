import { Box3, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { DEFAULT_APPEARANCE, OUTFITS } from '../src/sim/character.ts';
import { PROP_IDS } from '../src/sim/shop-goods.ts';
import { VEHICLE_CLASSES } from '../src/sim/vehicle.ts';
import {
  clearPlaceFor,
  GALLERY_PROPS,
  GALLERY_SUBJECTS,
  layGallery,
  type GallerySubject,
} from '../src/render/preview-gallery.ts';

/**
 * The gallery `--gallery` lays for a preview: every vehicle, every look and
 * every prop, standing on the ground in rows and let go again afterwards.
 * `scripts/render-preview.ts` takes the picture; this is what goes into it.
 */
const STAND = { x: 100, y: -40, heading: 0.7 };

/** Flat ground, so a piece standing on it stands at 0. */
const flat = (): number => 0;

const counts: Record<GallerySubject, number> = {
  vehicles: VEHICLE_CLASSES.length,
  people: OUTFITS.length,
  props: GALLERY_PROPS.length,
};

describe('the gallery of a preview', () => {
  it('lays every model of its subject, once, and names them in the order they lie', () => {
    for (const subject of GALLERY_SUBJECTS) {
      const gallery = layGallery(subject, STAND, flat, DEFAULT_APPEARANCE);
      expect(gallery.labels).toHaveLength(counts[subject]);
      expect(new Set(gallery.labels).size).toBe(counts[subject]);
      expect(gallery.group.children).toHaveLength(counts[subject]);
      gallery.dispose();
      expect(gallery.group.children).toHaveLength(0);
    }
  });

  it('names the roster and the goods, so a picture can be read without counting rows', () => {
    const vehicles = layGallery('vehicles', STAND, flat, DEFAULT_APPEARANCE);
    expect(vehicles.labels).toEqual([...VEHICLE_CLASSES]);
    vehicles.dispose();
    const props = layGallery('props', STAND, flat, DEFAULT_APPEARANCE);
    expect(props.labels).toEqual(GALLERY_PROPS.map((entry) => entry.prop));
    props.dispose();
  });

  it('stands every model on the ground, inside the reach the camera is given', () => {
    for (const subject of GALLERY_SUBJECTS) {
      const gallery = layGallery(subject, STAND, flat, DEFAULT_APPEARANCE);
      gallery.group.updateMatrixWorld(true);
      for (const piece of gallery.group.children) {
        const box = new Box3().setFromObject(piece);
        const middle = box.getCenter(new Vector3());
        // The ground is flat at 0, so nothing may sink far below it: a wheel
        // hangs a little on its suspension, and nothing else does.
        expect(box.min.y).toBeGreaterThan(-0.6);
        expect(box.max.y).toBeGreaterThan(0);
        const away = Math.hypot(middle.x - gallery.x, middle.z - gallery.y);
        expect(away).toBeLessThanOrEqual(gallery.reach);
      }
      gallery.dispose();
    }
  });

  it('turns the models back towards the player, whatever way the player faces', () => {
    const gallery = layGallery('people', { x: 0, y: 0, heading: 0 }, flat, DEFAULT_APPEARANCE);
    for (const piece of gallery.group.children) expect(piece.rotation.y).toBeCloseTo(-Math.PI, 5);
    gallery.dispose();
  });

  it('shows every prop the counters sell, and no prop twice', () => {
    expect([...GALLERY_PROPS.map((entry) => entry.prop)].sort()).toEqual([...PROP_IDS].sort());
  });
});

describe('where a gallery stands', () => {
  it('stays where it was asked for when the ground there is clear', () => {
    const place = clearPlaceFor('vehicles', STAND, () => false);
    expect(place).toEqual({ x: STAND.x, y: STAND.y });
  });

  it('moves off ground a building stands on, and no further than it has to', () => {
    // A building over everything within 30 m of where the player stands.
    const roofed = (x: number, y: number): boolean => Math.hypot(x - STAND.x, y - STAND.y) < 30;
    const place = clearPlaceFor('people', STAND, roofed);
    const moved = Math.hypot(place.x - STAND.x, place.y - STAND.y);
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThanOrEqual(96);
    expect(roofed(place.x, place.y)).toBe(false);
  });

  it('gives back the place asked for when nothing within reach is clear', () => {
    const place = clearPlaceFor('props', STAND, () => true);
    expect(place).toEqual({ x: STAND.x, y: STAND.y });
  });
});
