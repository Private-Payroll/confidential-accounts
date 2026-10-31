/**
 * **A WALLET'S SIGNED CLAIM OF AN UNSHIELDED ADDRESS IS CHECKED WHERE THE LEDGER LOADS.**
 *
 * A person or vendor added by an unshielded address is paid there only with their wallet's claim of it, signed with
 * that address's key. A page's own code loads no WebAssembly, so it asks its vault builder's worker; the wallet calls
 * the check itself. Both must give the answer the ledger's signature check gives, for a good claim and a forged one.
 */
import { describe, expect, it, vi } from 'vitest';
import { Buffer } from 'buffer';
import { signatureVerifyingKey } from '@midnightntwrk/ledger-v9';
import { identityFromSecret } from 'midnight-identity';
import { addressOfVerifyingKey } from 'midnight-identity/profile/disclosure';
import type { AddressClaimFor } from 'midnight-identity/profile/address-claim';
import { signUnshieldedClaim, unshieldedClaimRefusal } from 'midnight-identity/profile/address-claim-signed';
import { answerVaultAsk, type WorkerDeps } from './vault-worker-entry.js';
import type { VaultAsk } from './vault-worker-client.js';
import { signedClaimRefusal } from './signed-claim-refusal.js';
import { readPeopleHere, type ClaimRefusal } from './people-read-here.js';
import { newSigningKeypair, signingPublicKeyOf, type Hex } from '../../../src/core/crypto.js';
import { sealPerson } from '../../../src/core/person-record.js';
import { signCompanyFiling, toCompanyWire } from '../../../src/midnight/sealed-record-wire.js';
import { signJoinCode } from 'midnight-identity/profile/join-code';

/* The company's records believe every filing here, so a read turns only on the claim's check. */
vi.mock('./vault-page-doors.js', async (real) => ({
  ...(await real<typeof import('./vault-page-doors.js')>()),
  judgeIn: () => () => null,
  namedHere: () => [],
}));

const NETWORK = 'undeployed';
const walletOf = (n: number) => identityFromSecret(new Uint8Array(32).fill(n));
const unshieldedOf = (n: number): string => addressOfVerifyingKey(
  signatureVerifyingKey({ tag: 'schnorr', value: Buffer.from(walletOf(n).moneyAt(0).night).toString('hex') }).value, NETWORK as never);
const FOR: AddressClaimFor = Object.freeze({
  company: 'acme-label', person: 'emp_0123456789abcdef0123', payslipKey: 'ab'.repeat(32), address: unshieldedOf(5), network: NETWORK,
});
const GOOD = signUnshieldedClaim(walletOf(5), 0, FOR);
const FORGED = { ...signUnshieldedClaim(walletOf(6), 0, { ...FOR, address: unshieldedOf(6) }), address: FOR.address };
const FLIPPED = { ...GOOD, signature: (GOOD.signature[0] === '0' ? '1' : '0') + GOOD.signature.slice(1) };

const inTheWorker = async (claim: unknown, f: AddressClaimFor) => {
  const answer = await answerVaultAsk(async () => ({}) as WorkerDeps,
    { id: 7, network: NETWORK, ask: 'address-claim-refusal', claim, for: f } as unknown as VaultAsk);
  if (!answer.ok || answer.ask !== 'address-claim-refusal') throw new Error(`the worker did not answer the check: ${JSON.stringify(answer)}`);
  return answer.refusal;
};

describe('a signed claim of an unshielded address', () => {
  /* RED WHEN: the page's vault builder cannot check a claim, or believes one the ledger's signature check refuses. */
  it('is answered by the vault builder exactly as the signature check answers it', async () => {
    expect(await inTheWorker(GOOD, FOR)).toBeNull();
    for (const claim of [FORGED, FLIPPED]) {
      const refused = await inTheWorker(claim, FOR);
      expect(refused).not.toBeNull();
      expect(refused).toBe(unshieldedClaimRefusal(claim, FOR, NETWORK as never));
    }
    expect(await inTheWorker(GOOD, { ...FOR, payslipKey: 'cd'.repeat(32) })).not.toBeNull();
  });

  /* RED WHEN: the check the wallet fills a read with believes a claim the signature check refuses, or refuses a good one. */
  it('is answered in the wallet exactly as the signature check answers it', async () => {
    expect(await signedClaimRefusal(GOOD, FOR)).toBeNull();
    for (const claim of [FORGED, FLIPPED]) {
      expect(await signedClaimRefusal(claim, FOR)).toBe(unshieldedClaimRefusal(claim, FOR, NETWORK as never));
      expect(await signedClaimRefusal(claim, FOR)).not.toBeNull();
    }
    expect(await signedClaimRefusal(GOOD, { ...FOR, network: 'preview' })).not.toBeNull();
  });
});

const VK = '11'.repeat(32) as Hex;
const KEYS = { epoch: 0, newest: 0, key: VK, keyAt: () => VK, sealing: () => ({ key: VK, epoch: 0 }) };
const LABEL = `co_${'c1'.repeat(32)}`;
const SEAT = newSigningKeypair().secret;
const TYPED = 'mn_addr_stagenet1qgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpq8fl0tq';
const PAYSLIP = '02'.repeat(32);
const code = signJoinCode(walletOf(2), LABEL as never, 'usr_2', { kind: 'payee', address: TYPED, payslipKey: PAYSLIP });
const bo = {
  id: 'emp_0123456789abcdef0123', accountId: 'c1', name: 'Bo', email: null, title: 'Designer', asset: 'NIGHT', baseAmount: 1n,
  startDate: '2026-02-01', status: 'active', invitedAddress: TYPED, address: { kind: 'unshielded', network: 'stagenet', userAddress: '02'.repeat(32), bech32: TYPED },
  wrappingPublicKey: PAYSLIP, handedOverBy: code.committeeKey.value, payeeCode: code,
  addressClaim: { kind: 'unshielded', address: TYPED, verifyingKey: 'aa'.repeat(32), signature: 'ff'.repeat(64) },
  admittedBy: null, admittedAt: null, madeBy: signingPublicKeyOf(SEAT), madeAt: '2026-09-01T00:00:00Z',
};
const filed = toCompanyWire(signCompanyFiling(sealPerson(bo as never, 1, 1, VK), SEAT));
const readerWith = (claimRefusal: ClaimRefusal) => ({
  company: { id: 'c1', label: LABEL, viewingKey: KEYS }, network: 'stagenet', claimRefusal,
  directory: async () => ({}),
  send: async (path: string) => (path.endsWith('/people') ? { status: 200, body: { people: [{ filed, handedOver: false }] } } : { status: 404, body: {} }),
}) as never;

describe('a read of the people, with the claim check as its door', () => {
  it('pays a person added by an unshielded address only when the door answers null', async () => {
    const read = await readPeopleHere(readerWith(async () => null));
    expect(read.people.map((p) => p.person.id)).toEqual([bo.id]);
  });

  /* RED WHEN: a claim check that fails is read as the person being payable. */
  it('refuses the read when the door throws, and never reads the person as payable', async () => {
    await expect(readPeopleHere(readerWith(async () => { throw new Error('the vault builder stopped'); }))).rejects.toThrow(/stopped/u);
  });

  /* RED WHEN: a door that answers anything but null, undefined among it, lets the person be paid. */
  it.each([undefined, '', 0, false])('reads an answer of %s from the door as a refusal', async (answer) => {
    const read = await readPeopleHere(readerWith(async () => answer as never));
    expect(read.people).toEqual([]);
    expect(read.notPayable.map((n) => [n.here.person.id, /claim/u.test(n.why)])).toEqual([[bo.id, true]]);
  });
});
