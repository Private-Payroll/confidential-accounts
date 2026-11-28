// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '../testing/render.js';
import { LiveNotice } from './send-notices.js';

/*
 * THE WORDS ABOUT MONEY ARE THE NETWORK'S OWN RECORD'S. A network whose record
 * says it settles real money is told it is real; a test network is told it is
 * a test network whose tokens are worth nothing. The record is made to say
 * each in turn, so the screen cannot pass by being written for one network.
 */
const record = vi.hoisted(() => ({ real: false }));
vi.mock('../../../../src/core/networks.js', async (importActual) => ({
  ...(await importActual<typeof import('../../../../src/core/networks.js')>()),
  networkIsReal: () => record.real
}));

afterEach(cleanup);

const text = (): string => document.body.textContent ?? '';

describe('the live send notice reads the network record', () => {
  it('says real money only where the record says the network is real', () => {
    /* RED WHEN the notice says "real" without asking networkIsReal, or asks it and
     * still says it on a test network. */
    record.real = true;
    render(<LiveNotice inFlight={false} switchMode={() => {}} />);
    expect(text()).toContain('This is real.');
    expect(text()).toMatch(/moves real tNIGHT on/u);
    expect(text()).not.toMatch(/test network/u);
  });

  it('on a test network says plainly that its tokens have no value and never says real money', () => {
    /* RED WHEN a test network is shown "This is real" or "moves real tNIGHT" or "a real fee". */
    record.real = false;
    render(<LiveNotice inFlight={false} switchMode={() => {}} />);
    expect(text()).toContain('This is a test network.');
    expect(text()).toMatch(/tokens have no value/u);
    expect(text()).not.toMatch(/This is real/u);
    expect(text()).not.toMatch(/real tNIGHT/u);
    expect(text()).not.toMatch(/a real fee/u);
    expect(document.querySelector('section[aria-label^="This is a test network."]')).not.toBeNull();
  });
});
