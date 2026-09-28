import { describe, expect, it } from 'vitest';
import {
  amountsOutsideTheComponent, arbitraryValues, classWordsOf, colourValues, declaredBy, englishSentences, gapsOf, gapsThatDiffer,
  hasPhrase, inlineStyles, keysAskedFor, missingPhrases, paletteClasses, pathsIntoTheKit, physicalClasses, pluralOf, secondCn,
  stateVariantsOf, undeclaredImports, utilityOf, waysIntoSharedCode, wordingCensus, wordingInCode, WORDING_POSITIONS, amountsMadeOutsideTheAdapters, type Source,
} from './source-rules.test-support.js';

/*
 * EACH RULE AGAINST TEXT WRITTEN TO BREAK IT, AND TEXT WRITTEN TO PASS. The
 * tests that hold the kit and the application run these same functions over
 * the real files; these show each function finds what it is for.
 */
const src = (path: string, text: string): Source => ({ path, text });
const whats = (b: { what: string }[]) => b.map((x) => x.what);

describe('imports', () => {
  /* `path` is declared, so a built-in is refused for being one and not only for being undeclared. */
  const declared = declaredBy(JSON.stringify({ name: 'kit', dependencies: { 'radix-ui': '1', path: '1' }, peerDependencies: { react: '1' } }));

  /* RED WHEN: a package the file's own package does not declare, a Node built-in, or a module worked out at run time is let through. */
  it('names every package imported and not declared', async () => {
    const f = src('a.tsx', `import * as React from 'react';
      import { Slot } from 'radix-ui';
      import { cva } from 'class-variance-authority';
      import { x } from 'kit/lib/utils';
      import { y } from './near.js';
      export { z } from '@scope/pkg/sub';
      const m = await import('i18next');
      import { readFileSync } from 'node:fs';
      import path from 'path';
      const n = await import(name);
      console.log(React, Slot, cva, x, y, m, n, readFileSync, path);`);
    expect(whats(await undeclaredImports([f], declared))).toEqual(['class-variance-authority', 'node:fs', 'path', '@scope/pkg/sub', 'i18next', 'name']);
  });

  /* RED WHEN: the rules read imports themselves again, so they and the walk that finds what a page reaches answer differently about a type-only import. */
  it('reads imports as the browser is served them: a type-only import is not one', async () => {
    const f = src('a.ts', `import type { A } from 'undeclared-types';
      import { type B } from 'also-types';
      import { C } from 'kit';
      export const c: A | B = C;`);
    expect(whats(await undeclaredImports([f], declared))).toEqual([]);
  });

  /* RED WHEN: a path into the kit's folder, however spelled, or a module inside the kit named through the package, is let through, or the package name or its stylesheet is refused. */
  it('names every path into the kit', async () => {
    const f = src('apps/web/src/main.ts', `import 'vaults-ui/styles.css';
      import * as formatter from 'vaults-ui/format/token-amount';
      import { Amount } from 'vaults-ui';
      import { a } from '../../../packages/ui/src/index.js';
      import { b } from '../../../packages/uix/x.js';
      import { c } from '/packages/ui/src/lib/utils';
      import { e } from '../../../packages/UI/src/x.js';
      import { d } from './own.js';
      console.log(a, b, c, d, e, formatter, Amount);`);
    expect(whats(await pathsIntoTheKit([f], '/repo', 'packages/ui'))).toEqual(['vaults-ui/format/token-amount', '../../../packages/ui/src/index.js', '/packages/ui/src/lib/utils', '../../../packages/UI/src/x.js']);
  });

  /* RED WHEN: a path into the kit used only for a type is let through because the browser is never served it. */
  it('names a path into the kit that is used only for a type', async () => {
    const f = src('apps/web/src/main.ts', `import type { X } from '../../../packages/ui/src/a.js';
      import { type Y } from '../../../packages/ui/src/b.js';
      export type { Z } from '../../../packages/ui/src/c.js';
      type W = typeof import('../../../packages/ui/src/d.js');
      import type { V } from 'vaults-ui';
      export const v: X | Y | W | V = 1;`);
    expect(whats(await pathsIntoTheKit([f], '/repo', 'packages/ui'))).toEqual(['../../../packages/ui/src/a.js', '../../../packages/ui/src/b.js', '../../../packages/ui/src/c.js', '../../../packages/ui/src/d.js']);
  });
});

