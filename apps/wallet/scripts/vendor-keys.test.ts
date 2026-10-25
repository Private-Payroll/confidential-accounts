import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KEYS_DIR, REPO_ROOT, WALLET_DIR, accountFilesOf, vendorAccountKeys } from './vendor-keys.mjs';

/*
 * The script that puts the proving keys where the wallet serves them. Its
 * folders are read from its own place in the repository, and its account
 * branch is run here against a compile written into a temporary folder.
 */

const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');
const HERE = fileURLToPath(new URL('.', import.meta.url));

/** A repository with one compiled account circuit, and the verifier key its compile expects. */
const aCompile = (circuit = 'propose', verifier = 'the verifier key') => {
  const root = mkdtempSync(join(tmpdir(), 'vendor-account-'));
  mkdirSync(join(root, 'contracts/managed/keys'), { recursive: true });
  mkdirSync(join(root, 'contracts/managed/zkir'), { recursive: true });
  writeFileSync(join(root, `contracts/managed/keys/${circuit}.prover`), 'the prover key');
  writeFileSync(join(root, `contracts/managed/keys/${circuit}.verifier`), verifier);
  writeFileSync(join(root, `contracts/managed/zkir/${circuit}.bzkir`), 'the circuit');
  return { root, keysDir: join(root, 'served'), expectedVk: { [circuit]: sha(verifier) } };
};
const quiet = (): { lines: string[]; log: (l: string) => void } => {
  const lines: string[] = [];
  return { lines, log: (l) => lines.push(l) };
};

describe('the keys land in the folder the wallet serves', () => {
  it('the wallet, the repository and the served keys folder are read from where the script sits', () => {
    // RED WHEN: the script joins the wallet's path onto the wallet's own folder, so the keys land in a folder nothing serves
    expect(WALLET_DIR).toBe(join(HERE, '..'));
    expect(REPO_ROOT).toBe(join(HERE, '..', '..', '..'));
    expect(KEYS_DIR).toBe(join(REPO_ROOT, 'apps', 'wallet', 'public', 'keys'));
    expect(existsSync(join(REPO_ROOT, 'package.json'))).toBe(true);
  });
});

