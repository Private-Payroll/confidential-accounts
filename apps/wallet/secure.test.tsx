// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { newSecret } from 'midnight-identity/keys/derivation';
import { fingerprintOf } from 'midnight-identity/recovery/pieces';
import { toBase64Url } from 'midnight-identity/passkey/bytes';
import { loadSecuredSetup, saveSecret, saveSubwalletName } from './storage.js';
import { forgetOpenWallet } from './wallets-held.js';
import { DEFAULT_CANDIDATES, Secure, holderOf, planFromCandidates } from './screens/secure.js';

/*
 * THE SECURING FLOW, DRIVEN — real `suggestDefault`, real `checkPlan`
 * sentences, real `warningsFor`, a real Shamir split, the evidence-carrying
 * writer, and (§7.14) a finish step that CONSUMES one piece's bytes
 * read back from its card rather than a checkbox.
 */

const mount = (secret: Uint8Array): void => {
  render(<Secure secret={secret} />);
};

beforeEach(() => {
  cleanup();
  localStorage.clear();
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
  /* The open compartment is module state and outlives a test. */
  forgetOpenWallet();
});

/** Walk: plan → cut → tick all cards → continue → read the chosen piece's
 * bytes off the cards view we captured before leaving it → type → finish. */
async function driveToDone(): Promise<void> {
  fireEvent.click(screen.getByText('Cut the account into pieces'));
  await waitFor(() => expect(screen.getByTestId('piece-bytes-0')).toBeTruthy());
  const bytesByIndex = [0, 1, 2].map((i) =>
    (screen.getByTestId(`piece-bytes-${i}`).textContent ?? '').replace(/\s+/g, ''));
  for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box);
  fireEvent.click(screen.getByText(/are placed — continue/));
  /* The prove step names which piece it wants; no bytes are on screen. */
  const prompt = await screen.findByText(/Read one piece back from its card/);
  expect(prompt).toBeTruthy();
  const which = Number((screen.getByText(/^piece \d+ — /).textContent?.match(/piece (\d+)/) ?? [])[1]) - 1;
  fireEvent.change(screen.getByRole('textbox'), { target: { value: bytesByIndex[which] } });
  fireEvent.click(screen.getByText(/— finish$/));
  await waitFor(() => expect(screen.getByText(/Account secured\./)).toBeTruthy());
}

describe('the suggested plan — §7.3, reorder-proof', () => {
  it('is 2-of-3 from suggestDefault, and never this device, said on screen', () => {
    mount(newSecret());
    expect(screen.getByTestId('threshold').textContent).toContain('2');
    expect(screen.getByTestId('threshold').textContent).toContain('of 3');
    expect(screen.queryByDisplayValue(/this browser/)).toBeNull();
    expect(screen.getByText(/never includes the machine you are standing at/)).toBeTruthy();
  });

  it('drops the this-device candidate WHEREVER it sits in the list', () => {
    /* The old assertion passed for the wrong reason: the device candidate was
     * fourth and slice(0,3) dropped it regardless. Put it FIRST. */
    const candidates = [...DEFAULT_CANDIDATES];
    const device = candidates.pop();
    if (!device) throw new Error('fixture broke');
    expect(device.isThisDevice).toBe(true);
    const plan = planFromCandidates([device, ...candidates]);
    expect(plan.rows).toHaveLength(3);
    expect(plan.rows.some((r) => r.detail === device.detail)).toBe(false);
  });

  it('the candidate list genuinely contains a this-device entry to drop', () => {
    expect(DEFAULT_CANDIDATES.some((c) => c.isThisDevice)).toBe(true);
  });
});

