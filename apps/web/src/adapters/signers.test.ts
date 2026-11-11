import { describe, expect, it } from 'vitest';
import { approvalsForSigners, signerStandings, signersInvitedIn, thresholdChangesWaiting } from './signers.js';

const LEAF = (n: number): string => n.toString(16).padStart(2, '0').repeat(32);

describe('a signer who accepted is told from one who is seated', () => {
  /* RED WHEN: a signer the roster holds pending is read as seated, or one active whose seat the chain does not hold is. */
  it('reads pending as accepted, and each signer by whether the chain holds their seat', () => {
    const read = signerStandings([
      { id: 's1', name: 'Priya', status: 'active', leafCommitment: LEAF(1).toUpperCase() },
      { id: 's2', name: 'Sam', status: 'pending', leafCommitment: LEAF(2) },
      { id: 's3', name: 'Tia', status: 'pending', leafCommitment: null },
      { id: 's4', name: 'Uma', status: 'active', leafCommitment: LEAF(4) },
    ], [LEAF(1), LEAF(2)]);
    expect(read.map((s) => [s.id, s.accepted, s.seatOnChain])).toEqual([
      ['s1', false, true], ['s2', true, true], ['s3', true, false], ['s4', false, false],
    ]);
    /* RED WHEN: a standing does not carry the seat's leaf in lower case for a removal to name, or invents one for a signer the roster gives none. */
    expect(read.map((s) => s.leaf)).toEqual([LEAF(1), LEAF(2), null, LEAF(4)]);
  });

  it('lists once each seat the chain holds that someone invited waits to be admitted to, and no entry or invitation by address names', () => {
    const read = signerStandings([
      { id: 's1', name: 'Priya', status: 'active', leafCommitment: LEAF(1) },
      { id: 's2', name: 'Sam', status: 'pending', leafCommitment: LEAF(2) },
    ], [LEAF(1), LEAF(2), LEAF(0xc3), LEAF(5), LEAF(6)], { waited: [LEAF(2), LEAF(0xc3).toUpperCase(), LEAF(5), LEAF(6), LEAF(6), LEAF(7)], shown: [LEAF(5).toUpperCase()] });
    /* RED WHEN: a seat the chain holds that the roster waits for, with no roster entry and no invitation by address showing it, is left off the page, as when it is waited for in upper case. */
    expect(read.filter((s) => s.waiting === true).map((s) => s.id)).toContain(LEAF(0xc3));
    /* RED WHEN: a waited seat the chain no longer holds is listed as seated. */
    expect(read.some((s) => s.id === LEAF(7))).toBe(false);
    /* RED WHEN: a waited seat is listed twice, or beside the entry or the invitation by address that already shows it. */
    expect(read.map((s) => s.id)).toEqual(['s1', 's2', LEAF(0xc3), LEAF(6)]);
    /* RED WHEN: a waited seat is offered Finish adding, which needs the request that has not reached the page. */
    expect(read.filter((s) => s.waiting === true).every((s) => !s.accepted && s.seatOnChain && !s.you)).toBe(true);
  });
});

describe('the approvals a change of signers needs', () => {
  const VAULTS = ['aa'.repeat(32), 'bb'.repeat(32), 'cc'.repeat(32)];
  /* RED WHEN: the count is the account's threshold where the wallet read a higher seat bar, or is the threshold when the bar was not read. */
  it('is the seat bar the wallet read, and unreadable when there is none', () => {
    expect(approvalsForSigners({ approvals: 2, seatBar: 2, adoptedVaults: VAULTS, vaultThresholds: [] })).toEqual({ of: 'read', value: { count: 2, raisedAboveTheAccount: false, vaultsAtThatNumber: [], seated: null } });
    expect(approvalsForSigners({ approvals: 2, seatBar: 4, adoptedVaults: [] })).toEqual({ of: 'read', value: { count: 4, raisedAboveTheAccount: true, vaultsAtThatNumber: [], seated: null } });
    expect(approvalsForSigners({ approvals: 2, adoptedVaults: [] } as never)).toEqual({ of: 'unreadable' });
    expect(approvalsForSigners({ approvals: 3, seatBar: 2, adoptedVaults: [] })).toEqual({ of: 'unreadable' });
    expect(approvalsForSigners({ approvals: 2, seatBar: 0, adoptedVaults: [] })).toEqual({ of: 'unreadable' });
    expect(approvalsForSigners({ approvals: Number.NaN, seatBar: 2, adoptedVaults: [] })).toEqual({ of: 'unreadable' });
  });

  /* RED WHEN: the seats the chain holds are not counted into the read, or counted when the wallet gave none. */
  it('counts the seats the chain holds, and says nothing of them when none were read', () => {
    expect(approvalsForSigners({ approvals: 2, seatBar: 2, adoptedVaults: [], seats: [LEAF(1), LEAF(2), LEAF(3)] })).toMatchObject({ of: 'read', value: { seated: 3 } });
    expect(approvalsForSigners({ approvals: 2, seatBar: 2, adoptedVaults: [] })).toMatchObject({ of: 'read', value: { seated: null } });
  });

  /* RED WHEN: a vault not adopted, or one at another number, is listed among the vaults at that number, or the list says a vault set the bar. */
  it('lists only adopted vaults whose threshold is the bar, as vaults at that number', () => {
    expect(approvalsForSigners({
      approvals: 2, seatBar: 4, adoptedVaults: [VAULTS[0]!.toUpperCase(), VAULTS[1]!],
      vaultThresholds: [{ vault: VAULTS[0]!, threshold: 4 }, { vault: VAULTS[1]!, threshold: 3 }, { vault: VAULTS[2]!, threshold: 4 }],
    })).toEqual({ of: 'read', value: { count: 4, raisedAboveTheAccount: true, vaultsAtThatNumber: [VAULTS[0]], seated: null } });
  });
});