describe('the one way into shared code', () => {
  const OWN = 'apps/web/src';
  const LAYER = 'apps/web/src/adapters';

  /* RED WHEN: a screen reaches the shared package, the product's code, the network or the wallet by any of these routes, however it is written, and the route is not named. */
  it('names every way a file outside the adapters reaches shared code, the service or the wallet', async () => {
    const screen = src('apps/web/src/screens/vault.tsx', `import { read } from 'vaults-web-shared/device-vault-holdings.js';
      import type { Answer } from 'vaults-web-shared/public-payment.js';
      import { assets } from '../../../../src/core/assets.js';
      import { pay } from '../../../../packages/web-shared/src/public-payment.js';
      const later = await import('vaults-web-shared/keyring.js');
      const w = new Worker(new URL('../../../../packages/web-shared/src/vault-worker-entry.ts', import.meta.url));
      fetch('/api/vault'); const f = globalThis.fetch; window['fetch']('/x'); const { fetch: g } = window;
      new XMLHttpRequest(); new WebSocket('wss://x'); new EventSource('/e'); navigator.sendBeacon('/b', d);
      frame.contentWindow.postMessage(m, origin); window.open(u); const wallet = window.midnight; postMessage(m);
      window.addEventListener('message', h); self.onmessage = h; const mods = import.meta.glob('../../../../packages/web-shared/src/*.ts');
      (window as any).fetch('/y'); const { open: o } = (globalThis as any);
      midnight.mnLace.enable(); const alias = window; Reflect.get(globalThis, 'fetch'); (0, window).fetch('/z'); document.defaultView.fetch('/v');
      window[pick()]; addEventListener(\`message\`, h); const mod = await import(\`vaults-web-shared/\${n}.js\`); navigator.serviceWorker.register('/sw.js'); eval(code);
      new RTCPeerConnection(); new WebTransport(u); window.window.fetch('/a'); const t0 = window.top; const { window: w2 } = globalThis; const { ...rest } = window;
      const v = document.defaultView; new Function('x')(); setTimeout('go()', 1);
      console.log(read, assets, pay, later, w, f, g, wallet, mods);`);
    expect(whats(await waysIntoSharedCode([screen], '/repo', OWN, LAYER))).toEqual([
      'imports vaults-web-shared/keyring.js', 'reaches ../../../../packages/web-shared/src/vault-worker-entry.ts', 'imports vaults-web-shared/device-vault-holdings.js', 'imports vaults-web-shared/public-payment.js', 'reaches ../../../../src/core/assets.js', 'reaches ../../../../packages/web-shared/src/public-payment.js',
      'Worker', 'fetch', 'globalThis.fetch', 'window.fetch', 'window.fetch', 'window handed on',
      'XMLHttpRequest', 'WebSocket', 'EventSource', '.sendBeacon', '.postMessage', '.contentWindow',
      'window.open', 'window.midnight', 'postMessage', "addEventListener('message')", 'self.onmessage', 'import.meta.glob ../../../../packages/web-shared/src/*.ts',
      'window.fetch', 'globalThis.open', 'globalThis handed on', 'midnight', 'window handed on', 'globalThis handed on',
      'window.fetch', 'window.fetch', 'a global reached by a built name', "addEventListener('message')", 'import() of a module worked out at run time', '.serviceWorker',
      'eval', 'RTCPeerConnection', 'WebTransport', 'window.fetch', 'top handed on', 'globalThis handed on',
      'window handed on', 'defaultView handed on', 'Function', 'setTimeout given code as text',
    ]);
  });

  /* RED WHEN: the adapters are refused, the application's own files are, or an ordinary name that is also a browser's (a dialog's open state, a property named fetch) is taken for one. */
  it('lets the adapters through, and the application reach its own files and the kit', async () => {
    const adapter = src('apps/web/src/adapters/vault.ts', `import { readPublicHoldings } from 'vaults-web-shared/device-vault-holdings.js';
      import { assets } from '../../../../src/core/assets.js'; fetch('/api');`);
    const screen = src('apps/web/src/screens/vault.tsx', `import { vaultPublicMoney } from '../adapters/vault.js';
      import { Amount } from 'vaults-ui'; import './vault.css'; import type { Props } from './props.js';
      const [open, setOpen] = useState(false); const o = { fetch: 1, open: 2 }; o.fetch; menu.open(); type T = typeof fetch;
      if (typeof window !== 'undefined') window.scrollTo(0, 0); type W = typeof window; const page = await import('./page.js');
      if (event.source === window) go(); const touch = 'ontouchstart' in window; const midnight = new Date(); midnight.setHours(0);
      const { innerWidth } = window; setTimeout(() => go(), 1);
      el.addEventListener('click', h); console.log(vaultPublicMoney, Amount, open, setOpen);`);
    expect(whats(await waysIntoSharedCode([adapter, screen], '/repo', OWN, LAYER))).toEqual([]);
    /* With no adapters, the adapter's own routes are named: the rule is not passing for want of reading them. */
    expect(whats(await waysIntoSharedCode([adapter], '/repo', OWN, null))).toEqual(['imports vaults-web-shared/device-vault-holdings.js', 'reaches ../../../../src/core/assets.js', 'fetch']);
  });

  /* RED WHEN: an amount is made outside the adapters, by the name, through a namespace or taken apart from one, where its decimals would be typed rather than read from the token's record; or the adapters, or a key of the file's own object that happens to share the name, are refused. */
  it('names every amount made outside the adapters', () => {
    const screen = src('apps/web/src/screens/x.tsx', "import { tokenAmount } from 'vaults-ui'; const a = tokenAmount(1n, 2, 'NIGHT'); const b = kit.tokenAmount; const c = { tokenAmount: 1 }; kit['tokenAmount']; const { tokenAmount: m } = kit;");
    const adapter = src('apps/web/src/adapters/x.ts', "import { tokenAmount } from 'vaults-ui'; export const a = tokenAmount(1n, asset.decimals, asset.code);");
    expect(whats(amountsMadeOutsideTheAdapters([screen, adapter], '/repo', LAYER))).toEqual(['tokenAmount', 'tokenAmount', 'tokenAmount', 'tokenAmount', 'tokenAmount']);
    expect(amountsMadeOutsideTheAdapters([screen], '/repo', LAYER).map((b) => b.line)).toEqual([1, 1, 1, 1, 1]);
    expect(whats(amountsMadeOutsideTheAdapters([adapter], '/repo', null))).toEqual(['tokenAmount', 'tokenAmount']);
  });

  /* RED WHEN: two imports of one module are reported as one, or at the line of a comment that mentions it rather than at their own. */
  it('names each import at its own line', async () => {
    const f = src('apps/web/src/x.ts', `// was: import type { A } from 'vaults-web-shared/a.js'
      const x = 1;
      import type { A } from 'vaults-web-shared/a.js';
      import { b } from 'vaults-web-shared/a.js';
      export const y: A | typeof b | number = x;`);
    expect((await waysIntoSharedCode([f], '/repo', OWN, LAYER)).map((b) => [b.line, b.what])).toEqual([[3, 'imports vaults-web-shared/a.js'], [4, 'imports vaults-web-shared/a.js']]);
  });

  /* RED WHEN: a file is taken to be inside the adapters because its name starts the same way. */
  it('reads the adapters as a folder, not as a prefix', async () => {
    const lookalike = src('apps/web/src/adapters-old/x.ts', "fetch('/api');");
    expect(whats(await waysIntoSharedCode([lookalike], '/repo', OWN, LAYER))).toEqual(['fetch']);
  });
});

