import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { loadConfig, resetPassword, getPassword, saveConfig, configFilePath, FtpSyncConfig } from "./config";
import { RemoteFilesProvider, RemoteItem } from "./remoteTree";
import { FtpManager, OperationCancelledError } from "./ftpManager";
import { confirmSafeToUpload } from "./deploySafe";

// One FtpManager instance per workspace folder — useful when several
// projects with different configs/servers are open together.
const managers = new Map<string, FtpManager>();

// Session-only override of "uploadOnSave", set by the "Toggle Auto-Upload on
// Save" command. Takes precedence over ftp-sync.json without ever writing to
// it (that file is meant to be committed). Keyed by workspace folder URI.
const autoUploadOverride = new Map<string, boolean>();

// Reference assigned in activate() — lets getManager() wire up refreshing
// the remote view after every successful upload.
let remoteProviderRef: RemoteFilesProvider | undefined;

function getManager(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder
): FtpManager | null {
  const key = folder.uri.toString();
  let manager = managers.get(key);

  const config = loadConfig(folder);
  if (!config) {
    return null;
  }

  if (!manager) {
    manager = new FtpManager(context, folder, config, () =>
      remoteProviderRef?.refresh()
    );
    managers.set(key, manager);
  } else {
    manager.updateConfig(config);
  }

  return manager;
}

// Asks the user which folder(s) to target when the workspace has several
// (multi-root). Returns null if cancelled.
async function pickTargetFolders(): Promise<
  vscode.WorkspaceFolder[] | null
> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showWarningMessage(vscode.l10n.t("No workspace open."));
    return null;
  }

  if (folders.length === 1) {
    return [folders[0]];
  }

  const ALL = vscode.l10n.t("All folders");
  const pick = await vscode.window.showQuickPick(
    [ALL, ...folders.map((f) => f.name)],
    { placeHolder: vscode.l10n.t("Which folder to sync?") }
  );

  if (!pick) return null; // cancelled (Esc)
  if (pick === ALL) return [...folders];

  const chosen = folders.find((f) => f.name === pick);
  return chosen ? [chosen] : null;
}

