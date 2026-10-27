import { describe, expect, it } from 'vitest';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import {
  ClaimRewardsTransaction, Intent, MaintenanceUpdate, sampleContractAddress, signatureVerifyingKey, verifySignature,
} from '@midnightntwrk/ledger-v9';
import { identityFromWords } from '../keys/derivation.js';
import { addressOfVerifyingKey } from './disclosure.js';
import { addressClaimChallenge, readAddressClaim, typedAddressIsShielded, type AddressClaimFor } from './address-claim.js';
import { ADDRESS_CLAIM_SIGNED_DOMAIN, signUnshieldedClaim, unshieldedClaimRefusal } from './address-claim-signed.js';

/* A person added by an unshielded address claims their record with that address's own key. Every
 * device checks the claim against the address that was typed and the claim's challenge, which names the
 * company, the person, the payslip key, the address and the network. */

const NETWORK = 'undeployed' as const;
const identity = identityFromWords(TEST_MNEMONIC);
const unshieldedOf = (account: number): string => addressOfVerifyingKey(
  signatureVerifyingKey({ tag: 'schnorr', value: Buffer.from(identity.moneyAt(account).night).toString('hex') }).value, NETWORK);

const FOR: AddressClaimFor = Object.freeze({
  company: 'acme-label', person: 'emp_0123456789abcdef0123', payslipKey: 'ab'.repeat(32), address: unshieldedOf(0), network: NETWORK,
});

describe('an unshielded address is claimed by a signature with its own key', () => {
  it('a claim signed by the typed address\'s key for this company, person and payslip key is believed', () => {
    const claim = signUnshieldedClaim(identity, 0, FOR);
    expect(readAddressClaim(claim)).toEqual(claim);
    expect(unshieldedClaimRefusal(claim, FOR, NETWORK)).toBeNull();
  });

  it('RED WHEN: a claim signed by another wallet\'s key is believed for the typed address', () => {
    const other = signUnshieldedClaim(identity, 2, { ...FOR, address: unshieldedOf(2) });
    expect(unshieldedClaimRefusal({ ...other, address: FOR.address }, FOR, NETWORK)).toMatch(/another address/u);
  });

  it('RED WHEN: a claim made for one address is believed for another address that was typed', () => {
    const claim = signUnshieldedClaim(identity, 0, FOR);
    expect(unshieldedClaimRefusal(claim, { ...FOR, address: unshieldedOf(2) }, NETWORK)).toMatch(/another address/u);
  });

  it.each([
    ['company', { company: 'another-label' }],
    ['person', { person: 'emp_ffffffffffffffffffff' }],
    ['payslip key', { payslipKey: 'cd'.repeat(32) }],
    ['network', { network: 'preview' }],
  ])('RED WHEN: a claim made for one %s is believed for another', (_what, change) => {
    const claim = signUnshieldedClaim(identity, 0, FOR);
    const why = unshieldedClaimRefusal(claim, { ...FOR, ...change } as AddressClaimFor, NETWORK);
    expect(why).not.toBeNull();
  });

  it('RED WHEN: a claim whose signature was changed on the way is believed', () => {
    const claim = signUnshieldedClaim(identity, 0, FOR);
    const flipped = (claim.signature[0] === '0' ? '1' : '0') + claim.signature.slice(1);
    expect(unshieldedClaimRefusal({ ...claim, signature: flipped }, FOR, NETWORK)).toMatch(/signature/u);
  });

  it('the challenge changes with every field it names, so no two claims answer one challenge', () => {
    const base = addressClaimChallenge(FOR);
    for (const change of [{ company: 'x-label' }, { person: 'ven_0123456789abcdef0123' }, { payslipKey: '00'.repeat(32) },
      { address: unshieldedOf(2) }, { network: 'preview' }]) {
      expect(addressClaimChallenge({ ...FOR, ...change } as AddressClaimFor)).not.toBe(base);
    }
    expect(base).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('a claim of any other shape is not read as a claim', () => {
    const claim = signUnshieldedClaim(identity, 0, FOR);
    expect(readAddressClaim({ ...claim, extra: 1 })).toBeNull();
  });

  /* RED WHEN: a claim of a shielded address is read as a claim. No device here can check a proof that a wallet holds a
   * shielded address, so a person added by one is admitted on the fingerprint they read out, and carries no claim. */
  it('RED WHEN: a shielded address\'s claim, of any shape, is read as a claim', () => {
    expect(readAddressClaim({ kind: 'shielded', address: FOR.address, deploy: 'BBBB', proof: 'AAAA' })).toBeNull();
    expect(readAddressClaim({ kind: 'shielded', address: FOR.address, proof: 'AAAA' })).toBeNull();
    expect(typedAddressIsShielded('mn_shield-addr_undeployed1xyz')).toBe(true);
    expect(typedAddressIsShielded(FOR.address)).toBe(false);
  });
});

/*
 * Two defences for the second module that signs with a spending (NIGHT) key. The key that pays is the key
 * that signs a claim, and `ledger-v9.d.ts` warns against signing data that is not strictly controlled with a
 * valuable key. The structural half of that control is that what is signed here cannot be read as anything the
 * ledger would accept as an authorisation; the other half is that nothing exported signs bytes handed to it.
 */
describe('what a claim signs cannot be read as a ledger authorisation', () => {
  const AT = Date.UTC(2026, 9, 27);

  it('BEGINS WITH BYTES NO LEDGER SIGNING ENVELOPE BEGINS WITH, measured against the SDK', () => {
    /* All three producers of signable bytes in `ledger-v9`, asked at run time, as disclosure.test.ts asks them. */
    const envelopes: readonly Uint8Array[] = [
      Intent.new(new Date(AT + 3_600_000)).signatureData(1),
      new MaintenanceUpdate(sampleContractAddress(), [], 0n).dataToSign,
      ClaimRewardsTransaction.new('undeployed', 100n, signatureVerifyingKey({ tag: 'schnorr', value: 'ab'.repeat(32) }),
        '00'.repeat(32), 'Reward').dataToSign,
    ];
    for (const envelope of envelopes) expect(new TextDecoder().decode(envelope.slice(0, 9))).toBe('midnight:');
    /* What a claim signs is the domain and the challenge: the claim's own signature verifies over exactly those bytes. */
    const claim = signUnshieldedClaim(identity, 0, FOR);
    const ours = Uint8Array.from([...new TextEncoder().encode(ADDRESS_CLAIM_SIGNED_DOMAIN), ...Buffer.from(addressClaimChallenge(FOR), 'hex')]);
    expect(verifySignature({ tag: 'schnorr', value: claim.verifyingKey }, ours as Uint8Array<ArrayBuffer>, { tag: 'schnorr', value: claim.signature }))
      .toBe(true);
    /* RED WHEN: what a claim signs begins as a ledger envelope does. Ours differs from every one at the ninth byte. */
    for (const envelope of envelopes) {
      expect(Buffer.from(ours.slice(0, 8))).toEqual(Buffer.from(envelope.slice(0, 8)));
      expect(ours[8]).not.toBe(envelope[8]);
    }
  });

  it('RED WHEN: this module exports anything that signs bytes handed to it', async () => {
    const module = await import('./address-claim-signed.js') as Record<string, unknown>;
    expect(Object.keys(module).sort()).toEqual(['ADDRESS_CLAIM_SIGNED_DOMAIN', 'signUnshieldedClaim', 'unshieldedClaimRefusal']);
  });
});
