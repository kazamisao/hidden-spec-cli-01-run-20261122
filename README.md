# mend

mend applies an edit that an AI model wrote to a tree of text files. Models produce edits
in whatever shape their harness prefers, and they get the details wrong in characteristic
ways: unified diffs with stale line numbers, hunks whose indentation has drifted,
SEARCH/REPLACE blocks pasted inside prose and code fences, files that end without a line
break. mend reads each of the four shapes exactly the way `SPEC.md` prescribes, tolerates
the drift those mistakes cause, and then changes every file the patch touches — or, when
any edit in it fails, none of them.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

The working directory is the root of the tree; every path in a patch is relative to it.
`PATCH` names the patch file, and when it is absent (or `-`) the patch is read from
standard input.

- `--format=NAME` reads the patch as one format — `unified`, `search-replace`, `v4a` or
  `json`. The default, `auto`, detects the format from the patch's own lines.
- `--check` does everything except write: same report, same exit code, no file created,
  changed or deleted.
- `--strict` turns off the whitespace-tolerant matching tiers described below, so old
  lines must match byte for byte.

## What it prints

A run reports in whole lines and nothing else. When the invocation, the patch file or the
patch itself is unreadable, the report is a single `error:` line (usage, no-patch, format
or parse, with the patch line at fault) and the exit code is 2. When some edits fail, the
report is one `error: <code> <path>` line per failed edit — `no-match`, `ambiguous`,
`missing`, `exists` or `unsafe` — followed by `failed: <k> of <n> edits`, the exit code is
1, and the tree is left exactly as it was. When every edit succeeds the changes are
written, and the report lists one line per changed path in byte order — `A` for added,
`D` for deleted, `M` for modified, and `R <old> -> <new>` for a file a move edit relocated
— followed by `ok: <n> files`.

## The four formats

- **Unified diffs.** Sections open at `diff --git` lines or `--- `/`+++ ` header pairs;
  renames, creations and deletions are recognised from the header. A hunk's old lines are
  located near the position its header claims, so wrong line numbers still land. Counts in
  the header are never trusted, `\ No newline at end of file` markers are honoured, and a
  hunk that fails fails its whole section.
- **SEARCH/REPLACE blocks.** Each block names its file on a nearby line above the
  `<<<<<<< SEARCH` marker (code fences and prose around the blocks are ignored). Empty old
  lines create the file; otherwise the old lines must occur exactly once.
- **V4A patches.** `*** Add File:`, `*** Delete File:` and `*** Update File:` sections
  between `*** Begin Patch` and `*** End Patch`. Update chunks walk a cursor through the
  file, optionally steered by `@@` anchors and `*** End of File`, and an update may carry a
  `*** Move to:` line that relocates the file.
- **JSON edits.** An array of edit objects, or one object per line: `create` writes its
  `file_text` byte for byte, `str_replace` swaps one exact occurrence of a string, and
  `insert` splices lines in after a numbered line.

## How matching works

Unified hunks, SEARCH/REPLACE blocks and V4A chunks all name old lines to be replaced.
Those lines are searched for at the first of three tiers that has a match anywhere:
exactly, then ignoring trailing spaces and tabs, then ignoring leading whitespace as
well. At the loosest tier the replacement is re-indented to the file's own indentation,
while context lines are always taken from the file itself, never from the patch. Each
format then says how it chooses among several occurrences: a unified hunk takes the one
nearest its claimed position, a SEARCH/REPLACE block refuses to choose, and a V4A chunk
takes the first one at or after its cursor.

## Layout of this repository

- `main.ts` — the tool itself: command line, the four parsers, the matching engine and
  the all-or-nothing write. Node 22, standard library only.
- `runner.ts` — the trial driver. When `MAKEFUN_ENV_URL` is set, `main.ts` hands over to
  it; it fetches checks from the environment, runs `main.ts` on each in a fresh directory
  and posts the results. `check.ts` reuses the same machinery locally.
- `check.ts` — scores the tool against the public practice set:

      node check.ts <path-to-practice.json> [family ...]

  It prints every check whose exit code, output or resulting files differ from the
  reference, and the practice score at the end.
- `LICENSE` — MIT.

The behaviour implemented here follows the competition's `SPEC.md` sentence by sentence,
including the sentences the public practice set does not exercise.
