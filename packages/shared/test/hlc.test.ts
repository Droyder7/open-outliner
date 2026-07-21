import { describe, it, expect } from 'vitest';
import { compareHlc, hlcGreaterThan, tickHlc, receiveHlc, type Hlc } from '../src/hlc.js';

const h = (wallMs: number, counter: number, replicaId: string): Hlc => ({ wallMs, counter, replicaId });

describe('compareHlc — total order (ADR-0009)', () => {
  it('orders by wallMs first', () => {
    expect(compareHlc(h(2, 0, 'a'), h(1, 99, 'z'))).toBeGreaterThan(0);
    expect(compareHlc(h(1, 0, 'a'), h(2, 0, 'a'))).toBeLessThan(0);
  });

  it('breaks equal wallMs by counter', () => {
    expect(compareHlc(h(5, 2, 'a'), h(5, 1, 'z'))).toBeGreaterThan(0);
  });

  it('breaks equal wallMs+counter by replicaId (final deterministic tie-break)', () => {
    expect(compareHlc(h(5, 1, 'b'), h(5, 1, 'a'))).toBeGreaterThan(0);
    expect(compareHlc(h(5, 1, 'a'), h(5, 1, 'a'))).toBe(0);
  });

  it('is a total order — never returns 0 for distinct replicas', () => {
    const stamps = [h(1, 0, 'a'), h(1, 0, 'b'), h(1, 1, 'a'), h(2, 0, 'a')];
    for (const x of stamps) {
      for (const y of stamps) {
        if (x === y) continue;
        expect(compareHlc(x, y)).not.toBe(0);
      }
    }
  });

  it('is antisymmetric and consistent', () => {
    const x = h(3, 1, 'a');
    const y = h(3, 2, 'b');
    expect(Math.sign(compareHlc(x, y))).toBe(-Math.sign(compareHlc(y, x)));
  });

  it('hlcGreaterThan is strict', () => {
    expect(hlcGreaterThan(h(2, 0, 'a'), h(1, 0, 'a'))).toBe(true);
    expect(hlcGreaterThan(h(1, 0, 'a'), h(1, 0, 'a'))).toBe(false);
  });
});

describe('tickHlc — local update rule (ADR-0009)', () => {
  it('starts from physical clock with counter 0 when no prior', () => {
    expect(tickHlc(undefined, 100, 'a')).toEqual(h(100, 0, 'a'));
  });

  it('advances wallMs to physical now and resets counter', () => {
    expect(tickHlc(h(100, 5, 'a'), 200, 'a')).toEqual(h(200, 0, 'a'));
  });

  it('bumps counter when physical clock did not advance (or went backwards)', () => {
    expect(tickHlc(h(200, 5, 'a'), 200, 'a')).toEqual(h(200, 6, 'a'));
    // Backwards physical clock: wallMs stays, counter bumps — never goes back.
    expect(tickHlc(h(200, 5, 'a'), 150, 'a')).toEqual(h(200, 6, 'a'));
  });

  it('is strictly monotonic across successive local ticks', () => {
    let cur = tickHlc(undefined, 100, 'a');
    for (let i = 0; i < 100; i++) {
      const next = tickHlc(cur, i % 3 === 0 ? cur.wallMs : cur.wallMs + 1, 'a');
      expect(hlcGreaterThan(next, cur)).toBe(true);
      cur = next;
    }
  });
});

describe('receiveHlc — merge rule keeps local clock ahead of everything observed', () => {
  it('advances past a remote stamp with a higher wallMs', () => {
    const merged = receiveHlc(h(100, 0, 'a'), h(500, 3, 'b'), 100, 'a');
    expect(merged.wallMs).toBe(500);
    expect(merged.counter).toBe(4);
    expect(hlcGreaterThan(merged, h(500, 3, 'b'))).toBe(true);
  });

  it('takes max counter + 1 when all wall clocks tie', () => {
    const merged = receiveHlc(h(300, 2, 'a'), h(300, 5, 'b'), 300, 'a');
    expect(merged).toEqual(h(300, 6, 'a'));
  });

  it('result dominates both local and remote', () => {
    const local = h(300, 9, 'a');
    const remote = h(300, 4, 'b');
    const merged = receiveHlc(local, remote, 250, 'a');
    expect(hlcGreaterThan(merged, local)).toBe(true);
    expect(hlcGreaterThan(merged, remote)).toBe(true);
  });
});
