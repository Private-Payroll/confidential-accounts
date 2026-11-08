// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { ACT_REFUSAL } from './refusals.js';
import type { SignerActed } from './signer-acts.js';

/*
 * THE SIGNERS PAGE'S TWO ACTS OF THE SWITCH: removing a signer, and changing the vault secrets after one left. What is asked of the
 * wallet, what it tells back, and what its stops come to.
 */
const kr = vi.hoisted(() => ({
  acts: [] as Record<string, string>[], ended: { of: 'done', steps: 1, relayed: 0 } as unknown, user: { id: 'u1' } as { id: string } | null,
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => kr.user,
  forgetLocally: () => {},
  resumeSession: async () => null,
  api: async () => ({ companyLabel: 'label-1', contractAddress: 'c0'.repeat(32) }),
  actOnACompanyInTheWallet: async (intent: Record<string, string>) => { kr.acts.push(intent); return kr.ended; },
}));

async function load() {
  vi.resetModules();
  vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180');
  return import('./signer-acts.js');
}
const LEAF = 'ab'.repeat(32);
const stopped = (refused?: string, over: Record<string, unknown> = {}) => ({ of: 'stopped', step: 3, steps: 5, relayed: 0, unconfirmed: 0, why: refused === undefined ? 'relay-refused' : 'check-failed', ...(refused === undefined ? {} : { refused }), ...over });

describe('removing a signer', () => {
  /* RED WHEN: the wallet is asked to remove a seat other than the one pressed, is handed a number of approvals nobody gave, or is not handed the one given. */
  it('asks the wallet to remove exactly the seat pressed, with the number of approvals only when one was given', async () => {
    const m = await load();
    kr.acts.length = 0; kr.ended = { of: 'done', steps: 5, relayed: 1, outcome: { state: 'waiting-for-approvals' } };
    await m.removeSigner('u1', 'acc_Company00001', { leaf: LEAF });
    await m.removeSigner('u1', 'acc_Company00001', { leaf: LEAF, threshold: 2 });
    const base = { name: m.SIGNER_ACT.remove, record: 'acc_Company00001', company: 'label-1', account: 'c0'.repeat(32), leaf: LEAF };
    expect(kr.acts).toEqual([base, { ...base, threshold: '2' }]);
    expect(m.SIGNER_ACT.remove).toBe('remove-signer');
  });

  /* RED WHEN: a removal's state, its approvals and bar, the company key's change or the vaults' counts the wallet told are lost, or a count it did not tell is made up. */
  it('tells where the removal got to, the company key\'s change, and how many vaults ended in each state', async () => {
    const m = await load();
    kr.ended = { of: 'done', steps: 5, relayed: 2, outcome: {
      state: 'carried-out', approvals: 2, needed: 2, rotation: 'rotated', vaultsRotated: 1, vaultsAwaiting: 2, vaultsOwed: 0, vaultsWaiting: 3, vaultsNotChanged: 4,
    } };
    expect(await m.removeSigner('u1', 'acc_Company00001', { leaf: LEAF })).toEqual({
      of: 'done', state: 'carried-out',
      removal: { approvals: 2, needed: 2, rotation: 'rotated', vaultSecrets: null, vaultSecretsWhy: null, vaults: { rotated: 1, awaiting: 2, owed: 0, waiting: 3, notChanged: 4 } },
    } satisfies SignerActed);
    kr.ended = { of: 'done', steps: 5, relayed: 1, outcome: { state: 'waiting-for-approvals', approvals: 1, rotation: 'not-tried', vaultSecrets: 'not-started', vaultsRotated: 1 } };
    expect(await m.removeSigner('u1', 'acc_Company00001', { leaf: LEAF })).toEqual({
      of: 'done', state: 'waiting-for-approvals', removal: { approvals: 1, needed: null, rotation: 'not-tried', vaultSecrets: 'not-started', vaultSecretsWhy: null, vaults: null },
    } satisfies SignerActed);
    /* RED WHEN: what stopped the vault secrets' change, as the wallet told it, is lost on the way to the page. */
    kr.ended = { of: 'done', steps: 5, relayed: 1, outcome: { state: 'carried-out', rotation: 'rotated', vaultSecrets: 'not-started', vaultSecretsWhy: 'vault-records-not-read' } };
    expect(await m.removeSigner('u1', 'acc_Company00001', { leaf: LEAF })).toMatchObject({ removal: { vaultSecrets: 'not-started', vaultSecretsWhy: 'vault-records-not-read' } });
  });

  /* RED WHEN: a reason the wallet gives for stopping a removal is told as one the page does not know, a stop that may have gone part way is offered as nothing done, or another act's reason is taken for a removal's. */
  it('gives back the wallet\'s reason, and says which stops may have gone part of the way', async () => {
    const m = await load();
    for (const [code, partial] of [
      ['not-a-removal', false], ['refused', false], ['not-raised', false], ['not-carried', true], ['may-be-sent', true], ['not-as-shown', false], ['not-read', false],
      ['not-read-to-raise', false], ['no-such-seat', false], ['no-such-seat-to-raise', false], ['unread-seat-first', false], ['withdrawn', false],
      ['carried-out', false], ['already-counted', false], ['outrun', false], ['no-seat', false], ['roster-not-opened', false],
    ] as const) {
      kr.ended = stopped(`act.remove-signer.why.${code}`);
      expect(await m.removeSigner('u1', 'acc_Company00001', { leaf: LEAF }), code)
        .toEqual({ of: 'stopped', act: m.SIGNER_ACT.remove, why: code, partial, handedOver: false } satisfies SignerActed);
    }
    kr.ended = stopped('act.rotate-vault-secrets.why.not-a-vault');
    expect(await m.removeSigner('u1', 'acc_Company00001', { leaf: LEAF })).toMatchObject({ why: m.WHY.other, partial: true });
  });

  /* RED WHEN: a removal is asked of the wallet with nobody signed in. */
  it('asks the wallet for nothing when nobody is signed in', async () => {
    const m = await load();
    kr.acts.length = 0; kr.user = null;
    expect(await m.removeSigner('u1', 'acc_Company00001', { leaf: LEAF })).toEqual({ of: 'refused', why: ACT_REFUSAL.notSignedIn });
    expect(await m.changeVaultSecrets('u1', 'acc_Company00001')).toEqual({ of: 'refused', why: ACT_REFUSAL.notSignedIn });
    expect(kr.acts).toEqual([]);
    kr.user = { id: 'u1' };
  });
});