describe('the rules, live, in the library’s own words', () => {
  it('warns loudly at N-of-N, at the moment the numbers are chosen', () => {
    mount(newSecret());
    fireEvent.click(screen.getByLabelText('More pieces needed'));
    expect(screen.getByText(/Lose any one of them/)).toBeTruthy();
    expect((screen.getByText('Cut the account into pieces') as HTMLButtonElement).disabled)
      .toBe(false);
  });

  it('the SAME place under two different kinds is ONE holder', () => {
    mount(newSecret());
    const kinds = screen.getAllByLabelText('Kind of place');
    const details = screen.getAllByLabelText('Who controls it');
    /* Row 0: a cloud account "my Google Drive"; row 1: a FILE kept in
     * "My  google DRIVE" — different kind, different case and spacing, the
     * same login in the world. */
    fireEvent.change(kinds[0] as Element, { target: { value: 'cloud' } });
    fireEvent.change(details[0] as Element, { target: { value: 'my Google Drive' } });
    fireEvent.change(kinds[1] as Element, { target: { value: 'file' } });
    fireEvent.change(details[1] as Element, { target: { value: 'My  google DRIVE' } });
    expect(screen.getByText(/Two pieces in one place are one piece/)).toBeTruthy();
    expect((screen.getByText('Cut the account into pieces') as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it('other direction: different places under one kind do NOT collide', () => {
    expect(holderOf({ kind: 'cloud', detail: 'Drive A' }))
      .not.toBe(holderOf({ kind: 'cloud', detail: 'Drive B' }));
    /* And the kind carries nothing: same detail, any kinds, one holder. */
    expect(holderOf({ kind: 'cloud', detail: ' My Drive ' }))
      .toBe(holderOf({ kind: 'file', detail: 'my  drive' }));
  });

  it('an empty detail is refused with checkPlan’s who-controls-it sentence', () => {
    mount(newSecret());
    const details = screen.getAllByLabelText('Who controls it');
    fireEvent.change(details[0] as Element, { target: { value: '   ' } });
    expect(screen.getByText(/does not say who controls it/)).toBeTruthy();
  });
});

describe('cards and printing', () => {
  it('every card has its OWN print button and there is no print-the-set button', async () => {
    mount(newSecret());
    fireEvent.click(screen.getByText('Cut the account into pieces'));
    await waitFor(() => expect(screen.getByTestId('piece-bytes-0')).toBeTruthy());
    expect(screen.getAllByText('Print this card')).toHaveLength(3);
    expect(screen.queryByText('Print the cards')).toBeNull();
    /* Each card says on its face that it must be kept apart. */
    expect(screen.getAllByText(/keep apart from the others/)).toHaveLength(3);
    /* And no card predicts — §7.12. */
    expect(screen.queryByText(/still put it back/)).toBeNull();
  });

  it('printing one card marks exactly that card for the print stylesheet', async () => {
    /* The assertion happens INSIDE the print job — `window.print` is
     * synchronous and the page prints as it stands at that moment, so what
     * carries `print-target` right then is what lands on paper. Marking
     * every card, or the wrong card, turns this red; the test's name and its
     * assertion finally claim the same thing (a later finding). */
    const targetsAtPrintTime: string[][] = [];
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {
      targetsAtPrintTime.push(Array.from(
        document.querySelectorAll('.print-target [data-testid^="piece-bytes-"]'),
        (el) => el.getAttribute('data-testid') ?? ''));
    });
    mount(newSecret());
    fireEvent.click(screen.getByText('Cut the account into pieces'));
    await waitFor(() => expect(screen.getByTestId('piece-bytes-0')).toBeTruthy());
    fireEvent.click(screen.getAllByText('Print this card')[1] as Element);
    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
    /* One job ran, and at that moment exactly ONE card was the target — the
     * card whose own button was pressed. */
    expect(targetsAtPrintTime).toEqual([['piece-bytes-1']]);
    /* And the flag does not linger to leak into the NEXT print job. */
    await waitFor(() => expect(document.querySelectorAll('.print-target')).toHaveLength(0));
    printSpy.mockRestore();
  });
});

describe('the finish consumes evidence — §7.14', () => {
  it('cuts without writing, refuses wrong bytes, accepts the card’s bytes, then records', async () => {
    const secret = newSecret();
    mount(secret);
    fireEvent.click(screen.getByText('Cut the account into pieces'));
    await waitFor(() => expect(screen.getByTestId('piece-bytes-0')).toBeTruthy());
    expect(loadSecuredSetup(secret)).toBeNull();

    const bytesByIndex = [0, 1, 2].map((i) =>
      (screen.getByTestId(`piece-bytes-${i}`).textContent ?? '').replace(/\s+/g, ''));
    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box);
    fireEvent.click(screen.getByText(/are placed — continue/));
    await screen.findByText(/Read one piece back from its card/);

    /* No piece bytes are on screen at the proof step. */
    expect(screen.queryByTestId('piece-bytes-0')).toBeNull();
    /* Still nothing recorded. */
    expect(loadSecuredSetup(secret)).toBeNull();

    /* Wrong bytes: refused, still nothing recorded. */
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'AAAA BBBB CCCC' } });
    fireEvent.click(screen.getByText(/— finish$/));
    expect(await screen.findByText(/does not match piece/)).toBeTruthy();
    expect(loadSecuredSetup(secret)).toBeNull();

    /* The right bytes, read back from the card we captured. */
    const which = Number((screen.getByText(/^piece \d+ — /).textContent?.match(/piece (\d+)/) ?? [])[1]) - 1;
    fireEvent.change(screen.getByRole('textbox'), { target: { value: bytesByIndex[which] } });
    fireEvent.click(screen.getByText(/— finish$/));
    await waitFor(() => expect(screen.getByText(/Account secured\./)).toBeTruthy());

    const record = loadSecuredSetup(secret);
    expect(record).not.toBeNull();
    expect(record?.fingerprint).toBe(toBase64Url(fingerprintOf(secret)));
    /* Paper is null; every other home is 'never'. */
    const paper = record?.pieces.find((p) => p.label.startsWith('Printed on paper'));
    const cloud = record?.pieces.find((p) => p.label.startsWith('A cloud account'));
    expect(paper?.lastVerified).toBeNull();
    expect(cloud?.lastVerified).toBe('never');
  });
});

