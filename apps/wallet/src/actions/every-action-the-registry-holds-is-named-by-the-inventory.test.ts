// @vitest-environment jsdom
/*
 * The list of every place a company is read from names the wallet's actions (`COMPANY_VIEW_INVENTORY`), and the count of what
 * each reads is taken from it. The registry is what the wallet runs. Each wallet action on the list is one the registry
 * holds, and each action the registry holds is on the list, or is named here with why it reads no company.
 */
import { describe, expect, it } from 'vitest';
import { COMPANY_VIEW_INVENTORY } from '../../../../packages/web-shared/src/company-view-inventory.js';
import { ACTIONS } from './registry.js';

/* The registry's actions that the list does not hold, and why each reads no company. */
const OFF_THE_LIST: Readonly<Record<string, string>> = Object.freeze({});

const LISTED = COMPANY_VIEW_INVENTORY.filter((p) => p.kind === 'wallet action').map((p) => p.name);
const REGISTERED = Object.keys(ACTIONS);

describe('THE LIST OF PLACES A COMPANY IS READ FROM AND THE REGISTRY HOLD THE SAME WALLET ACTIONS', () => {
  it('every wallet action on the list is one the registry holds', () => {
    /* RED WHEN: the list names a wallet action the registry no longer holds, so its count is of an action that cannot run. */
    expect(LISTED.filter((name) => !REGISTERED.includes(name))).toEqual([]);
  });

  it('every action the registry holds is on the list, or is named with why it reads no company', () => {
    /* RED WHEN: the registry holds an action the list leaves out, so what it reads is held to no view and counted by nothing. */
    expect(REGISTERED.filter((name) => !LISTED.includes(name) && !Object.hasOwn(OFF_THE_LIST, name))).toEqual([]);
    /* RED WHEN: an action named as off the list is not in the registry, or is on the list, so its reason holds for nothing. */
    expect(Object.keys(OFF_THE_LIST).filter((name) => !REGISTERED.includes(name) || LISTED.includes(name))).toEqual([]);
    expect(Object.values(OFF_THE_LIST).filter((why) => why.trim() === '')).toEqual([]);
    expect(LISTED.length).toBeGreaterThan(0);
    expect(REGISTERED.length).toBeGreaterThan(0);
  });
});
