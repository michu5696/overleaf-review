import { OverleafSocket } from '../overleaf-socket';
import { config } from '../config';

export interface Doc {
  _id: string;
  /** Basename, e.g. "intro.tex". */
  name: string;
  /** Full project path, e.g. "sections/intro.tex". */
  path: string;
}

export interface OpenedProject {
  socket: OverleafSocket;
  /** This client's public id — used as `meta.source` on outgoing updates. */
  publicId: string;
  project: any;
  docs: Doc[];
}

export interface DocState {
  version: number;
  lines: string[];
  ranges: { comments?: any[]; changes?: any[] };
}

function collectDocs(rootFolder: any[] | undefined): Doc[] {
  const out: Doc[] = [];
  const walk = (folders: any[], prefix: string) => {
    for (const f of folders ?? []) {
      // The top-level folder is always named "rootFolder"; keep it out of paths.
      const dir = f.name && f.name !== 'rootFolder' ? (prefix ? `${prefix}/${f.name}` : f.name) : prefix;
      for (const d of f.docs ?? []) {
        out.push({ _id: d._id, name: d.name, path: dir ? `${dir}/${d.name}` : d.name });
      }
      walk(f.folders ?? [], dir);
    }
  };
  walk(rootFolder ?? [], '');
  return out;
}

/** Connect and receive the project (auto-pushed as joinProjectResponse). */
export async function openProject(opts: { debug?: boolean } = {}): Promise<OpenedProject> {
  const socket = new OverleafSocket(config.baseUrl, config.cookie, { debug: opts.debug ?? false });
  const pushed = new Promise<any[]>((resolve) => socket.on('joinProjectResponse', resolve));
  await socket.connect(config.projectId);

  const first = await Promise.race([
    pushed,
    new Promise<null>((r) => setTimeout(() => r(null), 6000)),
  ]);

  let publicId = '';
  let project: any;
  if (first) {
    publicId = first[0]?.publicId ?? '';
    project = first[0]?.project;
  } else {
    const r = (await socket.emit('joinProject', [{ project_id: config.projectId }])) as any[];
    project = r[1];
  }
  return { socket, publicId, project, docs: collectDocs(project?.rootFolder) };
}

/** Join a doc and return its current version, lines, and ranges. */
export async function joinDoc(socket: OverleafSocket, docId: string): Promise<DocState> {
  const res = (await socket.emit('joinDoc', [docId, { encodeRanges: true }])) as any[];
  const [err, lines, version, , ranges] = res;
  if (err) throw new Error(`joinDoc error: ${JSON.stringify(err)}`);
  return { version, lines: lines ?? [], ranges: ranges ?? {} };
}
