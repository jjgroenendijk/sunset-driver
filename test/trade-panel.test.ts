import { describe, expect, it } from 'vitest';
import { bars } from '../src/ui/trade-panel.ts';

/** The price history of spec section 12, as the trading panel draws it. */
describe('the price history', () => {
  it('draws a bar for every sample, lowest to highest', () => {
    expect(bars([1, 2, 3, 4])).toBe('▁▃▆█');
    // A price that has not moved draws flat rather than dividing by nothing.
    expect(bars([7, 7, 7])).toBe('▁▁▁');
    expect(bars([])).toBe('');
  });
});
