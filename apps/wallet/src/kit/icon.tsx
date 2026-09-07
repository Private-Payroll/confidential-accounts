import { HugeiconsIcon } from '@hugeicons/react';
import type { IconSvgElement } from '@hugeicons/react';
import {
  Alert02Icon, AlertDiamondIcon, ArrowDownLeft01Icon, ArrowRight01Icon,
  ArrowUpRight01Icon, Cancel01Icon, ChartUpIcon, CheckmarkCircle02Icon, CompassIcon, ContactBookIcon,
  GlobeIcon, Home01Icon, IdCardIcon, InboxIcon, InformationCircleIcon, Key01Icon, LockIcon,
  Moon02Icon, MonitorIcon,
  PanelLeftCloseIcon, PanelLeftOpenIcon, PencilEdit02Icon, PlusSignIcon, PrinterIcon,
  QrCode01Icon, ReceiptIcon, Settings02Icon, ShieldCheckIcon, Sun03Icon, Tick02Icon,
  UnfoldMoreIcon, Wallet01Icon,
} from '@hugeicons/core-free-icons';
import { cn } from './cn.js';

/**
 * THE ICON SEAM — one component, one list, and nothing else in this repository
 * imports an icon library.
 *
 * §2 replaced lucide with HugeIcons. That swap touched five files and would
 * have touched five again next time, because every one of them named its own
 * glyphs. This file is what makes the next swap one file: a screen asks for
 * `GLYPH.send`, not for `ArrowUpRight01Icon`, and what `send` is drawn as is a
 * decision made here.
 *
 * WHY IT IS ALSO A COMPONENT AND NOT JUST A MAP. HugeIcons' glyphs are DATA —
 * `IconSvgElement`, an array of tag/attribute pairs — where lucide's were
 * components. Every call site would otherwise have grown a `<HugeiconsIcon
 * icon={…} />` and its own opinion about size, stroke and `aria-hidden`. It
 * has one opinion instead, here.
 *
 * IT IS `aria-hidden` BY DEFAULT AND THAT IS THE IMPORTANT ONE. Every icon in
 * this wallet sits inside something that already has an accessible name — a
 * button, a link, a heading — and an icon that names itself makes a screen
 * reader say the thing twice. The rail's collapsed links are the one place a
 * glyph is the only visible label, and there the LINK carries the name and the
 * tooltip carries it visibly; the glyph is still decoration.
 *
 * THE SIZE IS A CLASS, NOT THE `size` PROP. `HugeiconsIcon` writes `width` and
 * `height` ATTRIBUTES on the `<svg>` (`@hugeicons/react/dist/esm/HugeiconsIcon.js`,
 * `elementProps`), and a CSS rule beats a presentation attribute — so
 * `size-5` wins and stays mergeable by `cn`, which a `size={20}` prop would
 * not be.
 *
 * IT IMPORTS FROM THE BARREL, AND THAT WAS MEASURED RATHER THAN ASSUMED.
 * `@hugeicons/core-free-icons` is 148 MB installed and its barrel re-exports
 * about eleven thousand modules, so the obvious worry is what Vite's dependency
 * pre-bundle does with it. Cold `vite optimize --force`, cache deleted first,
 * three runs each, on the same machine:
 *
 *     no icon package at all   2.00 s   2.02 s   3.63 s
 *     one subpath per icon     1.90 s   2.93 s   3.04 s
 *     this file, the barrel    3.12 s   3.25 s   3.67 s
 *
 * **About +1.2 s, once, per fresh install or cleared cache** — and importing
 * each icon individually would buy back roughly 0.3 s of it. A whole cold page
 * load is 6–14 s in the same container, dominated by 12 MB of WebAssembly, so
 * the icon set is not what makes this dev server slow.
 *
 * THE 0.3 S IS NOT WORTH WHAT IT COSTS. The per-icon `.d.ts` files import
 * `IconSvgObject` from a `./types` module the package does not ship, so under
 * `skipLibCheck` a subpath import silently degrades to `any` — measured: a
 * subpath import assigned to `number` compiles, the barrel's does not. Names
 * stay safe either way (an unknown subpath is a hard resolution error), but the
 * VALUES stop being checked, and this is the one file that decides what an icon
 * is. Nothing here is worth 0.3 s of a one-off. The tree-shaken bundle is the
 * same either way: the built JS contains only the glyphs named below.
 *
 * THE STROKE IS THE SET'S OWN. shadcn's usage template for this library passes
 * `strokeWidth={2}` (`shadcn/dist/icons/index.d.ts`); the glyph data already
 * carries `strokeWidth: "1.5"` per path and 1.5 is what the set was drawn at.
 * Overriding it would be re-drawing somebody's icons by hand, which is the
 * opposite of adopting a made design system.
 */

