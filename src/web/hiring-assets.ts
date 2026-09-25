import { assets, privateForm, ledgerFormOf, type Asset, type AssetRegistry } from '../core/assets.js';

/**
 * **WHAT A PERSON CAN BE HIRED IN: AN ASSET THAT CAN BE PAID ON MIDNIGHT.**
 * The service refuses the rest at hiring; this is so the form never offers
 * them. Assets with a private form come first, because a picker starts on its
 * first entry. An asset with a public form only stays on offer for a payee who
 * is paid publicly, which a run does out of the vault's public money.
 * Exported so a test holds the list against the registry.
 */
export const hiringAssets = (registry: AssetRegistry = assets): Asset[] => {
  const payable = registry.enabled().filter(a =>
    ledgerFormOf(a, 'shielded').of === 'token' || ledgerFormOf(a, 'unshielded').of === 'token');
  const privately = (a: Asset) => privateForm(a).of === 'available';
  return [...payable.filter(privately), ...payable.filter(a => !privately(a))];
};

/**
 * **WHAT AN EMPLOYEE CAN BE INVITED IN: AN ASSET WITH A PRIVATE FORM.** An
 * invited person's address comes from their own wallet and may be a private
 * one, which an asset with a public form only cannot pay. So that asset is left
 * to the form where a member adds their own address, which may be public.
 */
export const invitingAssets = (registry: AssetRegistry = assets): Asset[] =>
  hiringAssets(registry).filter(a => privateForm(a).of === 'available');

/** Said where a hiring form would be, in a build where nothing can be paid on Midnight. */
export const NOBODY_CAN_BE_HIRED =
  'Nobody can be hired yet. None of the currencies set up here can be paid out of a company '
  + 'account, and whoever runs this service has to add one.';

/** Said where the invitation form would be, when nothing here can be paid privately. */
export const NOBODY_CAN_BE_INVITED =
  'Nobody can be invited yet. An employee is paid privately, and none of the currencies set up '
  + 'here can be paid privately. Whoever runs this service has to add one.';
