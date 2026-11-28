/**
 * **WHAT AN ANCHOR READS HELD THROUGH, AND HOW A STEP HOLDS ITS ONE VIEW.** The anchor names what it will read before
 * the directory is read, so the directory's held read and the anchor's are one; a step holds one view at a time, and
 * the one it replaces is ended.
 */
import { describe, expect, it } from 'vitest';
import { signingPublicKeyOf, type Hex } from '../../../src/core/crypto.js';
import { FOUNDING_KEY_EPOCH, stateRecordId } from '../../../src/core/founding-state.js';
import { ROSTER_ID } from '../../../src/core/roster-record.js';
import { anchoredOnTheWayIn } from './anchored-on-the-way-in.js';
import { anchorServiceThrough, heldHere, throughTheView } from './anchored-through-the-view.js';
import { viewHeldOver, type CompanyView } from './company-view.js';
import type { AnchorDoors } from './records-anchored-here.js';

const OWN = { store: 'company' as const, kind: 'policy', id: 'pol_1' };

describe("AN ANCHOR'S HELD READ THROUGH THE VIEW", () => {
  it("declares what it asks before the view's directory is read, then reads held from the same view", async () => {
    const order: unknown[] = [];
    const view = {
      declare: (asked: unknown) => {
        order.push(['declared', asked]);
      },
      held: async (asked: unknown) => {
        order.push(['held', asked]);
        return 'held as declared';
      },
      directory: async () => {
        order.push(['directory']);
      }
    };
    const doors = {
      view: { current: () => view, again: () => view },
      directory: async () => {
        order.push(["the caller's directory"]);
      }
    } as unknown as AnchorDoors;
    expect(await heldHere(doors, { everyPending: true, records: [OWN] })).toBe('held as declared');
    /* RED WHEN: the directory is read before the anchor's asks are declared (held is read twice), or through the caller's door, not the view. */
    expect(order).toEqual([
      ['declared', { records: [OWN], everyPending: true }],
      ['directory'],
      ['held', { everyPending: true, records: [OWN] }]
    ]);
  });
});

describe("A STEP'S ONE VIEW", () => {
  it('ends the view it replaces, and reads from the fresh one from then on', () => {
    const opened: { ended: string | null }[] = [];
    const open = () => {
      const v = {
        ended: null as string | null,
        end: (why: string) => {
          v.ended = why;
        }
      };
      opened.push(v);
      return v as unknown as CompanyView<unknown>;
    };
    const held = viewHeldOver(open);
    const first = held.current();
    const fresh = held.again('raced');
    /* RED WHEN: the view replaced is left open beside the fresh one, or the step goes on reading the old one. */
    expect(opened.map((v) => v.ended)).toEqual(['raced', null]);
    expect(held.current()).toBe(fresh);
    expect(held.current()).not.toBe(first);
  });
});

describe("THE SERVICE'S READS AND THE ANCHOR'S SEND, THROUGH THE VIEW", () => {
  it('reads the proposals, the founding records and the anchors through the view, and sends through its write', async () => {
    const asked: unknown[] = [];
    const view = {
      list: async (kind: string) => {
        asked.push(['list', kind]);
        return [{ id: 'prp_1' }];
      },
      records: async (r: unknown) => {
        asked.push(['records', r]);
        return [{ versions: [] }, { versions: [] }];
      },
      write: async (b: unknown) => {
        asked.push(['write', b]);
        return ['sent'];
      },
      doors: {
        onChain: async () => {
          asked.push(['onChain']);
          return 'anchors';
        }
      },
      stores: {}
    };
    const refuse = async (): Promise<never> => {
      throw new Error('read around the view');
    };
    const doors = throughTheView({
      accountId: 'c1',
      onChain: refuse,
      service: { callState: refuse, sendProven: refuse, sealedProposals: refuse, foundingRecords: refuse },
      view: { current: () => view, again: () => view }
    } as unknown as AnchorDoors);
    /* RED WHEN: the anchor reads the proposals, the founding records or the chain, or sends, around the view. */
    expect(await doors.service.sealedProposals('c1')).toEqual([{ id: 'prp_1' }]);
    expect(await doors.service.foundingRecords('c1')).toEqual({ state: null, roster: null });
    expect(await doors.onChain()).toBe('anchors');
    expect(await doors.service.sendProven('c1', 'tx')).toBe('sent');
    expect(asked).toEqual([
      ['list', 'proposals'],
      [
        'records',
        [
          { kind: 'state', id: stateRecordId(FOUNDING_KEY_EPOCH), every: true },
          { kind: 'roster', id: ROSTER_ID, every: true }
        ]
      ],
      ['onChain'],
      ['write', [{ to: 'proven', tx: 'tx' }]]
    ]);
  });
});

