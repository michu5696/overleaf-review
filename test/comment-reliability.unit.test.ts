import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  extractPostedMessageId,
  findNewIdenticalMessage,
  findRecentIdenticalMessage,
  threadMessageId,
} from '../src/lib/rest';
import {
  beginReceipt,
  readReceipts,
  updateReceipt,
} from '../src/lib/receipts';
import {
  commentRangeAnchorsText,
  commentIntentHash,
  findCommentRangeByThreadId,
  findCommentRangesAt,
  shouldQuarantineCommentAnchorRetry,
  shouldQuarantineCommentRetry,
} from '../src/commands/comment';
import { replyWithResult } from '../src/commands/reply';

test('recent identical matching is exact and time bounded', () => {
  const now = Date.parse('2026-09-02T12:00:00Z');
  const thread = {
    messages: [
      { id: 'old', content: 'Done', timestamp: now - 10 * 60_000 },
      { id: 'different', content: 'done', timestamp: now - 1000 },
      { id: 'recent', content: 'Done', timestamp: now - 2000 },
    ],
  };

  assert.equal(threadMessageId(findRecentIdenticalMessage(thread, 'Done', now, 5 * 60_000)), 'recent');
  assert.equal(findRecentIdenticalMessage(thread, 'done ', now, 5 * 60_000), undefined);
  assert.equal(findRecentIdenticalMessage(thread, 'Done', now, 500), undefined);
});

test('recent matching accepts Unix seconds and rejects implausibly future messages', () => {
  const now = Date.parse('2026-09-02T12:00:00Z');
  assert.equal(
    threadMessageId(
      findRecentIdenticalMessage(
        { messages: [{ id: 'seconds', content: 'x', timestamp: (now - 1000) / 1000 }] },
        'x',
        now,
      ),
    ),
    'seconds',
  );
  assert.equal(
    findRecentIdenticalMessage(
      { messages: [{ id: 'future', content: 'x', timestamp: now + 120_000 }] },
      'x',
      now,
    ),
    undefined,
  );
});

test('new-message matching never mistakes a pre-existing duplicate for a forced reply', () => {
  const before = { messages: [{ id: 'one', content: 'same', timestamp: 1 }] };
  const unchanged = { messages: [{ id: 'one', content: 'same', timestamp: 1 }] };
  const after = {
    messages: [
      { id: 'one', content: 'same', timestamp: 1 },
      { id: 'two', content: 'same', timestamp: 2 },
    ],
  };

  assert.equal(findNewIdenticalMessage(before, unchanged, 'same'), undefined);
  assert.equal(threadMessageId(findNewIdenticalMessage(before, after, 'same')), 'two');
  assert.equal(threadMessageId(findNewIdenticalMessage(before, after, 'same', 'two')), 'two');
  assert.equal(findNewIdenticalMessage(before, after, 'different'), undefined);

  const raced = {
    messages: [
      ...before.messages,
      { id: 'two', content: 'same' },
      { id: 'three', content: 'same' },
    ],
  };
  assert.equal(findNewIdenticalMessage(before, raced, 'same'), undefined);
  assert.equal(findNewIdenticalMessage(before, raced, 'same', 'three')?.id, 'three');
  assert.equal(findNewIdenticalMessage(before, after, 'same', 'missing'), undefined);
});

test('message id extraction supports common Overleaf response shapes', () => {
  assert.equal(extractPostedMessageId({ message_id: 'one' }), 'one');
  assert.equal(extractPostedMessageId({ message: { id: 'two' } }), 'two');
  assert.equal(extractPostedMessageId({ data: { message: { _id: 'three' } } }), 'three');
  assert.equal(extractPostedMessageId({}), undefined);
});

test('comment range helpers identify exact anchors and recover by thread id', () => {
  const ranges = [
    { op: { p: 4, c: 'text', t: 'thread-a' } },
    { op: { p: 9, c: 'text', t: 'thread-b' } },
    { op: { p: 4, c: 'other', t: 'thread-c' } },
  ];
  assert.equal(findCommentRangeByThreadId(ranges, 'thread-b'), ranges[1]);
  assert.deepEqual(findCommentRangesAt(ranges, 4, 'text'), [ranges[0]]);
  assert.equal(findCommentRangeByThreadId(undefined, 'thread-a'), undefined);
  assert.equal(commentRangeAnchorsText(ranges[0], '0123text-rest', 'text'), true);
  assert.equal(commentRangeAnchorsText(ranges[0], '0123changed-rest', 'text'), false);
});

