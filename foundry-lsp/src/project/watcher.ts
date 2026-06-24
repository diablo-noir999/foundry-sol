import * as chokidar from 'chokidar';
import * as path from 'path';
import { pathToFileURL } from 'url';

export interface FileWatcher {
  onDidChangeSol: (callback: (uri: string) => void) => void;
  onDidChangeConfig: (callback: () => void) => void;
  dispose: () => void;
}

export function createWatcher(projectRoot: string): FileWatcher {
  const solCallbacks: ((uri: string) => void)[] = [];
  const configCallbacks: (() => void)[] = [];

  const watcher = chokidar.watch(
    [
      path.join(projectRoot, 'foundry.toml'),
      path.join(projectRoot, 'remappings.txt'),
      path.join(projectRoot, 'src', '**', '*.sol'),
      path.join(projectRoot, 'test', '**', '*.sol'),
      path.join(projectRoot, 'script', '**', '*.sol'),
      path.join(projectRoot, 'lib', '**', '*.sol'),
    ],
    {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      ignored: ['**/node_modules/**', '**/out/**', '**/.git/**'],
    }
  );

  watcher.on('change', (filePath: string) => {
    const basename = path.basename(filePath);
    if (basename === 'foundry.toml' || basename === 'remappings.txt') {
      for (const cb of configCallbacks) cb();
    } else if (filePath.endsWith('.sol')) {
      const uri = pathToFileURL(filePath).href;
      for (const cb of solCallbacks) cb(uri);
    }
  });

  return {
    onDidChangeSol(cb) {
      solCallbacks.push(cb);
    },
    onDidChangeConfig(cb) {
      configCallbacks.push(cb);
    },
    dispose() {
      watcher.close();
    },
  };
}
