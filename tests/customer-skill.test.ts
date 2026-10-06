import { expect, it } from 'vitest';
import { LibSQLStore } from '@mastra/libsql';
import { createOrderAgent } from '../src/assistant/agent.js';
import { buildSystemPrompt } from '../src/assistant/system-prompt.js';
import { DemoConnector } from '../src/connector/demo.js';
import { config } from './helpers.js';

it('discovers and loads the native customer skill with deployment-specific requirements', async () => {
  const c = config(); c.clients.requiredFields = ['email']; c.clients.sdiCountries = ['IT'];
  const storage = new LibSQLStore({id:'skill-test',url:':memory:'});
  try {
    const {agent} = createOrderAgent(c,new DemoConnector(),storage);
    expect((await agent.listSkills()).some(s => s.name === 'customer-creation')).toBe(true);
    const skill = await agent.getSkill('customer-creation');
    expect(skill?.instructions).toContain('Additional required fields from this deployment: email');
    expect(skill?.instructions).toContain('SDI is required only for these country codes: IT');
    expect(skill?.instructions).toContain('Preserve all previously supplied');
    expect(buildSystemPrompt(c)).not.toContain('Required base fields:');
    expect(buildSystemPrompt(c)).toContain('Never create invoices or proformas');
  } finally { await storage.close(); }
});
it('does not impose optional identifiers when configuration leaves them optional',async()=>{
  const c=config(); c.clients.requiredFields=[];c.clients.sdiCountries=[];
  const storage=new LibSQLStore({id:'optional-skill',url:':memory:'});
  try {
    const {agent}=createOrderAgent(c,new DemoConnector(),storage);
    const skill=await agent.getSkill('customer-creation');
    expect(skill?.instructions).toContain('Additional required fields from this deployment: none');
    expect(skill?.instructions).toContain('SDI is required only for these country codes: none');
  }finally{await storage.close();}
});
