/**
 * How a phone reaches full screen (`src/ui/input/fullscreen.ts`): through the
 * API, through the Home Screen on an iPhone, or not at all once it is there.
 */
import { describe, expect, it } from 'vitest';
import { fullscreenRoute } from '../../../src/ui/input/fullscreen.ts';

describe('fullscreenRoute', () => {
  it('asks the API where the browser has one', () => {
    expect(fullscreenRoute({ api: true, standalone: false })).toBe('api');
  });

  it('sends an iPhone to the Home Screen, since its Safari has no API for a page', () => {
    expect(fullscreenRoute({ api: false, standalone: false })).toBe('home-screen');
  });

  it('asks nothing of a web app opened from the Home Screen', () => {
    expect(fullscreenRoute({ api: false, standalone: true })).toBe('none');
    expect(fullscreenRoute({ api: true, standalone: true })).toBe('none');
  });
});
