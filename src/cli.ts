import { pull } from './commands/pull';

function getFlag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
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
    default:
      console.log('overleaf-review — sync Overleaf review data with git\n');
      console.log('Usage:');
      console.log('  overleaf-review pull [--out <dir>]   Read comments + tracked changes into a sidecar');
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
