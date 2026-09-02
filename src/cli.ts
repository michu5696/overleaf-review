#!/usr/bin/env node
import { pull } from './commands/pull';
import { push } from './commands/push';
import { fetchDocs } from './commands/fetch';
import { upload } from './commands/upload';
import { acquireMutationLock } from './lib/submission-lock';
import { comment } from './commands/comment';
import { reply } from './commands/reply';
import { resolve } from './commands/resolve';
import { deleteComment } from './commands/delete-comment';
import { deleteThreadMessage } from './commands/delete-message';
import { accept } from './commands/accept';
import { reject } from './commands/reject';
import { login } from './commands/login';
import { link } from './commands/link';
import { config } from './config';
import { beginReceipt, updateReceipt } from './lib/receipts';
import {
  TrackedChangeMutationError,
  type TrackedChangeMutationResult,
} from './lib/tracked-changes';

function getFlag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

/** All values for a repeatable flag, also splitting comma-separated lists. */
function getAll(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    const value = process.argv[i + 1];
    if (a === `--${name}` && value && !value.startsWith('--')) out.push(value);
  });
  return out.flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean);
}

function usage(): void {
  console.log('overleaf-review — sync Overleaf review data with git\n');
  console.log('Setup:');
  console.log('  login [--cookie <val>] [--browser]        Authenticate (SSO-friendly --browser)');
  console.log('  link --project <id>                       Link this repo to an Overleaf project\n');
  console.log('Read:');
  console.log('  pull [--out <dir>]                        Comments + tracked changes → sidecar\n');
  console.log('Safe review workflow:');
  console.log('  review start [--file <f>] [--out <dir>]   Fetch text/base, then pull review data');
  console.log('  review plan --out <plan.json> [options]   Save a complete binding push plan');
  console.log('  review submit --plan <plan.json>          Validate, apply, and verify that plan');
  console.log('       [--acknowledge-ambiguous]             Continue only after manual reconciliation\n');
  console.log('Content (replaces the git bridge):');
  console.log('  fetch [--file <f>] [--dry-run]            Overleaf text → local files + saved base');
  console.log('  upload <path…> [--folder <name>]          Upload figures / new files to Overleaf\n');
  console.log('Comments:');
  console.log('  comment --anchor <text> --message <text> [--doc <name>] [--nth <n>] [--force]');
  console.log('  reply --thread <id> --message <text> [--force]');
  console.log('  resolve --thread <id> [--reopen]          Resolve/reopen a thread');
  console.log('  delete-comment --thread <id>              Delete a whole thread');
  console.log('  delete-message --message-id <id>          Delete a single message\n');
  console.log('Tracked changes:');
  console.log('  push [--file <f>] [--doc <name>] [--direct] [--dry-run]');
  console.log('       [--plan-out <plan.json> | --plan <plan.json>] [--allow-overlap]');
  console.log('       [--acknowledge-ambiguous]  (after manually reconciling a prior uncertain push)');
  console.log('       [--unsafe-no-base]  (legacy escape hatch; disables three-way protection)');
  console.log('        Send local edits as tracked suggestions (--direct = plain edits)');
  console.log('  accept --change <id> [--change <id> …]    Accept collaborators’ changes');
  console.log('  reject --change <id> [--change <id> …]    Reject collaborators’ changes');
  console.log('\n(thread/change ids come from `pull`; --change accepts comma-separated lists too)');
}

async function pullAndReport(
  out: string,
  options: { acquireLock?: boolean } = {},
): Promise<void> {
  const data = await pull(out, options);
  console.log(
    `Pulled ${data.comments.length} comment(s) and ${data.changes.length} ` +
      `tracked change(s) from "${data.project}" → ${out}/`,
  );
}

function pushOptions() {
  return {
    file: getFlag('file'),
    docName: getFlag('doc'),
    direct: process.argv.includes('--direct'),
    dryRun: process.argv.includes('--dry-run'),
    unsafeNoBase: process.argv.includes('--unsafe-no-base'),
    allowOverlap: process.argv.includes('--allow-overlap'),
    planOut: getFlag('plan-out'),
    plan: getFlag('plan'),
    allowAmbiguousRetry: process.argv.includes('--acknowledge-ambiguous'),
  };
}

