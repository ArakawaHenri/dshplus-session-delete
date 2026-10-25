import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import {
  SessionPersistence, SessionAlreadyOwnedError, SessionPersistenceNotFoundError,
  SessionPersistenceCorruptionError,
} from '@deepseek-ai/dsh-session-persistence';
import { deleteArchivedSession } from '../deletion.js';

function createFixture(t, compression = 'none', version = 4) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dshplus-session-delete-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const id = 'fixture-only';
  const directory = join(root, '_no-cwd', id);
  mkdirSync(directory, { recursive: true });
  const current = join(directory, `session.v${version}.jsonl${compression === 'zstd' ? '.zstd' : ''}`);
  const header = { version, id, createdAt: 1, isSeeded: false };
  writeFileSync(current, `${JSON.stringify(header)}\n`);
  const lock = join(directory, 'session.lock');
  writeFileSync(lock, '');
  const lockInode = lstatSync(lock).ino;
  const calls = [];
  const events = [];
  let owned = false;

  const persistence = {
    identity: Symbol('fixture-persistence'),
    name: 'session-persistence-jsonl',
    root,
    locate: () => ({ kind: 'jsonl', path: current }),
    stat: async () => {
      try {
        return { header: JSON.parse(readFileSync(current, 'utf8')), formatStatus: 'current' };
      } catch {
        return undefined;
      }
    },
    open: async (_id, access) => {
      calls.push(access === 'write' ? 'open' : 'read');
      if (access === 'write' && owned) throw new SessionAlreadyOwnedError(id);
      if (!existsSync(current)) throw new SessionPersistenceNotFoundError(id);
      let stored;
      try {
        stored = JSON.parse(readFileSync(current, 'utf8'));
      } catch {
        throw new SessionPersistenceCorruptionError('Fixture header is corrupt');
      }
      if (access === 'write') owned = true;
      return {
        header: stored,
        close: async () => {
          if (access === 'write') owned = false;
          calls.push('close');
        },
      };
    },
  };
  const ctx = {
    emit: (...args) => events.push(args),
    sessionPersistence: persistence,
    sessions: { get: () => undefined },
    agents: { get: () => undefined },
    waterfall: async (_name, _request, next) => next(),
    workspaceRegistry: {
      archivedSessionIds: [id],
      list: () => [{ detachSession: async () => calls.push('detach') }],
      unarchiveSession: async () => {
        calls.push('unarchive');
        ctx.workspaceRegistry.archivedSessionIds = [];
      },
    },
  };
  return {
    root, id, directory, current, header, lock, lockInode, calls, events, persistence, ctx,
    remove: () => deleteArchivedSession(ctx, id),
  };
}

async function createCordisFixture(t) {
  const f = createFixture(t);
  const host = new Context();
  t.after(() => host.fiber.dispose());
  const { identity: _identity, ...options } = f.persistence;
  const persistence = Object.assign(new SessionPersistence(host), options);
  const inject = ['sessionPersistence', 'sessions', 'agents', 'workspaceRegistry'];
  for (const name of inject.slice(1)) host.provide(name, f.ctx[name]);
  let context;
  await host.plugin({ inject, apply: ctx => { context = ctx; } }).await();
  assert.ok(context);
  return {
    ...f, persistence, context,
    remove: () => deleteArchivedSession(context, f.id),
    replacePersistence() {
      const replacement = Object.assign(new SessionPersistence(host.isolate('sessionPersistence')), options);
      host.set('sessionPersistence', replacement);
    },
  };
}

function assertRefuses(operation, code) {
  return assert.rejects(operation, error => error.code === `session-delete/${code}`);
}

for (const compression of ['none', 'zstd']) {
  test(`removes all ${compression} generations and preserves lock and unrelated files`, async t => {
    const f = compression === 'none' ? await createCordisFixture(t) : createFixture(t, compression);
    if (f.context) assert.notEqual(f.context.sessionPersistence, f.context.sessionPersistence);
    const suffix = compression === 'zstd' ? '.zstd' : '';
    for (const version of ['', '.v1', '.v2', '.v3']) {
      writeFileSync(join(f.directory, `session${version}.jsonl${suffix}`), 'historical fixture');
    }
    writeFileSync(join(f.directory, 'notes.txt'), 'keep');
    mkdirSync(join(f.directory, 'attachments'));
    f.ctx.workspaceRegistry.list = () => [{
      detachSession: async () => {
        assert.deepEqual(readdirSync(f.directory).sort(), ['attachments', 'notes.txt', 'session.lock']);
        f.calls.push('detach');
      },
    }];

    assert.deepEqual(await f.remove(), { warnings: [] });
    assert.equal(lstatSync(f.lock).ino, f.lockInode);
    assert.deepEqual(f.calls, ['open', 'detach', 'unarchive', 'close']);
    if (!f.context) assert.deepEqual(f.events, [['api-session/removed', f.id, 'dshplus-session-delete']]);
  });
}

