import type { AppConfig } from '../config/schema.js';
import type { MessageEvent, ParsedCallback } from './contract.js';

/** What the conversation core needs from the installed channel. The runner installs one. */
export type ChannelInbound = {
  parseMessage(update: unknown, config: AppConfig): MessageEvent | null;
  parseCallback(update: unknown, config: AppConfig): ParsedCallback | undefined;
  threadTitle: string;
};

let current: ChannelInbound | undefined;

export function installInbound(inbound: ChannelInbound) {
  current = inbound;
}

export function inboundOf(): ChannelInbound {
  if (!current) throw new Error('No messaging channel is installed. The process entrypoint must install one before handling updates.');
  return current;
}
