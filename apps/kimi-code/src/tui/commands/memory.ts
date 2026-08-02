import type { SlashCommandHost } from './dispatch';

const MEMORY_STATUS_NOTICE = [
  'The persistent-memory core is enabled for this session.',
  '',
  'The agent may use memory automatically or through its Memory tool,',
  'according to the active persistent-memory flags.',
  '',
  'Interactive memory management (CRUD) is not available in this version.',
].join('\n');

const MEMORY_ARGUMENT_NOTICE =
  'Memory subcommands and arguments are not supported in this version. Use /memory without arguments for status.';

export function handleMemoryCommand(host: SlashCommandHost, args: string): void {
  host.showNotice(
    'Persistent memory',
    args.trim().length === 0 ? MEMORY_STATUS_NOTICE : MEMORY_ARGUMENT_NOTICE,
  );
}
