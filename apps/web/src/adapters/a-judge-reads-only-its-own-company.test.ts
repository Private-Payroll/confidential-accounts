/*
 * A judge of a page's company reads through that company's view alone: asked about any other company, it reads
 * nothing and names the mistake in this code, on the seat's page and on a reader's page alike.
 */
import { describe, expect, it } from 'vitest';
import { FAULT, Fault } from '../faults.js';
import { onlyItsOwn } from './filing-judge.js';

describe('A JUDGE READS ONLY ITS OWN COMPANY', () => {
  const view = { company: 'acc_1' };

  it('answers the view for its own company', () => {
    expect(onlyItsOwn(view)('acc_1')).toBe(view);
  });

  it('refuses any other company with the fault that names the mistake, and reads nothing', () => {
    const refused = (() => {
      try {
        return onlyItsOwn(view)('acc_2');
      } catch (e) {
        return e;
      }
    })();
    expect(refused).toBeInstanceOf(Fault);
    expect(String((refused as Error).message)).toContain(FAULT.judgeAskedAnotherCompany);
  });
});
