import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  KEYS_DIR,
  LEDGER_CIRCUITS,
  LEDGER_DECLARED,
  REPO_ROOT,
  BUCKET,
  TRUSTED_SETUP,
  declaredRefusal,
  droppedRefusal,
  ledgerFoldersOf,
  ledgerSourceOf,
  WALLET_DIR,
  accountFilesOf,
  keysFolderOrRefuse,
  pruneOrRefuse,
  pruneStale,
  staleKeysOf,
  vendorAccountKeys,
  vendorRegistryKeys,
  wroteLine
} from './vendor-keys.mjs';
import {
  ACCOUNT_CIRCUITS_THE_WALLET_HOLDS_KEYS_FOR,
  REGISTRY_CIRCUITS_THE_WALLET_PROVES,
  VAULT_CIRCUITS_THE_WALLET_DEPLOYS
} from '../src/chain/account-circuits.js';
import { ACCOUNT_KEYS_FOLDER, REGISTRY_KEYS_FOLDER, VAULT_KEYS_FOLDER } from '../src/chain/key-material.js';

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

describe("the company account's circuits are copied from this build and pinned", () => {
  it("each circuit's prover, verifier and circuit file are copied under the folder named, and pinned", () => {
    // RED WHEN: a file is copied without a pin, or from another place than the compile, so the wallet serves bytes nothing vouches for
    const c = aCompile();
    const artefacts: Record<string, { bytes: number; sha256: string }> = {};
    const out = quiet();
    expect(
      vendorAccountKeys({
        repoRoot: c.root,
        keysDir: c.keysDir,
        circuits: ['propose'],
        folder: 'account',
        expectedVk: c.expectedVk,
        artefacts,
        log: out.log
      })
    ).toBe(0);
    expect(Object.keys(artefacts).sort()).toEqual([
      'account/propose.bzkir',
      'account/propose.prover',
      'account/propose.verifier'
    ]);
    expect(artefacts['account/propose.prover']).toEqual({ bytes: 14, sha256: sha('the prover key') });
    expect(readFileSync(join(c.keysDir, 'account/propose.bzkir'), 'utf8')).toBe('the circuit');
    expect(accountFilesOf(['x'], 'account').map((f) => f.built)).toEqual([
      join('contracts', 'managed', 'keys', 'x.prover'),
      join('contracts', 'managed', 'keys', 'x.verifier'),
      join('contracts', 'managed', 'zkir', 'x.bzkir')
    ]);
  });

  it('a verifier key that is not the one the compiled contract expects is refused, and none of its files are written', () => {
    // RED WHEN: keys from an older compile are copied beside a contract that expects others
    const c = aCompile();
    const artefacts: Record<string, { bytes: number; sha256: string }> = {};
    const out = quiet();
    expect(
      vendorAccountKeys({
        repoRoot: c.root,
        keysDir: c.keysDir,
        circuits: ['propose'],
        folder: 'account',
        expectedVk: { propose: sha('another key') },
        artefacts,
        log: out.log
      })
    ).toBe(1);
    expect(artefacts).toEqual({});
    expect(existsSync(join(c.keysDir, 'account/propose.prover'))).toBe(false);
    expect(out.lines.join('\n')).toMatch(/not this compile's/u);
  });

  it('a pin already taken is defended: changed bytes are refused unless repinned on purpose', () => {
    // RED WHEN: a proving key that changed since it was pinned is accepted without a deliberate repin
    const c = aCompile();
    const artefacts: Record<string, { bytes: number; sha256: string }> = {
      'account/propose.prover': { bytes: 3, sha256: sha('old') }
    };
    const out = quiet();
    expect(
      vendorAccountKeys({
        repoRoot: c.root,
        keysDir: c.keysDir,
        circuits: ['propose'],
        folder: 'account',
        expectedVk: c.expectedVk,
        artefacts,
        log: out.log
      })
    ).toBe(1);
    expect(artefacts['account/propose.prover']).toEqual({ bytes: 3, sha256: sha('old') });
    expect(existsSync(join(c.keysDir, 'account/propose.verifier'))).toBe(false);
    expect(
      vendorAccountKeys({
        repoRoot: c.root,
        keysDir: c.keysDir,
        circuits: ['propose'],
        folder: 'account',
        expectedVk: c.expectedVk,
        artefacts,
        repin: true,
        log: out.log
      })
    ).toBe(0);
    expect(artefacts['account/propose.prover']?.sha256).toBe(sha('the prover key'));
  });

  it('a circuit the compile did not build is refused by name, with the command that builds it', () => {
    // RED WHEN: a missing compile is passed over and the wallet is left without a key it will be asked for
    const c = aCompile();
    const out = quiet();
    expect(
      vendorAccountKeys({
        repoRoot: c.root,
        keysDir: c.keysDir,
        circuits: ['approve'],
        folder: 'account',
        expectedVk: c.expectedVk,
        artefacts: {},
        log: out.log
      })
    ).toBe(1);
    expect(out.lines.join('\n')).toMatch(/REFUSED approve: .*npm run compact/u);
  });
});

describe("the vault's circuits are copied from the vault's own compile, whole or as a verifier key alone", () => {
  const aVaultCompile = () => {
    const root = mkdtempSync(join(tmpdir(), 'vendor-vault-'));
    mkdirSync(join(root, 'contracts/managed-vault/keys'), { recursive: true });
    mkdirSync(join(root, 'contracts/managed-vault/zkir'), { recursive: true });
    for (const c of ['setNonceSecret', 'deposit']) {
      writeFileSync(join(root, `contracts/managed-vault/keys/${c}.prover`), `${c} prover`);
      writeFileSync(join(root, `contracts/managed-vault/keys/${c}.verifier`), `${c} verifier`);
      writeFileSync(join(root, `contracts/managed-vault/zkir/${c}.bzkir`), `${c} circuit`);
    }
    return {
      root,
      keysDir: join(root, 'served'),
      expectedVk: { setNonceSecret: sha('setNonceSecret verifier'), deposit: sha('deposit verifier') }
    };
  };
  it("a circuit the wallet proves is copied whole from the vault's compile; any other only as its verifier key", () => {
    // RED WHEN: the vault's keys are read from the account's compile, or a prover the wallet never uses is copied and served
    const c = aVaultCompile();
    const artefacts: Record<string, { bytes: number; sha256: string }> = {};
    const out = quiet();
    expect(
      vendorAccountKeys({
        repoRoot: c.root,
        keysDir: c.keysDir,
        circuits: ['setNonceSecret'],
        folder: 'vault',
        expectedVk: c.expectedVk,
        artefacts,
        log: out.log,
        compiled: 'managed-vault'
      })
    ).toBe(0);
    expect(
      vendorAccountKeys({
        repoRoot: c.root,
        keysDir: c.keysDir,
        circuits: ['deposit'],
        folder: 'vault',
        expectedVk: c.expectedVk,
        artefacts,
        log: out.log,
        compiled: 'managed-vault',
        verifierOnly: true
      })
    ).toBe(0);
    expect(Object.keys(artefacts).sort()).toEqual([
      'vault/deposit.verifier',
      'vault/setNonceSecret.bzkir',
      'vault/setNonceSecret.prover',
      'vault/setNonceSecret.verifier'
    ]);
    expect(readFileSync(join(c.keysDir, 'vault/setNonceSecret.prover'), 'utf8')).toBe('setNonceSecret prover');
    expect(existsSync(join(c.keysDir, 'vault/deposit.prover'))).toBe(false);
  });
  it('a vault verifier key that is not the one the compiled vault expects is refused, alone or whole', () => {
    // RED WHEN: a vault key from another compile is pinned, so a deploy or a proof uses keys the vault was not built with
    const c = aVaultCompile();
    const artefacts: Record<string, { bytes: number; sha256: string }> = {};
    const out = quiet();
    expect(
      vendorAccountKeys({
        repoRoot: c.root,
        keysDir: c.keysDir,
        circuits: ['deposit'],
        folder: 'vault',
        expectedVk: { deposit: sha('another') },
        artefacts,
        log: out.log,
        compiled: 'managed-vault',
        verifierOnly: true
      })
    ).toBe(1);
    expect(artefacts).toEqual({});
  });
});

describe("the private registry's write is copied from the registry's own compile", () => {
  const aRegistryCompile = (compiled = true) => {
    const root = mkdtempSync(join(tmpdir(), 'vendor-registry-'));
    mkdirSync(join(root, 'contracts/managed-registry/keys'), { recursive: true });
    mkdirSync(join(root, 'contracts/managed-registry/zkir'), { recursive: true });
    writeFileSync(join(root, 'contracts/managed-registry/keys/put.prover'), 'put prover');
    writeFileSync(join(root, 'contracts/managed-registry/keys/put.verifier'), 'put verifier');
    writeFileSync(join(root, 'contracts/managed-registry/zkir/put.bzkir'), 'put circuit');
    if (compiled) {
      mkdirSync(join(root, 'contracts/managed-registry/contract'), { recursive: true });
      writeFileSync(
        join(root, 'contracts/managed-registry/contract/index.js'),
        `export const expectedVk = { put: '${sha('put verifier')}' };\n`
      );
    }
    return { root, keysDir: join(root, 'served') };
  };
  it("copies each circuit the wallet proves whole, under the registry's folder, checked against the registry's compile", async () => {
    // RED WHEN: the registry's keys are read from another compile's folder, or not copied under the folder the wallet serves them from
    const c = aRegistryCompile();
    const artefacts: Record<string, { bytes: number; sha256: string }> = {};
    const out = quiet();
    const got = await vendorRegistryKeys({
      repoRoot: c.root,
      keysDir: c.keysDir,
      circuits: REGISTRY_CIRCUITS_THE_WALLET_PROVES,
      folder: REGISTRY_KEYS_FOLDER,
      artefacts,
      log: out.log
    });
    expect(got).toEqual({
      refused: 0,
      walked: true,
      expected: ['registry/put.prover', 'registry/put.verifier', 'registry/put.bzkir']
    });
    expect(Object.keys(artefacts).sort()).toEqual([
      'registry/put.bzkir',
      'registry/put.prover',
      'registry/put.verifier'
    ]);
    expect(readFileSync(join(c.keysDir, 'registry/put.prover'), 'utf8')).toBe('put prover');
  });
  it('refuses by name, and copies nothing, when the registry has not been compiled', async () => {
    // RED WHEN: a missing registry compile is passed over in silence, so the wallet ships with no key for its write
    const c = aRegistryCompile(false);
    const artefacts: Record<string, { bytes: number; sha256: string }> = {};
    const out = quiet();
    const got = await vendorRegistryKeys({
      repoRoot: c.root,
      keysDir: c.keysDir,
      circuits: ['put'],
      folder: REGISTRY_KEYS_FOLDER,
      artefacts,
      log: out.log
    });
    expect(got).toEqual({ refused: 1, walked: false, expected: [] });
    expect(out.lines.join('\n')).toMatch(/no compiled registry at contracts\/managed-registry/u);
    expect(artefacts).toEqual({});
  });
});

describe('a circuit the compile no longer builds leaves nothing behind in the keys the wallet serves', () => {
  type Pins = Record<string, { bytes: number; sha256: string }>;
  /** A served folder holding `propose` (still built) and `amendSigner` (no longer built), each pinned. */
  const aFolderWithAGone = () => {
    const keysDir = mkdtempSync(join(tmpdir(), 'vendor-served-'));
    const graveyard = mkdtempSync(join(tmpdir(), 'vendor-graveyard-'));
    mkdirSync(join(keysDir, 'account'), { recursive: true });
    mkdirSync(join(keysDir, 'zswap/9'), { recursive: true });
    const artefacts: Pins = {};
    for (const name of ['propose', 'amendSigner']) {
      for (const suffix of ['.prover', '.verifier', '.bzkir']) {
        writeFileSync(join(keysDir, `account/${name}${suffix}`), `${name}${suffix}`);
        artefacts[`account/${name}${suffix}`] = { bytes: 1, sha256: sha(`${name}${suffix}`) };
      }
    }
    writeFileSync(join(keysDir, 'zswap/9/spend.prover'), 'the network key');
    artefacts['zswap/9/spend.prover'] = { bytes: 1, sha256: sha('the network key') };
    const expected = accountFilesOf(['propose'], 'account').map((f) => f.served);
    return { keysDir, graveyard, artefacts, expected };
  };

  it("a file or pin under a walked folder that the compile does not build is named, and the network's pins and the built circuits are not", () => {
    // RED WHEN: a removed circuit's key files and pins stay in the keys folder, so the wallet serves a 19 MB prover nothing proves with
    const f = aFolderWithAGone();
    expect(
      staleKeysOf({ keysDir: f.keysDir, artefacts: f.artefacts, folders: ['account'], expected: f.expected })
    ).toEqual(['account/amendSigner.bzkir', 'account/amendSigner.prover', 'account/amendSigner.verifier']);
    expect(staleKeysOf({ keysDir: f.keysDir, artefacts: f.artefacts, folders: ['vault'], expected: [] })).toEqual([]);
  });

  it('a run without --prune is refused by file name and moves nothing', () => {
    // RED WHEN: a stale key is passed over silently, or the script moves files nobody told it to move
    const f = aFolderWithAGone();
    const out = quiet();
    const before = { ...f.artefacts };
    expect(
      pruneOrRefuse({
        keysDir: f.keysDir,
        artefacts: f.artefacts,
        folders: ['account'],
        expected: f.expected,
        prune: false,
        graveyard: f.graveyard,
        stamp: 'T',
        log: out.log
      })
    ).toBe(1);
    expect(out.lines.join('\n')).toMatch(/account\/amendSigner\.prover[\s\S]*--prune/u);
    expect(f.artefacts).toEqual(before);
    expect(existsSync(join(f.keysDir, 'account/amendSigner.prover'))).toBe(true);
    expect(readdirSync(f.graveyard)).toEqual([]);
  });

  it('--prune moves the files into the graveyard under a name that says where they came from, and drops their pins', () => {
    // RED WHEN: the files are deleted rather than moved, or a pin outlives its file
    const f = aFolderWithAGone();
    const out = quiet();
    expect(
      pruneOrRefuse({
        keysDir: f.keysDir,
        artefacts: f.artefacts,
        folders: ['account'],
        expected: f.expected,
        prune: true,
        graveyard: f.graveyard,
        stamp: 'T',
        log: out.log
      })
    ).toBe(0);
    expect(readdirSync(f.graveyard).sort()).toEqual([
      'vendor-keys-pruned-T-account-amendSigner.bzkir',
      'vendor-keys-pruned-T-account-amendSigner.prover',
      'vendor-keys-pruned-T-account-amendSigner.verifier'
    ]);
    expect(readFileSync(join(f.graveyard, 'vendor-keys-pruned-T-account-amendSigner.prover'), 'utf8')).toBe(
      'amendSigner.prover'
    );
    expect(existsSync(join(f.keysDir, 'account/amendSigner.prover'))).toBe(false);
    expect(Object.keys(f.artefacts).sort()).toEqual([
      'account/propose.bzkir',
      'account/propose.prover',
      'account/propose.verifier',
      'zswap/9/spend.prover'
    ]);
    expect(existsSync(join(f.keysDir, 'zswap/9/spend.prover'))).toBe(true);
  });

  it('a folder the run did not walk is never pruned, and a pin whose file is already gone is dropped without a move', () => {
    // RED WHEN: a vault compile that is missing makes the vault's served keys look stale
    const f = aFolderWithAGone();
    mkdirSync(join(f.keysDir, 'vault'), { recursive: true });
    writeFileSync(join(f.keysDir, 'vault/payout.prover'), 'a vault key');
    f.artefacts['vault/payout.prover'] = { bytes: 1, sha256: sha('a vault key') };
    expect(
      staleKeysOf({ keysDir: f.keysDir, artefacts: f.artefacts, folders: ['account'], expected: f.expected }).some(
        (s) => s.startsWith('vault/')
      )
    ).toBe(false);
    f.artefacts['account/gone.prover'] = { bytes: 1, sha256: 'x' };
    expect(
      pruneStale({
        keysDir: f.keysDir,
        artefacts: f.artefacts,
        stale: ['account/gone.prover'],
        graveyard: f.graveyard,
        stamp: 'T'
      })
    ).toBe(0);
    expect(f.artefacts['account/gone.prover']).toBeUndefined();
  });

  it('the manifest the wallet ships pins no account or vault circuit that the wallet neither holds nor proves', () => {
    // RED WHEN: a removed circuit's pins stay in manifest.json, so the wallet pins and serves keys for a circuit the contract no longer has
    const pins = (JSON.parse(readFileSync(join(KEYS_DIR, 'manifest.json'), 'utf8')) as { artefacts: Pins }).artefacts;
    const circuitsPinnedUnder = (folder: string): string[] =>
      [
        ...new Set(
          Object.keys(pins)
            .filter((served) => served.startsWith(`${folder}/`))
            .map((served) => served.slice(folder.length + 1).replace(/\.(?:prover|verifier|bzkir)$/u, ''))
        )
      ].sort();
    expect(
      circuitsPinnedUnder(ACCOUNT_KEYS_FOLDER).filter((c) => !ACCOUNT_CIRCUITS_THE_WALLET_HOLDS_KEYS_FOR.includes(c))
    ).toEqual([]);
    expect(
      circuitsPinnedUnder(VAULT_KEYS_FOLDER).filter((c) => !VAULT_CIRCUITS_THE_WALLET_DEPLOYS.includes(c))
    ).toEqual([]);
  });
});

/** The wallet's map of the ledger's own keys, which the script reads as it loads, copied into a bare checkout. */
const withTheLedgerKeyMap = (root: string): void => {
  const chain = join(root, 'apps', 'wallet', 'src', 'chain');
  mkdirSync(chain, { recursive: true });
  copyFileSync(join(WALLET_DIR, 'src', 'chain', 'ledger-keys.json'), join(chain, 'ledger-keys.json'));
};

describe('the script reports where it wrote, and refuses a keys folder that is not there', () => {
  it('the success line names the manifest the run wrote, read from where it was written', () => {
    // RED WHEN: the success line names apps/wallet/public/keys whatever folder the run wrote to, so it reports success at a path it never touched
    const repoRoot = join(tmpdir(), 'a-repository');
    const line = wroteLine({ repoRoot, manifestPath: join(repoRoot, 'other', 'place', 'manifest.json'), pins: 3 });
    expect(line).toContain('Wrote 3 pins to other/place/manifest.json');
    expect(line).not.toContain('apps/wallet/public/keys');
  });

  it('a missing keys folder is refused by name, with what restores it, and is not created', () => {
    // RED WHEN: a run whose keys folder is missing creates it and reports success instead of stopping
    const repoRoot = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'vendor-folder-'));
    const keysDir = join(repoRoot, 'apps', 'wallet', 'public', 'keys');
    const q = quiet();
    expect(keysFolderOrRefuse({ keysDir, repoRoot, log: q.log })).toBe(1);
    const said = q.lines.join('\n');
    expect(said).toContain('REFUSED');
    expect(said).toContain('apps/wallet/public/keys');
    expect(said).toContain('manifest.json');
    expect(said).toMatch(/restore|check out/iu);
    expect(existsSync(keysDir)).toBe(false);
    mkdirSync(keysDir, { recursive: true });
    const ok = quiet();
    expect(keysFolderOrRefuse({ keysDir, repoRoot, log: ok.log })).toBe(0);
    expect(ok.lines).toEqual([]);
  });

  it('the script run against a repository with no keys folder stops before any download and creates nothing', () => {
    // RED WHEN: a first run in a checkout without the keys folder dials the network and then makes the folder itself
    const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'vendor-spawn-'));
    const scripts = join(root, 'apps', 'wallet', 'scripts');
    mkdirSync(scripts, { recursive: true });
    copyFileSync(join(HERE, 'vendor-keys.mjs'), join(scripts, 'vendor-keys.mjs'));
    withTheLedgerKeyMap(root);
    const ran = spawnSync(process.execPath, [join(scripts, 'vendor-keys.mjs')], { encoding: 'utf8', timeout: 20_000 });
    expect(ran.status).toBe(1);
    expect(ran.stdout).toContain('REFUSED');
    expect(ran.stdout).toContain('apps/wallet/public/keys');
    expect(existsSync(join(root, 'apps', 'wallet', 'public'))).toBe(false);
  });

  it('the script run through a symlinked folder, as macOS temp folders are, still runs and refuses', () => {
    // RED WHEN: the script decides it was not run directly because its path goes through a symlink, so it does nothing and exits 0 with the keys folder unchecked
    const real = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'vendor-real-'));
    const scripts = join(real, 'apps', 'wallet', 'scripts');
    mkdirSync(scripts, { recursive: true });
    copyFileSync(join(HERE, 'vendor-keys.mjs'), join(scripts, 'vendor-keys.mjs'));
    withTheLedgerKeyMap(real);
    const link = `${real}-link`;
    symlinkSync(real, link);
    const ran = spawnSync(process.execPath, [join(link, 'apps', 'wallet', 'scripts', 'vendor-keys.mjs')], {
      encoding: 'utf8',
      timeout: 20_000
    });
    expect(ran.status).toBe(1);
    expect(ran.stdout).toContain('REFUSED');
    expect(existsSync(join(real, 'apps', 'wallet', 'public'))).toBe(false);
  });
});

