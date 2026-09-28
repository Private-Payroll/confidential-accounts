/**
 * THE KIT'S AND THE APPLICATION'S SOURCE RULES, AS FUNCTIONS OVER SOURCE TEXT.
 *
 * Each rule is a function that takes files and returns what breaks it, so the
 * tests that hold the kit and the application run the same rule, and each rule
 * has its own test against text written to break it. Source is parsed with the
 * bundler's own parser, so what is read is what is served.
 */
import { readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseSync } from 'vite';

export interface Source { path: string; text: string }
export interface Breach { path: string; line: number; what: string }

type Node = { type: string; start: number; end: number; [k: string]: unknown };

const lineOf = (text: string, at: number): number => text.slice(0, at).split('\n').length;

const parse = (s: Source) => {
  const r = parseSync(s.path.replace(/\.(m?ts)$/, '.ts'), s.text);
  if (r.errors.length > 0) throw new Error(`${s.path} did not parse: ${r.errors[0]!.message}`);
  return r;
};

/** Every node under `root`, parents before children, each with its parent. */
function* walk(root: unknown, parent: Node | null = null): Generator<{ node: Node; parent: Node | null }> {
  if (Array.isArray(root)) { for (const r of root) yield* walk(r, parent); return; }
  if (root === null || typeof root !== 'object') return;
  const node = root as Node;
  if (typeof node.type === 'string') yield { node, parent };
  for (const [k, v] of Object.entries(node)) {
    if (k === 'type' || k === 'start' || k === 'end' || k === 'parent') continue;
    if (v !== null && typeof v === 'object') yield* walk(v, typeof node.type === 'string' ? node : parent);
  }
}

/** A code file that ships: TypeScript or TSX, and not a test or a test's support. */
export const isShippingCode = (p: string): boolean =>
  /\.(ts|tsx)$/.test(p) && !/\.test\.(ts|tsx)$/.test(p) && !/\.test-support\.ts$/.test(p) && !p.endsWith('.d.ts');

/** Every file under `dir` whose path passes `keep`, relative to `root`, sorted. */
export function filesUnder(root: string, dir: string, keep: (p: string) => boolean): string[] {
  const out: string[] = [];
  const go = (d: string) => {
    for (const n of readdirSync(d)) {
      if (n === 'node_modules') continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) go(p);
      else { const r = relative(root, p).split(sep).join('/'); if (keep(r)) out.push(r); }
    }
  };
  go(join(root, dir));
  return out.sort();
}

/* ------------------------------------------------------------------ imports */

