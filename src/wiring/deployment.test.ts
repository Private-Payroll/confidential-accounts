/**
 * THE DEPLOYMENT FACTS REFUSE RATHER THAN GUESS.
 *
 * `resolveDeployment` is the rules with the disk taken out, which is what makes
 * this file possible: every refusal below is reached by handing it a value,
 * not by arranging a filesystem. A rule that can only be exercised by building
 * a directory is a rule that gets exercised once.
 *
 * Each case names the change that turns it red, and each was watched failing
 * under that change before it was written down.
 */
import { describe, it, expect } from 'vitest';
import { NETWORK } from 'midnight-identity/network';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDeployment, deployment, deploymentRecordPath, serviceStorePath, storeDir } from './deployment.js';

const ENDPOINTS = {
  indexerUrl: 'https://indexer.example/api/v4/graphql',
  indexerWsUrl: 'wss://indexer.example/api/v4/graphql/ws',
  nodeUrl: 'https://rpc.example',
};

const good = {
  network: NETWORK,
  record: { network: NETWORK, contractAddress: 'bcb61fef' },
  recordPath: `/somewhere/.midnight/${NETWORK}-contract.json`,
  endpoints: ENDPOINTS,
  proverUrl: 'http://prover.invalid:1',
  stateRoot: '/somewhere',
  zkConfigPath: '/somewhere/contracts/managed',
  vaultZkConfigPath: '/somewhere/contracts/managed-vault',
};

