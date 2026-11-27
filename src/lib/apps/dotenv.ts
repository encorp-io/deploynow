/**
 * .env files: reading what people paste or upload, planning how it merges into an
 * app's variables, and writing the file compose apps load with `env_file: .env`.
 *
 * Pure functions with no Node imports, so the browser and the deploy runner share them.
 *
 *   KEY=value                 plain, trimmed, `  # comment` at the end is dropped
 *   export KEY=value          the export prefix is ignored
 *   KEY="a\nb ${X}"           double quotes: \n \r \t \" \\ \$ escapes, may span lines
 *   KEY='literal $X'          single (or back) quotes: taken as is, may span lines
 *   # comment, blank lines    skipped
 */

export const DOTENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export interface DotenvEntry {
  key: string;
  value: string;
  /** 1-based line where the variable starts */
  line: number;
}

export interface DotenvIssue {
  line: number;
  message: string;
}

export interface DotenvResult {
  entries: DotenvEntry[];
  /** lines that could not be read; they are skipped */
  errors: DotenvIssue[];
  /** keys set more than once; the last one wins, as in dotenv and docker compose */
  duplicates: string[];
}

const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\", $: "$", "'": "'" };

export function parseDotenv(input: string): DotenvResult {
  const text = input.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const byKey = new Map<string, DotenvEntry>();
  const errors: DotenvIssue[] = [];
  const duplicates = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const m = /^\s*(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(raw);
    if (!m) {
      errors.push({ line: lineNo, message: /^\s*export\s+\S+\s*$/.test(raw) ? "export without a value" : "not a KEY=value line" });
      continue;
    }
    const key = m[1];
    if (!DOTENV_KEY_RE.test(key) || key.length > 128) {
      errors.push({ line: lineNo, message: `"${key}" isn't a valid variable name` });
      continue;
    }

    let rest = m[2];
    let value: string;
    const q = rest[0];
    if (q === '"' || q === "'" || q === "`") {
      // Find the closing quote, reading further lines if needed
      let body = rest.slice(1);
      let end = findClose(body, q);
      let j = i;
      while (end < 0 && j + 1 < lines.length) {
        j++;
        body += "\n" + lines[j];
        end = findClose(body, q);
      }
      if (end < 0) {
        errors.push({ line: lineNo, message: `${key}: the ${q === '"' ? "double" : q === "'" ? "single" : "back"} quote is never closed` });
        continue;
      }
      const after = body.slice(end + 1).trim();
      if (after && !after.startsWith("#")) {
        errors.push({ line: lineNo, message: `${key}: unexpected text after the closing quote` });
        i = j;
        continue;
      }
      value = q === '"' ? unescapeDouble(body.slice(0, end)) : body.slice(0, end);
      i = j;
    } else {
      // Unquoted: an inline comment needs whitespace before the #
      const hash = rest.search(/\s#/);
      if (hash >= 0) rest = rest.slice(0, hash);
      value = rest.trim();
    }

    if (byKey.has(key)) {
      duplicates.add(key);
      byKey.delete(key); // keep the order of the last occurrence
    }
    byKey.set(key, { key, value, line: lineNo });
  }

  return { entries: [...byKey.values()], errors, duplicates: [...duplicates] };
}

function findClose(body: string, q: string): number {
  for (let k = 0; k < body.length; k++) {
    if (q === '"' && body[k] === "\\") {
      k++;
      continue;
    }
    if (body[k] === q) return k;
  }
  return -1;
}

function unescapeDouble(s: string): string {
  return s.replace(/\\(.)/g, (all, ch: string) => ESCAPES[ch] ?? all);
}

/** Names that usually hold credentials; imported as secrets unless the user says otherwise. */
export function looksSecret(key: string): boolean {
  return /(SECRET|PASSWORD|PASSWD|PWD|TOKEN|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY|AUTH|SALT|DSN|WEBHOOK)/i.test(key) || /(^|_)KEY$/i.test(key);
}

// ── Planning an import ─────────────────────────────────────────────────────────

export type EnvKindLike = "plain" | "secret" | "vault";

export interface EnvRowLike {
  key: string;
  kind: EnvKindLike;
  /** null for a stored secret the browser never sees */
  value: string | null;
  hasValue?: boolean;
}

/**
 *   merge    values from the file win; variables not in the file stay
 *   keep     only variables that aren't there yet are added
 *   replace  the list becomes exactly what is in the file
 */
export type ImportMode = "merge" | "keep" | "replace";

export type ImportStatus = "new" | "update" | "same" | "skip";

export interface ImportItem {
  key: string;
  value: string;
  kind: "plain" | "secret";
  status: ImportStatus;
  /** what the variable is now, if it exists */
  current?: EnvKindLike;
  line: number;
}

export interface ImportPlan {
  items: ImportItem[];
  /** variables that the import removes (replace mode) */
  removed: string[];
}

/** Default kind for a variable coming from a file. A Vault reference can't come from a file, so it becomes a secret. */
export function importKind(key: string, existing?: EnvRowLike): "plain" | "secret" {
  if (existing) return existing.kind === "plain" ? "plain" : "secret";
  return looksSecret(key) ? "secret" : "plain";
}

export function planImport(rows: EnvRowLike[], entries: DotenvEntry[], mode: ImportMode, kinds: Record<string, "plain" | "secret"> = {}): ImportPlan {
  const current = new Map(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r]));
  const items: ImportItem[] = entries.map((e) => {
    const ex = current.get(e.key);
    const kind = kinds[e.key] ?? importKind(e.key, ex);
    let status: ImportStatus;
    if (!ex) status = "new";
    else if (mode === "keep") status = "skip";
    else if (ex.kind === kind && kind === "plain" && ex.value === e.value) status = "same";
    else status = "update";
    return { key: e.key, value: e.value, kind, status, current: ex?.kind, line: e.line };
  });
  const inFile = new Set(entries.map((e) => e.key));
  const removed = mode === "replace" ? [...current.keys()].filter((k) => !inFile.has(k)) : [];
  return { items, removed };
}

/** The variable list after the import. Rows keep their place; new ones go at the end. */
export function applyImport<R extends EnvRowLike>(rows: R[], plan: ImportPlan): EnvRowLike[] {
  const byKey = new Map(plan.items.map((i) => [i.key, i]));
  const removed = new Set(plan.removed);
  const out: EnvRowLike[] = [];
  const done = new Set<string>();
  for (const r of rows) {
    const key = r.key.trim();
    if (!key) {
      out.push(r);
      continue;
    }
    if (removed.has(key)) continue;
    const item = byKey.get(key);
    done.add(key);
    if (item && item.status === "update") out.push({ key, kind: item.kind, value: item.value });
    else out.push(r);
  }
  for (const i of plan.items) if (i.status === "new" && !done.has(i.key)) out.push({ key: i.key, kind: i.kind, value: i.value });
  // Blank rows left from editing go last
  return [...out.filter((r) => r.key.trim()), ...out.filter((r) => !r.key.trim())];
}

// ── Writing a .env file ───────────────────────────────────────────────────────

/** Quote a value so docker compose reads it back exactly (no ${VAR} expansion). */
export function quoteDotenvValue(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
}

export function serializeDotenv(vars: { key: string; value: string }[]): string {
  return vars.map((v) => `${v.key}=${quoteDotenvValue(v.value)}`).join("\n") + (vars.length ? "\n" : "");
}
