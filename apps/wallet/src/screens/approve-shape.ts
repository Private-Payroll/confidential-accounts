/*
 * The one shape every approval view reads: what the screen was given, the channel and the stored record, what the page asked, what each button does, and what holds an ask answered at once.
 * A view takes it whole, or the same shape with its request narrowed to the one kind it draws.
 */
import type { ReactNode } from 'react';
import type { Ask } from 'midnight-identity/profile/request';
import type { ApproveInputs } from './approve-inputs.js';
import type { ApproveState, RowEntry, WhatIsAsked } from './approve-state.js';
import type { Answers } from './approve-answers.js';
import type { KeyAnswers } from './approve-key-answers.js';
import type { WalletKept } from './approve-state.js';
import type { Standing } from './approve-at-once.js';

export type Screen = ApproveInputs & ApproveState & WhatIsAsked & RowEntry & Answers & KeyAnswers & WalletKept & Standing;

export type ScreenAsking<R extends Ask> = Omit<Screen, 'request'> & { readonly request: R };

export type ScreenAnswered<R extends Ask> = Omit<Screen, 'request' | 'sentAt'> & { readonly request: R; readonly sentAt: number };

export type WhichWallet = (title: string, description: string, locked?: boolean) => ReactNode;

export type AskedScreen<R extends Ask> = ScreenAsking<R> & { readonly whoIsAsking: ReactNode; readonly whichWallet: WhichWallet };
