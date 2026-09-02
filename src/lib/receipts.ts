import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

export const RECEIPT_SCHEMA_VERSION = 1 as const;
export const DEFAULT_RECEIPTS_DIR = join('.overleaf', 'receipts');

export type ReceiptStatus =
  | 'started'
  | 'in_progress'
  | 'succeeded'
  | 'skipped'
  | 'failed'
  | 'ambiguous';

export interface AuditReceipt<T extends Record<string, unknown> = Record<string, unknown>> {
  schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  operationId: string;
  operation: string;
  status: ReceiptStatus;
  startedAt: string;
  updatedAt: string;
  details: T;
}

export interface ReceiptHandle<T extends Record<string, unknown> = Record<string, unknown>> {
  path: string;
  receipt: AuditReceipt<T>;
}

export interface ReceiptOptions {
  /** Override primarily for tests and embedding. */
  receiptsDir?: string;
  /** Override primarily for deterministic tests. */
  now?: () => Date;
  operationId?: string;
}

function safeFilenamePart(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'operation';
}

/**
 * Atomically replace a JSON file and fsync both it and its containing directory.
 * Temporary files live beside the destination so the rename stays on one device.
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  const targetDir = dirname(path);
  mkdirSync(targetDir, { recursive: true });

  const tempPath = join(
    targetDir,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, path);

    // Persist the directory entry where supported. Some platforms/filesystems do
    // not permit opening directories; the atomic rename above still protects
    // readers from partial JSON in that case.
    let dirFd: number | undefined;
    try {
      dirFd = openSync(targetDir, 'r');
      fsyncSync(dirFd);
    } catch {
      // Best-effort directory durability; file durability is already guaranteed.
    } finally {
      if (dirFd !== undefined) closeSync(dirFd);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}

export function beginReceipt<T extends Record<string, unknown>>(
  operation: string,
  details: T,
  options: ReceiptOptions = {},
): ReceiptHandle<T> {
  const now = (options.now ?? (() => new Date()))().toISOString();
  const operationId = options.operationId ?? randomUUID();
  const receipt: AuditReceipt<T> = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    operationId,
    operation,
    status: 'started',
    startedAt: now,
    updatedAt: now,
    details,
  };
  const dir = options.receiptsDir ?? DEFAULT_RECEIPTS_DIR;
  const timestamp = now.replace(/[:.]/g, '-');
  const path = join(dir, `${timestamp}-${safeFilenamePart(operation)}-${operationId}.json`);
  writeJsonAtomic(path, receipt);
  return { path, receipt };
}

export function updateReceipt<
  T extends Record<string, unknown>,
  U extends Record<string, unknown>,
>(
  handle: ReceiptHandle<T>,
  status: ReceiptStatus,
  details: U,
  options: Pick<ReceiptOptions, 'now'> = {},
): ReceiptHandle<T & U> {
  const receipt: AuditReceipt<T & U> = {
    ...handle.receipt,
    status,
    updatedAt: (options.now ?? (() => new Date()))().toISOString(),
    details: { ...handle.receipt.details, ...details },
  };
  writeJsonAtomic(handle.path, receipt);
  return { path: handle.path, receipt };
}

/** Read valid receipt files, ignoring unrelated or partially copied files. */
export function readReceipts(
  receiptsDir = DEFAULT_RECEIPTS_DIR,
): Array<ReceiptHandle<Record<string, unknown>>> {
  let names: string[];
  try {
    names = readdirSync(receiptsDir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }

  const receipts: Array<ReceiptHandle<Record<string, unknown>>> = [];
  for (const name of names) {
    const path = join(receiptsDir, name);
    try {
      const receipt = JSON.parse(readFileSync(path, 'utf8')) as AuditReceipt;
      if (
        receipt?.schemaVersion === RECEIPT_SCHEMA_VERSION &&
        typeof receipt.operationId === 'string' &&
        typeof receipt.operation === 'string' &&
        typeof receipt.updatedAt === 'string' &&
        receipt.details &&
        typeof receipt.details === 'object'
      ) {
        receipts.push({ path, receipt });
      }
    } catch {
      // A corrupt file cannot be one written atomically by this module, but it
      // should not prevent recovery from the remaining journal entries.
    }
  }
  return receipts.sort((a, b) => b.receipt.updatedAt.localeCompare(a.receipt.updatedAt));
}
