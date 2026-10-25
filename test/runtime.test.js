import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import Agents from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import Sessions from '@deepseek-ai/dsh-session';
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import Projections from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import { deleteArchivedSession } from '../deletion.js';

const rejectsWith = code => error => error.code === `session-delete/${code}`;

async function mount(ctx, plugin, config) {
  const fiber = ctx.plugin(plugin, config);
  await fiber.await();
  assert.equal(fiber.state, 2, `${plugin.name || 'plugin'} must activate`);
  return fiber;
}

async function createRuntime(t, compression = 'none') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-delete-runtime-')));
  const ctx = new Context();
  const handles = [];
  t.after(async () => {
    try {
      for (const handle of handles) await handle.dispose();
      await ctx.fiber.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  new Sessions(ctx);
  new Agents(ctx);
  new Projections(ctx);
  await mount(ctx, SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false });
  await mount(ctx, Tools, {});

  let respond = async function* () {
    yield { type: 'block-start', blockType: 'text', index: 0 };
    yield { type: 'text-delta', text: 'Fixture response.', index: 0 };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Fixture response.' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  class OfflineLlm extends Service {
    constructor() { super(ctx, 'llm'); }
    async prepareCall(config) {
      return { config, adapterDefaults: {}, stream: request => respond(request) };
    }
  }
  new OfflineLlm();
  await mount(ctx, Jsonl, { root: join(root, 'sessions'), compression });
  await mount(ctx, AgentLoop, {});

  const registry = {
    archivedSessionIds: [],
    list: () => [],
    async unarchiveSession(id) {
      this.archivedSessionIds = this.archivedSessionIds.filter(value => value !== id);
    },
  };
  ctx.provide('workspaceRegistry', registry);
  let deletionContext;
  await mount(ctx, {
    inject: ['sessionPersistence', 'sessions', 'agents', 'workspaceRegistry'],
    apply: scoped => { deletionContext = scoped; },
  });
  return {
    ctx, root, registry,
    setResponse: fn => { respond = fn; },
    archive: id => registry.archivedSessionIds.push(id),
    remove: id => deleteArchivedSession(deletionContext, id),
    async create(id, owner = ctx) {
      const handle = await owner.agents.create({
        sessionId: id,
        meta: { cwd: root },
        agentOptions: { provider: 'offline', model: 'fixture' },
      });
      handles.push(handle);
      return handle;
    },
    async resume(id, owner = ctx) {
      const handle = await owner.agents.resume({
        resumeSessionId: id,
        agentOptions: { provider: 'offline', model: 'fixture' },
      });
      handles.push(handle);
      return handle;
    },
  };
}

for (const compression of ['none', 'zstd']) {
  test(`deletes a current-run idle Agent through native teardown (${compression})`, async t => {
    const f = await createRuntime(t, compression);
    // The real API owns Agents in a plugin fiber and discards the returned handle.
    let owner;
    await mount(f.ctx, { inject: ['agents'], apply: ctx => { owner = ctx; } });
    const { agent } = await f.create('created-this-run', owner);
    const other = await f.create('keep-this-session');
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fixture prompt.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.equal(agent.status, 'idle');
    assert.ok(agent.session.snapshotEvents().some(event => event.type === 'turn/end'));
    await f.ctx.sessions.flush(agent.session);
    const path = f.ctx.sessionPersistence.locate(agent.session.header).path;
    await assert.rejects(f.ctx.sessionPersistence.open(agent.id, 'write'), { name: 'SessionAlreadyOwnedError' });
    f.archive(agent.id);

    assert.deepEqual(await f.remove(agent.id), { warnings: [] });
    assert.equal(f.ctx.agents.get(agent.id), undefined);
    assert.equal(f.ctx.sessions.get(agent.id), undefined);
    assert.equal(await f.ctx.sessionPersistence.stat(agent.id), undefined);
    assert.deepEqual(readdirSync(dirname(path)), ['session.lock']);
    assert.equal(f.ctx.agents.get(other.agent.id), other.agent);
    assert.deepEqual(f.registry.archivedSessionIds, []);
    // Teardown is idempotent even when the original owner subsequently unloads.
    await owner.fiber.dispose();
  });
}

test('deletes a session resumed in the current run', async t => {
  const f = await createRuntime(t);
  const first = await f.create('resumed-this-run');
  await f.ctx.sessions.flush(first.agent.session);
  await first.dispose();
  const { agent } = await f.resume(first.agent.id);
  f.archive(agent.id);
  assert.deepEqual(await f.remove(agent.id), { warnings: [] });
  assert.equal(f.ctx.agents.get(agent.id), undefined);
  assert.equal(await f.ctx.sessionPersistence.stat(agent.id), undefined);
});

test('deletes a retained blank session without requiring a materialized log', async t => {
  const f = await createRuntime(t);
  const { agent } = await f.create('blank-this-run');
  assert.equal(existsSync(f.ctx.sessionPersistence.locate(agent.session.header).path), false);
  f.archive(agent.id);
  assert.deepEqual(await f.remove(agent.id), { warnings: [] });
  assert.equal(f.ctx.sessions.get(agent.id), undefined);
  assert.equal(await f.ctx.sessionPersistence.stat(agent.id), undefined);
});

test('concurrent deletion retires the idle Agent only once', async t => {
  const f = await createRuntime(t);
  const { agent } = await f.create('two-delete-requests');
  await f.ctx.sessions.flush(agent.session);
  f.archive(agent.id);
  let disposals = 0;
  f.ctx.on('session/disposed', () => disposals++);
  const results = await Promise.allSettled([f.remove(agent.id), f.remove(agent.id)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const failure = results.find(result => result.status === 'rejected');
  assert.equal(failure.reason.code, 'session-delete/session-in-use');
  assert.equal(disposals, 1);
  assert.equal(await f.ctx.sessionPersistence.stat(agent.id), undefined);
});

test('does not retire an idle Agent while an active reminder is reported', async t => {
  const f = await createRuntime(t);
  const { agent } = await f.create('with-reminder');
  await f.ctx.sessions.flush(agent.session);
  const path = f.ctx.sessionPersistence.locate(agent.session.header).path;
  const before = readFileSync(path);
  f.archive(agent.id);
  f.ctx.on('workspace/session-activity', async (_request, next) => [...await next(), { kind: 'reminders' }]);

  await assert.rejects(f.remove(agent.id), rejectsWith('session-active'));
  assert.equal(f.ctx.agents.get(agent.id), agent);
  assert.deepEqual(readFileSync(path), before);
  await assert.rejects(f.ctx.sessionPersistence.open(agent.id, 'write'), { name: 'SessionAlreadyOwnedError' });
});

test('does not cancel a running turn to delete its session', async t => {
  const f = await createRuntime(t);
  const started = Promise.withResolvers();
  let signal;
  f.setResponse(async function* (request) {
    signal = request.signal;
    started.resolve();
    await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }));
    request.signal.throwIfAborted();
  });
  const { agent } = await f.create('running');
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Hold this turn.' }], source: { kind: 'user' } }));
  await started.promise;
  f.archive(agent.id);
  await assert.rejects(f.remove(agent.id), rejectsWith('session-active'));
  assert.equal(agent.status, 'running');
  assert.equal(signal.aborted, false);
  assert.equal(f.ctx.agents.get(agent.id), agent);
});

