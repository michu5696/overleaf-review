import assert from 'node:assert/strict';
import test from 'node:test';
import type { OverleafSocket } from '../src/overleaf-socket';
import { applyOtUpdateAndWait, type OtUpdate } from '../src/lib/session';

type Handler = (args: unknown[]) => void;

class FakeSocket {
  handlers = new Map<string, Set<Handler>>();
  ack: unknown[] = [];
  asynchronousError: unknown[] | undefined;
  eventsBeforeOwnAck: Array<{ event: string; args: unknown[] }> = [];
  autoOwnApplied = true;

  on(event: string, handler: Handler): () => void {
    const handlers = this.handlers.get(event) ?? new Set<Handler>();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => handlers.delete(handler);
  }

  async emit(_name: string, args: unknown[]): Promise<unknown[]> {
    const docId = args[0] as string;
    const update = args[1] as OtUpdate;
    queueMicrotask(() => {
      for (const event of this.eventsBeforeOwnAck) this.fire(event.event, event.args);
      if (this.asynchronousError) this.fire('otUpdateError', this.asynchronousError);
      else if (this.autoOwnApplied) {
        this.fire('otUpdateApplied', [{ doc: docId, v: update.v }]);
      }
    });
    return this.ack;
  }

  fire(event: string, args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(args);
  }
}

const update: OtUpdate = { doc: 'doc-1', op: [{ p: 0, i: 'x' }], v: 3, meta: {} };

test('applyOtUpdateAndWait waits for the applied event and removes listeners', async () => {
  const socket = new FakeSocket();
  await applyOtUpdateAndWait(socket as unknown as OverleafSocket, 'doc-1', update, 100);
  assert.equal(socket.handlers.get('otUpdateApplied')?.size, 0);
  assert.equal(socket.handlers.get('otUpdateError')?.size, 0);
});

test('applyOtUpdateAndWait rejects an asynchronous application failure', async () => {
  const socket = new FakeSocket();
  socket.asynchronousError = [{ message: 'delete mismatch' }];
  await assert.rejects(
    applyOtUpdateAndWait(socket as unknown as OverleafSocket, 'doc-1', update, 100),
    /delete mismatch/,
  );
});

test('applyOtUpdateAndWait ignores collaborator updates and wrong-version acknowledgements', async () => {
  const socket = new FakeSocket();
  socket.autoOwnApplied = false;
  let settled = false;
  const pending = applyOtUpdateAndWait(
    socket as unknown as OverleafSocket,
    'doc-1',
    update,
    100,
  ).finally(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));

  socket.fire('otUpdateApplied', [
    { doc: 'doc-1', v: update.v, op: [{ p: 0, i: 'remote' }] },
  ]);
  socket.fire('otUpdateApplied', [{ doc: 'doc-1', v: update.v - 1 }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  socket.fire('otUpdateApplied', [{ doc: 'doc-1', v: update.v + 1 }]);
  await pending;
});

test('applyOtUpdateAndWait ignores errors scoped to another document', async () => {
  const socket = new FakeSocket();
  socket.eventsBeforeOwnAck = [
    {
      event: 'otUpdateError',
      args: [{ message: 'other failure' }, { doc_id: 'doc-2' }],
    },
  ];
  await applyOtUpdateAndWait(socket as unknown as OverleafSocket, 'doc-1', update, 100);
});

test('applyOtUpdateAndWait rejects a queue acknowledgement error', async () => {
  const socket = new FakeSocket();
  socket.ack = [{ message: 'not allowed' }];
  await assert.rejects(
    applyOtUpdateAndWait(socket as unknown as OverleafSocket, 'doc-1', update, 100),
    /not allowed/,
  );
});
