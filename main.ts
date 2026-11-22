// main.ts — mend, a command-line tool that applies the edits AI models write to a tree of
// text files. Models produce those edits in four shapes: unified diffs (with line numbers
// that are often wrong), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls
// encoded as JSON. mend reads each shape the way SPEC.md prescribes and applies either
// every edit in the patch or none of them.
//
// Layout of this file: text and file-model helpers first, then the three-tier line
// matcher of SPEC section 5, one parser per format (sections 6 to 9), and finally the
// driver, which parses the command line (section 1), works out the format (section 4),
// applies the edits in order against an in-memory overlay of the tree (section 10) and
// prints the section 2 report. When MAKEFUN_ENV_URL is set the process is a trial run
// instead, and the last lines hand over to runner.ts.
//
// Node 22, standard library only. Run it as `node main.ts [options] [PATCH]`.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** A fatal, whole-run problem: the run prints this one line and exits with code 2. */
class Bail {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

/** One edit failed: a machine-readable code plus the path the failure is about. */
class Flop {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlankLine = (s: string): boolean => s.trim() === '';

/** The lines of a patch: split at `\n`, one trailing `\r` off each, no piece after a final `\n`. */
function patchLinesOf(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC section 3: a safe path is relative, backslash-free, and has no empty, `.` or `..` segment. */
function isSafePath(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
  );
}

/** A file held as lines plus the two facts needed to write it back byte-faithfully. */
interface TextFile {
  lines: string[];
  /** The file's own line break: `\r\n` when its first line feed follows a carriage return. */
  eol: string;
  /** Whether the text ends with that break. */
  tail: boolean;
}

function splitText(text: string): TextFile {
  if (text === '') return { lines: [], eol: '\n', tail: false };
  const nl = text.indexOf('\n');
  const eol = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(eol);
  let tail = false;
  if (text.endsWith(eol)) {
    parts.pop();
    tail = true;
  }
  return { lines: parts, eol, tail };
}

function joinText(f: TextFile): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.eol) + (f.tail ? f.eol : '');
}

const stripTrailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

/**
 * The tree as the edits see it. `base` caches each path's bytes before the patch (null when
 * absent); `top` holds what the edits have made of the paths they touched. Nothing reaches
 * the disk until every edit has succeeded, which is what makes a run all-or-nothing.
 */
class Overlay {
  private base = new Map<string, string | null>();
  private top = new Map<string, string | null>();

  /** The bytes a path had before the patch, or null when it did not exist. */
  before(p: string): string | null {
    if (!this.base.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.base.set(p, v);
    }
    return this.base.get(p)!;
  }

  /** The bytes a path has now: the edited value when an edit touched it, else the original. */
  read(p: string): string | null {
    return this.top.has(p) ? this.top.get(p)! : this.before(p);
  }

  put(p: string, v: string | null): void {
    this.top.set(p, v);
  }

  snapshot(): Map<string, string | null> {
    return new Map(this.top);
  }

  restore(snap: Map<string, string | null>): void {
    this.top = new Map(snap);
  }

  touched(): string[] {
    return [...this.top.keys()];
  }
}

/** One edit of a patch: reads and rewrites the overlay, or throws a Flop. */
type Edit = (tree: Overlay) => void;

// ---------------------------------------------------------------------------
// Section 5: matching old lines against a file's current lines.
//
// A run of old lines O occurs at the first of three tiers that has any
// occurrence at all: tier 0 compares lines exactly, tier 1 also ignores
// trailing spaces and tabs, tier 2 ignores leading ones too. --strict stops
// at tier 0. Occurrences may overlap, and every one of them counts.
// ---------------------------------------------------------------------------

function lineEqAt(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailWs(a) === stripTrailWs(b);
  return stripBothWs(a) === stripBothWs(b);
}

