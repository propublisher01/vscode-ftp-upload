import * as vscode from "vscode";
import { FtpManager } from "./ftpManager";
import { loadConfig } from "./config";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export class RemoteItem extends vscode.TreeItem {
  constructor(
    public readonly folder: vscode.WorkspaceFolder,
    public readonly remotePath: string,
    label: string,
    public readonly isDirectory: boolean,
    size?: number
  ) {
    super(
      label,
      isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    this.contextValue = isDirectory ? "ftpFolder" : "ftpFile";
    this.iconPath = new vscode.ThemeIcon(isDirectory ? "folder" : "file");
    this.tooltip = remotePath;

    if (!isDirectory) {
      this.description = size !== undefined ? formatSize(size) : undefined;
      this.command = {
        command: "ftpUpload.openRemoteFile",
        title: "Open (read-only)",
        arguments: [this],
      };
    }
  }
}

export class RemoteFilesProvider
  implements vscode.TreeDataProvider<RemoteItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    RemoteItem | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private getManager: (
      folder: vscode.WorkspaceFolder
    ) => FtpManager | null
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: RemoteItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: RemoteItem): Promise<RemoteItem[]> {
    // Root level: one node per workspace folder that has an FTP config.
    if (!element) {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const items: RemoteItem[] = [];

      for (const folder of folders) {
        const config = loadConfig(folder);
        if (!config) continue;
        items.push(
          new RemoteItem(folder, config.remoteRoot, folder.name, true)
        );
      }
      return items;
    }

    const manager = this.getManager(element.folder);
    if (!manager) return [];

    try {
      const entries = await manager.listDirectory(element.remotePath);
      return entries
        .sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .map((entry) => {
          const childPath =
            element.remotePath.replace(/\/$/, "") + "/" + entry.name;
          return new RemoteItem(
            element.folder,
            childPath,
            entry.name,
            entry.isDirectory,
            entry.size
          );
        });
    } catch (err) {
      vscode.window.showErrorMessage(
        `FTP: could not list "${element.remotePath}" — ${err}`
      );
      return [];
    }
  }
}
