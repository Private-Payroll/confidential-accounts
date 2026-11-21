/*
 * The company's vault routes through a view: every send into or out of a vault is a write through the view, checked
 * once just before it and sent to the vault's own route, and a vault's chain and payout state are read through the
 * view, once each, until a send makes the view forget them.
 */
import { describe, expect, it } from 'vitest';
import { companyViewFor, viewHeldOver } from './company-view.js';
import { serviceSource, type ServiceCall } from './records-source.js';
import { treeKeptInMemory } from './tree-kept-here.js';
import { vaultServiceThrough } from './vault-service-through-the-view.js';
import { ourServiceTookNothing } from './hand-over.js';

const VAULT = 'ab'.repeat(32);
const HOLDERS = { seats: ['aa'], approvals: 1, adoptedVaults: [VAULT], threshold: 1, committee: [], vaultThresholds: [], policyBar: null };

const aCompany = () => {
  const asked: string[] = [];
  const state = { directory: 0, refuse: false, down: null as null | { readonly status?: number; readonly code?: string } };
  const call: ServiceCall = async (path, init) => {
    const method = init?.method ?? 'GET';
    asked.push(`${method} ${path}`);
    if (path.endsWith('/directory')) return { filings: state.directory === 0 ? [] : [{ version: state.directory }] };
    if (path.endsWith('/manifest/newest')) return { versions: (JSON.parse(String(init?.body)) as { records: unknown[] }).records.map(() => 0) };
    if (state.refuse && method === 'POST') throw new Error('the fee payer could not pay. Nothing was sent.');
    if (state.down !== null && method === 'POST') throw Object.assign(new Error('our service took nothing. Nothing was sent.'), { nothingWasSent: true, ...state.down });
    if (method === 'POST') return { txRef: `ref ${path.split('/').at(-1)}`, transactionHash: null, vault: VAULT };
    return { vault: VAULT, at: path.split('/').at(-1) };
  };
  const held = viewHeldOver((from) => companyViewFor(serviceSource(call, 'acc_1'), {
    holders: async () => HOLDERS, onChain: async () => { throw new Error('no anchors here'); },
    builder: { anchorHeads: async () => { throw new Error('no heads here'); } }, kept: () => treeKeptInMemory(),
  }, async () => { throw new Error('no held read here'); }, from));
  return { asked, state, service: vaultServiceThrough(held) };
};

const posts = (asked: readonly string[]) => asked.filter((a) => a.startsWith('POST /api/accounts/acc_1/vaults'));

describe('A VAULT\'S ROUTES GO THROUGH THE COMPANY\'S VIEW', () => {
  it('sends each act to its vault\'s own route, the company read again once just before each', async () => {
    const c = aCompany();
    await c.service.deploy('t0');
    await c.service.deposit(VAULT as never, 't1');
    await c.service.depositPublicly!(VAULT as never, 't2');
    await c.service.payout(VAULT as never, 't3');
    await c.service.merge(VAULT as never, 't4');
    await c.service.payoutPublicly(VAULT as never, 't5');
    await c.service.handover(VAULT as never, 't6');
    /* RED WHEN: a vault's send goes to another route than its own, or around the view. */
    expect(posts(c.asked)).toEqual(['', '/deposit', '/public-deposit', '/payout', '/merge', '/public-payout', '/handover']
      .map((r, n) => `POST /api/accounts/acc_1/vaults${n === 0 ? '' : `/${VAULT}${r}`}`));
    /*
     * RED WHEN: a send is checked twice, or not at all, or leaves the view as it was: one read of the directory to begin,
     * one before each send, and one more for each send after the first, the send having ended the view it went through.
     */
    expect(c.asked.filter((a) => a.endsWith('/directory'))).toHaveLength(14);
  });

  it('sends nothing into a vault when the company changed since the view read it', async () => {
    const c = aCompany();
    await c.service.chain(VAULT as never);
    c.state.directory = 1;
    /* RED WHEN: money goes into a vault while another signer's change to the company goes unseen. */
    await expect(c.service.deposit(VAULT as never, 't1')).rejects.toThrow(/Another signer changed the company/u);
    expect(posts(c.asked)).toEqual([]);
  });

  it('keeps the service\'s mark that nothing was sent on a refused send', async () => {
    const c = aCompany();
    c.state.refuse = true;
    /* RED WHEN: a refusal loses whether anything was sent, so the act cannot say it is safe to try again. */
    await expect(c.service.payout(VAULT as never, 't3')).rejects.toMatchObject({ nothingWasSent: true });
  });

  it('keeps the service\'s status and code on a send it took nothing of, so the hand-over goes to the chain', async () => {
    for (const down of [{ status: 503 }, { status: 502 }, { code: 'fee-not-paid' }]) {
      const c = aCompany();
      c.state.down = down;
      const refused = await c.service.deposit(VAULT as never, 't1').catch((e: unknown) => e);
      expect(refused).toMatchObject({ nothingWasSent: true, ...down });
      expect(ourServiceTookNothing(refused)).toBe(true);
    }
  });

  it('reads a vault\'s chain and payout state through the view, once each until a send', async () => {
    const c = aCompany();
    await c.service.chain(VAULT as never);
    await c.service.chain(VAULT as never);
    await c.service.payoutState(VAULT as never);
    await c.service.payoutState(VAULT as never);
    /* RED WHEN: a vault's chain or payout state is read once for every time asked. */
    expect(c.asked.filter((a) => a.endsWith('/chain') || a.endsWith('/payout-state'))).toHaveLength(2);
    await c.service.deposit(VAULT as never, 't1');
    await c.service.chain(VAULT as never);
    /* RED WHEN: the view keeps the vault's chain it read before a send into the vault. */
    expect(c.asked.filter((a) => a.endsWith('/chain'))).toHaveLength(2);
  });
});