/** Every start position, at or after `from`, where O matches `lines` at `tier`. */
function spotsAt(lines: string[], olds: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const spots: number[] = [];
  for (let i = from; i + olds.length <= lines.length; i += 1) {
    if (eofOnly && i + olds.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < olds.length; j += 1) {
      if (!lineEqAt(lines[i + j]!, olds[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) spots.push(i);
  }
  return spots;
}

interface TierHit {
  tier: number;
  spots: number[];
}

/** The first tier with an occurrence of O at or after `from`, or null when O occurs nowhere. */
function firstTierFrom(
  lines: string[],
  olds: string[],
  strict: boolean,
  from: number,
  eofOnly: boolean,
): TierHit | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const spots = spotsAt(lines, olds, tier, from, eofOnly);
    if (spots.length > 0) return { tier, spots };
  }
  return null;
}

const firstTier = (lines: string[], olds: string[], strict: boolean): TierHit | null =>
  firstTierFrom(lines, olds, strict, 0, false);

/** The first line at or after `from` equal to a single anchor line, tier by tier, or -1. */
function findAnchorLine(lines: string[], anchor: string, strict: boolean, from: number): number {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    for (let i = from; i < lines.length; i += 1) {
      if (lineEqAt(lines[i]!, anchor, tier)) return i;
    }
  }
  return -1;
}

/**
 * One line of a hunk or chunk body. `ctx` lines belong to both the old and the new text,
 * `del` only to the old, `add` only to the new; `eol` is a `\` marker line, which speaks
 * about the body line before it. `oIdx` is a ctx/del line's position within the old text.
 */
interface BodyItem {
  tag: 'ctx' | 'del' | 'add' | 'eol';
  text: string;
  oIdx: number;
  /** True when the body line was a completely empty patch line (unified bodies only). */
  bare: boolean;
}

const oldTexts = (items: BodyItem[]): string[] =>
  items.filter((it) => it.tag === 'ctx' || it.tag === 'del').map((it) => it.text);

const newCount = (items: BodyItem[]): number =>
  items.filter((it) => it.tag === 'ctx' || it.tag === 'add').length;

/** Tier 2 re-indentation of one new line: swap its leading prefix P for the file's F. */
function reindentLine(line: string, fileLead: string, oldLead: string): string {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  if (line.startsWith(oldLead)) return fileLead + line.slice(oldLead.length);
  return line;
}

/**
 * The lines a matched hunk or chunk writes at `spot`: context lines are the file's own
 * matched lines, never the patch's; added lines are verbatim except at tier 2, where the
 * re-indentation rule of section 5 applies to them.
 */
function renderWritten(items: BodyItem[], fileLines: string[], spot: number, tier: number): string[] {
  const olds = oldTexts(items);
  const fileLead = fileLines.length > 0 && olds.length > 0 ? leadWs(fileLines[spot]!) : '';
  const oldLead = olds.length > 0 ? leadWs(olds[0]!) : '';
  const out: string[] = [];
  for (const it of items) {
    if (it.tag === 'ctx') out.push(fileLines[spot + it.oIdx]!);
    else if (it.tag === 'add') out.push(tier === 2 ? reindentLine(it.text, fileLead, oldLead) : it.text);
  }
  return out;
}

