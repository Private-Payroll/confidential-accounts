import { describe, expect, it } from 'vitest';
import * as L from '@midnightntwrk/ledger-v9';
import { identityFromWords, newWords } from 'midnight-identity';
import { committeeKeyFor, committeeSigningKeyFor } from 'midnight-identity/profile/committee-key';
import { superAdminChangeBytes } from 'midnight-identity/profile/committee-sign';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import { answerVaultAsk, type WorkerDeps } from './vault-worker-entry.js';
import { vaultBuilderOver, type VaultAnswer } from './vault-worker-client.js';

/*
 * A CHANGE OF THE SUPER ADMINS IS JUDGED ON THE PAGE WITH THE LEDGER IN THE VAULT WORKER. The page asks the worker
 * for each contract's update bytes and for every signature check; the answers come from the ledger itself, through the
 * worker's own handler behind the page's own client, so a signature the ledger refuses is refused on the page as before.
 */
type Key = { tag: string; value: string };
const LABEL = `co_${'c1'.repeat(32)}` as CompanyLabel;
const ACCOUNT = 'a0'.repeat(32);
const person = () => identityFromWords(newWords().join(' '));
const [alice, bob] = [person(), person()];
const keyOf = (who: ReturnType<typeof person>): Key => {
  const k = committeeKeyFor(who, LABEL) as unknown as Key;
  return { tag: k.tag, value: k.value.toLowerCase() };
};
const [A, B] = [keyOf(alice), keyOf(bob)];
const signed = (who: ReturnType<typeof person>, data: Uint8Array): Key => L.signData(committeeSigningKeyFor(who, LABEL) as never, data) as unknown as Key;

/** The page's client, with the vault worker's own handler behind it and the ledger as its only dependency. */
const builder = () => {
  const listeners: Array<(e: { data: unknown }) => void> = [];
  return vaultBuilderOver({
    addEventListener: (_t, l) => { listeners.push(l); },
    postMessage: (message) => {
      void answerVaultAsk(async () => ({ ledger: L }) as unknown as WorkerDeps, message as never).then(
        (a: VaultAnswer) => listeners.forEach((l) => l({ data: a })),
        (e: Error) => listeners.forEach((l) => l({ data: { id: (message as { id: number }).id, ok: false, error: e.message } })));
    },
  }, 'undeployed');
};

describe('THE SUPER ADMINS\' LEDGER, ASKED OF THE VAULT WORKER', () => {
  const to = { committee: [A, B], threshold: 2 };

  it('MAKES THE VERY BYTES THE LEDGER SIGNS AN UPDATE OVER', async () => {
    const ledger = builder().superAdmins!.ledger;
    const made = new L.MaintenanceUpdate(ACCOUNT, [new L.ReplaceAuthority(new L.ContractMaintenanceAuthority(to.committee as never, 2, 4n)) as never], 3n).dataToSign;
    /* RED WHEN: the worker's bytes are not the ledger's own update at the counter the chain holds, so every signature over them is spent. */
    expect(await ledger.updateBytes({ vault: ACCOUNT, counter: 3n, to })).toEqual(made);
  });

  it('COUNTS A SIGNATURE ONLY WHERE THE LEDGER VERIFIES IT: ANOTHER KEY\'S, OTHER BYTES OR AN UNREADABLE ONE IS REFUSED', async () => {
    const ledger = builder().superAdmins!.ledger;
    const data = await ledger.updateBytes({ vault: ACCOUNT, counter: 3n, to });
    const other = await ledger.updateBytes({ vault: ACCOUNT, counter: 4n, to });
    expect(await ledger.signedBy(A, data, signed(alice, data))).toBe(true);
    /* RED WHEN: the check through the worker counts a signature the ledger refuses, so fewer super admins than the threshold move a contract. */
    expect(await ledger.signedBy(A, data, signed(bob, data)), 'another key\'s signature').toBe(false);
    expect(await ledger.signedBy(A, data, signed(alice, other)), 'a signature over other bytes').toBe(false);
    expect(await ledger.signedBy(A, data, { tag: 'schnorr', value: 'zz' }), 'a signature the ledger cannot read').toBe(false);
  });

  it('TAKES A JOINING KEY\'S SIGNATURE ONLY AS ITS OWN OVER THE CHANGE', async () => {
    const ledger = builder().superAdmins!.ledger;
    const bytes = superAdminChangeBytes(LABEL, ACCOUNT, '5a'.repeat(32), {
      kind: 'super-admins', from: { committee: [A], threshold: 1 }, committee: [A, B], threshold: 2,
      contracts: [{ contract: 'account', address: ACCOUNT, counter: '3' }],
    } as never);
    const bobs = signed(bob, bytes).value.toLowerCase();
    expect(await ledger.joinedBy(bytes, B, bobs)).toBe(true);
    /* RED WHEN: a joining signature is taken from a key that did not make it, or of a kind the chain does not check. */
    expect(await ledger.joinedBy(bytes, A, bobs), 'another key\'s signature').toBe(false);
    expect(await ledger.joinedBy(bytes, { tag: 'ecdsa', value: B.value }, bobs), 'a key of another kind').toBe(false);
    expect(await ledger.joinedBy(bytes.slice(1), B, bobs), 'other bytes').toBe(false);
  });
});
