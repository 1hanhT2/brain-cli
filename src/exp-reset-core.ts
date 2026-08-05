export interface ExpResetTaskTarget {
  path: string;
  title: string;
}

export interface ExpResetOutcome {
  tasks: number;
  artifacts: number;
  skippedTasks: string[];
}

export const isExpResetArtifactType = (value: unknown): boolean =>
  value === "exp-entry" || value === "exp-goal";

export const runExpReset = async (
  taskTargets: ExpResetTaskTarget[],
  artifactPaths: string[],
  clearTask: (target: ExpResetTaskTarget) => Promise<void>,
  trashArtifact: (path: string) => Promise<void>
): Promise<ExpResetOutcome> => {
  const skippedTasks: string[] = [];
  let tasks = 0;
  for (const target of taskTargets) {
    try {
      await clearTask(target);
      tasks += 1;
    } catch {
      skippedTasks.push(target.path);
    }
  }
  if (skippedTasks.length > 0) return { tasks, artifacts: 0, skippedTasks };
  for (const path of artifactPaths) await trashArtifact(path);
  return { tasks, artifacts: artifactPaths.length, skippedTasks };
};
