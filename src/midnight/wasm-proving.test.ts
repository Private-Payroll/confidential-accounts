/**
 * The key-location parser.
 *
 * A tiny amount of string handling, tested because it was wrong on a live chain
 * and the failure cost a run. The SDK asks for proving material by a structured
 * reference, not a circuit id:
 *
 *     contract:90a19bf2…d484/credit?vk=5ac4195f…4f84
 *
 * Treating that as a filename produced an ENOENT naming a path that could never
 * exist. Cheap to test, and the sort of thing that silently rots when the SDK
 * changes the format.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileKeyMaterialSource } from './wasm-proving.js';

const ADDR = '90a19bf2cd784d5b52d6264cc0facbef657f2a9be16cf6f510aee4c2d275d484';
const VK = '5ac4195fe2a6800891d33311411f4f0cd294d5c795021aa1fdb2d2ad8b704f84';

function artefacts() {
  const root = mkdtempSync(join(tmpdir(), 'artefacts-'));
  mkdirSync(join(root, 'keys'), { recursive: true });
  mkdirSync(join(root, 'zkir'), { recursive: true });
  /*
   * `credit` IS A SHED CIRCUIT AND IS KEPT HERE ON PURPOSE.
   *
   * This is not a fixture standing in for a live circuit: it is the exact key
   * location the chain asked for during the failing run this file exists
   * because of. The parser under test does not know or care which
   * circuits the contract has, and renaming it to a surviving circuit would
   * quietly edit a recorded observation into something nobody saw.
   */
  writeFileSync(join(root, 'keys', 'credit.prover'), 'PROVER');
  writeFileSync(join(root, 'keys', 'credit.verifier'), 'VERIFIER');
  writeFileSync(join(root, 'zkir', 'credit.bzkir'), 'IR');
  return root;
}

function params() {
  const root = mkdtempSync(join(tmpdir(), 'params-'));
  writeFileSync(join(root, 'bls_midnight_2p15'), 'SRS15');
  writeFileSync(join(root, 'bls_filecoin_2p14'), 'SRS14-oldname');
  return root;
}

describe('fileKeyMaterialSource', () => {
  it('finds the circuit inside a full key location', async () => {
    // The exact string the chain asked for, from the failing run.
    const src = await fileKeyMaterialSource(artefacts(), params());
    const km = await src.lookupKey(`contract:${ADDR}/credit?vk=${VK}`);
    expect(new TextDecoder().decode(km!.proverKey)).toBe('PROVER');
    expect(new TextDecoder().decode(km!.verifierKey)).toBe('VERIFIER');
    expect(new TextDecoder().decode(km!.ir)).toBe('IR');
  });

  it('still accepts a bare circuit id', async () => {
    // Not every caller uses the structured form, and guessing wrong in either
    // direction breaks proving entirely.
    const src = await fileKeyMaterialSource(artefacts(), params());
    expect(await src.lookupKey('credit')).toBeTruthy();
  });

  it('reads the SRS under the name the container actually uses', async () => {
    // bls_midnight_*, not the bls_filecoin_* the proof server's own download
    // script fetches. Renamed upstream; both are tried.
    const src = await fileKeyMaterialSource(artefacts(), params());
    expect(new TextDecoder().decode(await src.getParams(15))).toBe('SRS15');
  });

  it('falls back to the older filecoin spelling', async () => {
    const src = await fileKeyMaterialSource(artefacts(), params());
    expect(new TextDecoder().decode(await src.getParams(14))).toBe('SRS14-oldname');
  });

  it('says which k is missing, and where it looked', async () => {
    // A bare ENOENT here means nothing to whoever sees it.
    const src = await fileKeyMaterialSource(artefacts(), params());
    await expect(src.getParams(12)).rejects.toThrow(/k=12.*bls_midnight_2p12/s);
  });
});
