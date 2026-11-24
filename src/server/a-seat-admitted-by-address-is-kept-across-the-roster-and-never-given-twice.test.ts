/**
 * A seat taken by address and admitted, in a company where Eve and Fay are already seated: a wallet the roster records as
 * seated is not approved or admitted for a second seat, a fold and a follow of the roster keep each seat's coin key, and an
 * admission whose entry in the records was lost is entered again from another seat's device.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { type Hex } from '../core/crypto.js';
import { sealRoster } from '../core/roster-record.js';
import { vaultKeyIndexOf } from '../core/vault-keys.js';
import { signCompanyFiling, toCompanyWire } from '../midnight/sealed-record-wire.js';
import { companyRecordEntry } from '../midnight/record-manifest.js';
import { InvitationNotBound } from 'vaults-web-shared/company-change-on-device.js';
import { approveSeatInvitationOnDevice, raiseSeatInvitationOnDevice } from 'vaults-web-shared/seat-invited-on-device.js';
import { rosterHere } from 'vaults-web-shared/roster-here.js';
import { admitSignerHere, fileTheRosterFollowedHere, foldOffersHere, offerVaultKeysHere } from 'vaults-web-shared/roster-filed-here.js';
import { FiledNotEntered } from 'vaults-web-shared/record-entered-here.js';
import { viewOver } from '../testing/writes-over-a-send.js';
import { aCompanyWhoseSignersChange, ADA, api, BO, CO, companyNow, CY, events, ID, KEY, rosterDoorsOf, sendAs, walletOf as releasedBy } from './a-company-whose-signers-change-on-the-chain.test-support.js';
import { addressOf, coinKeyAt, inviteAddressOf, seatingDevice, withCommitments, EVE, FAY, GUS, coinOf, invited, seatTaken, seated } from './a-signer-invited-by-address.test-support.js';
aCompanyWhoseSignersChange();

describe('A SEAT ADMITTED BY ADDRESS IS KEPT ACROSS THE ROSTER AND NEVER GIVEN TWICE', () => {

  beforeAll(async () => {
    await seated(EVE);
    await seated(FAY);
  }, 120_000);

  it('RED WHEN: a proposal that invites a wallet the roster records as seated is approved, though it is the one the window showed', { timeout: 120_000 }, async () => {
    /* Eve is seated, and Ada's device invites her address again without its check: the proposal is as shown, and only the approving device can stop it. */
    const again = await invited(EVE, { unchecked: true });
    const before = events.length;
    const refused = await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: again.shown }, inviteAddressOf).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(InvitationNotBound);
    expect(String((refused as Error).message)).toMatch(/not approved, and nothing was sent: that address already has a seat on this company/u);
    /* RED WHEN: the approving device sends its approval of a second seat for a wallet already seated. */
    expect(events.slice(before)).toEqual([]);
  });

  it('a fold and a follow of the roster each keep the coin key a seat was admitted with', async () => {
    /* Bo gives his vault keys again, and Ada's device folds them in: the roster is filed again. */
    await offerVaultKeysHere(CO, {
      signerId: ID[BO.person]!, signingSecret: BO.signingSecret as Hex, committeeKey: BO.committeeKey as never, ...releasedBy(BO), entry: BO.statement, viewingKey: KEY,
    }, viewOver(api(BO.person), CO));
    const before = (await rosterHere(rosterDoorsOf(ADA))).version;
    expect((await foldOffersHere(rosterDoorsOf(ADA))).folded).toEqual([BO.seat]);
    expect((await rosterHere(rosterDoorsOf(ADA))).version).toBe(before + 1);
    /* RED WHEN: a fold of the roster drops the coin key an admitted seat records. */
    expect(coinOf(EVE.name)).toBe(coinKeyAt(addressOf(EVE.fill)));
    /* Ada's seat files a version that leaves Cy out: every device refuses it, and Bo's device follows it with a version of its own. */
    const now = await rosterHere(rosterDoorsOf(ADA));
    const next = { name: now.carried.name, signers: now.carried.signers.filter((x) => x.status === 'active' && x.id !== ID[CY.person]) };
    const rec = signCompanyFiling(sealRoster(CO, next, now.version + 1, 0, KEY as Hex), ADA.signingSecret as Hex);
    const filed = await sendAs(ADA.person)(`/api/accounts/${CO}/roster`, {
      method: 'POST', body: JSON.stringify({ roster: { version: now.version + 1, message: toCompanyWire(rec) }, folded: [], index: vaultKeyIndexOf({ id: CO, signers: next.signers }) }),
    });
    expect(filed.status).toBe(201);
    await ADA.entered.enter([companyRecordEntry(rec)]);
    expect(await fileTheRosterFollowedHere(rosterDoorsOf(BO))).toBe(now.version + 2);
    /* RED WHEN: a roster filed to follow a refused one drops the coin key an admitted seat records. */
    expect(coinOf(EVE.name)).toBe(coinKeyAt(addressOf(EVE.fill)));
    expect(coinOf(FAY.name)).toBe(coinKeyAt(addressOf(FAY.fill)));
    expect(companyNow().signers.some((x) => x.id === ID[CY.person] && x.status === 'active')).toBe(true);
  });

  it('an admission whose entry in the records was lost is entered again from another seat\'s device with the entry its filer signed, and every device reads the roster', { timeout: 120_000 }, async () => {
    const gus = await invited(GUS);
    await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: gus.shown }, inviteAddressOf);
    const signerId = await seatTaken(GUS, gus);
    const lost = { enter: async () => { throw new FiledNotEntered('the connection dropped'); } };
    await expect(admitSignerHere({ ...withCommitments(ADA), entered: lost }, { signerId, readOut: '', name: GUS.name })).rejects.toThrow(FiledNotEntered);
    /* The service holds the admission and the entry Bo's seat signed with it; the records name nothing of it yet. */
    expect(companyNow().signers.find((x) => x.name === GUS.name)?.status).toBe('active');
    /* RED WHEN: only the seat that filed the admission can enter it again, so every other device refuses the roster until that seat acts. */
    const adas = await rosterHere(rosterDoorsOf(ADA));
    expect(adas.followed).toBeNull();
    expect(adas.opened.signers.find((x) => x.name === GUS.name)?.status).toBe('active');
    /* RED WHEN: once another device has entered it, the seat that filed the admission refuses the roster. */
    const bos = await rosterHere(rosterDoorsOf(BO));
    expect(bos.opened.signers.find((x) => x.name === GUS.name)?.status).toBe('active');
    expect(coinOf(GUS.name)).toBe(coinKeyAt(addressOf(GUS.fill)));
  });

  it('RED WHEN: a wallet another entry records as seated is admitted to a second seat', { timeout: 120_000 }, async () => {
    /* Ada's device invites Eve's address again without its check; Bo's device approves from the offer, and Eve's wallet takes a second seat. */
    const again = await invited(EVE, { unchecked: true });
    await raiseSeatInvitationOnDevice(seatingDevice(BO), {
      viewingKey: KEY, invited: again.offer.invited, proposalSalt: again.offer.byAddress!.proposalSalt, name: EVE.name,
    });
    const signerId = await seatTaken(EVE, again, { n: 1, person: 'eve-again' });
    await expect(admitSignerHere(withCommitments(ADA), { signerId, readOut: '', name: EVE.name }))
      .rejects.toThrow(/already holds a seat on this company, so nobody is seated from it/u);
    expect(companyNow().signers.filter((x) => x.name === EVE.name && x.status === 'active')).toHaveLength(1);
  });
});