const LEDGER_RELEASE = join(REPO_ROOT, 'midnight-src', 'preprod', 'midnight-ledger');

describe("the ledger's own keys are the ones its release declares", () => {
  it('every ledger key file the wallet serves has the hash its release declares, and nothing else is declared', () => {
    /* RED WHEN: a ledger key the wallet asks for is fetched with no declared hash to refuse it against. */
    const served = LEDGER_CIRCUITS.flatMap((c) => ['prover', 'verifier', 'bzkir'].map((k) => `${c}.${k}`)).sort();
    expect(Object.keys(LEDGER_DECLARED).sort()).toEqual(served);
  });

  it.skipIf(!existsSync(LEDGER_RELEASE))(
    'each declared hash is the one the ledger release preprod runs writes in its own source',
    () => {
      /* RED WHEN: a ledger key hash is written from anywhere but the ledger release, so a key the node refuses is pinned as good. */
      const where: Record<string, string> = {
        'dust/10/spend': 'ledger/static/dust/spend',
        'zswap/9/spend': 'zswap/static/spend',
        'zswap/9/output': 'zswap/static/output',
        'zswap/9/sign': 'zswap/static/sign'
      };
      for (const [circuit, file] of Object.entries(where)) {
        for (const kind of ['prover', 'verifier', 'bzkir']) {
          const declared = readFileSync(join(LEDGER_RELEASE, `${file}.${kind}.sha256`), 'utf8')
            .trim()
            .split(/\s+/)[0];
          expect(LEDGER_DECLARED[`${circuit}.${kind}`], `${circuit}.${kind}`).toBe(declared);
        }
      }
    }
  );

  it.skipIf(!existsSync(LEDGER_RELEASE))(
    'the ledger package the product installs is the release the declared hashes were read from',
    () => {
      /* RED WHEN: the product pins a ledger whose own keys are not the ones the wallet fetches, so every fee is proved with a key that node refuses. */
      const released = JSON.parse(readFileSync(join(LEDGER_RELEASE, 'ledger-wasm', 'package.json'), 'utf8')).version;
      const pinned = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).dependencies[
        '@midnightntwrk/ledger-v9'
      ];
      expect(pinned).toBe(released);
    }
  );

  it('the Dust spend key comes from the trusted-setup host and every other ledger key from the bucket', () => {
    /* RED WHEN: the Dust spend key is fetched from the bucket, which serves bytes the release does not declare. */
    for (const kind of ['prover', 'verifier', 'bzkir'])
      expect(ledgerSourceOf(`dust/10/spend.${kind}`)).toBe(TRUSTED_SETUP);
    for (const c of ['spend', 'output', 'sign']) expect(ledgerSourceOf(`zswap/9/${c}.prover`)).toBe(BUCKET);
  });

  it('a ledger key file that does not hash to the declared value is refused by name; the declared bytes pass', () => {
    /* RED WHEN: a Dust spend key the release does not declare is written and pinned. */
    expect(declaredRefusal('dust/10/spend.prover', 'ff'.repeat(32), TRUSTED_SETUP)?.join('\n')).toMatch(
      /REFUSED dust\/10\/spend\.prover[\s\S]*3dff9f54/u
    );
    expect(declaredRefusal('dust/10/spend.prover', LEDGER_DECLARED['dust/10/spend.prover']!, TRUSTED_SETUP)).toBeNull();
    expect(declaredRefusal('bls_midnight_2p16', 'ff'.repeat(32), BUCKET)).toBeNull();
  });

  it('an earlier generation of a ledger key left in the keys folder or the pins is found, and the current ones are not', () => {
    /* RED WHEN: the wallet keeps serving the Dust spend key of a generation the node no longer accepts. */
    const keysDir = mkdtempSync(join(tmpdir(), 'ledger-keys-'));
    mkdirSync(join(keysDir, 'dust', '8'), { recursive: true });
    writeFileSync(join(keysDir, 'dust', '8', 'spend.prover'), 'old');
    const artefacts = {
      'dust/9/spend.verifier': { bytes: 1, sha256: 'a' },
      'dust/10/spend.prover': { bytes: 1, sha256: 'b' },
      'zswap/9/spend.prover': { bytes: 1, sha256: 'c' }
    };
    const folders = ledgerFoldersOf({ keysDir, artefacts, circuits: LEDGER_CIRCUITS });
    const expected = LEDGER_CIRCUITS.flatMap((c) => ['.prover', '.verifier', '.bzkir'].map((k) => `${c}${k}`));
    expect(staleKeysOf({ keysDir, artefacts, folders, expected })).toEqual([
      'dust/8/spend.prover',
      'dust/9/spend.verifier'
    ]);
  });
});

describe('a download that drops is refused by name, not thrown', () => {
  /* RED WHEN: a dropped download is refused without naming the file, the address, or that running it again fetches it. */
  it('names the file, the address and the cause, and says running the command again fetches it', () => {
    const cause = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    const lines = droppedRefusal('bls_midnight_2p17', 'https://srs.example/bls_midnight_2p17', cause).join('\n');
    expect(lines).toContain('REFUSED bls_midnight_2p17');
    expect(lines).toContain('https://srs.example/bls_midnight_2p17');
    expect(lines).toContain('ECONNRESET');
    expect(lines).toMatch(/Run this door again/u);
  });
});