test('comment intent hash is stable but distinguishes document and occurrence', () => {
  const intent = {
    projectId: 'project',
    docId: 'doc',
    anchor: 'anchor',
    occurrence: 1,
    message: 'message',
  };
  assert.equal(
    commentIntentHash(intent),
    commentIntentHash({
      message: intent.message,
      occurrence: intent.occurrence,
      anchor: intent.anchor,
      docId: intent.docId,
      projectId: intent.projectId,
    }),
  );
  assert.notEqual(commentIntentHash(intent), commentIntentHash({ ...intent, docId: 'other' }));
  assert.notEqual(commentIntentHash(intent), commentIntentHash({ ...intent, occurrence: 2 }));
});

test('a recent unverified comment POST is quarantined before retry', () => {
  const now = Date.parse('2026-09-02T12:00:00Z');
  assert.equal(
    shouldQuarantineCommentRetry(
      {
        status: 'ambiguous',
        updatedAt: new Date(now - 1000).toISOString(),
        postAttemptedAt: new Date(now - 2000).toISOString(),
      },
      now,
      5 * 60_000,
    ),
    true,
  );
  assert.equal(
    shouldQuarantineCommentRetry(
      { status: 'failed', updatedAt: new Date(now - 1000).toISOString() },
      now,
      5 * 60_000,
    ),
    false,
  );
  assert.equal(
    shouldQuarantineCommentRetry(
      {
        status: 'ambiguous',
        updatedAt: new Date(now - 10 * 60_000).toISOString(),
        postAttemptedAt: new Date(now - 10 * 60_000).toISOString(),
      },
      now,
      5 * 60_000,
    ),
    false,
  );
});

test('a recent uncertain anchor attempt is quarantined until readback finds it', () => {
  const now = Date.parse('2026-09-02T12:00:00Z');
  assert.equal(
    shouldQuarantineCommentAnchorRetry(
      {
        status: 'in_progress',
        updatedAt: new Date(now - 1000).toISOString(),
        anchorAttemptedAt: new Date(now - 1000).toISOString(),
      },
      now,
      5 * 60_000,
    ),
    true,
  );
  assert.equal(
    shouldQuarantineCommentAnchorRetry(
      { status: 'in_progress', updatedAt: new Date(now - 1000).toISOString() },
      now,
      5 * 60_000,
    ),
    false,
  );
});

