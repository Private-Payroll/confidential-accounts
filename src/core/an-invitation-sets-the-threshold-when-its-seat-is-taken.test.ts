/**
 * **AN INVITATION THAT SETS A THRESHOLD SETS IT WHEN ITS SEAT IS TAKEN, ON THE SIMULATED LEDGER AS ON THE CHAIN.**
 *
 * The contract's `seatInvited` takes the threshold as a `Uint<64>`: a whole number from 0 (keep the threshold in
 * force) to the largest it stores, and no higher than the signers seated once the seat is taken. The simulated
 * ledger the service runs on takes it as a `number`, so the range the type keeps on the chain is checked here, as
 * `setThreshold` checks its own. Every assertion names the change that turns it red.
 */
import { describe, it, expect } from 'vitest';
import { SimulatedLedger, SimulatedCommitments, type InvitedSeat, type SignerRef, type StateChange } from './ledger.js';
import { toHex, randomBytes, type Hex } from './crypto.js';
import { anInvitee } from '../testing/an-invitee.js';

const C = SimulatedCommitments;
const change = (): StateChange => ({ asset: 'GBP', amount: 0n, batchDigest: toHex(randomBytes(32)), salt: toHex(randomBytes(32)) });

/** An account of one seat at a threshold of one, with an invitation of `seed`'s wallet raised (and so approved) at `threshold`. */
const invitedAt = async (threshold: number, seed = 1) => {
  const ledger = new SimulatedLedger(C);
  const leaf = C.signerLeaf(C.signerPublicKey(toHex(randomBytes(32))), toHex(randomBytes(32)));
  const by: SignerRef = { signerId: 'sig_1', leaf };
  await ledger.open('acct', {
    signerLeaves: [leaf], threshold: 1, assetBlinding: toHex(randomBytes(32)),
    sealedState: { keyEpoch: 0, sealed: { iv: '', ct: '', tag: '' } as never },
  });
  const who = anInvitee(C, seed);
  const c = change();
  const payload = C.signerInvitePayload(who.address, who.scope, threshold);
  await ledger.propose('acct', payload, c, by, C.noVault());
  const proposalId = C.proposalId(payload, c.salt, C.noVault()) as Hex;
  const seat: InvitedSeat = {
    proposalId, coinSecretKey: who.coinSecretKey, addressSalt: who.addressSalt, signerPublicKey: who.signerPublicKey,
    blinding: who.blinding, scope: who.scope, newThreshold: threshold,
  };
  return { ledger, seat, leaf: who.leaf };
};

const thresholdOf = async (ledger: SimulatedLedger): Promise<unknown> => (await ledger.status('acct'))?.threshold;

describe('a seat taken with the threshold its invitation sets', () => {
  it('sets the threshold the invitation names once the seat is taken, and 0 keeps the one in force', async () => {
    /* RED WHEN: the threshold an approved invitation names is not written when its seat is taken. */
    const two = await invitedAt(2);
    await two.ledger.seatInvited('acct', two.seat);
    expect(await thresholdOf(two.ledger)).toBe(2);
    expect(await two.ledger.holdsSigner('acct', two.leaf)).toBe(true);
    /* RED WHEN: 0 is written as a threshold instead of keeping the one in force. */
    const keeps = await invitedAt(0);
    await keeps.ledger.seatInvited('acct', keeps.seat);
    expect(await thresholdOf(keeps.ledger)).toBe(1);
  });

  it('refuses a threshold above the signers seated once the seat is taken, and seats nobody', async () => {
    /* RED WHEN: a threshold no signers could meet is written. */
    const three = await invitedAt(3);
    await expect(three.ledger.seatInvited('acct', three.seat)).rejects.toThrow(/cannot exceed the signers seated/u);
    expect(await thresholdOf(three.ledger)).toBe(1);
    expect(await three.ledger.holdsSigner('acct', three.leaf)).toBe(false);
  });

  it('refuses a threshold that is not a whole number the account can store, and writes nothing', async () => {
    /* RED WHEN: a negative, fractional, NaN or larger than 64-bit threshold is written, as the chain's Uint<64> never could be. */
    for (const bad of [-1, 1.5, Number.NaN, 2 ** 64]) {
      const inv = await invitedAt(bad);
      await expect(inv.ledger.seatInvited('acct', inv.seat), String(bad)).rejects.toThrow(/whole number/u);
      expect(await thresholdOf(inv.ledger), String(bad)).toBe(1);
      expect(await inv.ledger.holdsSigner('acct', inv.leaf), String(bad)).toBe(false);
    }
  });
});
