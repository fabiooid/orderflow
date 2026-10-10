import { open, readFile, unlink } from 'node:fs/promises';
/** One poller per local deployment. A crashed process's stale lock can be removed safely. */
export async function acquirePollerLock(path: string): Promise<() => Promise<void>> {
  try {
    const file = await open(path, 'wx', 0o600);
    await file.writeFile(String(process.pid)); await file.close();
    return async () => { await unlink(path); };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = Number(await readFile(path, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid poller lock; inspect it before starting');
    try { process.kill(pid, 0); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('Cannot verify existing poller lock');
      await unlink(path); return acquirePollerLock(path);
    }
    throw new Error('A Telegram poller is already running for this deployment');
  }
}