test('uses the backend current-generation declaration without assuming format v4', async t => {
  const f = createFixture(t, 'none', 7);
  writeFileSync(join(f.directory, 'session.v4.jsonl'), 'historical fixture');
  writeFileSync(join(f.directory, 'session.v6.jsonl'), 'historical fixture');
  assert.deepEqual(await f.remove(), { warnings: [] });
  assert.deepEqual(readdirSync(f.directory), ['session.lock']);
});

test('reports an unavailable locator without removing storage or metadata', async t => {
  const f = createFixture(t);
  delete f.persistence.locate;
  await assertRefuses(f.remove, 'unsupported-backend');
  assert.ok(existsSync(f.current));
  assert.deepEqual(f.ctx.workspaceRegistry.archivedSessionIds, [f.id]);
  assert.deepEqual(f.calls, []);
});

test('an unavailable lifecycle action only prevents deletion while the Agent is retained', async t => {
  const f = createFixture(t);
  const session = { id: f.id };
  const agent = { id: f.id, session, status: 'idle' };
  f.ctx.sessions.get = () => session;
  f.ctx.agents.get = () => agent;
  // This host exposes no Cordis lifecycle collection to the plugin.
  await assertRefuses(f.remove, 'unsupported-runtime');
  assert.ok(existsSync(f.current));
  assert.deepEqual(f.ctx.workspaceRegistry.archivedSessionIds, [f.id]);
  assert.deepEqual(f.calls, []);

  f.ctx.sessions.get = () => undefined;
  f.ctx.agents.get = () => undefined;
  assert.deepEqual(await f.remove(), { warnings: [] });
});

for (const kind of ['unarchived', 'live', 'agent', 'activity', 'old-format', 'backend']) {
  test(`refuses ${kind} without removing logs or metadata`, async t => {
    const f = createFixture(t);
    const codes = {
      unarchived: 'not-archived', live: 'session-in-use', agent: 'session-in-use',
      activity: 'session-active', 'old-format': 'unsupported-format', backend: 'unsupported-backend',
    };
    if (kind === 'unarchived') f.ctx.workspaceRegistry.archivedSessionIds = [];
    if (kind === 'live') f.ctx.sessions.get = () => ({});
    if (kind === 'agent') f.ctx.agents.get = () => ({});
    if (kind === 'activity') f.ctx.waterfall = async () => [{ kind: 'reminders' }];
    if (kind === 'old-format') f.persistence.stat = async () => ({ header: f.header, formatStatus: 'migration-required' });
    if (kind === 'backend') f.persistence.locate = () => ({ kind: 'sqlite' });

    await assertRefuses(f.remove, codes[kind]);
    assert.ok(existsSync(f.current));
    assert.deepEqual(f.calls, kind === 'activity' ? ['open', 'close'] : []);
    assert.deepEqual(f.events, []);
  });
}

