import { expect, it, vi } from 'vitest';
import { checkConnections, type HealthPorts } from '../src/health/check.js';
import { TelegramApi } from '../src/channels/telegram/api.js';
import { config } from './helpers.js';
function ports(): HealthPorts {
  return { telegram: async () => ({ member: true, canSend: true, polling: true }), company: async () => true,
    products: async () => [{ id: 900, name: 'Delivery', code: 'X', description: '', netPrice: 8 }], clients: async () => [],
    vat: async () => [{ id: 1, value: 22 }], payments: async () => [{ id: 2 }] };
}
it('reports manual checks honestly rather than claiming everything passed', async () => {
  const report = await checkConnections(config(), ports());
  expect(report.filter(c => c.status === 'fail')).toHaveLength(0);
  expect(report.find(c => c.name === 'Token scopes / API plan')?.status).toBe('manual');
  expect(report.find(c => c.name === 'LLM')?.status).toBe('manual');
});
it('detects shipping, VAT and payment mismatches independently', async () => {
  const c = config(); c.payments.methodId = 8;
  const p = ports(); p.products = async () => []; p.vat = async () => [{ id: 1, value: 10 }];
  const report = await checkConnections(c, p);
  expect(report.filter(r => r.status === 'fail').map(r => r.name)).toEqual(['Catalogue and shipping', 'VAT mappings', 'Payment method']);
});
it('does not leak authenticated SDK errors into a report', async () => {
  const p = ports(); p.company = async () => { throw new Error('Bearer top-secret'); };
  expect(JSON.stringify(await checkConnections(config(), p))).not.toContain('top-secret');
});
it('does not leak Telegram token or upstream error details', async () => {
  const api = new TelegramApi('top-secret', vi.fn().mockRejectedValue(new Error('https://api.telegram.org/bottop-secret/getMe')));
  await expect(api.getMe()).rejects.toThrow('Telegram getMe failed');
  await expect(api.getMe()).rejects.not.toThrow('top-secret');
});
it('uses only read operations for Telegram diagnostics', async () => {
  const calls: string[] = [];
  const api = new TelegramApi('fake', (async url => {
    calls.push(String(url).split('/').at(-1)!);
    return new Response(JSON.stringify({ ok: true, result: {} }));
  }) as typeof fetch);
  await api.getMe(); await api.getChat('-1'); await api.getChatMember('-1', 1); await api.getWebhookInfo();
  expect(calls).toEqual(['getMe', 'getChat', 'getChatMember', 'getWebhookInfo']);
});
it('sends a document attachment only when explicitly invoked and rejects non-HTTPS URLs', async () => {
  const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { message_id: 10 } })));
  const api = new TelegramApi('fake', request);
  await expect(api.sendOrderPdf('-1', 'https://example.invalid/order.pdf', 'Order')).resolves.toEqual({ message_id: 10 });
  const payload = JSON.parse(request.mock.calls[0]![1].body);
  expect(payload).toEqual({ chat_id: '-1', document: 'https://example.invalid/order.pdf', caption: 'Order' });
  expect(() => api.sendOrderPdf('-1', 'http://example.invalid/order.pdf', 'Order')).toThrow();
});
it('fails Telegram readiness when another webhook is configured', async () => {
  const p = ports(); p.telegram = async () => ({ member: true, canSend: true, polling: false });
  expect((await checkConnections(config(), p))[0]?.status).toBe('fail');
});