describe("THE ANCHOR'S SERVICE A STEP BUILDS FROM ITS VIEW", () => {
  it("reads the call state through the step's current view, and reads or sends nothing else itself", async () => {
    const asked: unknown[] = [];
    const viewOf = (n: number) => ({
      company: 'c1',
      callState: async () => {
        asked.push([n, 'callState']);
        return { account: 'acct' };
      },
      list: async () => {
        asked.push([n, 'list']);
        return [];
      },
      records: async () => {
        asked.push([n, 'records']);
        return [];
      },
      write: async () => {
        asked.push([n, 'write']);
        return [];
      }
    });
    let now = viewOf(1);
    const service = anchorServiceThrough({ current: () => now as never });
    now = viewOf(2);
    /* RED WHEN: the call state the anchor is built on is read from a view the step has moved past. */
    expect(await service.callState('c1')).toEqual({ account: 'acct' });
    /* RED WHEN: this door reads or sends what each attempt reads and sends through its own view, a second way the send could go. */
    await expect(service.sendProven('c1', 'tx')).rejects.toThrow(/each attempt's own view/u);
    await expect(service.sealedProposals('c1')).rejects.toThrow(/each attempt's own view/u);
    await expect(service.foundingRecords('c1')).rejects.toThrow(/each attempt's own view/u);
    expect(asked).toEqual([[2, 'callState']]);
  });
});

describe('A CHANGE FILED AGAIN ON THE WAY IN, REFUSED', () => {
  it('is kept for a later anchor, and the step goes on from a fresh view, not the one the refusal ended', async () => {
    const secret = '11'.repeat(32) as Hex;
    const seat = { seat: 's1', signingKey: signingPublicKeyOf(secret), role: 'admin', retired: null };
    const here = {
      dir: { version: 1, seats: [seat] },
      passedOver: [],
      refiled: () => ({ filed: [] }),
      anchoredAgain: new Set(),
      notApplied: []
    };
    const viewOf = (n: number) => ({
      n,
      ended: null as string | null,
      directory: async () => here,
      filings: async () => [],
      write: async () => {
        throw new Error('the version was taken');
      },
      declare: () => {},
      held: async () => {
        throw new Error(`held read on view ${n}`);
      },
      stores: {
        changes: {
          all: async () => [{ signedAt: 2, change: { kind: 'retire' } }],
          keep: async () => {},
          letGo: async () => {}
        }
      },
      doors: { onChain: async () => ({ landed: [] }) }
    });
    const opened = [viewOf(1)];
    const whys: string[] = [];
    const doors = {
      accountId: 'c1',
      material: { signingSecret: secret },
      fileDirectory: async () => {},
      service: {},
      view: {
        current: () => opened.at(-1)!,
        again: (why: string) => {
          whys.push(why);
          opened.push(viewOf(opened.length + 1));
          return opened.at(-1)!;
        }
      }
    } as unknown as AnchorDoors;
    const out = await anchoredOnTheWayIn(doors);
    /* RED WHEN: after the refused filing the step reads on from the view the refusal ended, or with no reason given. */
    expect(whys).toEqual(['a change filed again was refused (the version was taken)']);
    expect(out).toEqual({ notAnchored: 'held read on view 2' });
  });
});
