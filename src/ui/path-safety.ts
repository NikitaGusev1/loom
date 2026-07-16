import { existsSync, lstatSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const assertContainedArtifactPath = (rootPath: string, artifactPath: string): void => {
  const root = resolve(rootPath);
  const target = resolve(artifactPath);
  const relativePath = relative(root, target);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error('Intake artifact path escapes project');
  }

  let current = root;
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error('Intake artifact path crosses a symbolic link');
    }
  }
};
