import { describe, it, expect } from 'vitest';
import { compareOrder, sortSiblings } from '../src/ordering.js';

describe('compareOrder — total order (rank, id) [ADR-0005]', () => {
  it('orders by rank first', () => {
    expect(compareOrder({ id: 'z', rank: 'a' }, { id: 'a', rank: 'b' })).toBeLessThan(0);
  });

  it('breaks equal ranks by id (ties are legal)', () => {
    expect(compareOrder({ id: 'a', rank: 'm' }, { id: 'b', rank: 'm' })).toBeLessThan(0);
    expect(compareOrder({ id: 'b', rank: 'm' }, { id: 'a', rank: 'm' })).toBeGreaterThan(0);
    expect(compareOrder({ id: 'a', rank: 'm' }, { id: 'a', rank: 'm' })).toBe(0);
  });

  it('sortSiblings is deterministic regardless of input order', () => {
    const items = [
      { id: 'c', rank: 'b' },
      { id: 'a', rank: 'a' },
      { id: 'b', rank: 'a' }, // collides on rank with 'a' → id breaks tie
    ];
    const forward = sortSiblings(items).map((i) => i.id);
    const reversed = sortSiblings([...items].reverse()).map((i) => i.id);
    expect(forward).toEqual(['a', 'b', 'c']);
    expect(reversed).toEqual(forward);
  });
});
