import { describe, expect, it } from 'vitest';
import { GOODS, goodIndex, type Good } from '../src/sim/contraband.ts';
import type { TradeRow } from '../src/sim/market.ts';
import { cardFacts, heights } from '../src/ui/trade-panel.ts';

/** The price history of spec section 12, as the trading panel draws it. */
describe('the price history', () => {
  it('draws a bar for every sample, lowest to highest', () => {
    const run = heights([1, 2, 3, 4]);
    expect(run).toHaveLength(4);
    expect(run[0]).toBeGreaterThan(0);
    expect(run[3]).toBe(1);
    for (let i = 1; i < run.length; i++) expect(run[i] ?? 0).toBeGreaterThan(run[i - 1] ?? 0);
    // A price that has not moved draws flat rather than dividing by nothing.
    expect(new Set(heights([7, 7, 7])).size).toBe(1);
    expect(heights([])).toEqual([]);
  });
});

/** The card of the dealer's panel: what one good is doing at this corner. */
describe('the card of a good', () => {
  const good = GOODS[goodIndex('powder')] as Good;
  const row: TradeRow = { good: 11, name: good.name, buy: 2600, sell: 2400, held: 0, room: 3, paid: 0, standing: 2000, mood: 'spike' };

  it('measures the price against an ordinary day, and says where the good is cheap', () => {
    const facts = cardFacts(row, good, [0, 0.5, 1], 0);
    expect(facts[0]).toMatchObject({ label: 'Here', text: 'Spike, +30%', tone: 'spike' });
    expect(facts.map((fact) => fact.label)).toEqual(['Here', '12 hours', 'Cheapest']);
    expect(facts[2]?.text).toBe('Los Reyes turf');
  });

  it('says what a holding would make if it were sold here now', () => {
    const facts = cardFacts({ ...row, held: 4, paid: 6000, mood: '' }, good, [1], 0.5);
    expect(facts.find((fact) => fact.label === 'Holding')?.text).toBe('4 at $1,500');
    expect(facts.find((fact) => fact.label === 'Sale now')).toMatchObject({ text: 'Up $3,600', tone: 'up' });
    expect(facts.find((fact) => fact.label === 'Terms')?.text).toBe('They like you');
  });
});