describe('one cn', () => {
  /* RED WHEN: the cn package, clsx or tailwind-merge is imported outside the kit's own cn, or a second cn is declared. */
  it('names every second cn', async () => {
    const home = src('lib/utils.ts', "import { clsx } from 'clsx'; export function cn() { return clsx(); }");
    const other = src('components/x.tsx', `import { cn as c } from 'cn';
      import { twMerge } from 'tailwind-merge';
      import { cn } from 'vaults-ui/lib/utils';
      import { cva, cx } from 'class-variance-authority';
      console.log(c, twMerge, cn, cva, cx);
      const cn2 = 1; function cn() {} const f = () => { const cn = 2; };`);
    expect(whats(await secondCn([home, other], 'lib/utils.ts'))).toEqual(['imports cn', 'imports tailwind-merge', 'imports cx', 'declares cn', 'declares cn']);
  });
});

describe('colours', () => {
  /* RED WHEN: a colour value in any of these spellings is let through, or a token or a colour-space name is taken for one. */
  it('names every colour value', () => {
    const f = src('x.tsx', `const a = '#fff'; const b = "#A1B2C3"; const c = 'rgb(0 0 0)'; const d = 'hsl(1 2% 3%)';
      const e = 'oklch(0.5 0 0)'; const g = "bg-[#123456]"; const h = 'rgba(0,0,0,.5)';
      const ok = 'bg-primary hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] #main';`);
    expect(whats(colourValues([f]))).toEqual(['#fff', '#A1B2C3', 'rgb(', 'hsl(', 'oklch(', '#123456', 'rgba(']);
  });

  /* RED WHEN: a palette colour in a class is let through behind a variant, an opacity or an arbitrary variant, or a token is refused. */
  it('names every palette colour in a class', () => {
    const f = src('x.tsx', `const a = cn('bg-red-500 hover:text-white dark:border-zinc-200/50 ring-black', x && 'fill-sky-100');
      const b = <div className="text-muted-foreground bg-primary text-sm border-transparent shadow-md" />;
      const c = cva('[&>svg]:text-slate-400', { variants: { v: { a: 'bg-background' } } });`);
    expect(whats(paletteClasses([f]))).toEqual(['bg-red-500', 'hover:text-white', 'dark:border-zinc-200/50', 'ring-black', 'fill-sky-100', '[&>svg]:text-slate-400']);
  });

  /* RED WHEN: a palette colour held anywhere but in className, cn or cva is let through: a variable, a map, a return value, a stylesheet's @apply, a page's class. */
  it('names a palette colour wherever a string holds it', () => {
    const f = src('x.tsx', `const held = 'bg-red-500'; const tones = { bad: 'text-white' }; function tone() { return 'border-zinc-300'; }
      const d = <div className={held} />;`);
    const sheet = src('x.css', '.a { @apply bg-background text-rose-600; }');
    const page = src('x.html', '<div class="bg-primary text-black"></div>');
    expect(whats(paletteClasses([f, sheet, page]))).toEqual(['bg-red-500', 'text-white', 'border-zinc-300', 'text-rose-600', 'text-black']);
  });

  /* RED WHEN: any colour of the palette is let through as a class; every name the rule knows is written out here, so a name dropped from it goes red. */
  it('names a class in every colour of the palette', () => {
    const names = ['red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
      'slate', 'gray', 'zinc', 'neutral', 'stone', 'mauve', 'olive', 'mist', 'taupe'];
    const f = src('x.tsx', `const a = '${names.map((n) => `bg-${n}-500`).join(' ')} text-black border-white';`);
    expect(whats(paletteClasses([f]))).toEqual([...names.map((n) => `bg-${n}-500`), 'text-black', 'border-white']);
  });

  /* RED WHEN: a page attribute in single quotes or in none is not read: a class, a style, or words. */
  it('reads a page attribute however its value is quoted', () => {
    const page = src('apps/web/index.html', `<div class='text-black ml-2'></div><div class=bg-red-500></div>
      <p style='color: red'></p><p style=color:red></p><p title='Hello'></p><p title=Hello></p><meta name=viewport content=width=device-width>`);
    expect(whats(paletteClasses([page]))).toEqual(['text-black', 'bg-red-500']);
    expect(whats(physicalClasses([page]))).toEqual(['ml-2']);
    expect(whats(inlineStyles([page]))).toEqual(['color: red', 'color: red']);
    /* `style` is not on the wording rule's list of attributes whose value never reaches the screen, so the wording rule names it too, as well as the inline-style rule. */
    expect(whats(wordingInCode([page], new Set()))).toEqual(['style="color: red"', 'style="color:red"', 'title="Hello"', 'title="Hello"']);
  });

  /* RED WHEN: an arbitrary value that is not a token, a size or a blend of tokens is let through, behind an opacity too, or one the kit writes is refused. */
  it('names every arbitrary value made of anything but tokens and sizes, and every arbitrary property', () => {
    const f = src('x.tsx', `const a = cn('bg-[red] text-[rebeccapurple] hover:fill-[currentColor] [margin-left:4px] [color:var(--x)] bg-[red]/50 [COLOR:red]/50');
      const ok = cn('hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] rounded-[min(var(--radius-md),10px)]',
        'text-[0.8rem] ring-[3px] translate-y-[calc(-50%_-_2px)] grid-cols-[auto_1fr] origin-(--radix-tooltip-content-transform-origin)',
        '[&_svg:not([class*=size-])]:size-4 has-data-[icon=inline-end]:pe-1.5 data-[side=left]:slide-in-from-right-2');`);
    expect(whats(arbitraryValues([f]))).toEqual(['bg-[red]', 'text-[rebeccapurple]', 'hover:fill-[currentColor]', '[margin-left:4px]', '[color:var(--x)]', 'bg-[red]/50', '[COLOR:red]/50']);
  });

  /* RED WHEN: an inline style that sets anything, however it reaches the element, or one that cannot be read, is let through, or a stylesheet colour given as a token is refused. */
  it('names every inline style and every stylesheet colour that is not a token', () => {
    const f = src('x.tsx', `const a = <div style={{ color: 'red', marginLeft: 4 }} />; const b = <p style={s} />;
      createElement('div', { style: { background: 'red' } }); el.style.color = 'red'; el.setAttribute('style', 'left: 0');
      const c = <div {...{ style: { left: 0 } }} />; cloneElement(e, { style: s }); el['style'].left = '0';
      new Intl.NumberFormat(tag, { style: 'percent' }); rule.cssText = 'color: red';`);
    const sheet = src('x.css', ':root { --brand: red; } .a { color: red; background-color: var(--primary); border-color: transparent; font-variant-numeric: tabular-nums; } .c { border: 1px solid red; box-shadow: 0 0 0 1px var(--ring); outline: 2px solid var(--ring); outline-color: red; }');
    const page = src('x.html', '<p style="color: var(--x)"></p><p style="--brand: red"></p><style>.b { fill: blue }</style>');
    expect(whats(inlineStyles([f, sheet, page]))).toEqual(['style color', 'style marginLeft', 'style', 'style background', '.style', "setAttribute('style')", 'style left', 'style', '.style', '.cssText', 'color: red', 'border: 1px solid red', 'outline-color: red', 'fill: blue', 'color: var(--x)', '--brand: red']);
    expect(inlineStyles([f]).map((b) => b.line)).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3, 4]);
  });
});