describe('changing the vault secrets after a signer left', () => {
  /* RED WHEN: the wallet is asked to change the vault secrets of anything but the whole company, or the counts it told come back wrong. */
  it('asks the wallet to change every vault whose change is owed, and tells how many ended in each state', async () => {
    const m = await load();
    kr.acts.length = 0;
    kr.ended = { of: 'done', steps: 3, relayed: 1, outcome: { state: 'partial', vaultsRotated: 1, vaultsAwaiting: 0, vaultsOwed: 2, vaultsWaiting: 0, vaultsNotChanged: 0 } };
    expect(await m.changeVaultSecrets('u1', 'acc_Company00001')).toEqual({
      of: 'done', state: 'partial', vaults: { vaults: { rotated: 1, awaiting: 0, owed: 2, waiting: 0, notChanged: 0 } },
    } satisfies SignerActed);
    expect(kr.acts).toEqual([{ name: m.SIGNER_ACT.rotate, record: 'acc_Company00001', company: 'label-1', account: 'c0'.repeat(32) }]);
    expect(m.SIGNER_ACT.rotate).toBe('rotate-vault-secrets');
  });

  /* RED WHEN: a reason the wallet gives for stopping the change is told as one the page does not know, or a stop is told as nothing done where the change may have gone part of the way. */
  it('gives back the wallet\'s reason', async () => {
    const m = await load();
    for (const [code, why, partial] of [['not-a-vault', 'not-a-vault', false], ['no-person', 'no-person', false], ['no-seat', 'no-seat', false], ['nonsense', m.WHY.other, true]] as const) {
      kr.ended = stopped(`act.rotate-vault-secrets.why.${code}`);
      expect(await m.changeVaultSecrets('u1', 'acc_Company00001'), code).toEqual({ of: 'stopped', act: m.SIGNER_ACT.rotate, why, partial, handedOver: false } satisfies SignerActed);
    }
    kr.ended = stopped(undefined, { relayed: 1 });
    expect(await m.changeVaultSecrets('u1', 'acc_Company00001')).toMatchObject({ why: m.WHY.stopped, partial: true, handedOver: true });
  });
});
