export interface WriterLane {
  /** Run `fn` after every previously-enqueued land has settled. */
  enqueue: <T>(fn: () => Promise<T>) => Promise<T>;
}

export const createWriterLane = (): WriterLane => {
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  return { enqueue };
};

export type LandStatus = 'merged' | 'base-moved' | 'conflict';

export interface LandResult {
  status: LandStatus;
  newSha?: string;
  conflict?: string;
}

export interface LandWorktreeDeps {
  verifyBaseUnchanged: (baseBranch: string, baseCommitSha: string) => Promise<boolean>;
  mergeWorktrees: (
    taskIds: string[],
    onMerged: (taskId: string) => void,
  ) => Promise<{ success: boolean; failedAt?: string; conflict?: string }>;
  currentHeadSha: () => Promise<string>;
}

export interface LandWorktreeArgs {
  taskId: string;
  baseBranch: string;
  baseCommitSha: string;
  onMerged: (taskId: string) => void;
  deps: LandWorktreeDeps;
}

export const landWorktree = async ({
  taskId,
  baseBranch,
  baseCommitSha,
  onMerged,
  deps,
}: LandWorktreeArgs): Promise<LandResult> => {
  const unchanged = await deps.verifyBaseUnchanged(baseBranch, baseCommitSha);
  if (!unchanged) return { status: 'base-moved' };

  const merge = await deps.mergeWorktrees([taskId], onMerged);
  if (!merge.success) return { status: 'conflict', conflict: merge.conflict };

  return { status: 'merged', newSha: await deps.currentHeadSha() };
};