/** True when a `\` marker immediately follows the body's last context or added line. */
function noEolAfterLastWritten(items: BodyItem[]): boolean {
  for (let k = items.length - 1; k >= 0; k -= 1) {
    const it = items[k]!;
    if (it.tag === 'ctx' || it.tag === 'add') {
      return k + 1 < items.length && items[k + 1]!.tag === 'eol';
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits. The patch is one JSON array of edit objects, or
// JSON Lines with one object per line. Any malformed object is a parse
// fault: at the line where the array starts, or at the offending line.
// ---------------------------------------------------------------------------

/** The file an edit works on: safety is checked before existence, always. */
function mustExist(tree: Overlay, p: string): string {
  if (!isSafePath(p)) throw new Flop('unsafe', p);
  const t = tree.read(p);
  if (t === null) throw new Flop('missing', p);
  return t;
}

/** Turn one decoded JSON value into an edit, or return null when it is not a valid edit object. */
function jsonToEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafePath(p)) throw new Flop('unsafe', p);
      if (tree.read(p) !== null) throw new Flop('exists', p);
      tree.put(p, text);
    };
  }

  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = mustExist(tree, p);
      // In a CRLF file the text and both strings are read with every break as `\n`,
      // and the outcome is written back with the file's own break throughout.
      const nlAt = before.indexOf('\n');
      const crlf = nlAt > 0 && before[nlAt - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
      const hay = toLf(before);
      const needle = toLf(oldStr);
      let hits = 0;
      for (let k = hay.indexOf(needle); k >= 0; k = hay.indexOf(needle, k + 1)) hits += 1;
      if (hits === 0) throw new Flop('no-match', p);
      if (hits > 1) throw new Flop('ambiguous', p);
      const at = hay.indexOf(needle);
      const merged = hay.slice(0, at) + toLf(newStr) + hay.slice(at + needle.length);
      tree.put(p, crlf ? merged.split('\n').join('\r\n') : merged);
    };
  }

  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const newStr = o.new_str;
    return (tree) => {
      const before = mustExist(tree, p);
      const model = splitText(before);
      if (line < 0 || line > model.lines.length) throw new Flop('no-match', p);
      model.lines.splice(line, 0, ...patchLinesOf(newStr));
      tree.put(p, joinText(model));
    };
  }

  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlankLine(l));
  if (first < 0) throw new Bail('error: parse 1');
  if (lines[first]!.trimStart().startsWith('[')) {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Bail(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(data)) throw new Bail(`error: parse ${first + 1}`);
    return data.map((item) => {
      const ed = jsonToEdit(item);
      if (ed === null) throw new Bail(`error: parse ${first + 1}`);
      return ed;
    });
  }
  const edits: Edit[] = [];
  lines.forEach((l, idx) => {
    if (isBlankLine(l)) return;
    let ed: Edit | null = null;
    try {
      ed = jsonToEdit(JSON.parse(l));
    } catch {
      ed = null;
    }
    if (ed === null) throw new Bail(`error: parse ${idx + 1}`);
    edits.push(ed);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 4: detecting the format of a patch read with --format=auto. The
// four tests run in the order the section lists them.
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlankLine(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const lead = lines[first]!.trimStart().charAt(0);
  if (lead === '[' || lead === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  for (let k = 0; k < lines.length; k += 1) {
    if (lines[k]!.startsWith('diff --git ')) return 'unified';
    if (lines[k]!.startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
//
// A section opens at a `diff --git` line or at a `--- `/`+++ ` header pair.
// Before its first hunk, a section's header names its paths (the pair wins,
// then `rename from`/`rename to`, then the `diff --git` paths) and may flag
// a creation or a deletion. Each section is a single edit; its hunks apply
// in order, each anchored near the line the header claims it starts at.
// ---------------------------------------------------------------------------

interface Hunk {
  /** The A of the `@@ -A[,B] +C[,D] @@` header; B, C and D are never used. */
  a: number;
  items: BodyItem[];
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  headOld: string | null | undefined;
  headNew: string | null | undefined;
  renFrom: string | undefined;
  renTo: string | undefined;
  creates: boolean;
  deletes: boolean;
  hunks: Hunk[];
}

function freshSection(): Section {
  return {
    gitOld: null,
    gitNew: null,
    headOld: undefined,
    headNew: undefined,
    renFrom: undefined,
    renTo: undefined,
    creates: false,
    deletes: false,
    hunks: [],
  };
}

/** The two paths of a `diff --git a/<X> b/<Y>` line; any other shape is a parse fault. */
function gitPaths(line: string, lineNo: number): [string, string] {
  const rest = line.slice('diff --git '.length);
  const sep = rest.startsWith('a/') ? rest.indexOf(' b/', 2) : -1;
  if (sep < 0) throw new Bail(`error: parse ${lineNo}`);
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') throw new Bail(`error: parse ${lineNo}`);
  return [x, y];
}

/** The path of a `--- ` or `+++ ` line: up to the first tab, spaces off, `a/` or `b/` off. */
function headerPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

/** The A of a hunk header line; any other line starting with `@@` is a parse fault. */
function hunkStart(line: string, lineNo: number): number {
  const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
  if (m === null) throw new Bail(`error: parse ${lineNo}`);
  return Number(m[1]);
}

function parseUnified(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const pairAt = (j: number): boolean =>
    lines[j]!.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const [x, y] = gitPaths(line, i + 1);
      cur = freshSection();
      cur.gitOld = x;
      cur.gitNew = y;
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (pairAt(i)) {
      if (cur !== null && inHeader && cur.headOld === undefined) {
        cur.headOld = headerPath(line);
        cur.headNew = headerPath(lines[i + 1]!);
      } else {
        cur = freshSection();
        cur.headOld = headerPath(line);
        cur.headNew = headerPath(lines[i + 1]!);
        sections.push(cur);
      }
      inHeader = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Bail(`error: parse ${i + 1}`);
      const a = hunkStart(line, i + 1);
      const items: BodyItem[] = [];
      let oCount = 0;
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ') || pairAt(j)) break;
        const c = b.charAt(0);
        if (b === '') items.push({ tag: 'ctx', text: '', oIdx: oCount++, bare: true });
        else if (c === ' ') items.push({ tag: 'ctx', text: b.slice(1), oIdx: oCount++, bare: false });
        else if (c === '-') items.push({ tag: 'del', text: b.slice(1), oIdx: oCount++, bare: false });
        else if (c === '+') items.push({ tag: 'add', text: b.slice(1), oIdx: -1, bare: false });
        else if (c === '\\') items.push({ tag: 'eol', text: '', oIdx: -1, bare: false });
        else break;
        j += 1;
      }
      // Empty lines at the end of a body are not part of it.
      while (items.length > 0) {
        const last = items[items.length - 1]!;
        if (last.tag === 'ctx' && last.bare) items.pop();
        else break;
      }
      cur.hunks.push({ a, items });
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      // A `--- ` line with no `+++ ` after it, inside a section's header, is
      // a parse fault at the line that follows it. Header lines that name
      // paths or flags are read; everything else here is ignored.
      if (line.startsWith('--- ')) throw new Bail(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.creates = true;
      else if (line.startsWith('deleted file mode')) cur.deletes = true;
      i += 1;
      continue;
    }
    // Prose, code fences and anything else outside a section's header or a
    // hunk body is ignored.
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict, moves));
}

/**
 * Apply one section's hunks to a file model, in order. `d` is the running
 * length change of the hunks applied so far; a hunk with old lines takes
 * the occurrence nearest to A - 1 + d, and one without inserts after the
 * first A + d lines. The final line break follows the section 6 rule: when
 * a hunk's matched lines run to the end of the file, the result ends with
 * a break unless a `\` marker follows the hunk's last context or `+` line.
 */
function applyUnifiedHunks(model: TextFile, hunks: Hunk[], errPath: string, strict: boolean): void {
  let d = 0;
  for (const h of hunks) {
    const olds = oldTexts(h.items);
    if (olds.length > 0) {
      const found = firstTier(model.lines, olds, strict);
      if (found === null) throw new Flop('no-match', errPath);
      const target = h.a - 1 + d;
      let spot = found.spots[0]!;
      for (const s of found.spots) {
        if (Math.abs(s - target) < Math.abs(spot - target)) spot = s;
      }
      const written = renderWritten(h.items, model.lines, spot, found.tier);
      const atEnd = spot + olds.length === model.lines.length;
      model.lines.splice(spot, olds.length, ...written);
      if (atEnd) {
        model.tail = written.length > 0 ? !noEolAfterLastWritten(h.items) : model.lines.length > 0;
      }
      d += newCount(h.items) - olds.length;
    } else {
      const spot = Math.min(h.a + d, model.lines.length);
      const written = h.items.filter((it) => it.tag === 'add').map((it) => it.text);
      const atEnd = spot === model.lines.length;
      model.lines.splice(spot, 0, ...written);
      if (atEnd && written.length > 0) model.tail = !noEolAfterLastWritten(h.items);
      d += written.length;
    }
  }
}

/** One unified section as an edit: a creation, a deletion, a move or a change. */
function unifiedEdit(s: Section, strict: boolean, moves: Array<[string, string]>): Edit {
  const oldP = s.headOld !== undefined ? s.headOld : s.renFrom !== undefined ? s.renFrom : s.gitOld;
  const newP = s.headNew !== undefined ? s.headNew : s.renTo !== undefined ? s.renTo : s.gitNew;
  return (tree) => {
    if (typeof oldP === 'string' && !isSafePath(oldP)) throw new Flop('unsafe', oldP);
    if (typeof newP === 'string' && !isSafePath(newP)) throw new Flop('unsafe', newP);
    if (oldP === null || s.creates) {
      const p = (newP ?? oldP)!;
      if (tree.read(p) !== null) throw new Flop('exists', p);
      const model: TextFile = { lines: [], eol: '\n', tail: false };
      applyUnifiedHunks(model, s.hunks, p, strict);
      tree.put(p, joinText(model));
    } else if (newP === null || s.deletes) {
      const p = oldP!;
      if (tree.read(p) === null) throw new Flop('missing', p);
      tree.put(p, null);
    } else if (oldP !== newP) {
      if (tree.read(oldP) === null) throw new Flop('missing', oldP);
      if (tree.read(newP) !== null) throw new Flop('exists', newP);
      const model = splitText(tree.read(oldP)!);
      applyUnifiedHunks(model, s.hunks, oldP, strict);
      tree.put(newP, joinText(model));
      tree.put(oldP, null);
      moves.push([oldP, newP]);
    } else {
      const p = oldP;
      const before = tree.read(p);
      if (before === null) throw new Flop('missing', p);
      const model = splitText(before);
      applyUnifiedHunks(model, s.hunks, p, strict);
      tree.put(p, joinText(model));
    }
  };
}


// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks. The path of a block is the nearest
// suitable line above its SEARCH marker (not blank, not a code fence), or
// the previous block's path when there is none. A block with empty old
// lines creates its file; any other block replaces the one place its old
// lines occur.
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let mid = -1;
    for (let k = s + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        mid = k;
        break;
      }
    }
    let end = -1;
    if (mid >= 0) {
      for (let k = mid + 1; k < lines.length; k += 1) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          end = k;
          break;
        }
      }
    }
    if (mid < 0 || end < 0) throw new Bail(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let k = s - 1; k >= prevEnd; k -= 1) {
      const l = lines[k]!;
      if (isBlankLine(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Bail(`error: parse ${s + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(s + 1, mid), lines.slice(mid + 1, end), strict));
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

/** One SEARCH/REPLACE block as an edit. */
function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new Flop('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.read(path) !== null) throw new Flop('exists', path);
      tree.put(path, joinText({ lines: [...newLines], eol: '\n', tail: true }));
      return;
    }
    const before = tree.read(path);
    if (before === null) throw new Flop('missing', path);
    const model = splitText(before);
    const found = firstTier(model.lines, oldLines, strict);
    if (found === null) throw new Flop('no-match', path);
    if (found.spots.length > 1) throw new Flop('ambiguous', path);
    const spot = found.spots[0]!;
    const fileLead = leadWs(model.lines[spot]!);
    const oldLead = leadWs(oldLines[0]!);
    const written = newLines.map((l) => (found.tier === 2 ? reindentLine(l, fileLead, oldLead) : l));
    model.lines.splice(spot, oldLines.length, ...written);
    tree.put(path, joinText(model));
  };
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches. Between `*** Begin Patch` and `*** End Patch`,
// sections add, delete or update one file each. An update is a run of
// chunks applied with a cursor: an anchored chunk first moves the cursor
// past its anchor line, then the chunk's old lines are taken at their
// first occurrence at or after the cursor.
// ---------------------------------------------------------------------------

interface Chunk {
  anchor: string | null;
  /** True when a `*** End of File` line closed the chunk. */
  eof: boolean;
  items: BodyItem[];
}

function parseV4a(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const first = lines.findIndex((l) => !isBlankLine(l));
  if (first < 0) throw new Bail('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Bail(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!isBlankLine(lines[k])) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Bail(`error: parse ${lines.length + 1}`);

  const sectionKind = (l: string): 'add' | 'del' | 'upd' | null =>
    l.startsWith('*** Add File: ')
      ? 'add'
      : l.startsWith('*** Delete File: ')
        ? 'del'
        : l.startsWith('*** Update File: ')
          ? 'upd'
          : null;

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlankLine(line)) {
      i += 1;
      continue;
    }
    const kind = sectionKind(line);
    if (kind === null) throw new Bail(`error: parse ${i + 1}`);
    const sectionLine = i + 1;
    const path = line.slice(kind === 'add' ? '*** Add File: '.length : '*** Delete File: '.length).trim();
    // The section's lines run until the next section opens; blank lines at
    // its end (empty or only whitespace) are not part of it.
    const content: Array<{ text: string; no: number }> = [];
    let j = i + 1;
    while (j < last && sectionKind(lines[j]!) === null) {
      content.push({ text: lines[j]!, no: j + 1 });
      j += 1;
    }
    while (content.length > 0 && content[content.length - 1]!.text.trim() === '') content.pop();

    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const c of content) {
        if (c.text.startsWith('+')) fileLines.push(c.text.slice(1));
        else if (c.text === '') fileLines.push('');
        else throw new Bail(`error: parse ${c.no}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
    } else if (kind === 'del') {
      if (content.length > 0) throw new Bail(`error: parse ${content[0]!.no}`);
      edits.push(v4aDeleteEdit(path));
    } else {
      let moveTo: string | null = null;
      let start = 0;
      if (content.length > 0 && content[0]!.text.startsWith('*** Move to: ')) {
        moveTo = content[0]!.text.slice('*** Move to: '.length).trim();
        start = 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      let oCount = 0;
      for (let t = start; t < content.length; t += 1) {
        const c = content[t]!;
        const l = c.text;
        if (l.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const anchorText = l.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, eof: false, items: [] };
          oCount = 0;
        } else if (l.trim() === '*** End of File') {
          if (cur !== null) {
            cur.eof = true;
            chunks.push(cur);
            cur = null;
          } else {
            chunks.push({ anchor: null, eof: true, items: [] });
          }
        } else if (l === '' || l.charAt(0) === ' ' || l.charAt(0) === '-' || l.charAt(0) === '+') {
          if (cur === null) {
            cur = { anchor: null, eof: false, items: [] };
            oCount = 0;
          }
          if (l === '') cur.items.push({ tag: 'ctx', text: '', oIdx: oCount++, bare: true });
          else if (l.charAt(0) === ' ') cur.items.push({ tag: 'ctx', text: l.slice(1), oIdx: oCount++, bare: false });
          else if (l.charAt(0) === '-') cur.items.push({ tag: 'del', text: l.slice(1), oIdx: oCount++, bare: false });
          else cur.items.push({ tag: 'add', text: l.slice(1), oIdx: -1, bare: false });
        } else {
          throw new Bail(`error: parse ${c.no}`);
        }
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Bail(`error: parse ${sectionLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict, moves));
    }
    i = j;
  }
  return edits;
}

/** A V4A Add File section as an edit: the file is the section's lines, ended by a line break. */
function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new Flop('unsafe', path);
    if (tree.read(path) !== null) throw new Flop('exists', path);
    tree.put(path, joinText({ lines: [...fileLines], eol: '\n', tail: true }));
  };
}

/** A V4A Delete File section as an edit. */
function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new Flop('unsafe', path);
    if (tree.read(path) === null) throw new Flop('missing', path);
    tree.put(path, null);
  };
}

/** A V4A Update File section as an edit, with its chunks and optional move. */
function v4aUpdateEdit(
  path: string,
  moveTo: string | null,
  chunks: Chunk[],
  strict: boolean,
  moves: Array<[string, string]>,
): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new Flop('unsafe', path);
    if (moveTo !== null && !isSafePath(moveTo)) throw new Flop('unsafe', moveTo);
    const before = tree.read(path);
    if (before === null) throw new Flop('missing', path);
    if (moveTo !== null && tree.read(moveTo) !== null) throw new Flop('exists', moveTo);
    const model = splitText(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchorLine(model.lines, ch.anchor, strict, cursor);
        if (at < 0) throw new Flop('no-match', path);
        cursor = at + 1;
      }
      const olds = oldTexts(ch.items);
      if (olds.length > 0) {
        const found = firstTierFrom(model.lines, olds, strict, cursor, ch.eof);
        if (found === null) throw new Flop('no-match', path);
        const spot = found.spots[0]!;
        const written = renderWritten(ch.items, model.lines, spot, found.tier);
        model.lines.splice(spot, olds.length, ...written);
        cursor = spot + written.length;
      } else {
        const spot = ch.eof ? model.lines.length : Math.min(cursor, model.lines.length);
        const written = ch.items.filter((it) => it.tag === 'add').map((it) => it.text);
        model.lines.splice(spot, 0, ...written);
        cursor = spot + written.length;
      }
    }
    if (moveTo !== null) {
      tree.put(moveTo, joinText(model));
      tree.put(path, null);
      moves.push([path, moveTo]);
    } else {
      tree.put(path, joinText(model));
    }
  };
}

// ---------------------------------------------------------------------------
// The driver: command line, patch reading, edit application, reporting.
// ---------------------------------------------------------------------------

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

function execute(argv: string[]): { code: number; out: string[] } {
  // Section 1: options and at most one positional argument, in any order.
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const positional: string[] = [];
  let afterDashDash = false;
  for (const arg of argv) {
    if (!afterDashDash && arg === '--') {
      afterDashDash = true;
    } else if (!afterDashDash && arg.length > 1 && arg.startsWith('-')) {
      if (arg.startsWith('--format=') && format === null && FORMAT_NAMES.includes(arg.slice(9))) {
        format = arg.slice(9);
      } else if (arg === '--check' && !checkOnly) {
        checkOnly = true;
      } else if (arg === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };

  const patchPath = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let text = '';
  try {
    text = readFileSync(patchPath ?? 0, 'utf8');
  } catch {
    if (patchPath !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLinesOf(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  // The whole patch is parsed before any file is looked at, so a parse
  // fault anywhere outranks every per-edit failure.
  const moves: Array<[string, string]> = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict, moves);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict, moves);
    if (edits.length === 0) throw new Bail('error: parse 1');
  } catch (e) {
    if (e instanceof Bail) return { code: 2, out: [e.text] };
    throw e;
  }

  // Section 10: edits run in order against the overlay; a failed edit is
  // rolled back and reported, and the edits after it still run.
  const tree = new Overlay();
  const flops: Flop[] = [];
  for (const ed of edits) {
    const saved = tree.snapshot();
    try {
      ed(tree);
    } catch (e) {
      if (!(e instanceof Flop)) throw e;
      tree.restore(saved);
      flops.push(e);
    }
  }
  if (flops.length > 0) {
    return {
      code: 1,
      out: [...flops.map((f) => `error: ${f.code} ${f.path}`), `failed: ${flops.length} of ${edits.length} edits`],
    };
  }

  // Section 2: one line per changed path in byte order of the paths. A
  // successful move whose old path vanished and whose new path appeared
  // replaces its D and A lines with a single R line, sorted by the new path.
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const rowByPath = new Map<string, Row>();
  for (const p of tree.touched()) {
    const was = tree.before(p);
    const now = tree.read(p);
    if (was === now) continue;
    const row: Row = { key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` };
    rows.push(row);
    rowByPath.set(p, row);
  }
  for (const [oldP, newP] of moves) {
    const qualifies =
      tree.before(oldP) !== null && tree.read(oldP) === null && tree.before(newP) === null && tree.read(newP) !== null;
    const rowOld = rowByPath.get(oldP);
    const rowNew = rowByPath.get(newP);
    if (qualifies && rowOld !== undefined && rowNew !== undefined) {
      rows.splice(rows.indexOf(rowOld), 1);
      rows.splice(rows.indexOf(rowNew), 1);
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));

  if (!checkOnly) {
    for (const p of tree.touched()) {
      const was = tree.before(p);
      const now = tree.read(p);
      if (was === now) continue;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

// With MAKEFUN_ENV_URL set this process is a trial: runner.ts fetches the
// checks from the environment and runs this same file on each of them.
const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(envUrl);
} else {
  const result = execute(process.argv.slice(2));
  writeSync(1, result.out.map((l) => `${l}\n`).join(''));
  process.exitCode = result.code;
}