test('receipt journal atomically creates, advances, and discovers JSON receipts', () => {
  const root = mkdtempSync(join(tmpdir(), 'overleaf-review-receipts-'));
  const receiptsDir = join(root, '.overleaf', 'receipts');
  try {
    let handle = beginReceipt(
      'reply',
      { threadId: 'thread-a', phase: 'preflight' },
      {
        receiptsDir,
        operationId: 'operation-a',
        now: () => new Date('2026-09-02T12:00:00Z'),
      },
    );
    handle = updateReceipt(
      handle,
      'succeeded',
      { phase: 'complete', messageId: 'message-a' },
      { now: () => new Date('2026-09-02T12:00:01Z') },
    );

    const onDisk = JSON.parse(readFileSync(handle.path, 'utf8'));
    assert.equal(onDisk.status, 'succeeded');
    assert.equal(onDisk.details.threadId, 'thread-a');
    assert.equal(onDisk.details.messageId, 'message-a');
    assert.equal(onDisk.updatedAt, '2026-09-02T12:00:01.000Z');
    assert.equal(readdirSync(receiptsDir).some((name) => name.endsWith('.tmp')), false);

    writeFileSync(join(receiptsDir, 'unrelated.json'), '{not valid JSON');
    const discovered = readReceipts(receiptsDir);
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0].receipt.operationId, 'operation-a');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reply force posts a new id while the default skips a recent identical message', async () => {
  const root = mkdtempSync(join(tmpdir(), 'overleaf-review-reply-'));
  const receiptsDir = join(root, 'receipts');
  const originalFetch = globalThis.fetch;
  const originalProjectId = process.env.OVERLEAF_PROJECT_ID;
  const originalSession = process.env.OVERLEAF_SESSION2;
  process.env.OVERLEAF_PROJECT_ID = 'project-test';
  process.env.OVERLEAF_SESSION2 = 'session-test';

  let threadReads = 0;
  let posts = 0;
  const recent = { id: 'message-old', content: 'same', timestamp: Date.now() - 1000 };
  try {
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith('/threads')) {
        threadReads += 1;
        const messages =
          posts > 0
            ? [recent, { id: 'message-new', content: 'same', timestamp: Date.now() }]
            : [recent];
        return new Response(JSON.stringify({ 'thread-a': { messages } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/thread/thread-a/messages') && init?.method === 'POST') {
        posts += 1;
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/project/project-test')) {
        return new Response('<meta name="ol-csrfToken" content="csrf-test">', { status: 200 });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const skipped = await replyWithResult('thread-a', 'same', { receiptsDir });
    assert.equal(skipped.duplicate, true);
    assert.equal(skipped.messageId, 'message-old');
    assert.equal(posts, 0);

    const forced = await replyWithResult('thread-a', 'same', {
      force: true,
      receiptsDir,
      verificationTimeoutMs: 0,
    });
    assert.equal(forced.posted, true);
    assert.equal(forced.messageId, 'message-new');
    assert.equal(posts, 1);
    assert.ok(threadReads >= 3);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalProjectId === undefined) delete process.env.OVERLEAF_PROJECT_ID;
    else process.env.OVERLEAF_PROJECT_ID = originalProjectId;
    if (originalSession === undefined) delete process.env.OVERLEAF_SESSION2;
    else process.env.OVERLEAF_SESSION2 = originalSession;
    rmSync(root, { recursive: true, force: true });
  }
});

test('an ambiguous reply timeout is journaled and blocks an automatic retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'overleaf-review-reply-ambiguous-'));
  const receiptsDir = join(root, 'receipts');
  const originalFetch = globalThis.fetch;
  const originalProjectId = process.env.OVERLEAF_PROJECT_ID;
  const originalSession = process.env.OVERLEAF_SESSION2;
  process.env.OVERLEAF_PROJECT_ID = 'project-test';
  process.env.OVERLEAF_SESSION2 = 'session-test';

  let posts = 0;
  try {
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith('/threads')) {
        return new Response(JSON.stringify({ 'thread-a': { messages: [] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/thread/thread-a/messages') && init?.method === 'POST') {
        posts += 1;
        throw new TypeError('simulated connection reset after send');
      }
      if (url.endsWith('/project/project-test')) {
        return new Response('<meta name="ol-csrfToken" content="csrf-test">', { status: 200 });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    await assert.rejects(
      replyWithResult('thread-a', 'uncertain', {
        receiptsDir,
        verificationTimeoutMs: 0,
      }),
      /ambiguous outcome/,
    );
    await assert.rejects(
      replyWithResult('thread-a', 'uncertain', {
        receiptsDir,
        verificationTimeoutMs: 0,
      }),
      /recent reply attempt has an unverified outcome/,
    );
    assert.equal(posts, 1);
    assert.deepEqual(
      readReceipts(receiptsDir).map(({ receipt }) => receipt.status).sort(),
      ['ambiguous', 'skipped'],
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalProjectId === undefined) delete process.env.OVERLEAF_PROJECT_ID;
    else process.env.OVERLEAF_PROJECT_ID = originalProjectId;
    if (originalSession === undefined) delete process.env.OVERLEAF_SESSION2;
    else process.env.OVERLEAF_SESSION2 = originalSession;
    rmSync(root, { recursive: true, force: true });
  }
});

test('an interrupted in-progress reply POST is not sent again automatically', async () => {
  const root = mkdtempSync(join(tmpdir(), 'overleaf-review-reply-interrupted-'));
  const receiptsDir = join(root, 'receipts');
  const originalFetch = globalThis.fetch;
  const originalProjectId = process.env.OVERLEAF_PROJECT_ID;
  const originalSession = process.env.OVERLEAF_SESSION2;
  process.env.OVERLEAF_PROJECT_ID = 'project-test';
  process.env.OVERLEAF_SESSION2 = 'session-test';

  let posts = 0;
  try {
    let interrupted = beginReceipt(
      'reply',
      {
        projectId: 'project-test',
        threadId: 'thread-a',
        message: 'uncertain',
        phase: 'preflight',
      },
      { receiptsDir },
    );
    interrupted = updateReceipt(interrupted, 'in_progress', {
      phase: 'posting_message',
      postAttemptedAt: new Date().toISOString(),
    });
    assert.equal(interrupted.receipt.status, 'in_progress');

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith('/threads')) {
        return new Response(JSON.stringify({ 'thread-a': { messages: [] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/thread/thread-a/messages') && init?.method === 'POST') {
        posts += 1;
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    await assert.rejects(
      replyWithResult('thread-a', 'uncertain', { receiptsDir }),
      /recent reply attempt has an unverified outcome/,
    );
    assert.equal(posts, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalProjectId === undefined) delete process.env.OVERLEAF_PROJECT_ID;
    else process.env.OVERLEAF_PROJECT_ID = originalProjectId;
    if (originalSession === undefined) delete process.env.OVERLEAF_SESSION2;
    else process.env.OVERLEAF_SESSION2 = originalSession;
    rmSync(root, { recursive: true, force: true });
  }
});
