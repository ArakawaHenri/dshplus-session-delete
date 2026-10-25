import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { installConnection } from '@deepseek-ai/dsh-client-connection/client';
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol';
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence';
import * as plugin from '../index.js';

const SESSION_ID = 'fixture-only';
const ENDPOINT = 'sessionDelete/deleteArchived';

async function createFixture(t, { archived = true, missing = true, inUse = false, active = false, cleanupFails = false }) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());

  for (const [key, value] of Object.entries({
    typert: { register() {} },
    sessionPersistence: {
      name: 'session-persistence-jsonl',
      identity: Symbol('fixture-persistence'),
      stat: async () => missing ? undefined : { header: { id: SESSION_ID }, formatStatus: 'current' },
      open: async () => { throw new SessionPersistenceNotFoundError(SESSION_ID); },
    },
    sessions: { get: () => (inUse ? {} : undefined) },
    agents: { get: () => undefined },
    workspaceRegistry: {
      archivedSessionIds: archived ? [SESSION_ID] : [],
      list: () => cleanupFails ? [{ detachSession: async () => { throw new Error('Fixture workspace write failed'); } }] : [],
      unarchiveSession: async () => {},
    },
  })) {
    ctx.provide(key, value);
  }
  ctx.on('workspace/session-activity', (_request, next) => (active ? [{ kind: 'reminders' }] : next()));

  const fiber = ctx.plugin(plugin);
  await fiber.await();
  const service = ctx.get('sessionDelete');
  assert.ok(service, 'The host service must mount without Agent tools or search services');

  let failure;
  installConnection(ctx, {
    transport: {
      // Exercise the actual Connection parser through JSON, using the Gateway's
      // failure envelope. No HTTP request or real session storage is involved.
      async fetch(url, init) {
        assert.equal(url, `api/${ENDPOINT}`);
        const request = JSON.parse(init.body);
        assert.equal(request.method, ENDPOINT);
        let result;
        try {
          result = { ok: true, value: await service.deleteArchived(request.payload.args.sessionId) };
        } catch (error) {
          failure = remoteErrorOf(error);
          assert.ok(failure, 'The host must return its original RemoteError');
          result = {
            ok: false,
            error: { code: failure.code, message: failure.message, details: failure.details },
          };
        }
        return Response.json({ type: 'server-response', rpcId: request.rpcId, result });
      },
    },
  });

  return {
    invoke: () => ctx.get('connection').rpc.call('/api', ENDPOINT, { args: { sessionId: SESSION_ID } }),
    failure: () => failure,
  };
}

test('RPC completes metadata cleanup without optional Agent tools or search services', async t => {
  const fixture = await createFixture(t, {});
  assert.deepEqual(await fixture.invoke(), { ok: true, value: { warnings: [] } });
});

test('RPC succeeds for a session whose logs and archive entry were already removed', async t => {
  const fixture = await createFixture(t, { archived: false });
  assert.deepEqual(await fixture.invoke(), { ok: true, value: { warnings: [] } });
});

for (const scenario of [
  { code: 'session-in-use', options: { inUse: true }, message: /Close this session in all windows/ },
  { code: 'not-archived', options: { archived: false, missing: false }, message: /Archive the session before deleting/ },
  { code: 'session-active', options: { active: true }, message: /running work or active reminders/ },
  { code: 'cleanup-failed', options: { cleanupFails: true }, message: /Logs deleted/ },
]) {
  test(`RPC preserves ${scenario.code} through the real Connection parser`, async t => {
    const fixture = await createFixture(t, scenario.options);
    const result = await fixture.invoke();

    assert.equal(result.ok, false);
    assert.equal(result.error.code, `session-delete/${scenario.code}`);
    assert.match(result.error.message, scenario.message);
    assert.equal(result.error.message, fixture.failure().message);
    assert.deepEqual(result.error.details, scenario.code === 'cleanup-failed'
      ? { reason: 'Fixture workspace write failed' } : {});
  });
}