describe('the signers invited by address, read off the company\'s proposals', () => {
  const COIN = '0c'.repeat(32);
  const rec = (id: string) => ({ id, accountId: 'c1' }) as never;
  const opened = (status: string, signed: number, round?: unknown) => ({ kind: 'add-signer', status, approvals: Array.from({ length: signed }, (_, i) => ({ signerId: `s${i}` })), ...(round === undefined ? {} : { approvalRound: round }) }) as never;
  const body = (name: string, coinPublicKey: string | null, withInvite = true) => ({
    chainId: 'cc', summary: '', proposalSalt: 'aa', coinPublicKey,
    invited: { terms: { name, role: 'approver', ...(withInvite ? { invite: { address: LEAF(9), salt: LEAF(8), scope: LEAF(7) } } : {}) } },
  }) as never;

  /* RED WHEN: a signer waiting for approvals is listed under another proposal's record id, or with the name, address, rights or coin key of another. */
  it('lists each proposal that invites by address with its record id and what it invites', () => {
    const bodies: Record<string, unknown> = { p1: body('Sam', COIN), p2: body('Tia', null) };
    const read = signersInvitedIn([
      { rec: rec('p1'), opened: opened('open', 1, { state: 'short', approvals: 1, threshold: 3 }), status: 'open', approvals: 1 },
      { rec: rec('p2'), opened: opened('approved', 2), status: 'approved', approvals: 2 },
    ], (r) => (bodies[(r as { id: string }).id] ?? null) as never);
    expect(read).toEqual([
      { proposal: 'p1', name: 'Sam', role: 'approver', address: LEAF(9), scope: LEAF(7), coinKey: COIN, status: 'open', approvals: 1, seat: null, threshold: null },
      { proposal: 'p2', name: 'Tia', role: 'approver', address: LEAF(9), scope: LEAF(7), coinKey: null, status: 'approved', approvals: 2, seat: null, threshold: null },
    ]);
  });

  /* RED WHEN: a proposal that does not invite by address, or one whose invitation names no address, is listed as a signer to approve. */
  it('leaves out what is not an invitation by address', () => {
    const bodies: Record<string, unknown> = { p1: null, p2: body('Sam', COIN, false), p3: body('Uma', COIN) };
    const read = signersInvitedIn([
      { rec: rec('p1'), opened: opened('open', 0), status: 'open', approvals: 0 }, { rec: rec('p2'), opened: opened('open', 0), status: 'open', approvals: 0 }, { rec: rec('p3'), opened: opened('open', 0), status: 'open', approvals: 0 },
    ], (r) => (bodies[(r as { id: string }).id] ?? null) as never);
    expect(read.map((x) => x.proposal)).toEqual(['p3']);
  });

  /* RED WHEN: an approvals count or a status is shown that the chain did not give: the sealed body's list (filed empty, or chosen by the filer), the number the service says, or the service's status. */
  it("carries the chain's count and where the chain holds it, whatever the sealed list or the service says", () => {
    const read = signersInvitedIn([
      { rec: rec('p1'), opened: { ...(opened('executed', 2) as object), approvalCount: 9 } as never, status: 'open', approvals: 1 },
    ], () => body('Sam', COIN));
    expect([read[0]!.status, read[0]!.approvals]).toEqual(['open', 1]);
  });

  /* RED WHEN: the role shown is anything but the role the signed terms carry. */
  /* RED WHEN: an entry waiting that the chain does not show the proposal took is read as the invitee's seat, or the seat the chain says the proposal took is not, or it is tied to an entry waiting at another seat. */
  it('reads a seat only where the chain says the proposal took it, with the entry waiting at that very seat', () => {
    const named = (chainId: string) => ({ ...(body('Sam', COIN) as object), chainId }) as never;
    const bodies: Record<string, unknown> = { p1: named('ca'), p2: named('cb'), p3: named('cd'), p4: named('ce') };
    const read = signersInvitedIn([
      { rec: rec('p1'), opened: opened('open', 1), status: 'open', approvals: 1 }, { rec: rec('p2'), opened: opened('open', 1), status: 'open', approvals: 1 },
      { rec: rec('p3'), opened: opened('open', 1), status: 'open', approvals: 1 }, { rec: rec('p4'), opened: opened('open', 1), status: 'open', approvals: 1 },
    ], (r) => (bodies[(r as { id: string }).id] ?? null) as never, {
      taken: { CA: LEAF(5).toUpperCase(), cb: null, cd: LEAF(7) },
      waiting: [{ id: 'sB', leafCommitment: LEAF(5) }, { id: 'sF', leafCommitment: LEAF(6) }, { id: 'sN', leafCommitment: null }],
    });
    expect(read.map((x) => [x.proposal, x.seat])).toEqual([
      ['p1', { signer: 'sB' }], ['p2', null], ['p3', { signer: null }], ['p4', null],
    ]);
  });

  /* RED WHEN: an invitation a removal outran is listed as one to approve, though it can never seat anyone; or one whose seat is already taken is marked outrun. */
  it('marks an invitation the chain says a removal outran, and only while it has taken no seat', () => {
    const one = { rec: rec('p1'), opened: opened('open', 1), status: 'open' as const, approvals: 1, standing: { outrun: true } };
    expect(signersInvitedIn([one], () => body('Sam', COIN))[0]!.outrun).toBe(true);
    expect(signersInvitedIn([{ ...one, standing: { outrun: false } }], () => body('Sam', COIN))[0]!.outrun).toBeUndefined();
    expect(signersInvitedIn([one], () => body('Sam', COIN), { taken: { cc: LEAF(3) }, waiting: [] })[0]!.outrun).toBeUndefined();
  });

  it('carries the role the signed terms name', () => {
    const read = signersInvitedIn([{ rec: rec('p1'), opened: opened('open', 0), status: 'open', approvals: 0 }], () => ({ ...(body('Sam', COIN) as object), invited: { terms: { name: 'Sam', role: 'limited', invite: { address: LEAF(9), salt: LEAF(8), scope: LEAF(7) } } } }) as never);
    expect(read[0]!.role).toBe('limited');
  });

  /* RED WHEN: the threshold an invitation binds is not carried to the page as its digits, or an invitation that binds none, or one that binds something that is not a threshold, shows one. */
  it('carries the approvals an invitation sets once the seat is taken, and null where it sets none', () => {
    const withThreshold = (threshold?: string) => ({ ...(body('Sam', COIN) as object), invited: { terms: { name: 'Sam', role: 'approver', invite: { address: LEAF(9), salt: LEAF(8), scope: LEAF(7), ...(threshold === undefined ? {} : { threshold }) } } } }) as never;
    const one = (threshold?: string) => signersInvitedIn([{ rec: rec('p1'), opened: opened('open', 0), status: 'open', approvals: 0 }], () => withThreshold(threshold))[0]!.threshold;
    expect(one('3')).toBe('3');
    expect(one()).toBeNull();
    expect(one('0')).toBeNull();
    expect(one('x')).toBeNull();
  });
});

describe('the changes of the company\'s approvals that wait', () => {
  const row = (over: Record<string, unknown> = {}) => ({ id: 'p1', kind: 'set-threshold', status: 'open', asks: { threshold: 3 }, ...over }) as never;

  /* RED WHEN: an open change of the company's threshold is not listed with its number, or one that is carried out, withdrawn, a vault's own, of another kind or without a whole number is. */
  it('lists the open changes of the account\'s threshold only, with the number each holds', () => {
    expect(thresholdChangesWaiting([row()])).toEqual([{ id: 'p1', count: 3 }]);
    expect(thresholdChangesWaiting([
      row({ status: 'executed' }), row({ status: 'cancelled' }), row({ kind: 'set-vault-threshold' }), row({ kind: 'transfer', asks: {} }),
      row({ asks: undefined }), row({ asks: { threshold: '3' } }), row({ asks: { threshold: 0 } }), row({ asks: { threshold: 1.5 } }),
    ])).toEqual([]);
  });
});
