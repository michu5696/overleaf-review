import { pull } from './commands/pull';
import { push } from './commands/push';
import { comment } from './commands/comment';
import { resolve } from './commands/resolve';

function getFlag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function usage(): void {
  console.log('overleaf-review — sync Overleaf review data with git\n');
  console.log('Usage:');
  console.log('  overleaf-review pull [--out <dir>]');
  console.log('      Read comments + tracked changes into a sidecar (.overleaf/)');
  console.log('  overleaf-review push --file <f> [--doc <name>] [--dry-run]');
  console.log('      Send local edits back as tracked-change suggestions');
  console.log('  overleaf-review comment --anchor <text> --message <text> [--doc <name>] [--nth <n>]');
  console.log('      Add a comment anchored on the given text');
  console.log('  overleaf-review resolve --thread <id> [--reopen]');
  console.log('      Resolve (or reopen) a comment thread (ids come from `pull`)');
}

async function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'pull': {
      const out = getFlag('out') ?? '.overleaf';
      const data = await pull(out);
      console.log(
        `Pulled ${data.comments.length} comment(s) and ${data.changes.length} ` +
          `tracked change(s) from "${data.project}" → ${out}/`,
      );
      break;
    }
    case 'push': {
      const file = getFlag('file');
      if (!file) {
        console.error('push requires --file <path-to-local-.tex>');
        process.exit(1);
      }
      await push({ file, docName: getFlag('doc'), dryRun: process.argv.includes('--dry-run') });
      break;
    }
    case 'comment': {
      const anchor = getFlag('anchor');
      const message = getFlag('message');
      if (!anchor || !message) {
        console.error('comment requires --anchor <text> and --message <text>');
        process.exit(1);
      }
      const nthRaw = getFlag('nth');
      await comment({
        docName: getFlag('doc'),
        anchor,
        message,
        occurrence: nthRaw ? Number(nthRaw) : undefined,
      });
      break;
    }
    case 'resolve': {
      const thread = getFlag('thread');
      if (!thread) {
        console.error('resolve requires --thread <id>');
        process.exit(1);
      }
      await resolve(thread, process.argv.includes('--reopen'));
      break;
    }
    default:
      usage();
      process.exit(cmd ? 1 : 0);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