describe('start and end, not left and right', () => {
  /* RED WHEN: a physical class is let through behind any variant or as a negative, or a logical one is refused. */
  it('names every left or right class', () => {
    const f = src('x.tsx', `const a = cn('ml-2 hover:pr-1.5 -mr-px has-data-[icon=inline-start]:pl-2', 'text-left rounded-tl-lg left-0 border-r');
      const b = <div className={\`ms-2 pe-1 text-start rounded-lg rounded-s-md start-0 border-e \${x} float-right\`} />;
      const c = cn('data-[side=left]:slide-in-from-right-2 placeholder:text-muted-foreground prose');`);
    expect(whats(physicalClasses([f]))).toEqual(['ml-2', 'hover:pr-1.5', '-mr-px', 'has-data-[icon=inline-start]:pl-2', 'text-left', 'rounded-tl-lg', 'left-0', 'border-r', 'float-right']);
  });

  /* RED WHEN: left or right held anywhere but in a class is let through: a prop, a variable, a stylesheet's property or value, a page's inline style. */
  it('names left and right wherever they are written', () => {
    const f = src('x.tsx', `const a = <Popover side="left" />; const s = 'ml-2'; const o = { className: 'mr-1' };
      const t = <Toaster position="bottom-right" className="bg-left origin-top-right object-right scroll-ml-2 clear-left" />;`);
    const sheet = src('x.css', '/* margin-left in a comment */ .a { margin-left: 4px; float: right; margin-inline-start: 4px; }');
    const page = src('x.html', '<p style="text-align: left"></p>');
    expect(whats(physicalClasses([f, sheet, page]))).toEqual(['left', 'ml-2', 'mr-1', 'bottom-right', 'bg-left', 'origin-top-right', 'object-right', 'scroll-ml-2', 'clear-left', 'margin-left: 4px', 'float: right', 'text-align: left']);
    expect(physicalClasses([f]).map((b) => b.line)).toEqual([1, 1, 1, 2, 2, 2, 2, 2, 2]);
  });

  /* RED WHEN: a variant with a colon inside brackets is cut there, so the utility is misread. */
  it('reads the utility after the last variant', () => {
    expect(utilityOf('has-data-[icon=inline-start]:pl-2')).toBe('pl-2');
    expect(utilityOf('[&_svg:not([class*=size-])]:size-4')).toBe('size-4');
    expect(utilityOf('hover:-ml-2!')).toBe('ml-2');
  });

  /* RED WHEN: a string that is not a class, a key of a variants object, is read as one where a stylesheet must define every class's variants. */
  it('reads classes only where classes are written, for the state variants', () => {
    const f = src('x.tsx', "const v = cva('a', { variants: { 'pl-9': { x: 'b' } } }); const s = 'ml-2'; const o = { className: 'mr-1' };");
    expect(classWordsOf(f).map((w) => w.word)).toEqual(['a', 'b']);
  });
});

