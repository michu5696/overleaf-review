#!/usr/bin/env node
import { pull } from './commands/pull';
import { push } from './commands/push';
import { comment } from './commands/comment';
import { reply } from './commands/reply';
import { resolve } from './commands/resolve';
import { deleteComment } from './commands/delete-comment';
import { deleteThreadMessage } from './commands/delete-message';
import { accept } from './commands/accept';
import { reject } from './commands/reject';
import { login } from './commands/login';
import { link } from './commands/link';

function getFlag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** All values for a repeatable flag, also splitting comma-separated lists. */
function getAll(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]);
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
  console.log('Comments:');
  console.log('  comment --anchor <text> --message <text> [--doc <name>] [--nth <n>]');
  console.log('  reply --thread <id> --message <text>      Reply to an existing thread');
  console.log('  resolve --thread <id> [--reopen]          Resolve/reopen a thread');
  console.log('  delete-comment --thread <id>              Delete a whole thread');
  console.log('  delete-message --message-id <id>          Delete a single message\n');
  console.log('Tracked changes:');
  console.log('  push [--file <f>] [--doc <name>] [--dry-run]   Send local edits as suggestions');
  console.log('  accept --change <id> [--change <id> …]    Accept collaborators’ changes');
  console.log('  reject --change <id> [--change <id> …]    Reject collaborators’ changes');
  console.log('\n(thread/change ids come from `pull`; --change accepts comma-separated lists too)');
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
      const data = await pull(out);
      console.log(
        `Pulled ${data.comments.length} comment(s) and ${data.changes.length} ` +
          `tracked change(s) from "${data.project}" → ${out}/`,
      );
      break;
    }
    case 'push':
      await push({ file: getFlag('file'), docName: getFlag('doc'), dryRun: process.argv.includes('--dry-run') });
      break;
    case 'comment': {
      const anchor = getFlag('anchor');
      const message = getFlag('message');
      if (!anchor || !message) fail('comment requires --anchor <text> and --message <text>');
      const nthRaw = getFlag('nth');
      await comment({ docName: getFlag('doc'), anchor: anchor!, message: message!, occurrence: nthRaw ? Number(nthRaw) : undefined });
      break;
    }
    case 'reply': {
      const thread = getFlag('thread');
      const message = getFlag('message');
      if (!thread || !message) fail('reply requires --thread <id> and --message <text>');
      await reply(thread!, message!);
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
      await accept(ids);
      break;
    }
    case 'reject': {
      const ids = getAll('change');
      if (!ids.length) fail('reject requires --change <id>');
      await reject(ids);
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
