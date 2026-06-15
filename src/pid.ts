// ---------------------------------------------------------------------------
// PID liveness probe — shared by semaphore.ts (reclaim) and slots-status.ts (scan).
// ---------------------------------------------------------------------------
//
// process.kill(pid, 0) sends no signal; it only probes existence. ESRCH means the
// process is gone; EPERM (or any other error) means it exists but we can't signal
// it — still alive. A pid <= 0 targets a *process group* in kill(2), and a
// non-integer is meaningless, so a slot/lock file carrying such a value is a
// corrupt claim: treated as dead, never probed.

export const isPidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};
