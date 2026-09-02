import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const BASE_STATE_SCHEMA_VERSION = 1 as const;
export const BASE_STATE_PATH = join('.overleaf', 'base.json');

export interface BaseDocumentState {
  docId: string;
  path: string;
  /** Exact text returned by joinDoc (lines joined with a single newline). */
  text: string;
  hash: string;
  version: number;
  rangeFingerprint: string;
  fetchedAt: string;
}

export interface BaseStateV1 {
  schemaVersion: typeof BASE_STATE_SCHEMA_VERSION;
  projectId: string;
  updatedAt: string;
  documents: Record<string, BaseDocumentState>;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = canonicalize(item);
    }
    return out;
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sortedRanges(values: unknown[] | undefined): unknown[] {
  return (values ?? []).map(canonicalize).sort((a, b) => {
    const left = stableJson(a);
    const right = stableJson(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/** Hash all review anchors, independent of the order returned by Overleaf. */
export function fingerprintRanges(ranges: { comments?: unknown[]; changes?: unknown[] }): string {
  return sha256(
    stableJson({
      comments: sortedRanges(ranges.comments),
      changes: sortedRanges(ranges.changes),
    }),
  );
}

function assertBaseState(value: unknown, path: string): asserts value is BaseStateV1 {
  if (!value || typeof value !== 'object') throw new Error(`Invalid base state in ${path}`);
  const state = value as Partial<BaseStateV1>;
  if (
    state.schemaVersion !== BASE_STATE_SCHEMA_VERSION ||
    typeof state.projectId !== 'string' ||
    !state.documents ||
    typeof state.documents !== 'object'
  ) {
    throw new Error(
      `Unsupported or invalid base state in ${path}; run fetch to create a new synchronization base.`,
    );
  }
  for (const [docId, raw] of Object.entries(state.documents)) {
    const doc = raw as Partial<BaseDocumentState>;
    if (
      doc.docId !== docId ||
      typeof doc.path !== 'string' ||
      typeof doc.text !== 'string' ||
      typeof doc.hash !== 'string' ||
      doc.hash !== sha256(doc.text)
    ) {
      throw new Error(`Invalid document ${docId} in ${path}`);
    }
  }
}

export function loadBaseState(path = BASE_STATE_PATH): BaseStateV1 | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in ${path}; run fetch to recreate the synchronization base.`);
  }
  assertBaseState(parsed, path);
  return parsed;
}

/** Write JSON through a sibling temporary file so interruption cannot truncate state. */
export function saveBaseState(state: BaseStateV1, path = BASE_STATE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // The rename may already have consumed the temporary file.
    }
    throw error;
  }
}

/** Merge newly fetched docs while retaining bases for docs outside a subset fetch. */
export function mergeBaseDocuments(
  projectId: string,
  documents: BaseDocumentState[],
  path = BASE_STATE_PATH,
): BaseStateV1 {
  const previous = loadBaseState(path);
  const now = new Date().toISOString();
  const state: BaseStateV1 = {
    schemaVersion: BASE_STATE_SCHEMA_VERSION,
    projectId,
    updatedAt: now,
    documents:
      previous?.projectId === projectId
        ? { ...previous.documents }
        : {},
  };
  for (const doc of documents) state.documents[doc.docId] = doc;
  saveBaseState(state, path);
  return state;
}