describe('a deployment resolves from one place or it refuses', () => {
  it('resolves when every fact has its one home', () => {
    const d = resolveDeployment(good);
    expect(d.contractAddress).toBe('bcb61fef');
    expect(d.network).toBe(NETWORK);
    expect(d.indexerUrl).toBe(ENDPOINTS.indexerUrl);
    expect(d.proverUrl).toBe('http://prover.invalid:1');
    expect(d.privateStateId).toBe(`confidential-accounts-${NETWORK}`);
  });

  /*
   * **PER NETWORK, BOTH OF THEM, AND ASSERTED SO THAT IT CAN FAIL.**
   *
   * RED WHEN: the network is dropped from either path. The previous version of
   * this asserted the sealed root merely contained `.midnight`, which is true
   * of every root this function can produce — it could not have failed for the
   * property it named, and the property was in fact broken when it passed.
   *
   * What it costs if it breaks: a blob is filed under an account id and a
   * commitment that is one constant everywhere, and the store leaves an
   * existing file alone. Two chains sharing a root means the second one's state
   * is silently never written and the first one's is read back in its place.
   */
  /*
   * **THE TWO ARTEFACT PATHS ARE TWO CONTRACTS, AND THIS IS WHAT SAYS SO.**
   *
   * RED WHEN: the vault's path is derived from, or set equal to, the account's.
   * A vault client pointed at the account's compiled assets does not fail as
   * absent — it checks arity and verifier keys against the wrong contract's
   * ABI, which is confidently wrong, and the sentence it produces names
   * circuits nobody called.
   */
  it('the account\'s compiled assets and the vault\'s are different directories', () => {
    const d = resolveDeployment(good);
    expect(d.zkConfigPath).toBe('/somewhere/contracts/managed');
    expect(d.vaultZkConfigPath).toBe('/somewhere/contracts/managed-vault');
  });

  /*
   * RED WHEN a path of a network's store is built outside that network's store folder, or two networks share one
   * folder: a run on one network would then read or write another network's records and seeds.
   */
  it('every file of a network\'s store is in that network\'s own folder, and no two networks share one', () => {
    expect(storeDir('/r', 'preprod')).toBe(join('/r', '.midnight', 'preprod'));
    expect(storeDir('/r', 'preview')).not.toBe(storeDir('/r', NETWORK));
    expect(deploymentRecordPath('/r', 'preprod')).toBe(join(storeDir('/r', 'preprod'), 'preprod-contract.json'));
    expect(serviceStorePath('/r', 'preprod')).toBe(join(storeDir('/r', 'preprod'), 'beta.json'));
    expect(resolveDeployment(good).sealedStateRoot).toBe(join(storeDir('/somewhere', NETWORK), 'sealed'));
  });

  it('the sealed root and the private state id both name the network', () => {
    const compiled = resolveDeployment(good);
    const preview = resolveDeployment({
      ...good, network: 'preview',
      record: { network: 'preview', contractAddress: 'bcb61fef' },
    });
    expect(compiled.sealedStateRoot).not.toBe(preview.sealedStateRoot);
    expect(compiled.sealedStateRoot).toContain(NETWORK);
    expect(preview.sealedStateRoot).toContain('preview');
    expect(compiled.privateStateId).not.toBe(preview.privateStateId);
  });

  /*
   * RED WHEN: a missing record is refused again, or read as if present.
   * Companies on a chain are founded from their signers' browsers and this
   * service deploys none, so a fresh network has no record; the deployment
   * still resolves, with no address of its own.
   */
  it('resolves with no address when no deployment has been recorded', () => {
    const d = resolveDeployment({ ...good, record: null });
    expect(d.contractAddress).toBeNull();
    expect(d.network).toBe(NETWORK);
  });

  it('still refuses a missing proof server when no record is there either', () => {
    expect(() => resolveDeployment({ ...good, record: null, proverUrl: undefined }))
      .toThrow(/no proof server is configured/);
  });

  /*
   * RED WHEN: the `record.network !== network` comparison is dropped. This is
   * the one that matters most — a record from another chain read as this
   * chain's is the product talking to a contract nobody is watching, and
   * nothing else in the system would notice.
   */
  it('refuses a record written for another network, and names both', () => {
    expect(() => resolveDeployment({
      ...good, record: { network: 'preview', contractAddress: 'bcb61fef' },
    })).toThrow(new RegExp(`written for "preview".*signs people in on "${NETWORK}"`, 's'));
  });

  /*
   * RED WHEN: the empty-address check weakens to a truthiness test that accepts
   * a blank string, or the field is defaulted anywhere.
   */
  it('refuses a record with no contract address', () => {
    expect(() => resolveDeployment({ ...good, record: { network: NETWORK } }))
      .toThrow(/carries no contract address/);
  });

  it('refuses a record whose address is blank rather than absent', () => {
    expect(() => resolveDeployment({
      ...good, record: { network: NETWORK, contractAddress: '   ' },
    })).toThrow(/carries no contract address/);
  });

  /*
   * RED WHEN: `endpoints` acquires a fallback. A guessed indexer is a product
   * reading a chain nobody chose.
   */
  it('refuses a network with no endpoints rather than guessing one', () => {
    expect(() => resolveDeployment({ ...good, endpoints: undefined }))
      .toThrow(`no indexer and node are known for "${NETWORK}"`);
  });

  /*
   * RED WHEN: `proverUrl` gets a default — a localhost port, say, which is what
   * every other consumer in this repository does. THE POINT OF THIS ASSERTION
   * IS THAT THE DEFAULT IS ABSENT, so it is the one most likely to be
   * "fixed" by somebody being helpful.
   */
  it('refuses a missing proof server rather than defaulting to a local port', () => {
    expect(() => resolveDeployment({ ...good, proverUrl: undefined }))
      .toThrow(/no proof server is configured, and there is deliberately no default/);
    expect(() => resolveDeployment({ ...good, proverUrl: '' }))
      .toThrow(/deliberately no default/);
  });

  /*
   * A NEGATIVE CONTROL FOR THE WHOLE FILE. If `resolveDeployment` were changed
   * to return a fixed object, every refusal above would still pass while
   * proving nothing; this is the case that would not.
   */
  it('carries the values it was given rather than values of its own', () => {
    const d = resolveDeployment({
      ...good,
      record: { network: NETWORK, contractAddress: 'aaaa0000' },
      proverUrl: 'http://prover.elsewhere:7777',
    });
    expect(d.contractAddress).toBe('aaaa0000');
    expect(d.proverUrl).toBe('http://prover.elsewhere:7777');
  });

  /*
   * **THE READER'S OWN PATHS, WHICH THE RULES ABOVE CANNOT SEE.**
   *
   * Everything else here hands `resolveDeployment` a value, so the two artefact
   * paths the READER supplies were asserted nowhere: a reader that handed both
   * arguments the same directory would pass every case above. This is the one
   * check that needs a disk, and it needs only a file.
   *
   * RED WHEN: either path is changed, or the two are made equal.
   *
   * **BOTH SIDES ARE BUILT FROM THE SAME UNRESOLVED `root`**, so nothing here
   * compares a resolved path against an unresolved one. On macOS `tmpdir()` is
   * reached through a link and a comparison that resolved one side only would
   * be true on Linux and false on a Mac.
   */
  it('the reader points at contracts/managed and contracts/managed-vault', () => {
    const root = mkdtempSync(join(tmpdir(), 'mn-s116-deploy-'));
    mkdirSync(storeDir(root, NETWORK), { recursive: true });
    writeFileSync(
      deploymentRecordPath(root, NETWORK),
      JSON.stringify({ network: NETWORK, contractAddress: 'bcb61fef' }));

    const d = deployment(root, {
      MIDNIGHT_NETWORK_ID: NETWORK,
      MIDNIGHT_PROVER_URL: 'http://prover.invalid:1',
    } as NodeJS.ProcessEnv);

    expect(d.zkConfigPath).toBe(join(root, 'contracts', 'managed'));
    expect(d.vaultZkConfigPath).toBe(join(root, 'contracts', 'managed-vault'));
  });
});