async function mutateTrackedChanges(
  action: 'accept' | 'reject',
  ids: string[],
  mutate: (changeIds: string[]) => Promise<TrackedChangeMutationResult>,
): Promise<void> {
  let receipt = beginReceipt(action, {
    projectId: config.projectId,
    requestedIds: ids,
    phase: 'preflight',
  });
  try {
    receipt = updateReceipt(receipt, 'in_progress', {
      phase: 'mutating',
      mutationStartedAt: new Date().toISOString(),
    });
    const result = await mutate(ids);
    receipt = updateReceipt(receipt, 'succeeded', {
      phase: 'complete',
      verifiedAt: new Date().toISOString(),
      result,
    });
    console.log(`Audit receipt: ${receipt.path}`);
  } catch (error) {
    const result = error instanceof TrackedChangeMutationError ? error.result : undefined;
    const outcomeUnknown = Boolean(result?.attemptedIds.length && !result.verified);
    receipt = updateReceipt(receipt, outcomeUnknown ? 'ambiguous' : 'failed', {
      phase: outcomeUnknown ? 'outcome_unknown' : 'failed',
      recordedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      ...(result ? { result } : {}),
    });
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}. Audit receipt: ${receipt.path}`,
      { cause: error },
    );
  }
}

async function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'login':
      await login({
        cookie: getFlag('cookie'),
        baseUrl: getFlag('base-url'),
        browser: process.argv.includes('--browser'),
      });
      break;
    case 'link': {
      const project = getFlag('project');
      if (!project) fail('link requires --project <id>');
      link(project!, getFlag('base-url'));
      break;
    }
    case 'pull': {
      const out = getFlag('out') ?? '.overleaf';
      await pullAndReport(out);
      break;
    }
    case 'push':
      await push(pushOptions());
      break;
    case 'review': {
      const reviewCommand = process.argv[3];
      if (process.argv.includes('--through')) {
        fail('Section-scoped --through is not implemented; no review action was performed.');
      }
      if (reviewCommand === 'start') {
        const file = getFlag('file') ?? getFlag('doc');
        const mutationLock = acquireMutationLock(config.projectId);
        try {
          await fetchDocs({ file, dryRun: false, acquireLock: false });
          await pullAndReport(getFlag('out') ?? '.overleaf', { acquireLock: false });
        } finally {
          mutationLock.release();
        }
      } else if (reviewCommand === 'plan') {
        const out = getFlag('out');
        if (!out) fail('review plan requires --out <plan.json>');
        await push({ ...pushOptions(), plan: undefined, planOut: out, dryRun: true });
      } else if (reviewCommand === 'submit') {
        const plan = getFlag('plan');
        if (!plan) fail('review submit requires --plan <plan.json>');
        await push({
          plan,
          allowAmbiguousRetry: process.argv.includes('--acknowledge-ambiguous'),
        });
      } else {
        usage();
        fail('review requires start, plan, or submit');
      }
      break;
    }
    case 'fetch':
      await fetchDocs({ file: getFlag('file'), dryRun: process.argv.includes('--dry-run') });
      break;
    case 'upload': {
      const argv = process.argv.slice(3);
      const paths: string[] = [];
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--folder') { i++; continue; } // skip flag + its value
        if (argv[i].startsWith('--')) continue;
        paths.push(argv[i]);
      }
      if (!paths.length) fail('upload requires at least one file path');
      await upload(paths, getFlag('folder'));
      break;
    }
    case 'comment': {
      const anchor = getFlag('anchor');
      const message = getFlag('message');
      if (!anchor || !message) fail('comment requires --anchor <text> and --message <text>');
      const nthRaw = getFlag('nth');
      const occurrence = nthRaw === undefined ? undefined : Number(nthRaw);
      if (occurrence !== undefined && (!Number.isSafeInteger(occurrence) || occurrence < 1)) {
        fail('comment --nth must be a positive integer');
      }
      await comment({
        docName: getFlag('doc'),
        anchor: anchor!,
        message: message!,
        occurrence,
        force: process.argv.includes('--force'),
      });
      break;
    }
    case 'reply': {
      const thread = getFlag('thread');
      const message = getFlag('message');
      if (!thread || !message) fail('reply requires --thread <id> and --message <text>');
      await reply(thread!, message!, { force: process.argv.includes('--force') });
      break;
    }
    case 'resolve': {
      const thread = getFlag('thread');
      if (!thread) fail('resolve requires --thread <id>');
      await resolve(thread!, process.argv.includes('--reopen'));
      break;
    }
    case 'delete-comment': {
      const thread = getFlag('thread');
      if (!thread) fail('delete-comment requires --thread <id>');
      await deleteComment(thread!);
      break;
    }
    case 'delete-message': {
      const messageId = getFlag('message-id');
      if (!messageId) fail('delete-message requires --message-id <id>');
      await deleteThreadMessage(messageId!, getFlag('thread'));
      break;
    }
    case 'accept': {
      const ids = getAll('change');
      if (!ids.length) fail('accept requires --change <id>');
      await mutateTrackedChanges('accept', ids, accept);
      break;
    }
    case 'reject': {
      const ids = getAll('change');
      if (!ids.length) fail('reject requires --change <id>');
      await mutateTrackedChanges('reject', ids, reject);
      break;
    }
    default:
      usage();
      process.exit(cmd ? 1 : 0);
  }
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
