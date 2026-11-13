/**
 * **THE RECOVERY WINDOW KEPT BESIDE THE LAST RECORDS THE WALLET CHECKED.** The upkeep keeps the window it read under the
 * head the same directory read stood on. Unread is kept only for a version this device holds no key to open; a service
 * that fails keeps what was kept, keeps none in force where the records name no window, and carries a window forward
 * where no version of it was anchored since.
 */
import { describe, expect, it } from 'vitest';
import type { Hex } from '../../../src/core/crypto.js';
import { keepRecoveryWindowHere, type WindowRead } from './recovery-window-here.js';
import { treeKeptInMemory } from './tree-kept-here.js';

const CO = 'acc_window_kept';
const head = (fill: string) => fill.repeat(64) as Hex;
const at = (seq: number, fill: string) => ({ head: head(fill), seq });
const inForce = (seconds: number, where: { head: Hex; seq: number }, named: number[] = [1]): WindowRead =>
  ({ inForce: { seconds, version: 2, sequence: 1 }, waiting: null, highest: 2, here: {} as WindowRead['here'], at: where, named });

describe('THE RECOVERY WINDOW KEPT BY THE UPKEEP', () => {
  it('keeps the window in force, or none, under the head the same read stood on', async () => {
    const kept = treeKeptInMemory();
    await keepRecoveryWindowHere(CO, async () => inForce(3600, at(3, 'a')), kept);
    expect(await kept.windows.read(CO)).toEqual({ head: head('a'), seq: 3, seconds: 3600 });
    await keepRecoveryWindowHere(CO, async () => ({ ...inForce(1, at(4, 'b')), inForce: null }), kept);
    /* RED WHEN: a window read for a later batch is kept under the head of an earlier one, or none in force keeps a length. */
    expect(await kept.windows.read(CO)).toEqual({ head: head('b'), seq: 4, seconds: null });
  });

  it('keeps unread only for a version this device holds no key to open', async () => {
    const kept = treeKeptInMemory();
    await keepRecoveryWindowHere(CO, async () => ({ unread: 'version 2 was sealed under a key this device does not hold', noKey: true, at: at(3, 'a'), named: [2] }), kept);
    /* RED WHEN: a version this device cannot open is kept as none, so a recovery holds a length the company may not have chosen. */
    expect(await kept.windows.read(CO)).toEqual({ head: head('a'), seq: 3, seconds: null, unread: 'version 2 was sealed under a key this device does not hold' });
  });

  it('a service that fails never makes the window unread: none named keeps none in force, and a window is carried forward where none was anchored since', async () => {
    const kept = treeKeptInMemory();
    await keepRecoveryWindowHere(CO, async () => ({ unread: 'the service answered 503', at: at(3, 'a'), named: [] }), kept);
    /* RED WHEN: a service that does not answer, where the records name no window, keeps the window as unread and refuses every recovery. */
    expect(await kept.windows.read(CO)).toEqual({ head: head('a'), seq: 3, seconds: null });
    await keepRecoveryWindowHere(CO, async () => inForce(7200, at(5, 'b'), [4]), kept);
    await keepRecoveryWindowHere(CO, async () => ({ unread: 'the service answered 503', at: at(8, 'c'), named: [4] }), kept);
    /* RED WHEN: a window read at an earlier head is not carried to a later one though no version of it was anchored between. */
    expect(await kept.windows.read(CO)).toEqual({ head: head('c'), seq: 8, seconds: 7200 });
    await keepRecoveryWindowHere(CO, async () => ({ unread: 'the service answered 503', at: at(9, 'd'), named: [4, 9] }), kept);
    /* RED WHEN: a window is carried past a version anchored after it, or the failure is kept as unread. */
    expect(await kept.windows.read(CO)).toEqual({ head: head('c'), seq: 8, seconds: 7200 });
    await keepRecoveryWindowHere(CO, async () => ({ unread: 'the directory was not read' }), kept);
    expect(await kept.windows.read(CO)).toEqual({ head: head('c'), seq: 8, seconds: 7200 });
  });
});