describe('re-cutting', () => {
  it('states the fact, names the old pieces, and keeps them on the record', async () => {
    const secret = newSecret();
    mount(secret);
    await driveToDone();

    cleanup();
    mount(secret);
    expect(screen.getByText('This account is secured.')).toBeTruthy();
    /* The fact, not an instruction — and the old holders by label. */
    expect(screen.getByText(/adds a way in — it never removes one/)).toBeTruthy();
    expect(screen.getByText(/A cloud account of mine — my own cloud drive/)).toBeTruthy();
    expect(screen.queryByText(/collect and destroy/i)).toBeNull();

    fireEvent.click(screen.getByText('Choose a new plan…'));
    await driveToDone();
    const record = loadSecuredSetup(secret);
    expect(record?.superseded).toHaveLength(1);
    expect(record?.superseded[0]?.pieces.map((p) => p.label).join(' '))
      .toContain('cloud account');
  });
});

describe('the sheet — names ride with the map, and printing it prints it alone', () => {
  it('the secured screen offers the sheet; the sheet carries the checked names and the caveat', async () => {
    const secret = newSecret();
    saveSubwalletName(secret, 2, 'Client money');
    mount(secret);
    await driveToDone();

    cleanup();
    mount(secret);
    fireEvent.click(screen.getByText('Print the sheet…'));

    /* The map and the names, on one page. */
    expect(screen.getByText('Where your pieces are')).toBeTruthy();
    expect(screen.getByText('Wallet names on this account')).toBeTruthy();
    expect(screen.getByText('“Client money”')).toBeTruthy();
    expect(screen.getByText('Subwallet 1')).toBeTruthy();
    /* The honest half, printed ON the sheet: it is a snapshot. */
    expect(screen.getAllByText(/names given or changed after it was made are not on\s+it/i)
      .length).toBeGreaterThan(0);
    /* And a print button whose job is this page. */
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});
    fireEvent.click(screen.getByText('Print this sheet'));
    expect(printSpy).toHaveBeenCalledTimes(1);
    printSpy.mockRestore();
    /* No piece bytes anywhere near the sheet. */
    expect(document.body.textContent).not.toMatch(/[A-Za-z0-9_-]{40,}/);
  });

  it('a STRANGER’s names never reach the sheet, on paper', async () => {
    /* The stranger's names, left in the compartment this wallet then lands
     * in — the `startFresh` shape. The names are STILL refused, and now for
     * two reasons rather than one: the fingerprint check on the record,
     * which is what this test is about, standing behind the compartment. */
    saveSubwalletName(newSecret(), 2, 'Savings');
    const secret = newSecret();
    await saveSecret(secret);
    mount(secret);
    await driveToDone();

    cleanup();
    mount(secret);
    fireEvent.click(screen.getByText('Print the sheet…'));
    expect(screen.getByText('Where your pieces are')).toBeTruthy();
    expect(screen.queryByText('“Savings”')).toBeNull();
    expect(screen.queryByText('Wallet names on this account')).toBeNull();
  });
});