describe('the company account\'s circuits are copied from this build and pinned', () => {
  it('each circuit\'s prover, verifier and circuit file are copied under the folder named, and pinned', () => {
    // RED WHEN: a file is copied without a pin, or from another place than the compile, so the wallet serves bytes nothing vouches for
    const c = aCompile();
    const artefacts: Record<string, { bytes: number; sha256: string }> = {};
    const out = quiet();
    expect(vendorAccountKeys({ repoRoot: c.root, keysDir: c.keysDir, circuits: ['propose'], folder: 'account', expectedVk: c.expectedVk, artefacts, log: out.log })).toBe(0);
    expect(Object.keys(artefacts).sort()).toEqual(['account/propose.bzkir', 'account/propose.prover', 'account/propose.verifier']);
    expect(artefacts['account/propose.prover']).toEqual({ bytes: 14, sha256: sha('the prover key') });
    expect(readFileSync(join(c.keysDir, 'account/propose.bzkir'), 'utf8')).toBe('the circuit');
    expect(accountFilesOf(['x'], 'account').map((f) => f.built)).toEqual([
      join('contracts', 'managed', 'keys', 'x.prover'), join('contracts', 'managed', 'keys', 'x.verifier'), join('contracts', 'managed', 'zkir', 'x.bzkir'),
    ]);
  });

  it('a verifier key that is not the one the compiled contract expects is refused, and none of its files are written', () => {
    // RED WHEN: keys from an older compile are copied beside a contract that expects others
    const c = aCompile();
    const artefacts: Record<string, { bytes: number; sha256: string }> = {};
    const out = quiet();
    expect(vendorAccountKeys({ repoRoot: c.root, keysDir: c.keysDir, circuits: ['propose'], folder: 'account', expectedVk: { propose: sha('another key') }, artefacts, log: out.log })).toBe(1);
    expect(artefacts).toEqual({});
    expect(existsSync(join(c.keysDir, 'account/propose.prover'))).toBe(false);
    expect(out.lines.join('\n')).toMatch(/not this compile's/u);
  });

  it('a pin already taken is defended: changed bytes are refused unless repinned on purpose', () => {
    // RED WHEN: a proving key that changed since it was pinned is accepted without a deliberate repin
    const c = aCompile();
    const artefacts: Record<string, { bytes: number; sha256: string }> = { 'account/propose.prover': { bytes: 3, sha256: sha('old') } };
    const out = quiet();
    expect(vendorAccountKeys({ repoRoot: c.root, keysDir: c.keysDir, circuits: ['propose'], folder: 'account', expectedVk: c.expectedVk, artefacts, log: out.log })).toBe(1);
    expect(artefacts['account/propose.prover']).toEqual({ bytes: 3, sha256: sha('old') });
    expect(existsSync(join(c.keysDir, 'account/propose.verifier'))).toBe(false);
    expect(vendorAccountKeys({ repoRoot: c.root, keysDir: c.keysDir, circuits: ['propose'], folder: 'account', expectedVk: c.expectedVk, artefacts, repin: true, log: out.log })).toBe(0);
    expect(artefacts['account/propose.prover']?.sha256).toBe(sha('the prover key'));
  });

  it('a circuit the compile did not build is refused by name, with the command that builds it', () => {
    // RED WHEN: a missing compile is passed over and the wallet is left without a key it will be asked for
    const c = aCompile();
    const out = quiet();
    expect(vendorAccountKeys({ repoRoot: c.root, keysDir: c.keysDir, circuits: ['approve'], folder: 'account', expectedVk: c.expectedVk, artefacts: {}, log: out.log })).toBe(1);
    expect(out.lines.join('\n')).toMatch(/REFUSED approve: .*npm run compact/u);
  });
});

describe('the vault\'s circuits are copied from the vault\'s own compile, whole or as a verifier key alone', () => {
  const aVaultCompile = () => {
    const root = mkdtempSync(join(tmpdir(), 'vendor-vault-'));
    mkdirSync(join(root, 'contracts/managed-vault/keys'), { recursive: true });
    mkdirSync(join(root, 'contracts/managed-vault/zkir'), { recursive: true });
    for (const c of ['setNonceSecret', 'deposit']) {
      writeFileSync(join(root, `contracts/managed-vault/keys/${c}.prover`), `${c} prover`);
      writeFileSync(join(root, `contracts/managed-vault/keys/${c}.verifier`), `${c} verifier`);
      writeFileSync(join(root, `contracts/managed-vault/zkir/${c}.bzkir`), `${c} circuit`);
    }
    return { root, keysDir: join(root, 'served'), expectedVk: { setNonceSecret: sha('setNonceSecret verifier'), deposit: sha('deposit verifier') } };
  };
  it('a circuit the wallet proves is copied whole from the vault\'s compile; any other only as its verifier key', () => {
    // RED WHEN: the vault's keys are read from the account's compile, or a prover the wallet never uses is copied and served
    const c = aVaultCompile();
    const artefacts: Record<string, { bytes: number; sha256: string }> = {};
    const out = quiet();
    expect(vendorAccountKeys({ repoRoot: c.root, keysDir: c.keysDir, circuits: ['setNonceSecret'], folder: 'vault', expectedVk: c.expectedVk, artefacts, log: out.log, compiled: 'managed-vault' })).toBe(0);
    expect(vendorAccountKeys({ repoRoot: c.root, keysDir: c.keysDir, circuits: ['deposit'], folder: 'vault', expectedVk: c.expectedVk, artefacts, log: out.log, compiled: 'managed-vault', verifierOnly: true })).toBe(0);
    expect(Object.keys(artefacts).sort()).toEqual(['vault/deposit.verifier', 'vault/setNonceSecret.bzkir', 'vault/setNonceSecret.prover', 'vault/setNonceSecret.verifier']);
    expect(readFileSync(join(c.keysDir, 'vault/setNonceSecret.prover'), 'utf8')).toBe('setNonceSecret prover');
    expect(existsSync(join(c.keysDir, 'vault/deposit.prover'))).toBe(false);
  });
  it('a vault verifier key that is not the one the compiled vault expects is refused, alone or whole', () => {
    // RED WHEN: a vault key from another compile is pinned, so a deploy or a proof uses keys the vault was not built with
    const c = aVaultCompile();
    const artefacts: Record<string, { bytes: number; sha256: string }> = {};
    const out = quiet();
    expect(vendorAccountKeys({ repoRoot: c.root, keysDir: c.keysDir, circuits: ['deposit'], folder: 'vault', expectedVk: { deposit: sha('another') }, artefacts, log: out.log, compiled: 'managed-vault', verifierOnly: true })).toBe(1);
    expect(artefacts).toEqual({});
  });
});