test('does not cancel maintenance even though native status is idle', async t => {
  const f = await createRuntime(t);
  const { agent } = await f.create('maintenance');
  const finish = Promise.withResolvers();
  let signal;
  const work = agent.runMaintenance(async value => { signal = value; await finish.promise; });
  f.archive(agent.id);
  try {
    assert.equal(agent.status, 'idle');
    await assert.rejects(f.remove(agent.id), rejectsWith('session-active'));
    assert.equal(signal.aborted, false);
  } finally {
    finish.resolve();
    await work;
  }
});

test('rechecks archival after an activity provider yields, before retiring the Agent', async t => {
  const f = await createRuntime(t);
  const { agent } = await f.create('unarchived-during-check');
  f.archive(agent.id);
  f.ctx.on('workspace/session-activity', async (_request, next) => {
    await Promise.resolve();
    f.registry.archivedSessionIds = [];
    return next();
  });
  await assert.rejects(f.remove(agent.id), rejectsWith('not-archived'));
  assert.equal(f.ctx.agents.get(agent.id), agent);
});

test('still refuses a native write lock held by another backend', async t => {
  const f = await createRuntime(t);
  const handle = await f.create('foreign-owner');
  const id = handle.agent.id;
  await f.ctx.sessions.flush(handle.agent.session);
  const path = f.ctx.sessionPersistence.locate(handle.agent.session.header).path;
  await handle.dispose();
  f.archive(id);
  const foreign = new Context();
  let writer;
  try {
    await mount(foreign, Jsonl, { root: f.ctx.sessionPersistence.root, compression: 'none' });
    writer = await foreign.sessionPersistence.open(id, 'write');
    await assert.rejects(f.remove(id), rejectsWith('session-in-use'));
    assert.ok(existsSync(path));
    assert.deepEqual(f.registry.archivedSessionIds, [id]);
  } finally {
    await writer?.close();
    await foreign.fiber.dispose();
  }
  assert.deepEqual(await f.remove(id), { warnings: [] });
});
