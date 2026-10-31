import { describe, expect, it } from 'vitest';
import { approvalsForSigners, signerStandings, signersInvitedIn } from './signers.js';

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
  });
});

describe('the approvals a change of signers needs', () => {
  const VAULTS = ['aa'.repeat(32), 'bb'.repeat(32), 'cc'.repeat(32)];
  /* RED WHEN: the count is the account's threshold where the wallet read a higher seat bar, or is the threshold when the bar was not read. */
  it('is the seat bar the wallet read, and unreadable when there is none', () => {
    expect(approvalsForSigners({ approvals: 2, seatBar: 2, adoptedVaults: VAULTS, vaultThresholds: [] })).toEqual({ of: 'read', value: { count: 2, raisedAboveTheAccount: false, vaultsAtThatNumber: [] } });
    expect(approvalsForSigners({ approvals: 2, seatBar: 4, adoptedVaults: [] })).toEqual({ of: 'read', value: { count: 4, raisedAboveTheAccount: true, vaultsAtThatNumber: [] } });
    expect(approvalsForSigners({ approvals: 2, adoptedVaults: [] } as never)).toEqual({ of: 'unreadable' });
    expect(approvalsForSigners({ approvals: 3, seatBar: 2, adoptedVaults: [] })).toEqual({ of: 'unreadable' });
    expect(approvalsForSigners({ approvals: 2, seatBar: 0, adoptedVaults: [] })).toEqual({ of: 'unreadable' });
    expect(approvalsForSigners({ approvals: Number.NaN, seatBar: 2, adoptedVaults: [] })).toEqual({ of: 'unreadable' });
  });

  /* RED WHEN: a vault not adopted, or one at another number, is listed among the vaults at that number, or the list says a vault set the bar. */
  it('lists only adopted vaults whose threshold is the bar, as vaults at that number', () => {
    expect(approvalsForSigners({
      approvals: 2, seatBar: 4, adoptedVaults: [VAULTS[0]!.toUpperCase(), VAULTS[1]!],
      vaultThresholds: [{ vault: VAULTS[0]!, threshold: 4 }, { vault: VAULTS[1]!, threshold: 3 }, { vault: VAULTS[2]!, threshold: 4 }],
    })).toEqual({ of: 'read', value: { count: 4, raisedAboveTheAccount: true, vaultsAtThatNumber: [VAULTS[0]] } });
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
      { rec: rec('p1'), opened: opened('open', 1, { state: 'short', approvals: 1, threshold: 3 }) },
      { rec: rec('p2'), opened: opened('approved', 2) },
    ], (r) => (bodies[(r as { id: string }).id] ?? null) as never);
    expect(read).toEqual([
      { proposal: 'p1', name: 'Sam', role: 'approver', address: LEAF(9), scope: LEAF(7), coinKey: COIN, status: 'open', approvals: null, seat: null },
      { proposal: 'p2', name: 'Tia', role: 'approver', address: LEAF(9), scope: LEAF(7), coinKey: null, status: 'approved', approvals: null, seat: null },
    ]);
  });

  /* RED WHEN: a proposal that does not invite by address, or one whose invitation names no address, is listed as a signer to approve. */
  it('leaves out what is not an invitation by address', () => {
    const bodies: Record<string, unknown> = { p1: null, p2: body('Sam', COIN, false), p3: body('Uma', COIN) };
    const read = signersInvitedIn([
      { rec: rec('p1'), opened: opened('open', 0) }, { rec: rec('p2'), opened: opened('open', 0) }, { rec: rec('p3'), opened: opened('open', 0) },
    ], (r) => (bodies[(r as { id: string }).id] ?? null) as never);
    expect(read.map((x) => x.proposal)).toEqual(['p3']);
  });

  /* RED WHEN: an approvals count is shown that the chain did not give: the sealed body's list (filed empty, or chosen by the filer) or the number the service says. */
  it('carries no approvals count, whatever the sealed list or the service says', () => {
    const read = signersInvitedIn([
      { rec: rec('p1'), opened: { ...(opened('open', 2) as object), approvalCount: 9 } as never },
    ], () => body('Sam', COIN));
    expect(read[0]!.approvals).toBeNull();
  });

  /* RED WHEN: the role shown is anything but the role the signed terms carry. */
  /* RED WHEN: an entry waiting that the chain does not show the proposal took is read as the invitee's seat, or the seat the chain says the proposal took is not, or it is tied to an entry waiting at another seat. */
  it('reads a seat only where the chain says the proposal took it, with the entry waiting at that very seat', () => {
    const named = (chainId: string) => ({ ...(body('Sam', COIN) as object), chainId }) as never;
    const bodies: Record<string, unknown> = { p1: named('ca'), p2: named('cb'), p3: named('cd'), p4: named('ce') };
    const read = signersInvitedIn([
      { rec: rec('p1'), opened: opened('open', 1) }, { rec: rec('p2'), opened: opened('open', 1) },
      { rec: rec('p3'), opened: opened('open', 1) }, { rec: rec('p4'), opened: opened('open', 1) },
    ], (r) => (bodies[(r as { id: string }).id] ?? null) as never, {
      taken: { CA: LEAF(5).toUpperCase(), cb: null, cd: LEAF(7) },
      waiting: [{ id: 'sB', leafCommitment: LEAF(5) }, { id: 'sF', leafCommitment: LEAF(6) }, { id: 'sN', leafCommitment: null }],
    });
    expect(read.map((x) => [x.proposal, x.seat])).toEqual([
      ['p1', { signer: 'sB' }], ['p2', null], ['p3', { signer: null }], ['p4', null],
    ]);
  });

  it('carries the role the signed terms name', () => {
    const read = signersInvitedIn([{ rec: rec('p1'), opened: opened('open', 0) }], () => ({ ...(body('Sam', COIN) as object), invited: { terms: { name: 'Sam', role: 'viewer', invite: { address: LEAF(9), salt: LEAF(8), scope: LEAF(7) } } } }) as never);
    expect(read[0]!.role).toBe('viewer');
  });
});