test('uses native write ownership to reject a second concurrent deletion', async t => {
  const f = createFixture(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  f.ctx.waterfall = async () => { entered.resolve(); await release.promise; return []; };
  const first = f.remove();
  try {
    await entered.promise;
    await assertRefuses(f.remove, 'session-in-use');
    assert.ok(existsSync(f.current));
  } finally {
    release.resolve();
  }
  assert.deepEqual(await first, { warnings: [] });
});

test('rechecks live state after acquiring ownership and releases the handle', async t => {
  const f = createFixture(t);
  const open = f.persistence.open;
  f.persistence.open = async (...args) => {
    const handle = await open(...args);
    f.ctx.sessions.get = () => ({});
    return handle;
  };
  await assertRefuses(f.remove, 'session-in-use');
  assert.ok(existsSync(f.current));
  assert.deepEqual(f.calls, ['open', 'close']);
});

test('refuses a replacement provider because teardown releases its write locks', async t => {
  const f = await createCordisFixture(t);
  const open = f.persistence.open;
  f.persistence.open = async (...args) => {
    const handle = await open(...args);
    f.replacePersistence();
    return handle;
  };
  await assertRefuses(f.remove, 'session-changed');
  assert.ok(existsSync(f.current));
  assert.deepEqual(f.calls, ['open', 'close']);
});

test('refuses a locked path different from the validated target', async t => {
  const f = createFixture(t);
  const open = f.persistence.open;
  f.persistence.open = async (...args) => {
    const handle = await open(...args);
    f.persistence.locate = () => ({ kind: 'jsonl', path: join(f.root, 'other', 'session.v4.jsonl') });
    return handle;
  };
  await assertRefuses(f.remove, 'session-changed');
  assert.ok(existsSync(f.current));
  assert.deepEqual(f.calls, ['open', 'close']);
});

test('metadata cleanup can retry after deletion without an in-memory receipt', async t => {
  const f = createFixture(t);
  const list = f.ctx.workspaceRegistry.list;
  f.ctx.workspaceRegistry.list = () => [{
    detachSession: async () => { throw new Error('fixture cleanup failure'); },
  }];
  await assert.rejects(f.remove, error => {
    assert.equal(error.code, 'session-delete/cleanup-failed');
    assert.equal(error.details.reason, 'fixture cleanup failure');
    return true;
  });
  assert.ok(!existsSync(f.current));
  assert.deepEqual(f.events, [['api-session/removed', f.id, 'dshplus-session-delete']]);
  assert.deepEqual(f.ctx.workspaceRegistry.archivedSessionIds, [f.id]);
  f.ctx.workspaceRegistry.list = list;

  assert.deepEqual(await deleteArchivedSession(f.ctx, f.id), { warnings: [] });
  assert.deepEqual(f.calls, ['open', 'close', 'read', 'detach', 'unarchive']);
});

test('metadata cleanup is repeatable after native open confirms the logs are absent', async t => {
  const f = createFixture(t);
  rmSync(f.current);
  assert.deepEqual(await f.remove(), { warnings: [] });
  assert.deepEqual(f.ctx.workspaceRegistry.archivedSessionIds, []);
  assert.deepEqual(await f.remove(), { warnings: [] });
  assert.deepEqual(f.calls, ['read', 'detach', 'unarchive', 'read', 'detach', 'unarchive']);
});

for (const archived of [true, false]) {
  test(`an unreadable ${archived ? 'archived' : 'unarchived'} header is not treated as missing storage`, async t => {
    const f = createFixture(t);
    const archiveIds = archived ? [f.id] : [];
    f.ctx.workspaceRegistry.archivedSessionIds = archiveIds;
    writeFileSync(f.current, '{truncated');
    await assert.rejects(f.remove, { name: 'SessionPersistenceCorruptionError' });
    assert.ok(existsSync(f.current));
    assert.deepEqual(f.calls, ['read']);
    assert.deepEqual(f.ctx.workspaceRegistry.archivedSessionIds, archiveIds);
  });
}

test('a readable session with an inconclusive stat is left unchanged', async t => {
  const f = createFixture(t);
  f.persistence.stat = async () => undefined;
  await assertRefuses(f.remove, 'session-unavailable');
  assert.ok(existsSync(f.current));
  assert.deepEqual(f.calls, ['read', 'close']);
});

for (const kind of ['symlink', 'hardlink']) {
  test(`refuses a ${kind} lock before the backend can open it for writing`, async t => {
    const f = createFixture(t);
    const outside = join(f.root, 'important.txt');
    writeFileSync(outside, 'keep');
    rmSync(f.lock);
    (kind === 'symlink' ? symlinkSync : linkSync)(outside, f.lock);
    await assertRefuses(f.remove, 'unsafe-path');
    assert.equal(readFileSync(outside, 'utf8'), 'keep');
    assert.ok(existsSync(f.current));
    assert.deepEqual(f.calls, []);
  });
}

test('rejects redirected directories and paths outside the storage root', async t => {
  const f = createFixture(t);
  const alias = join(f.root, 'alias');
  symlinkSync(f.directory, alias, 'dir');
  f.persistence.locate = () => ({ kind: 'jsonl', path: join(alias, 'session.v4.jsonl') });
  await assertRefuses(f.remove, 'unsafe-path');
  f.persistence.locate = () => ({ kind: 'jsonl', path: '/unrelated/fixture-only/session.v4.jsonl' });
  await assertRefuses(f.remove, 'unsafe-path');
  assert.ok(existsSync(f.current));
  assert.deepEqual(f.calls, []);
});

test('plans all logs before unlinking and refuses a linked log', async t => {
  const f = createFixture(t);
  const older = join(f.directory, 'session.v1.jsonl');
  const outside = join(f.root, 'important.txt');
  writeFileSync(older, 'keep history');
  writeFileSync(outside, 'keep');
  symlinkSync(outside, join(f.directory, 'session.v3.jsonl'));
  await assertRefuses(f.remove, 'unsafe-path');
  assert.ok(existsSync(f.current));
  assert.ok(existsSync(older));
  assert.equal(readFileSync(outside, 'utf8'), 'keep');
  assert.deepEqual(f.calls, ['open', 'close']);
});

test('unlinking a hardlinked historical log preserves its other name', async t => {
  const f = createFixture(t);
  const outside = join(f.root, 'retained-copy.jsonl');
  writeFileSync(outside, 'copied history');
  linkSync(outside, join(f.directory, 'session.v3.jsonl'));
  assert.deepEqual(await f.remove(), { warnings: [] });
  assert.equal(readFileSync(outside, 'utf8'), 'copied history');
});

test('reports a close failure as a warning after the logs were removed', async t => {
  const f = createFixture(t);
  const open = f.persistence.open;
  f.persistence.open = async (...args) => {
    const handle = await open(...args);
    const close = handle.close;
    handle.close = async () => { await close(); throw new Error('fixture close failure'); };
    return handle;
  };
  const result = await f.remove();
  assert.match(result.warnings[0], /lock release reported/);
  assert.ok(!existsSync(f.current));
  assert.deepEqual(f.ctx.workspaceRegistry.archivedSessionIds, []);
});