export type { IconSvgElement };

/**
 * THE NAMES ARE THIS WALLET'S, THE DRAWINGS ARE HUGEICONS'.
 *
 * The annotation is load-bearing, not decoration. `@hugeicons/core-free-icons`
 * types its barrel correctly, but its per-icon `.d.ts` files import from a
 * `./types` module that is not shipped — so a subpath import degrades to `any`
 * under `skipLibCheck`. This map is imported from the BARREL, which is typed,
 * and the annotation below means that stays true whichever way the imports are
 * spelled later.
 */
export const GLYPH = {
  /* places */
  home: Home01Icon,
  activity: ReceiptIcon,
  explore: CompassIcon,
  settings: Settings02Icon,

  /* actions and chrome */
  newAction: PlusSignIcon,
  send: ArrowUpRight01Icon,
  /* HOME'S QUICK ACTIONS AND ITS PENCIL. Five names, and they are named
   * here rather than at the call site for the reason this file exists: a
   * screen asks for `GLYPH.receive`, and what `receive` is DRAWN as stays one
   * decision in one file.
   *
   * `receive` MIRRORS `send` ON PURPOSE — the same arrow, turned round. They
   * are the pair a person reads fastest, and drawing them from different
   * families would make the pair the thing they have to decode.
   *
   * `rename` IS THE PENCIL, and the design says it is not cosmetic:
   * naming is what CREATES an account, so this glyph sits on the control that
   * adopts a slot. */
  receive: ArrowDownLeft01Icon,
  rename: PencilEdit02Icon,
  qr: QrCode01Icon,
  earn: ChartUpIcon,
  contacts: ContactBookIcon,
  /* MY PROFILE, AND IT IS ITS OWN NAME BECAUSE IT SITS BESIDE
   * `contacts` IN ONE BLOCK ON HOME. Two tiles side by side wearing one
   * drawing is two tiles a person has to READ rather than recognise, which is
   * the whole of what a glyph is for. `contacts` is the book of OTHER people;
   * this is the card that says who YOU are.
   *
   * IT IS NOT `passkey`, AND THAT IS A CLAIM RATHER THAN A TASTE. A key in
   * this wallet means a CREDENTIAL — the thing that opens an account, and the
   * thing a company is released. What this glyph sits on is a name and an
   * email that a person typed about themselves, which no key opens and nobody
   * has checked. Drawing the two alike would say they are the same kind of
   * thing.
   *
   * WHAT SEPARATES THE TWO DRAWINGS WAS READ OFF THE DATA, NOT ASSUMED. Both
   * carry a person. `ContactBookIcon` is a PORTRAIT book with a spine —
   * `M4.5 6H2M4.5 12H2M4.5 18H2`, three marks down its left edge.
   * `IdCardIcon` is a LANDSCAPE card — a rounded rect from `M15 4H9C5.7 4…` —
   * with two rules of type beside the face at `M16 9H19` and `M16 13H19`. The
   * container is the difference, and both are drawn at the set's own
   * `strokeWidth: "1.5"`, so neither is heavier than its neighbours. */
  details: IdCardIcon,
  /* THE HEADER CHEVRON, and it is `next` rather than `chevronRight`
   * because this file names the MEANING and lets the drawing be swappable
   * (the same rule the two rail glyphs are commented with). It means *the
   * place this card is a preview of*, and it has two callers.
   *
   * `ArrowRight01Icon` IS A CHEVRON, checked rather than assumed: its whole
   * path is `M9 6C9 6 15 10.4189 15 12C15 13.5812 9 18 9 18` — one stroke, no
   * shaft. `ArrowRight02Icon` is the one with a shaft, and an arrow that
   * carries a line reads as *go somewhere else* rather than *open this*. */
  next: ArrowRight01Icon,
  lock: LockIcon,
  close: Cancel01Icon,
  chosen: Tick02Icon,
  switcher: UnfoldMoreIcon,
  /* THESE TWO ARE CROSSED ON PURPOSE, AND IT WAS MEASURED OFF A SCREENSHOT.
   * HugeIcons names these from the panel's point of view; lucide named them
   * from the chevron's, and this rail wants the chevron's — a control that
   * NARROWS the rail should point inward. `PanelLeftCloseIcon` draws `|>` and
   * `PanelLeftOpenIcon` draws `|<`, which is the opposite of what the names
   * suggest. First shot of the change had both arrows pointing away from the
   * thing they would do. The keys below are named for the ACTION, which is what
   * the rail asks for; the values are whichever drawing points the right way. */
  collapseRail: PanelLeftOpenIcon,
  expandRail: PanelLeftCloseIcon,

  /* themes — one per entry in `shell/themes.ts`, plus the machine */
  themeDark: Moon02Icon,
  themeLight: Sun03Icon,
  themeSystem: MonitorIcon,

  /* the four severities of `Alert` */
  info: InformationCircleIcon,
  success: CheckmarkCircle02Icon,
  warning: Alert02Icon,
  danger: AlertDiamondIcon,

  /* SETTINGS. Two names, and they are named here for this file's own
   * reason: a screen asks for `GLYPH.passkey`, and what a passkey is DRAWN as
   * stays one decision in one file.
   *
   * `passkey` IS A KEY AND NOT A FINGERPRINT, and that is a claim rather than
   * a taste. A fingerprint draws the GESTURE — the thing the person does on
   * one particular authenticator — and this wallet's passkeys are also opened
   * by a face, a PIN and a hardware key on a USB port. The credential is the
   * thing being listed, so the credential is what is drawn.
   *
   * `network` IS THE GLOBE because the section it heads is about hosts this
   * wallet dials, which is the only place in this product where something
   * leaves the machine. */
  passkey: Key01Icon,
  network: GlobeIcon,

  /* things the gallery draws, and screens will */
  inbox: InboxIcon,
  printer: PrinterIcon,
  secured: ShieldCheckIcon,
  wallet: Wallet01Icon,
} satisfies Record<string, IconSvgElement>;

export type GlyphName = keyof typeof GLYPH;

/**
 * A glyph looked up by a name computed at runtime — which is what the theme
 * picker does, because the theme list is data and its entries name their own
 * glyphs. An unknown name falls back rather than throwing: a theme added to
 * `shell/themes.ts` without a glyph should look dull, not take the wallet down.
 */
export function glyphFor(name: string): IconSvgElement {
  const found = (GLYPH as Record<string, IconSvgElement | undefined>)[name];
  return found ?? GLYPH.themeSystem;
}

export function Icon({ glyph, className }: {
  readonly glyph: IconSvgElement;
  readonly className?: string;
}): ReturnType<typeof HugeiconsIcon> {
  return (
    <HugeiconsIcon
      icon={glyph}
      className={cn('size-5 shrink-0', className)}
      aria-hidden="true"
      focusable="false"
    />
  );
}