describe('state variants', () => {
  /* RED WHEN: a bare data- variant, grouped, named or multi-word, is missed, or a bracketed one is returned. */
  it('finds every bare data- variant a class uses', () => {
    const f = src('x.tsx', "cn('data-open:a group-data-foo/button:bg-muted peer-data-checked:b data-state-open:c data-[side=top]:d has-data-[icon=x]:e')");
    expect(stateVariantsOf(f)).toEqual(['data-checked', 'data-foo', 'data-open', 'data-state-open']);
  });
});

describe('wording', () => {
  const codes = new Set(['USDC', 'NIGHT']);

  /* RED WHEN: a word held in a variable, given to any prop, or put on a screen any other way is let through: the rule lists what it allows, not what it refuses. */
  it('names every string with a letter that stands anywhere not named as a position', () => {
    const f = src('apps/web/src/x.tsx', `const label = 'Send';
      const a = <input value="Send now" title="Hello" aria-label={'Close'} />;
      const b = <div>Pay now {'Cancel'} {ok ? 'Yes' : t('kit.no')} {\`Sent \${n}\`} USDC {' '} {'—'} 42</div>;
      const c = { label: 'Save' }; const d = ['First', 'Second']; function e() { return 'Done'; }
      throw new Error('Could not send');
      createElement('p', null, 'Payroll is coming'); const g = <ComingSoon explanation="Export arrives in May" />;`);
    expect(whats(wordingInCode([f], codes))).toEqual(['Send', 'Send now', 'Hello', 'Close', 'Pay now', 'Cancel', 'Yes', 'Sent', 'Save', 'First', 'Second', 'Done', 'Could not send', 'Payroll is coming', 'Export arrives in May']);
    expect(wordingInCode([f], codes).map((b) => b.line).slice(0, 5)).toEqual([1, 2, 2, 2, 3]);
  });

  /* RED WHEN: a position is widened past what it names: each string below stands just outside one. */
  it('refuses a string that stands just outside a named position', () => {
    const f = src('apps/web/src/x.tsx', `const a = 'Send' as const; enum Say { Go = 'Send now' }
      const b = { variant: 'Pay' }; new Foo.Bar('Paid'); x.querySelector('Payee'); const c = label + 'Owed';
      const label = 'Label'; const d = <label>{label}</label>;
      const Inner = () => { const x = 'Inside'; return <p>{x}</p>; }; const e = <Inner />;
      const Tag = ok ? 'h1' : 'Heading'; const g = <Tag />; const Other = f('Called'); const h = <Other />;
      const i = <Tooltip content="Hold to send" name="Alice" kind="Pay" visibility="Seen" />; const j = <Amount kind="balance" visibility="public" />;
      const k = 'Отправить';`);
    expect(whats(wordingInCode([f], codes))).toEqual(['Send', 'Send now', 'Pay', 'Paid', 'Payee', 'Owed', 'Label', 'Inside', 'Heading', 'Called', 'Hold to send', 'Alice', 'Pay', 'Seen', 'Отправить']);
  });

  /* RED WHEN: a string in a named position is refused, or a position in WORDING_POSITIONS is one nothing can reach. */
  it('lets a string stand in every named position, and each position is reached', () => {
    const kit = src('packages/ui/src/x.tsx', `"use client"
      import { thing } from 'some-package';
      export * from './other.js';
      const g = import.meta.glob('./locales/*.json', { eager: true, import: 'default' });
      type Tag = React.ComponentProps<'span'>;
      function Badge({ variant = 'outline', size = 'default' }: { variant?: 'outline' | 'ghost'; size?: string }) {
        const t = useText();
        const Comp = asChild ? Slot.Root : 'span';
        if (variant === 'ghost') throw new Error(\`a badge is not \${variant}\`);
        switch (size) { case 'large': break; }
        return <Comp className={cn('inline-flex text-sm', variant)} data-slot="badge" type="button" dir="ltr">{t('kit.badge.label')} USDC</Comp>;
      }
      createElement('section', { variant: 'quiet' });
      new Intl.DateTimeFormat(tag, { dateStyle: 'medium' });
      document.getElementById('root');`);
    expect(whats(wordingInCode([kit], codes))).toEqual([]);
    const census = wordingCensus([kit], codes);
    expect(Object.keys(census.byPosition).sort()).toEqual(Object.keys(WORDING_POSITIONS).filter((p) => p !== 'code').sort());
  });

  /* RED WHEN: a declaration named in CODES lets its strings through in another file, or under another name. */
  it('lets a named declaration hold codes only in its own file and under its own name', () => {
    const named = src('packages/ui/src/i18n/languages.ts', "export const FALLBACK = 'en'; export const OTHER = 'fr';");
    const elsewhere = src('packages/ui/src/other.ts', "export const FALLBACK = 'en';");
    expect(whats(wordingInCode([named, elsewhere], codes))).toEqual(['fr', 'en']);
    expect(wordingCensus([named], codes).byPosition).toEqual({ code: 1 });
    expect(wordingCensus([named], codes).codes).toEqual(['packages/ui/src/i18n/languages.ts#FALLBACK']);
  });

  /* RED WHEN: a position meant for the kit alone lets the application through. */
  it('lets only the kit throw an error with a message of its own', () => {
    expect(whats(wordingInCode([src('packages/ui/src/a.ts', "throw new Error('a token amount is never below zero');")], codes))).toEqual([]);
    expect(whats(wordingInCode([src('apps/web/src/a.ts', "throw new Error('a token amount is never below zero');")], codes))).toEqual(['a token amount is never below zero']);
  });

  /* RED WHEN: a page's title or text, a meta description, or a stylesheet's content is let through, or the viewport's settings or an id is refused. */
  it('reads a page and a stylesheet', () => {
    const page = src('apps/web/index.html', `<!DOCTYPE html>
      <html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <meta name="description" content="Private payroll"><title>Private Vaults</title></head>
      <body><div id="root">Loading</div><script type="module" src="./src/main.ts"></script></body></html>`);
    const sheet = src('apps/web/src/app.css', '.a::after { content: "Sent"; } .b::before { content: ""; } .c::before { content: var(--x); }');
    expect(whats(wordingInCode([page, sheet], codes))).toEqual(['Private Vaults', 'Loading', 'content="Private payroll"', 'content: "Sent"']);
    expect(whats(wordingInCode([src('apps/web/index.html', page.text.replace('<meta name="description" content="Private payroll"><title>Private Vaults</title>', '<title></title>').replace('Loading', ''))], codes))).toEqual([]);
  });

  /* RED WHEN: a sentence in a shared module is missed, or a code or a key is taken for one. */
  it('names every English sentence in a module', () => {
    const f = src('shared.ts', `export const a = 'The vault has no signers.';
      throw new Error(\`Could not reach \${x}\`);
      const k = 'kit.public.label'; const c = 'USDC'; const w = 'word'; const i = 'Content-Type';
      // A comment is not code`);
    const lower = src('lower.ts', "throw new Error('a vault is pinned to its company'); const two = 'two words';");
    expect(whats(englishSentences([f]))).toEqual(['The vault has no signers.', 'Could not reach  ']);
    expect(whats(englishSentences([lower]))).toEqual(['a vault is pinned to its company']);
  });

  /* RED WHEN: a key asked for is missed, or a key built at run time is reported as a key. */
  it('finds every key asked for', () => {
    const f = src('x.tsx', "t('kit.a'); i18n.t(\"kit.b\"); t(`kit.c`); t(`kit.${x}`); t(key); other('kit.z');");
    expect(keysAskedFor(f).map((k) => k.key)).toEqual(['kit.a', 'kit.b', 'kit.c', null, null]);
    const renamed = src('y.tsx', "const say = useText(); say('kit.d'); const { t: tr } = useTranslation(); tr('kit.e'); const again = say; again('kit.f');");
    expect(keysAskedFor(renamed).map((k) => k.key)).toEqual(['kit.d', 'kit.e', 'kit.f']);
  });

  /* RED WHEN: a key that is only the start of another key, or a plural form asked for by name, counts as present. */
  it('finds a phrase by its key or its plural forms, and nothing else', () => {
    const en = { 'run.total_paid': 'x', 'run.people_one': 'x', 'run.people_other': 'x', 'kit.a': 'x' };
    expect(['kit.a', 'run.people', 'run.total_paid'].map((k) => hasPhrase(en, k))).toEqual([true, true, true]);
    expect(['run.total', 'run.people_one', 'kit'].map((k) => hasPhrase(en, k))).toEqual([false, false, false]);
  });
});