/** Every module a file names: static, re-exported and dynamic with a literal, with where. */
export function specifiersOf(s: Source): { specifier: string; at: number }[] {
  const { module } = parse(s);
  const out: { specifier: string; at: number }[] = [];
  for (const i of module.staticImports) out.push({ specifier: i.moduleRequest.value, at: i.start });
  for (const e of module.staticExports) for (const en of e.entries) {
    if (en.moduleRequest !== null) out.push({ specifier: en.moduleRequest.value, at: e.start });
  }
  for (const d of module.dynamicImports) {
    const lit = /^(['"`])([^'"`$]+)\1$/.exec(s.text.slice(d.moduleRequest.start, d.moduleRequest.end).trim());
    if (lit) out.push({ specifier: lit[2]!, at: d.start });
  }
  return out;
}

/** The package a bare specifier names: `@scope/name` or `name`. */
export const packageOf = (spec: string): string => {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
};

const BUILTINS = new Set(builtinModules);
const isBuiltin = (spec: string) => spec.startsWith('node:') || BUILTINS.has(packageOf(spec));

/**
 * RULE: every package a file imports is declared by the package the file is
 * in. `declared` is that package's own dependencies and peer dependencies, and
 * its own name, which is how a package reaches its own files. A Node built-in
 * is never declared, so it is always a breach in code a browser is served.
 */
export function undeclaredImports(files: readonly Source[], declared: ReadonlySet<string>): Breach[] {
  const out: Breach[] = [];
  for (const f of files) {
    for (const { specifier, at } of specifiersOf(f)) {
      if (specifier.startsWith('.') || specifier.startsWith('/')) continue;
      if (isBuiltin(specifier) || !declared.has(packageOf(specifier))) {
        out.push({ path: f.path, line: lineOf(f.text, at), what: specifier });
      }
    }
  }
  return out;
}

/** What a package's own `package.json` lets its files import. */
export function declaredBy(packageJson: string): Set<string> {
  const p = JSON.parse(packageJson) as { name: string; dependencies?: object; peerDependencies?: object };
  return new Set([p.name, ...Object.keys(p.dependencies ?? {}), ...Object.keys(p.peerDependencies ?? {})]);
}

/**
 * RULE: the application reaches the kit only by its package name. A relative
 * or absolute path that lands inside the kit's folder is a breach. `root` is
 * the repository, `kit` the kit's folder in it.
 */
export function pathsIntoTheKit(files: readonly Source[], root: string, kit: string): Breach[] {
  /* Compared without case: the Mac's file system finds `packages/UI` as `packages/ui`. */
  const kitDir = (resolve(root, kit) + sep).toLowerCase();
  const out: Breach[] = [];
  for (const f of files) {
    for (const { specifier, at } of specifiersOf(f)) {
      const target = specifier.startsWith('.') ? resolve(root, dirname(f.path), specifier)
        : specifier.startsWith('/') ? resolve(root, `.${specifier}`) : null;
      if (target !== null && (target + sep).toLowerCase().startsWith(kitDir)) out.push({ path: f.path, line: lineOf(f.text, at), what: specifier });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ cn */

/**
 * RULE: one `cn`, the kit's, at `home`. A breach is an import of the `cn`
 * package, or of the two libraries `cn` is made from, anywhere but `home`;
 * an import of `cx`, the class joiner `class-variance-authority` also offers;
 * or a function, variable or export named `cn` declared anywhere but `home`.
 */
export function secondCn(files: readonly Source[], home: string): Breach[] {
  const out: Breach[] = [];
  for (const f of files) {
    if (f.path === home) continue;
    for (const { specifier, at } of specifiersOf(f)) {
      if (['cn', 'clsx', 'tailwind-merge'].includes(packageOf(specifier))) out.push({ path: f.path, line: lineOf(f.text, at), what: `imports ${specifier}` });
    }
    for (const i of parse(f).module.staticImports) {
      if (i.moduleRequest.value !== 'class-variance-authority') continue;
      for (const e of i.entries) if (e.importName.kind === 'Name' && e.importName.name === 'cx') out.push({ path: f.path, line: lineOf(f.text, i.start), what: 'imports cx' });
    }
    for (const { node } of walk(parse(f).program)) {
      const id = (node.id ?? null) as Node | null;
      const named = (node.type === 'FunctionDeclaration' || node.type === 'VariableDeclarator') && id?.type === 'Identifier' && id.name === 'cn';
      if (named) out.push({ path: f.path, line: lineOf(f.text, node.start), what: 'declares cn' });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ colours */

const COLOUR_VALUE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/g;

/** RULE: no colour value in a component or in the application; colours come from the theme's tokens. */
export function colourValues(files: readonly Source[]): Breach[] {
  const out: Breach[] = [];
  for (const f of files) {
    for (const m of f.text.matchAll(COLOUR_VALUE)) out.push({ path: f.path, line: lineOf(f.text, m.index), what: m[0] });
  }
  return out;
}

/**
 * Every class name in a file, with where: each word of every string inside a
 * `className` prop or inside a call to `cn` or `cva`, the three places a class
 * name is written. A string anywhere else (`side="left"`, a key) is not one.
 */
export function classWordsOf(s: Source): { word: string; at: number }[] {
  const roots: Node[] = [];
  for (const { node } of walk(parse(s).program)) {
    if (node.type === 'JSXAttribute' && (node.name as Node).type === 'JSXIdentifier' && (node.name as Node).name === 'className' && node.value) roots.push(node.value as Node);
    if (node.type === 'CallExpression' && (node.callee as Node).type === 'Identifier' && ['cn', 'cva'].includes(String((node.callee as Node).name))) roots.push(...(node.arguments as Node[]));
  }
  const seen = new Set<number>();
  const out: { word: string; at: number }[] = [];
  for (const root of roots) {
    for (const { node, parent } of walk(root)) {
      if (seen.has(node.start)) continue;
      const isKey = parent?.type === 'Property' && parent.key === node && !parent.computed;
      let text: string | null = null;
      if (node.type === 'Literal' && typeof node.value === 'string' && !isKey) text = node.value;
      if (node.type === 'TemplateElement') text = (node.value as { raw: string }).raw;
      if (text === null) continue;
      seen.add(node.start);
      for (const w of text.split(/\s+/)) if (w) out.push({ word: w, at: node.start });
    }
  }
  return out;
}

/** The utility a class name applies, without its variants, `!` or leading `-`: `hover:-ml-2!` is `ml-2`. */
export function utilityOf(word: string): string {
  let depth = 0; let last = 0;
  for (let i = 0; i < word.length; i += 1) {
    const c = word[i];
    if (c === '[' || c === '(') depth += 1;
    else if (c === ']' || c === ')') depth -= 1;
    else if (c === ':' && depth === 0) last = i + 1;
  }
  return word.slice(last).replace(/^!/, '').replace(/!$/, '').replace(/^-/, '');
}

const PALETTE = 'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|mauve|olive|mist|taupe|black|white';
const COLOUR_UTILITY = new RegExp(`^(?:bg|text|border(?:-[xytrblse])?|ring|ring-offset|outline|fill|stroke|decoration|divide|from|via|to|shadow|inset-shadow|inset-ring|accent|caret|placeholder)-(?:${PALETTE})(?:-\\d+)?(?:\\/\\S+)?$`);

/** RULE: no Tailwind palette colour (`bg-red-500`, `text-white`); the kit's stylesheet switches the palette off, so one would silently draw nothing. */
export function paletteClasses(files: readonly Source[]): Breach[] {
  return files.flatMap((f) => classWordsOf(f).filter(({ word }) => COLOUR_UTILITY.test(utilityOf(word)))
    .map(({ word, at }) => ({ path: f.path, line: lineOf(f.text, at), what: word })));
}

const PHYSICAL = /^(?:m[lr]|p[lr]|scroll-m[lr]|scroll-p[lr]|left|right|border-[lr]|rounded-(?:[lr]|tl|tr|bl|br)|text-(?:left|right)|float-(?:left|right)|clear-(?:left|right))(?:-|$)/;

/** RULE: no left or right; start and end (`ms-`, `pe-`, `text-start`), so a right-to-left language needs no redraw. */
export function physicalClasses(files: readonly Source[]): Breach[] {
  return files.flatMap((f) => classWordsOf(f).filter(({ word }) => PHYSICAL.test(utilityOf(word)))
    .map(({ word, at }) => ({ path: f.path, line: lineOf(f.text, at), what: word })));
}

/* ------------------------------------------------------------------ wording */

/** The props whose text a person reads or hears. */
export const READ_PROPS = new Set([
  'title', 'placeholder', 'alt', 'label', 'aria-label', 'aria-description', 'aria-placeholder', 'aria-roledescription',
  'aria-valuetext', 'explanation', 'description', 'summary', 'heading', 'caption', 'message', 'text', 'tooltip', 'children',
]);

const hasLetter = (t: string) => /\p{L}/u.test(t);

const isCreateElement = (callee: Node): boolean => (callee.type === 'Identifier' && ['createElement', 'jsx', 'jsxs'].includes(String(callee.name)))
  || (callee.type === 'MemberExpression' && (callee.property as Node).type === 'Identifier' && (callee.property as Node).name === 'createElement');

/** The strings an expression shows when put on a screen, without looking inside a call: `t('key')` shows a translation, not its key. */
function shownStrings(expr: Node): Node[] {
  switch (expr.type) {
    case 'Literal': return typeof expr.value === 'string' ? [expr] : [];
    case 'TemplateLiteral': return [expr];
    case 'ConditionalExpression': return [...shownStrings(expr.consequent as Node), ...shownStrings(expr.alternate as Node)];
    case 'LogicalExpression': return [...shownStrings(expr.left as Node), ...shownStrings(expr.right as Node)];
    case 'BinaryExpression': return [...shownStrings(expr.left as Node), ...shownStrings(expr.right as Node)];
    case 'ArrayExpression': return (expr.elements as Node[]).filter(Boolean).flatMap(shownStrings);
    case 'ParenthesizedExpression': return shownStrings(expr.expression as Node);
    default: return [];
  }
}

const textOf = (n: Node, src: string): string => n.type === 'Literal' ? String(n.value)
  : n.type === 'TemplateLiteral' ? (n.quasis as { value: { raw: string } }[]).map((q) => q.value.raw).join(' ') : src.slice(n.start, n.end);

/**
 * RULE: no wording outside the language files. A breach is text with a letter
 * in it put on a screen as JSX text, as a string in a child expression, or as
 * the value of a prop a person reads (`READ_PROPS`). `allowed` is what may be
 * shown as it is in every language: the codes of the assets.
 */
export function wordingInCode(files: readonly Source[], allowed: ReadonlySet<string>): Breach[] {
  const out: Breach[] = [];
  for (const f of files) {
    for (const { node, parent } of walk(parse(f).program)) {
      let shown: Node[] = [];
      if (node.type === 'JSXText') shown = [node];
      else if (node.type === 'JSXExpressionContainer' && (parent?.type === 'JSXElement' || parent?.type === 'JSXFragment')) {
        shown = shownStrings(node.expression as Node);
      } else if (node.type === 'JSXAttribute') {
        const name = node.name as Node;
        const attr = name.type === 'JSXIdentifier' ? String(name.name) : '';
        const value = node.value as Node | null;
        if (READ_PROPS.has(attr) && value !== null) {
          shown = value.type === 'JSXExpressionContainer' ? shownStrings(value.expression as Node) : [value];
        }
      }
      else if (node.type === 'CallExpression' && isCreateElement(node.callee as Node)) {
        /* `createElement(type, props, ...children)`: the children are shown, and so are the props a person reads. */
        const [, props, ...children] = node.arguments as Node[];
        shown = children.flatMap(shownStrings);
        if (props?.type === 'ObjectExpression') {
          for (const p of props.properties as Node[]) {
            const key = p.key as Node | undefined;
            const name = key?.type === 'Identifier' ? String(key.name) : key?.type === 'Literal' ? String(key.value) : '';
            if (p.type === 'Property' && READ_PROPS.has(name)) shown.push(...shownStrings(p.value as Node));
          }
        }
      }
      for (const s of shown) {
        const text = (s.type === 'JSXText' ? String(s.value) : textOf(s, f.text)).trim();
        if (hasLetter(text) && !allowed.has(text)) out.push({ path: f.path, line: lineOf(f.text, s.start), what: text });
      }
    }
  }
  return out;
}

/**
 * RULE: no sentence in English exported to the application by the shared
 * browser code. A breach is a string of two or more words beginning with a
 * capital letter, or of three or more words however it begins, anywhere in
 * the module's code; comments are not code.
 */
export function englishSentences(files: readonly Source[]): Breach[] {
  const out: Breach[] = [];
  for (const f of files) {
    for (const { node } of walk(parse(f).program)) {
      const text = node.type === 'Literal' && typeof node.value === 'string' ? node.value
        : node.type === 'TemplateLiteral' ? textOf(node, f.text) : null;
      if (text !== null && (/^\s*\p{Lu}\p{Ll}*[\p{L}']*\s+\p{L}/u.test(text) || /\p{L}[\p{L}']*\s+\p{L}[\p{L}']*\s+\p{L}/u.test(text))) out.push({ path: f.path, line: lineOf(f.text, node.start), what: text.slice(0, 80) });
    }
  }
  return out;
}

/** Every key a file asks a translation for, as a literal: `t('kit.x')`, `i18n.t("kit.x")`. A key built at run time is returned as null. */
export function keysAskedFor(s: Source): { key: string | null; line: number }[] {
  const out: { key: string | null; line: number }[] = [];
  const program = parse(s).program;
  /* Every name a translation function goes by in this file: `t`, and whatever `useText()`, `t` itself or a destructured `t` is given to. */
  const names = new Set(['t']);
  for (const { node } of walk(program)) {
    if (node.type !== 'VariableDeclarator') continue;
    const id = node.id as Node; const init = node.init as Node | null;
    if (id.type === 'Identifier' && init !== null && ((init.type === 'CallExpression' && (init.callee as Node).type === 'Identifier' && (init.callee as Node).name === 'useText')
      || (init.type === 'Identifier' && names.has(String(init.name))))) names.add(String(id.name));
    if (id.type === 'ObjectPattern') {
      for (const p of id.properties as Node[]) {
        const key = p.key as Node | undefined; const value = p.value as Node | undefined;
        if (key?.type === 'Identifier' && key.name === 't' && value?.type === 'Identifier') names.add(String(value.name));
      }
    }
  }
  for (const { node } of walk(program)) {
    if (node.type !== 'CallExpression') continue;
    const callee = node.callee as Node;
    const isT = (callee.type === 'Identifier' && names.has(String(callee.name)))
      || (callee.type === 'MemberExpression' && (callee.property as Node).type === 'Identifier' && (callee.property as Node).name === 't');
    if (!isT) continue;
    const arg = (node.arguments as Node[])[0];
    const key = arg?.type === 'Literal' && typeof arg.value === 'string' ? arg.value
      : arg?.type === 'TemplateLiteral' && (arg.expressions as unknown[]).length === 0 ? textOf(arg, s.text) : null;
    out.push({ key, line: lineOf(s.text, node.start) });
  }
  return out;
}

/* ------------------------------------------------------------------ amounts */

/**
 * RULE: an amount reaches a screen only through the amount component, which
 * says whether it is private or public. A breach is anything else that turns
 * an amount into text: the token-amount formatter named, or the browser's own
 * number formatting reached (`NumberFormat` however spelled, `toLocaleString`,
 * `toFixed`), anywhere but `homes`: the component, the token-amount
 * formatter and the plain-number formatter in `format/intl.ts`.
 * NOT SEEN: `String(amount)` and `formatNumber(Number(amount))`, which look
 * like any other conversion.
 */
export function amountsOutsideTheComponent(files: readonly Source[], homes: readonly string[]): Breach[] {
  const out: Breach[] = [];
  for (const f of files) {
    if (homes.includes(f.path)) continue;
    const seen = new Set<string>();
    for (const { node } of walk(parse(f).program)) {
      /* An import's name is two nodes at one place, the name imported and the local one. */
      const at = `${node.type}:${node.start}:${node.end}`;
      if (seen.has(at)) continue;
      seen.add(at);
      if (node.type === 'Identifier' && node.name === 'formatTokenAmount') out.push({ path: f.path, line: lineOf(f.text, node.start), what: 'formatTokenAmount' });
      if (node.type === 'MemberExpression') {
        const prop = node.property as Node;
        const name = prop.type === 'Identifier' && !node.computed ? String(prop.name) : prop.type === 'Literal' ? String(prop.value) : '';
        if (['NumberFormat', 'toLocaleString', 'toFixed'].includes(name)) out.push({ path: f.path, line: lineOf(f.text, node.start), what: name });
      }
      if (node.type === 'Property' && (node.key as Node).type === 'Identifier' && (node.key as Node).name === 'NumberFormat') {
        out.push({ path: f.path, line: lineOf(f.text, node.start), what: 'NumberFormat' });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ language files */

/** The key a plural entry belongs to, and its category: `x.count_one` is `x.count`, `one`. */
export function pluralOf(key: string): { base: string; category: string | null } {
  const m = /^(.*)_(zero|one|two|few|many|other)$/.exec(key);
  return m ? { base: m[1]!, category: m[2]! } : { base: key, category: null };
}

/** The named gaps of a phrase, sorted: `{name} paid {count}` has `count`, `name`. */
export const gapsOf = (phrase: string): string[] => [...new Set([...phrase.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort();

/**
 * RULE: every language file has every phrase of the English one, with one entry
 * for each plural category the language needs, and nothing the English one has
 * not. A phrase is plural in every language when it is plural in English.
 */
export function missingPhrases(english: Readonly<Record<string, string>>, tag: string, messages: Readonly<Record<string, string>>): string[] {
  const categories = new Intl.PluralRules(tag).resolvedOptions().pluralCategories as string[];
  const bases = new Map<string, boolean>();
  for (const k of Object.keys(english)) { const { base, category } = pluralOf(k); bases.set(base, (bases.get(base) ?? false) || category !== null); }
  const out: string[] = [];
  for (const [base, plural] of bases) {
    const want = plural ? categories.map((c) => `${base}_${c}`) : [base];
    for (const k of want) if (!(k in messages)) out.push(`${tag}: ${k} is missing`);
  }
  for (const k of Object.keys(messages)) {
    const { base, category } = pluralOf(k);
    if (!bases.has(base)) out.push(`${tag}: ${k} is not in the English file`);
    else if (category !== null && !categories.includes(category)) out.push(`${tag}: ${k} is a plural form ${tag} does not have`);
    else if (category === null && bases.get(base) === true) out.push(`${tag}: ${k} is plural in English and has no plural forms here`);
  }
  return out.sort();
}

/** RULE: every phrase has the same named gaps in every language, and in each of its plural forms. */
export function gapsThatDiffer(english: Readonly<Record<string, string>>, tag: string, messages: Readonly<Record<string, string>>): string[] {
  const want = new Map<string, string>();
  for (const [k, v] of Object.entries(english)) {
    const { base } = pluralOf(k);
    const g = gapsOf(v).join(',');
    if (want.has(base) && want.get(base) !== g) return [`en: the plural forms of ${base} have different gaps`];
    want.set(base, g);
  }
  const out: string[] = [];
  for (const [k, v] of Object.entries(messages)) {
    const { base } = pluralOf(k);
    const w = want.get(base);
    if (w !== undefined && gapsOf(v).join(',') !== w) out.push(`${tag}: ${k} has gaps {${gapsOf(v).join('}, {')}} where English has {${w.split(',').join('}, {')}}`);
  }
  return out.sort();
}

/** Whether the English file has a phrase for `key`: the key itself, or its plural forms. */
export function hasPhrase(english: Readonly<Record<string, string>>, key: string): boolean {
  if (key in english) return pluralOf(key).category === null;
  return Object.keys(english).some((e) => { const { base, category } = pluralOf(e); return category !== null && base === key; });
}

/**
 * The bare `data-...` variants a file's classes use (`data-open:`,
 * `group-data-open/button:`), which Tailwind would read as a plain attribute
 * and a stylesheet must define. Bracketed ones (`data-[state=open]:`) say
 * their own selector and are not returned.
 */
export function stateVariantsOf(s: Source): string[] {
  const out = new Set<string>();
  for (const { word } of classWordsOf(s)) {
    const variants = word.slice(0, word.length - utilityOf(word).length);
    for (const m of variants.matchAll(/(?:^|:|-)(data-[a-z]+(?:-[a-z]+)*)(?:\/[\w-]+)?:/g)) out.add(m[1]!);
  }
  return [...out].sort();
}
