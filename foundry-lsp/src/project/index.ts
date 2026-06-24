import * as path from 'path';
import * as fs from 'fs';
import { WorkspaceFolder } from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { parseFoundryToml, FoundryConfig } from './foundry';
export type { FoundryConfig } from './foundry';
import { loadRemappings } from './remappings';
import { findSolFiles } from './workspace';
import { createWatcher, FileWatcher } from './watcher';

export interface FoundryProject {
  root: string;
  config: FoundryConfig;
  remappings: Map<string, string>;
  solFiles: Set<string>;
}

export class ProjectManager {
  private projects = new Map<string, FoundryProject>();
  private watchers = new Map<string, FileWatcher>();
  private workspaceFolders: string[] = [];

  init(workspaceFolders: WorkspaceFolder[] | null): void {
    if (!workspaceFolders) return;

    for (const folder of workspaceFolders) {
      const root = URI.parse(folder.uri).fsPath;
      this.workspaceFolders.push(root);
      // Search for foundry.toml upward from workspace root
      const projectRoot = this.findProjectRoot(root);
      this.loadProject(projectRoot);
    }
  }

  private findProjectRoot(startDir: string): string {
    // First search upward for foundry.toml
    let dir = startDir;
    while (true) {
      if (fs.existsSync(path.join(dir, 'foundry.toml'))) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    // If not found upward, search immediate children (one level deep)
    try {
      const entries = fs.readdirSync(startDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          const childDir = path.join(startDir, entry.name);
          if (fs.existsSync(path.join(childDir, 'foundry.toml'))) {
            return childDir;
          }
        }
      }
    } catch {}

    return startDir; // fallback to workspace root
  }

  getProject(uri: string): FoundryProject | undefined {
    const docUri = URI.parse(uri);
    const filePath = docUri.fsPath;

    for (const [, project] of this.projects) {
      if (filePath.startsWith(project.root)) {
        return project;
      }
    }

    return undefined;
  }

  private loadProject(root: string): FoundryProject {
    const config = parseFoundryToml(root);
    const remappings = loadRemappings(root);

    const srcDir = path.join(root, config.src);
    const solFiles = findSolFiles(srcDir);

    // also index lib/ dirs
    for (const lib of config.libs) {
      const libDir = path.join(root, lib);
      for (const file of findSolFiles(libDir)) {
        solFiles.add(file);
      }
    }

    const project: FoundryProject = { root, config, remappings, solFiles };
    this.projects.set(root, project);

    const watcher = createWatcher(root);
    this.watchers.set(root, watcher);

    watcher.onDidChangeConfig(() => {
      this.reloadProject(root);
    });

    watcher.onDidChangeSol((uri) => {
      project.solFiles.add(uri);
    });

    return project;
  }

  private reloadProject(root: string): void {
    const existing = this.projects.get(root);
    if (!existing) return;

    existing.config = parseFoundryToml(root);
    existing.remappings = loadRemappings(root);

    const srcDir = path.join(root, existing.config.src);
    existing.solFiles = findSolFiles(srcDir);

    for (const lib of existing.config.libs) {
      const libDir = path.join(root, lib);
      for (const file of findSolFiles(libDir)) {
        existing.solFiles.add(file);
      }
    }
  }

  dispose(): void {
    for (const watcher of this.watchers.values()) {
      watcher.dispose();
    }
    this.watchers.clear();
    this.projects.clear();
  }
}

export const projectManager = new ProjectManager();
