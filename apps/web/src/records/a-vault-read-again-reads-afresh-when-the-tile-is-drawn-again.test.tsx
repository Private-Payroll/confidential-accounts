// @vitest-environment jsdom
/*
 * A press to read a vault again reads it afresh, even after the tile was drawn again in the same opening of the page:
 * each press is handed its own fresh reading by the page's view, never one an earlier draw already read.
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({ view: null as unknown, rounds: [] as number[] }));
vi.mock('../session.js', async (real) => ({
  ...(await real<typeof import('../session.js')>()),
  useSession: () => ({ person: { id: 'u1' } }),
}));
vi.mock('./company-records.js', async (real) => ({
  ...(await real<typeof import('./company-records.js')>()),
  useCompanyView: () => st.view,
}));
/* Each side's read stands in for the chain: which reading of the view it was asked in is what is counted. */
vi.mock('../adapters/company-vaults-read.js', async (real) => ({
  ...(await real<typeof import('../adapters/company-vaults-read.js')>()),
  readVaultPublicMoney: async (_p: string, _v: unknown, _vault: string, round = 0) => { st.rounds.push(round); return null; },
}));
vi.mock('../adapters/vault-private-money.js', async (real) => ({
  ...(await real<typeof import('../adapters/vault-private-money.js')>()),
  readVaultPrivateMoney: async () => ({ of: 'nothing-yet' }),
}));

const { useVaultMoney } = await import('./parts.js');
const { openViewOf } = await import('../adapters/filing-judge.js');

function Tile({ asked }: { asked: number }) {
  useVaultMoney('c1', 'ab'.repeat(32), asked);
  return null;
}
const drawn = async (asked: number) => { const r = render(<Tile asked={asked} />); await act(async () => { await new Promise((x) => { setTimeout(x, 5); }); }); return r; };
const pressed = async (r: Awaited<ReturnType<typeof drawn>>, asked: number) => {
  r.rerender(<Tile asked={asked} />);
  await act(async () => { await new Promise((x) => { setTimeout(x, 5); }); });
};

afterEach(cleanup);

describe('A VAULT READ AGAIN IN ONE OPENING', () => {
  it('reads in a round no earlier draw of the tile read in, however often the tile is drawn again', async () => {
    st.view = openViewOf('c1');
    st.rounds = [];
    const first = await drawn(0);
    await pressed(first, 1);
    first.unmount();
    const second = await drawn(0);
    await pressed(second, 1);
    /* RED WHEN: a press after the tile is drawn again reads in a round an earlier draw read, so it is handed the kept answer as if read now. */
    expect(st.rounds).toEqual([0, 1, 0, 2]);
  });
});