export function activate(context: vscode.ExtensionContext) {
  // "FTP: Remote Files" view in the explorer — browses the server
  // without mounting it as a real filesystem (the model stays local +
  // upload).
  const remoteProvider = new RemoteFilesProvider((folder) =>
    getManager(context, folder)
  );
  remoteProviderRef = remoteProvider;
  context.subscriptions.push(
    vscode.window.createTreeView("ftpUpload.remoteFiles", {
      treeDataProvider: remoteProvider,
      canSelectMany: true,
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ftpUpload.refreshRemoteFiles", () =>
      remoteProvider.refresh()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ftpUpload.openRemoteFile",
      async (item?: RemoteItem) => {
        if (!item) {
          vscode.window.showInformationMessage(
            vscode.l10n.t(
              "FTP: click a file in the \"FTP Remote Files\" view to open it."
            )
          );
          return;
        }

        const manager = getManager(context, item.folder);
        if (!manager) return;

        try {
          const localPath = await manager.downloadToTemp(item.remotePath);
          const doc = await vscode.workspace.openTextDocument(localPath);
          await vscode.window.showTextDocument(doc, { preview: true });
          vscode.window.setStatusBarMessage(
            vscode.l10n.t(
              "FTP: read-only temporary copy — changes won't be re-uploaded"
            ),
            6000
          );
        } catch (err) {
          vscode.window.showErrorMessage(
            vscode.l10n.t(
              "FTP: could not open \"{0}\" — {1}",
              item.remotePath,
              String(err)
            )
          );
        }
      }
    )
  );

  // "Download" action — downloads to the matching local path (via the
  // config's remoteRoot/localRoot mapping), not to a temp file. The 2nd
  // argument (items) is provided by VSCode when several items are
  // selected in the view.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ftpUpload.downloadRemote",
      async (item?: RemoteItem, items?: RemoteItem[]) => {
        const targets = items && items.length > 0 ? items : item ? [item] : [];
        if (targets.length === 0) return;

        const config = loadConfig(targets[0].folder);
        const manager = getManager(context, targets[0].folder);
        if (!manager || !config) return;

        // Resolves each target's local path and checks for overwrites.
        const resolved = targets.map((t) => {
          const relative = path.posix.relative(config.remoteRoot, t.remotePath);
          const localPath = path.join(
            t.folder.uri.fsPath,
            config.localRoot,
            relative
          );
          return { item: t, relative, localPath };
        });

        const willOverwrite = resolved.some((r) => fs.existsSync(r.localPath));
        if (willOverwrite) {
          // For a single file that already exists locally, refine the
          // message with a date comparison (clock-skew adjusted) rather
          // than a generic warning.
          let label = vscode.l10n.t("{0} item(s)", resolved.length);
          if (resolved.length === 1 && !resolved[0].item.isDirectory) {
            const { conflict } = await manager.checkDownloadConflict(
              resolved[0].localPath,
              resolved[0].item.remotePath
            );
            label = conflict
              ? vscode.l10n.t(
                  "\"{0}\" (your local copy looks newer than the remote version — you will lose these changes)",
                  resolved[0].relative
                )
              : `"${resolved[0].relative}"`;
          } else if (resolved.length === 1) {
            label = `"${resolved[0].relative}"`;
          }

          const downloadLabel = vscode.l10n.t("Download");
          const confirm = await vscode.window.showWarningMessage(
            vscode.l10n.t("Overwrite {0} locally with the remote version?", label),
            { modal: true },
            downloadLabel
          );
          if (confirm !== downloadLabel) return;
        }

        const failed: string[] = [];

        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: vscode.l10n.t("FTP: downloading ({0} item(s))", resolved.length),
              cancellable: true,
            },
            async (progress, token) => {
              for (let i = 0; i < resolved.length; i++) {
                if (token.isCancellationRequested) {
                  throw new OperationCancelledError();
                }
                const { item: t, relative, localPath } = resolved[i];

                try {
                  if (t.isDirectory) {
                    let count = 0;
                    await manager.downloadDirectoryTo(
                      t.remotePath,
                      localPath,
                      (fileName) => {
                        count++;
                        progress.report({
                          message: vscode.l10n.t(
                            "[{0}/{1}] {2} — {3} file(s) — {4}",
                            i + 1,
                            resolved.length,
                            relative,
                            count,
                            fileName
                          ),
                        });
                      },
                      token,
                      (fileName, err) => failed.push(`${relative}/${fileName} (${err})`)
                    );
                  } else {
                    progress.report({
                      message: vscode.l10n.t(
                        "[{0}/{1}] {2}",
                        i + 1,
                        resolved.length,
                        relative
                      ),
                    });
                    await manager.downloadFileTo(t.remotePath, localPath);
                  }
                } catch (err) {
                  if (err instanceof OperationCancelledError) throw err;
                  failed.push(`${relative} (${err})`);
                }
              }
            }
          );

          if (failed.length > 0) {
            const list =
              failed.length <= 5
                ? failed.join(", ")
                : vscode.l10n.t(
                    "{0}, +{1} more",
                    failed.slice(0, 5).join(", "),
                    failed.length - 5
                  );
            vscode.window.showWarningMessage(
              vscode.l10n.t(
                "FTP: download finished, but {0} file(s) failed: {1}",
                failed.length,
                list
              )
            );
          } else {
            vscode.window.showInformationMessage(
              vscode.l10n.t("FTP: {0} item(s) downloaded.", resolved.length)
            );
          }
        } catch (err) {
          if (err instanceof OperationCancelledError) {
            vscode.window.showInformationMessage(
              vscode.l10n.t("FTP: download cancelled.")
            );
          } else {
            vscode.window.showErrorMessage(
              vscode.l10n.t("FTP: download failed — {0}", String(err))
            );
          }
        }
      }
    )
  );

  // "Delete" action — irreversible, confirmation dialog required.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ftpUpload.deleteRemote",
      async (item?: RemoteItem, items?: RemoteItem[]) => {
        const targets = items && items.length > 0 ? items : item ? [item] : [];
        if (targets.length === 0) return;

        const manager = getManager(context, targets[0].folder);
        if (!manager) return;

        const label =
          targets.length === 1
            ? targets[0].isDirectory
              ? vscode.l10n.t("the remote folder \"{0}\"", targets[0].remotePath)
              : vscode.l10n.t("the remote file \"{0}\"", targets[0].remotePath)
            : vscode.l10n.t("{0} selected remote items", targets.length);

        const deleteLabel = vscode.l10n.t("Delete");
        const confirm = await vscode.window.showWarningMessage(
          vscode.l10n.t(
            "Permanently delete {0}? This action cannot be undone.",
            label
          ),
          { modal: true },
          deleteLabel
        );
        if (confirm !== deleteLabel) return;

        let deleted = 0;
        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: vscode.l10n.t("FTP: deleting ({0} item(s))", targets.length),
              cancellable: true,
            },
            async (progress, token) => {
              for (const t of targets) {
                if (token.isCancellationRequested) {
                  throw new OperationCancelledError();
                }
                progress.report({
                  message: vscode.l10n.t(
                    "[{0}/{1}] {2}",
                    deleted + 1,
                    targets.length,
                    t.remotePath
                  ),
                });
                if (t.isDirectory) {
                  await manager.deleteDirectory(t.remotePath);
                } else {
                  await manager.deleteFile(t.remotePath);
                }
                deleted++;
              }
            }
          );
          remoteProvider.refresh();
          vscode.window.showInformationMessage(
            vscode.l10n.t("FTP: {0} item(s) deleted.", deleted)
          );
        } catch (err) {
          remoteProvider.refresh();
          if (err instanceof OperationCancelledError) {
            vscode.window.showInformationMessage(
              vscode.l10n.t(
                "FTP: deletion cancelled ({0} item(s) already deleted).",
                deleted
              )
            );
          } else {
            vscode.window.showErrorMessage(
              vscode.l10n.t("FTP: deletion failed — {0}", String(err))
            );
          }
        }
      }
    )
  );

  // Right-click on a LOCAL file/folder → downloads the matching version
  // from the server, overwriting local content.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ftpUpload.downloadFromServer",
      async (clickedUri?: vscode.Uri) => {
        if (!clickedUri) return;

        const folder = vscode.workspace.getWorkspaceFolder(clickedUri);
        if (!folder) return;

        const config = loadConfig(folder);
        const manager = getManager(context, folder);
        if (!config || !manager) {
          vscode.window.showWarningMessage(
            vscode.l10n.t("FTP: no ftp-sync.json config in \"{0}\".", folder.name)
          );
          return;
        }

        const localRootPath = path.join(folder.uri.fsPath, config.localRoot);
        const relative = path
          .relative(localRootPath, clickedUri.fsPath)
          .split(path.sep)
          .join("/");
        const remotePath =
          config.remoteRoot.replace(/\/$/, "") + "/" + relative;

        const isDirectory = fs.statSync(clickedUri.fsPath).isDirectory();

        let warningMessage = vscode.l10n.t(
          "Overwrite \"{0}\" locally with the server version? Local changes not yet uploaded will be lost.",
          relative
        );
        if (!isDirectory) {
          const { conflict } = await manager.checkDownloadConflict(
            clickedUri.fsPath,
            remotePath
          );
          if (conflict) {
            warningMessage = vscode.l10n.t(
              "Your local copy of \"{0}\" looks newer than the remote version — downloading will overwrite these local changes. Continue?",
              relative
            );
          }
        }

        const downloadLabel = vscode.l10n.t("Download");
        const confirm = await vscode.window.showWarningMessage(
          warningMessage,
          { modal: true },
          downloadLabel
        );
        if (confirm !== downloadLabel) return;

        const failed: string[] = [];

        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: vscode.l10n.t("FTP: downloading \"{0}\"", relative),
              cancellable: true,
            },
            async (progress, token) => {
              if (isDirectory) {
                let count = 0;
                await manager.downloadDirectoryTo(
                  remotePath,
                  clickedUri.fsPath,
                  (fileName) => {
                    count++;
                    progress.report({
                      message: vscode.l10n.t("{0} file(s) — {1}", count, fileName),
                    });
                  },
                  token,
                  (fileName, err) => failed.push(`${fileName} (${err})`)
                );
              } else {
                await manager.downloadFileTo(remotePath, clickedUri.fsPath);
              }
            }
          );

          if (failed.length > 0) {
            const list =
              failed.length <= 5
                ? failed.join(", ")
                : vscode.l10n.t(
                    "{0}, +{1} more",
                    failed.slice(0, 5).join(", "),
                    failed.length - 5
                  );
            vscode.window.showWarningMessage(
              vscode.l10n.t(
                "FTP: download finished, but {0} file(s) failed: {1}",
                failed.length,
                list
              )
            );
          } else {
            vscode.window.showInformationMessage(
              vscode.l10n.t("FTP: \"{0}\" downloaded from server.", relative)
            );
          }
        } catch (err) {
          if (err instanceof OperationCancelledError) {
            vscode.window.showInformationMessage(
              vscode.l10n.t("FTP: download cancelled.")
            );
          } else {
            vscode.window.showErrorMessage(
              vscode.l10n.t("FTP: download failed — {0}", String(err))
            );
          }
        }
      }
    )
  );

  // Right-click on a LOCAL file/folder → manual upload to the server
  // (independent from auto-upload on save). Supports explorer multi-
  // selection (VSCode then passes an array of URIs).
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ftpUpload.uploadToServer",
      async (clickedUri?: vscode.Uri, uris?: vscode.Uri[]) => {
        const targets = uris && uris.length > 0 ? uris : clickedUri ? [clickedUri] : [];
        if (targets.length === 0) return;

        // Groups by workspace folder — rare in practice but possible if
        // the selection spans multiple folders of a multi-root workspace.
        const byFolder = new Map<
          string,
          { folder: vscode.WorkspaceFolder; uris: vscode.Uri[] }
        >();
        for (const uri of targets) {
          const folder = vscode.workspace.getWorkspaceFolder(uri);
          if (!folder) continue;
          const key = folder.uri.toString();
          if (!byFolder.has(key)) byFolder.set(key, { folder, uris: [] });
          byFolder.get(key)!.uris.push(uri);
        }
        if (byFolder.size === 0) return;

        const conflicts: string[] = [];

        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: vscode.l10n.t("FTP: uploading ({0} item(s))", targets.length),
              cancellable: true,
            },
            async (progress, token) => {
              let count = 0;
              for (const { folder, uris: folderUris } of byFolder.values()) {
                const manager = getManager(context, folder);
                if (!manager) continue;

                for (const uri of folderUris) {
                  if (token.isCancellationRequested) {
                    throw new OperationCancelledError();
                  }
                  await manager.uploadPath(
                    uri.fsPath,
                    (fileName) => {
                      count++;
                      progress.report({
                        message: vscode.l10n.t("{0} file(s) — {1}", count, fileName),
                      });
                    },
                    token,
                    (fileName) => conflicts.push(fileName)
                  );
                }
              }
            }
          );

          if (conflicts.length > 0) {
            const list =
              conflicts.length <= 5
                ? conflicts.join(", ")
                : vscode.l10n.t(
                    "{0}, +{1} more",
                    conflicts.slice(0, 5).join(", "),
                    conflicts.length - 5
                  );
            vscode.window.showWarningMessage(
              vscode.l10n.t(
                "FTP: upload finished, but {0} file(s) skipped because they are newer on the server: {1}",
                conflicts.length,
                list
              )
            );
          } else {
            vscode.window.showInformationMessage(
              vscode.l10n.t("FTP: upload finished.")
            );
          }
          remoteProvider.refresh();
        } catch (err) {
          if (err instanceof OperationCancelledError) {
            vscode.window.showInformationMessage(
              vscode.l10n.t("FTP: upload cancelled.")
            );
          } else {
            vscode.window.showErrorMessage(
              vscode.l10n.t("FTP: upload failed — {0}", String(err))
            );
          }
        }
      }
    )
  );

  // Auto-upload on save
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      const folder = vscode.workspace.getWorkspaceFolder(document.uri);
      if (!folder) return;

      const config = loadConfig(folder);
      if (!config) return;
      const autoUploadEnabled =
        autoUploadOverride.get(folder.uri.toString()) ?? config.uploadOnSave;
      if (!autoUploadEnabled) return;

      if (config.scanBeforeUpload) {
        const relative = path.relative(folder.uri.fsPath, document.uri.fsPath);
        const proceed = await confirmSafeToUpload(document.uri.fsPath, relative);
        if (!proceed) {
          vscode.window.setStatusBarMessage(
            vscode.l10n.t("FTP: upload of \"{0}\" skipped.", relative),
            5000
          );
          return;
        }
      }

      const manager = getManager(context, folder);
      manager?.enqueueUpload(document.uri.fsPath);
    })
  );

  // Status bar reminder shown while auto-upload is paused via the toggle
  // command — an in-memory override is easy to forget, so keep it visible.
  const pausedIndicator = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    99
  );
  pausedIndicator.text = vscode.l10n.t("$(circle-slash) FTP: auto-upload off");
  pausedIndicator.tooltip = vscode.l10n.t("Click to re-enable auto-upload on save");
  pausedIndicator.command = "ftpUpload.toggleAutoUpload";
  context.subscriptions.push(pausedIndicator);

  const updatePausedIndicator = () => {
    if ([...autoUploadOverride.values()].some((enabled) => !enabled)) {
      pausedIndicator.show();
    } else {
      pausedIndicator.hide();
    }
  };

  // Command: toggle auto-upload on save for this session, without touching
  // ftp-sync.json. Wins over the file's "uploadOnSave" until VS Code closes.
  context.subscriptions.push(
    vscode.commands.registerCommand("ftpUpload.toggleAutoUpload", async () => {
      const folders = await pickTargetFolders();
      if (!folders) return;

      for (const folder of folders) {
        const config = loadConfig(folder);
        if (!config) {
          vscode.window.showWarningMessage(
            vscode.l10n.t("FTP: no ftp-sync.json config in \"{0}\".", folder.name)
          );
          continue;
        }

        const key = folder.uri.toString();
        const enabled = !(autoUploadOverride.get(key) ?? config.uploadOnSave);
        autoUploadOverride.set(key, enabled);

        vscode.window.showInformationMessage(
          enabled
            ? vscode.l10n.t(
                "FTP [{0}]: auto-upload on save enabled (until VS Code is closed).",
                folder.name
              )
            : vscode.l10n.t(
                "FTP [{0}]: auto-upload on save paused (until VS Code is closed).",
                folder.name
              )
        );
      }
      updatePausedIndicator();
    })
  );

  // Command: full sync — for a chosen folder, or all at once if the
  // workspace has several.
  context.subscriptions.push(
    vscode.commands.registerCommand("ftpUpload.syncAll", async () => {
      const folders = await pickTargetFolders();
      if (!folders) return;

      for (const folder of folders) {
        const manager = getManager(context, folder);
        if (!manager) {
          vscode.window.showWarningMessage(
            vscode.l10n.t(
              "FTP: no ftp-sync.json config in \"{0}\", skipped.",
              folder.name
            )
          );
          continue;
        }

        const files = await vscode.workspace.findFiles(
          new vscode.RelativePattern(folder, "**/*"),
          "{**/node_modules/**,**/.git/**}"
        );
        await manager.syncAll(files.map((f) => f.fsPath));
        vscode.window.showInformationMessage(
          vscode.l10n.t(
            "FTP [{0}]: {1} file(s) queued for upload.",
            folder.name,
            files.length
          )
        );
      }
    })
  );

  // Command: test connection — for a chosen folder, or all
  context.subscriptions.push(
    vscode.commands.registerCommand("ftpUpload.testConnection", async () => {
      const folders = await pickTargetFolders();
      if (!folders) return;

      for (const folder of folders) {
        const manager = getManager(context, folder);
        if (!manager) {
          vscode.window.showWarningMessage(
            vscode.l10n.t("FTP: no ftp-sync.json config in \"{0}\".", folder.name)
          );
          continue;
        }
        await manager.testConnection();
      }
    })
  );

  // Command: reset password (e.g. after a change server-side) — clears
  // the stored secret, asks for a new one, then forces a reconnect to
  // verify it works.
  context.subscriptions.push(
    vscode.commands.registerCommand("ftpUpload.resetPassword", async () => {
      const folders = await pickTargetFolders();
      if (!folders) return;

      for (const folder of folders) {
        await resetPassword(context, folder);

        const config = loadConfig(folder);
        if (!config) {
          vscode.window.showWarningMessage(
            vscode.l10n.t("FTP: no ftp-sync.json config in \"{0}\".", folder.name)
          );
          continue;
        }

        // Asks for the new password right away instead of waiting for
        // the next save.
        const pw = await getPassword(context, folder);
        if (!pw) continue;

        const manager = getManager(context, folder);
        const ok = await manager?.testConnection();
        if (ok) {
          vscode.window.showInformationMessage(
            vscode.l10n.t("FTP [{0}]: new password saved.", folder.name)
          );
        }
      }
    })
  );

  // Command: right-click a folder → FTP config wizard. The click can be
  // on any subfolder; we find the enclosing workspace folder, since
  // that's where ftp-sync.json lives.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ftpUpload.configureFolder",
      async (clickedUri?: vscode.Uri) => {
        const folder = clickedUri
          ? vscode.workspace.getWorkspaceFolder(clickedUri)
          : vscode.workspace.workspaceFolders?.[0];

        if (!folder) {
          vscode.window.showWarningMessage(
            vscode.l10n.t("This folder isn't part of an open workspace.")
          );
          return;
        }

        const existing = loadConfig(folder);

        const host = await vscode.window.showInputBox({
          prompt: vscode.l10n.t("FTP host for \"{0}\"", folder.name),
          value: existing?.host ?? "",
          ignoreFocusOut: true,
        });
        if (!host) return; // cancelled

        const portStr = await vscode.window.showInputBox({
          prompt: vscode.l10n.t("Port"),
          value: String(existing?.port ?? 21),
          ignoreFocusOut: true,
        });
        if (!portStr) return;

        const ftpsLabel = vscode.l10n.t("FTPS (secure)");
        const securePick = await vscode.window.showQuickPick(
          [ftpsLabel, vscode.l10n.t("FTP (insecure)")],
          { placeHolder: vscode.l10n.t("Connection type"), ignoreFocusOut: true }
        );
        if (!securePick) return;

        const user = await vscode.window.showInputBox({
          prompt: vscode.l10n.t("FTP username"),
          value: existing?.user ?? "",
          ignoreFocusOut: true,
        });
        if (!user) return;

        // remoteRoot is pre-filled from the clicked folder, relative to
        // the workspace folder root — handy when clicking directly on a
        // subfolder to sync.
        const suggestedRemote =
          clickedUri && clickedUri.fsPath !== folder.uri.fsPath
            ? "/" +
              path
                .relative(folder.uri.fsPath, clickedUri.fsPath)
                .split(path.sep)
                .join("/")
            : existing?.remoteRoot ?? "/";

        const remoteRoot = await vscode.window.showInputBox({
          prompt: vscode.l10n.t("Remote root folder"),
          value: suggestedRemote,
          ignoreFocusOut: true,
        });
        if (!remoteRoot) return;

        const config: FtpSyncConfig = {
          host,
          port: parseInt(portStr, 10) || 21,
          secure: securePick === ftpsLabel,
          user,
          localRoot: existing?.localRoot ?? ".",
          remoteRoot,
          ignore: existing?.ignore ?? [".git/**", "node_modules/**", ".vscode/**"],
          uploadOnSave: existing?.uploadOnSave ?? true,
          scanBeforeUpload: existing?.scanBeforeUpload ?? true,
          checkRemoteModifiedTime: existing?.checkRemoteModifiedTime ?? true,
          clockToleranceSeconds: existing?.clockToleranceSeconds ?? 5,
        };

        saveConfig(folder, config);

        // Only re-prompts for the password if host/user changed, to
        // avoid unnecessary prompts on a simple edit.
        if (!existing || existing.host !== host || existing.user !== user) {
          await resetPassword(context, folder);
          await getPassword(context, folder);
        }

        const manager = getManager(context, folder);
        const ok = await manager?.testConnection();

        if (ok) {
          const doc = await vscode.workspace.openTextDocument(
            configFilePath(folder)
          );
          await vscode.window.showTextDocument(doc);
        }
      }
    )
  );
}

export function deactivate() {
  for (const manager of managers.values()) {
    manager.dispose();
  }
  managers.clear();
}
