import { describe, it, expect } from 'vitest';
import { vaultArtefactFile, vaultArtefactPlaces } from './vault-artefacts.js';

/* Only the files a device proves a vault's transactions with; nothing else by any spelling. */
const places = vaultArtefactPlaces('/repo', {});

describe('THE PROVING MATERIAL A DEVICE MAY FETCH', () => {
  it('names the vault\'s own circuits, the network\'s shielded circuits and the public parameters', () => {
    expect(vaultArtefactFile(places, '/keys/deposit.prover')).toBe('/repo/contracts/managed-vault/keys/deposit.prover');
    expect(vaultArtefactFile(places, '/keys/payout.verifier')).toBe('/repo/contracts/managed-vault/keys/payout.verifier');
    expect(vaultArtefactFile(places, '/zkir/deposit.bzkir')).toBe('/repo/contracts/managed-vault/zkir/deposit.bzkir');
    expect(vaultArtefactFile(places, '/params/bls_midnight_2p13')).toBe('/repo/.midnight/params/bls_midnight_2p13');
    expect(vaultArtefactFile(places, '/builtin/zswap/9/keys/output.prover')).toBe('/repo/.midnight/params/zswap/9/output.prover');
    expect(vaultArtefactFile(places, '/builtin/zswap/9/zkir/output.bzkir')).toBe('/repo/.midnight/params/zswap/9/output.bzkir');
    expect(vaultArtefactFile(vaultArtefactPlaces('/repo', { MIDNIGHT_PARAMS_DIR: '/params' }), '/params/bls_midnight_2p9'))
      .toBe('/params/bls_midnight_2p9');
  });

  it('A PAYMENT OUT ALSO PROVES THE ACCOUNT\'S recordPayment, AND THAT IS THE ONLY ONE OF THE ACCOUNT\'S SERVED', () => {
    /* RED WHEN: the account's folder is not served (a payment out then cannot be proved on a device), or it
     * serves any other circuit of the account's, or a vault name reaches it. */
    expect(vaultArtefactFile(places, '/account/keys/recordPayment.prover')).toBe('/repo/contracts/managed/keys/recordPayment.prover');
    expect(vaultArtefactFile(places, '/account/keys/recordPayment.verifier')).toBe('/repo/contracts/managed/keys/recordPayment.verifier');
    expect(vaultArtefactFile(places, '/account/zkir/recordPayment.bzkir')).toBe('/repo/contracts/managed/zkir/recordPayment.bzkir');
    for (const path of [
      '/account/keys/approve.prover', '/account/keys/propose.prover', '/account/keys/payout.prover',
      '/account/zkir/recordPayment.prover', '/account/keys/recordPayment.bzkir', '/account/keys/../keys/recordPayment.prover',
      '/keys/recordPayment.prover', '/account/params/bls_midnight_2p13', '/account/keys/recordpayment.prover',
    ]) {
      expect(vaultArtefactFile(places, path), path).toBeNull();
    }
  });

  it('REFUSES EVERY OTHER NAME: another circuit, another folder, a mismatched kind, or a way out', () => {
    for (const path of [
      '/keys/../../.env', '/keys/deposit.prover/../x', '/keys/notACircuit.prover', '/keys/deposit.bzkir',
      '/zkir/deposit.prover', '/params/../wallet.seed', '/params/bls_midnight_2p', '/params/seed',
      '/builtin/zswap/9/keys/../../../wallet.seed', '/builtin/dust/9/keys/spend.prover',
      '/builtin/zswap/9/keys/sign.bzkir', '/builtin/zswap/8/keys/output.prover', '/', '',
      '/keys/Deposit.prover', '/keys/deposit.prover?x',
    ]) {
      expect(vaultArtefactFile(places, path), path).toBeNull();
    }
  });
});
