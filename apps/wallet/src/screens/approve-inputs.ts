/*
 * What the approval screen is given: the wallet's identity and secret, the stored record's registry and port, the clock, the page allowed to frame it, and how a company's account is read.
 * Every hook and view of the approval reads this one shape.
 */
import type { Identity, Secret } from 'midnight-identity/keys/derivation';
import type { Registry } from 'midnight-identity/profile/attributes';
import type { Port } from 'midnight-identity/profile/store';
import type { ChannelWindow } from 'midnight-identity/profile/channel';
import type { LabelReader } from './company-on-chain.js';
import type { ChainReader } from './approve-committee.js';

export interface ApproveInputs {
  readonly identity: Identity;
  readonly secret: Secret;
  readonly registry: Registry;
  readonly port: Port;
  readonly view: ChannelWindow | undefined;
  readonly now: () => number;
  readonly embedder: string | null;
  readonly readLabel: LabelReader;
  readonly readChain: ChainReader | undefined;
}
