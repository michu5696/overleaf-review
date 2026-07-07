import { config } from '../config';
import { OverleafSocket } from '../overleaf-socket';

/**
 * PROBE 1 — prove auth + READ.
 *
 * Connects to the real-time service (socket bound to the project at handshake),
 * receives the project, then joins each doc and dumps { version, ranges }.
 * `ranges.comments` and `ranges.changes` are the anchored comments and tracked
 * changes we ultimately want to sync into git.
 */

interface Doc {
  _id: string;
  name: string;
}

interface Folder {
  docs?: Doc[];
  folders?: Folder[];
}

function collectDocs(rootFolder: Folder[] | undefined): Doc[] {
  const out: Doc[] = [];
  const walk = (folders: Folder[]) => {
    for (const f of folders) {
      for (const d of f.docs ?? []) out.push(d);
      walk(f.folders ?? []);
    }
  };
  walk(rootFolder ?? []);
  return out;
}

async function main() {
  const socket = new OverleafSocket(config.baseUrl, config.cookie);

  // Newer Overleaf pushes the project automatically once the (project-bound)
  // socket connects, via a `joinProjectResponse` event.
  const projectPushed = new Promise<any[]>((resolve) => {
    socket.on('joinProjectResponse', (args) => resolve(args));
  });

  console.log(`Connecting to ${config.baseUrl} (project ${config.projectId}) …`);
  await socket.connect(config.projectId);

  let project: any;
  const pushed = await Promise.race([
    projectPushed,
    new Promise<null>((r) => setTimeout(() => r(null), 6000)),
  ]);

  if (pushed) {
    console.log('joinProjectResponse:', JSON.stringify(pushed).slice(0, 400));
    project = pushed[0]?.project ?? pushed[0];
  } else {
    console.log('No pushed joinProjectResponse; emitting joinProject …');
    const joinRes = await socket.emit('joinProject', [{ project_id: config.projectId }]);
    const [joinErr, proj] = joinRes as [unknown, any];
    if (joinErr) throw new Error(`joinProject error: ${JSON.stringify(joinErr)}`);
    project = proj;
  }

  console.log(`Joined project: ${project?.name ?? '(name?)'}`);
  const docs = collectDocs(project?.rootFolder);
  console.log(`Found ${docs.length} doc(s): ${docs.map((d) => d.name).join(', ') || '(none)'}`);

  for (const doc of docs) {
    const res = await socket.emit('joinDoc', [doc._id, { encodeRanges: true }]);
    // Expected ack shape: [error, docLines, version, updates, ranges]
    const [err, lines, version, , ranges] = res as [unknown, string[], number, unknown, any];
    if (err) {
      console.log(`  ! joinDoc(${doc.name}) error: ${JSON.stringify(err)}`);
      continue;
    }
    const comments = ranges?.comments ?? [];
    const changes = ranges?.changes ?? [];
    console.log(`\n=== ${doc.name}  (v${version}, ${lines?.length ?? '?'} lines) ===`);
    console.log(`    ${comments.length} comment range(s), ${changes.length} tracked change(s)`);
    if (comments.length || changes.length) {
      console.dir({ comments, changes }, { depth: 8 });
    }
  }

  socket.close();
  console.log('\nProbe 1 complete.');
}

main().catch((e) => {
  console.error('\nProbe 1 FAILED:', e);
  process.exit(1);
});
