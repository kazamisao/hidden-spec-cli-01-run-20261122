// runner.ts — the trial driver for mend.
//
// When MAKEFUN_ENV_URL is set, main.ts imports runTrial from here. The driver talks to the
// trial environment over HTTP:
//
//   GET  $MAKEFUN_ENV_URL/checks    -> {"checks": [{"id", "argv", "stdin", "files"}], ...}
//   POST $MAKEFUN_ENV_URL/results   <- {"results": [{"id", "exit", "stdout", "files"}]}
//
// Every check is executed by runCheck: it builds a fresh temporary directory holding exactly
// the check's files, runs `node main.ts` there with the check's arguments and standard input
// (MAKEFUN_ENV_URL removed, so the child acts as the plain CLI), and reports the exit code,
// the standard output and the whole file tree left behind. Results are posted in batches.
// A request that dies on the network is retried a few times; a POST that actually landed is
// answered 409 by the environment, which runTrial treats as delivered.
//
// check.ts reuses runCheck to score the public practice set locally.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A single check: arguments, standard input (null for none) and the starting files. */
export interface Check {
  id: string;
  argv: string[];
  stdin: string | null;
  files: Record<string, string>;
}

/** The outcome of one check: exit code, standard output and the files afterwards. */
export interface Result {
  id: string;
  exit: number;
  stdout: string;
  files: Record<string, string>;
}

/** The CLI entry point, in the same directory as this file. */
export const MAIN = join(dirname(fileURLToPath(import.meta.url)), 'main.ts');

/** A check run that takes longer than this is killed and reported with exit code 124. */
export const TIMEOUT_MS = 10_000;
/** Caps the environment accepts on one result's output size and file count. */
export const MAX_STDOUT_BYTES = 64 * 1024;
export const MAX_FILES = 64;
/** How many results go into one POST, and how many times a network failure is retried. */
export const BATCH = 10;
export const RETRIES = 4;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** fetch with retries on network errors only; any HTTP answer, good or bad, is final. */
async function fetchRetried(url: string, init?: RequestInit): Promise<Response> {
  let attempt = 0;
  for (;;) {
    try {
      return await fetch(url, init);
    } catch (err) {
      if (attempt >= RETRIES) throw err;
      attempt += 1;
      await pause(250 * attempt);
    }
  }
}

/** Collect every regular file under `dir` into a map keyed by `/`-separated relative path. */
function snapshotTree(dir: string): Record<string, string> {
  const found: Record<string, string> = {};
  const descend = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) descend(p);
      else if (st.isFile() && Object.keys(found).length < MAX_FILES) {
        found[relative(dir, p).split(sep).join('/')] = readFileSync(p, 'utf8');
      }
    }
  };
  descend(dir);
  return found;
}

/** Run one check against `program` (main.ts by default) and report what it did. */
export function runCheck(c: Check, program = MAIN): Result {
  const dir = mkdtempSync(join(tmpdir(), 'mend-'));
  try {
    for (const [p, text] of Object.entries(c.files)) {
      const target = join(dir, ...p.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    const env = { ...process.env };
    delete env.MAKEFUN_ENV_URL;
    const r = spawnSync(process.execPath, [program, ...c.argv], {
      cwd: dir,
      env,
      input: c.stdin ?? '',
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      maxBuffer: 4 * MAX_STDOUT_BYTES,
    });
    const exit = r.error !== undefined || r.status === null ? 124 : r.status;
    let stdout = r.stdout ?? '';
    while (Buffer.byteLength(stdout, 'utf8') > MAX_STDOUT_BYTES) {
      stdout = stdout.slice(0, Math.floor(stdout.length / 2));
    }
    return { id: c.id, exit, stdout, files: snapshotTree(dir) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run every check the environment at `envUrl` hands out and post the results back. */
export async function runTrial(envUrl: string): Promise<void> {
  const base = envUrl.replace(/\/+$/, '');
  const postBatch = async (results: Result[]): Promise<void> => {
    const res = await fetchRetried(`${base}/results`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ results }),
    });
    // The body is always drained so no half-open connection keeps the process alive.
    const body = await res.text();
    if (!res.ok && res.status !== 409) {
      throw new Error(`POST /results answered ${res.status}: ${body}`);
    }
  };
  const res = await fetchRetried(`${base}/checks`);
  if (!res.ok) throw new Error(`GET /checks answered ${res.status}`);
  const { checks } = (await res.json()) as { checks: Check[] };
  let batch: Result[] = [];
  for (const c of checks) {
    batch.push(runCheck(c));
    if (batch.length === BATCH) {
      await postBatch(batch);
      batch = [];
    }
  }
  if (batch.length > 0) await postBatch(batch);
  process.stdout.write(`posted ${checks.length} results\n`);
}