describe('amounts', () => {
  /* RED WHEN: any way a value becomes text or a number outside the amount's homes is let through, or the homes are refused. */
  it('names every conversion it lists, outside the amount\'s homes', () => {
    const home = src('packages/ui/src/components/amount.tsx', "formatTokenAmount(1n, 2, 'en'); String(amount); `${amount}`;");
    const helper = src('packages/ui/src/format/token-amount.ts', "new Intl.NumberFormat(tag).format(amount); (amount % unit).toString();");
    const other = src('apps/web/src/x.tsx', `import { formatTokenAmount } from 'vaults-ui/format/token-amount';
      String(amount); amount.toString(); Number(amount); formatNumber(Number(amount), 'en');
      parseFloat(a); parseInt(a, 10); Number.parseInt(a); \`\${amount} USDC\`; '' + amount; +amount; JSON.stringify({ amount });
      new Intl.NumberFormat('en').format(5n); (5n).toLocaleString(); n.toFixed(2); n.toPrecision(3);
      const c = new Intl['NumberFormat']('en'); const { NumberFormat } = Intl; new String(amount); n.toExponential(1);
      xs.map(String); [amount].join(''); ''.concat(amount); globalThis.String(amount); encodeURIComponent(amount);
      el.textContent = amount; s += 'x';`);
    expect(whats(amountsOutsideTheComponent([home, helper, other]))).toEqual([
      'formatTokenAmount', 'String(...)', 'toString', 'Number(...)', 'Number(...)', 'parseFloat(...)', 'parseInt(...)', 'parseInt',
      'template with a value', '+ with a string', 'unary +', 'stringify', 'NumberFormat', 'toLocaleString', 'toFixed', 'toPrecision',
      'NumberFormat', 'NumberFormat', 'String(...)', 'toExponential',
      'String as a value', 'join', 'concat', 'String', 'encodeURIComponent(...)', 'textContent', '+= with a string',
    ]);
    expect(amountsOutsideTheComponent([other]).map((b) => b.line).slice(0, 3)).toEqual([1, 2, 2]);
  });

  /* RED WHEN: a + beside a name the file gives a string, a template or a phrase, a + beside a phrase asked for in place, or a global reached by a name built at run time is let through; or a sum of two counts is refused. */
  it('names a + beside a string held in a name, and a global reached by a built name', () => {
    const f = src('apps/web/src/x.tsx', `const label = t('run.paid'); const tpl = \`x\`; const say = useText(); const heading = say('run.title');
      label + amount; amount + tpl; s += label; t('run.total') + amount; heading + amount;
      globalThis[name](amount); window[k]; self[pick()]; (globalThis as any)[k]; (window!)[k];
      const count = a + b; i += 1; const n = rows.length + 1; window['localStorage']; globalThis.crypto;`);
    expect(whats(amountsOutsideTheComponent([f]))).toEqual([
      '+ with a string held in a name', '+ with a string held in a name', '+= with a string held in a name', '+ with a phrase', '+ with a string held in a name',
      'a global reached by a built name', 'a global reached by a built name', 'a global reached by a built name', 'a global reached by a built name', 'a global reached by a built name',
    ]);
  });

  /* RED WHEN: the plain-number formatter may do more than reach the browser's number formatter, or a kit error may not carry a value. */
  it('lets the plain-number formatter reach only the number formatter, and a kit error carry a value', () => {
    const intl = src('packages/ui/src/format/intl.ts', "new Intl.NumberFormat(tag).format(v); String(v);");
    const kit = src('packages/ui/src/i18n/languages.ts', 'throw new Error(`${path} is not a language file`);');
    expect(whats(amountsOutsideTheComponent([intl, kit]))).toEqual(['String(...)']);
  });
});

