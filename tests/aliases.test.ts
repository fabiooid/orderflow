import { expect, it } from 'vitest';
import { LibSQLStore } from '@mastra/libsql';
import { startTurn } from '../src/assistant/turn-context.js';
import { RequestContext } from '@mastra/core/request-context';
import { noopObserve } from '@mastra/core/tools';
import { createOrderAgent } from '../src/assistant/agent.js';
import { DemoConnector } from '../src/connector/demo.js';
import { config } from './helpers.js';

it('learns product and client aliases in Mastra memory and uses them in fresh agent searches', async () => {
  const storage = new LibSQLStore({ id: 'aliases', url: ':memory:' });
  try {
    const connector = new DemoConnector();
    const tools = await createOrderAgent(config(), connector, storage).agent.listTools();
    const requestContext = new RequestContext();
    const turn = { evidence: '', operatorWords: '', senderId: 'operator-1', knownPhrases: [] as string[] };
    startTurn(requestContext, turn);
    turn.operatorWords = 'By little pebble I mean DEMO-A; the shop is called Corner shop.';
    const ctx = { requestContext, observe: noopObserve };
    const product = { kind: 'product', phrase: 'little pebble', targetId: 101, action: 'remember', quote: 'By little pebble I mean DEMO-A' } as const;
    expect(await tools.rememberAlias!.execute!(product, ctx)).toEqual({ status: 'remembered' });
    expect(await tools.rememberAlias!.execute!({ kind: 'client', phrase: 'Corner shop', targetId: 201, action: 'remember', quote: 'the shop is called Corner shop' }, ctx)).toEqual({ status: 'remembered' });
    const fresh = await createOrderAgent(config(), connector, storage).agent.listTools();
    expect(await fresh.searchProducts!.execute!({ query: 'little pebble' }, ctx)).toEqual(expect.arrayContaining([expect.objectContaining({ id: 101 })]));
    expect(await fresh.searchClients!.execute!({ query: 'Corner shop' }, ctx)).toEqual([expect.objectContaining({ id: 201 })]);
    const other = config(); other.deploymentId = 'another-deployment';
    const isolated = await createOrderAgent(other, connector, storage).agent.listTools();
    expect(await isolated.searchClients!.execute!({ query: 'Corner shop' }, ctx)).toEqual([]);
    expect(await tools.rememberAlias!.execute!({ ...product, targetId: 999 }, ctx)).toEqual({ status: 'target-not-found' });
    expect(await tools.rememberAlias!.execute!(product, { observe: noopObserve })).toEqual({ status: 'not-authorized' });
    expect(await tools.rememberAlias!.execute!({ ...product, quote: 'invented evidence' }, ctx)).toEqual({ status: 'not-authorized' });
    turn.operatorWords = 'Forget little pebble';
    expect(await tools.rememberAlias!.execute!({ ...product, action: 'forget', quote: 'Forget little pebble' }, ctx)).toEqual({ status: 'forgotten' });
    const { memory } = createOrderAgent(config(), connector, storage);
    expect(await memory.getWorkingMemory({ threadId: 'unused', resourceId: `${config().deploymentId}:telegram:${config().channel.groupId}` })).not.toContain('little pebble');
    turn.operatorWords = 'No, I meant the 250 ml bottle.';
    turn.knownPhrases = ['little pebble'];
    expect(await tools.rememberAlias!.execute!({ ...product, quote: 'No, I meant the 250 ml bottle.' }, ctx)).toEqual({ status: 'remembered' });
  } finally { await storage.close(); }
});

it('enabled Jev cannot learn an alias from its prediction or a model-supplied target alone', async () => {
  const storage = new LibSQLStore({ id: 'jev-alias-guard', url: ':memory:' });
  try {
    const { matchingConfigSchema } = await import('../src/matching/config.js');
    const tools = await createOrderAgent(config(), new DemoConnector(), storage, { enabled: false, rate: 0 }, {
      config: matchingConfigSchema.parse({ mode: 'on' }), selectMany: async () => [],
    }).agent.listTools();
    const requestContext = new RequestContext();
    const turn = { evidence: '', operatorWords: '', senderId: 'operator-1', knownPhrases: [] as string[] };
    startTurn(requestContext, turn);
    const input = { kind: 'product', phrase: 'little pebble', targetId: 101, action: 'remember', quote: 'Remember little pebble' } as const;
    turn.operatorWords = input.quote;
    const ctx = { requestContext, observe: noopObserve };
    expect(await tools.rememberAlias!.execute!(input, ctx)).toEqual({ status: 'not-authorized' });
    turn.operatorWords = 'Remember little pebble means DEMO-A';
    expect(await tools.rememberAlias!.execute!({ ...input, quote: 'Remember little pebble means DEMO-A', targetId: 102 }, ctx)).toEqual({ status: 'not-authorized' });
    expect(await tools.rememberAlias!.execute!({ ...input, quote: 'Remember little pebble means DEMO-A' }, ctx)).toEqual({ status: 'remembered' });
  } finally { await storage.close(); }
});