describe('language files', () => {
  const en = { 'kit.a': 'A {name}', 'x.count_one': '{count} person', 'x.count_other': '{count} people' };

  /* RED WHEN: a missing phrase, a missing plural form, a form the language does not have, or a stray key is let through. */
  it('names what a language file lacks or has too much of', () => {
    expect(missingPhrases(en, 'en', en)).toEqual([]);
    expect(missingPhrases(en, 'fr', { 'kit.a': 'A {name}', 'x.count_one': '', 'x.count_other': '' })).toEqual(['fr: x.count_many is missing']);
    expect(missingPhrases(en, 'ar', { 'x.count_one': '', 'x.count_other': '', 'x.count_few': '', 'x.count_many': '', 'x.count_two': '', 'x.count_zero': '', 'old': '' }))
      .toEqual(['ar: kit.a is missing', 'ar: old is not in the English file']);
    expect(missingPhrases(en, 'ja', { 'kit.a': '', 'x.count_other': '', 'x.count_one': '' })).toEqual(['ja: x.count_one is a plural form ja does not have']);
    expect(missingPhrases(en, 'de', { 'kit.a': '', 'x.count': '', 'x.count_one': '', 'x.count_other': '' })).toEqual(['de: x.count is plural in English and has no plural forms here']);
  });

  /* RED WHEN: a phrase whose gaps differ from English, in any plural form, is let through. */
  it('names every phrase whose gaps differ', () => {
    expect(gapsThatDiffer(en, 'de', { 'kit.a': 'B {name}', 'x.count_one': '{count} Person', 'x.count_other': '{count} Leute' })).toEqual([]);
    expect(gapsThatDiffer(en, 'de', { 'kit.a': 'B {nom}', 'x.count_one': 'eine Person', 'x.count_other': '{count} Leute' }).length).toBe(2);
    expect(gapsThatDiffer({ 'y_one': '{a}', 'y_other': '{b}' }, 'de', {})).toEqual(['en: the plural forms of y have different gaps']);
  });

  it('reads plural keys and gaps', () => {
    expect(pluralOf('a.b_few')).toEqual({ base: 'a.b', category: 'few' });
    expect(pluralOf('a.b_fewer')).toEqual({ base: 'a.b_fewer', category: null });
    expect(gapsOf('{b} and {a} and {b}')).toEqual(['a', 'b']);
  });
});
