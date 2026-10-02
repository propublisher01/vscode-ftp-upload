import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { Client, FileType } from "basic-ftp";
import { minimatch } from "minimatch";
import { FtpSyncConfig, getPassword, configFilePath } from "./config";

export interface RemoteEntry {
  name: string;
  isDirectory: boolean;
  size: number;
  modifiedAt?: Date;
}

interface QueuedUpload {
  localPath: string;
  remotePath: string;
}

export class OperationCancelledError extends Error {
  constructor() {
    super("Operation cancelled");
    this.name = "OperationCancelledError";
  }
}

export class FtpManager {
  private client: Client | null = null;
  private connecting: Promise<void> | null = null;
  private queue: QueuedUpload[] = [];
  private processing = false;
  private statusBar: vscode.StatusBarItem;

  // Estimated offset (server time - local time), in ms. Calibrated on
  // every upload by comparing Date.now() to the MDTM date the server
  // reports for the file we just sent. Avoids assuming both clocks are
  // in sync (often untrue in practice).
  private clockSkewMs: number | null = null;

  // Single chain through which ALL FTP commands go (upload, list,
  // download, delete...). basic-ftp only supports one command at a time
  // on a connection — without this, browsing the remote view while a
  // download is running crashes the client ("task while another one is
  // still running").
  private taskChain: Promise<unknown> = Promise.resolve();

  private exec<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const run = () => this.execWithRetry(fn);
    const result = this.taskChain.then(run, run);
    this.taskChain = result.catch(() => undefined);
    return result;
  }

  // Centralized retry + reconnect: covers ALL commands (list, download,
  // delete, upload), not just file downloads — an ECONNRESET can happen
  // on any command, including a LIST while browsing a large tree.
  private async execWithRetry<T>(
    fn: (client: Client) => Promise<T>,
    attempt = 1
  ): Promise<T> {
    try {
      const client = await this.ensureConnected();
      return await fn(client);
    } catch (err) {
      const retryable = this.isRetryableError(err);
      if (!retryable || attempt >= 3) {
        throw err;
      }

      // Force a clean reconnect before retrying — the basic-ftp client
      // doesn't always recover on its own from an ECONNRESET.
      this.client?.close();
      this.client = null;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      return this.execWithRetry(fn, attempt + 1);
    }
  }

  private isRetryableError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return /ECONNRESET|ETIMEDOUT|EPIPE|socket|closed/i.test(message);
  }

  constructor(
    private context: vscode.ExtensionContext,
    private workspaceFolder: vscode.WorkspaceFolder,
    private config: FtpSyncConfig,
    private onUploadComplete?: () => void
  ) {
    this.statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBar.text = "$(cloud) FTP";
    this.statusBar.show();
  }

  updateConfig(config: FtpSyncConfig) {
    this.config = config;
  }

  private isIgnored(relativePath: string): boolean {
    const normalized = relativePath.split(path.sep).join("/");

    // The config file itself is NEVER uploaded, even if the user's
    // "ignore" pattern is misconfigured (e.g. ".vscode" instead of
    // ".vscode/**", which doesn't match files inside it).
    const configRelative = path
      .relative(this.workspaceFolder.uri.fsPath, configFilePath(this.workspaceFolder))
      .split(path.sep)
      .join("/");
    if (normalized === configRelative) {
      return true;
    }

    return this.config.ignore.some((pattern) =>
      minimatch(normalized, pattern)
    );
  }

  // Persistent connection — reconnects when needed rather than opening a
  // new connection for every upload.
  private async ensureConnected(): Promise<Client> {
    if (this.client && !this.client.closed) {
      return this.client;
    }

    if (this.connecting) {
      await this.connecting;
      if (this.client && !this.client.closed) {
        return this.client;
      }
    }

    this.connecting = (async () => {
      const password = await getPassword(this.context, this.workspaceFolder);
      if (!password) {
        throw new Error(vscode.l10n.t("FTP password not provided"));
      }

      const client = new Client();
      client.ftp.verbose = false;

      await client.access({
        host: this.config.host,
        port: this.config.port,
        user: this.config.user,
        password,
        secure: this.config.secure,
      });

      this.client = client;
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }

    if (!this.client) {
      throw new Error(vscode.l10n.t("Could not connect to FTP server"));
    }
    return this.client;
  }

  // Entry point called from onDidSaveTextDocument. Queues rather than
  // uploading immediately, to absorb a burst "Save All".
  enqueueUpload(localPath: string) {
    const relative = path.relative(
      this.workspaceFolder.uri.fsPath,
      localPath
    );

    if (this.isIgnored(relative)) {
      return;
    }

    const remotePath = path
      .join(this.config.remoteRoot, relative)
      .split(path.sep)
      .join("/");

    this.queue.push({ localPath, remotePath });
    this.processQueue();
  }

  async syncAll(files: string[]) {
    for (const file of files) {
      this.enqueueUpload(file);
    }
  }

  private async processQueue() {
    if (this.processing) return;
    this.processing = true;

    // Simple concurrency limit: process one at a time without reopening
    // the connection — avoids overwhelming the FTP server, which often
    // handles many parallel connections poorly.
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      await this.uploadOne(item);
    }

    this.processing = false;
  }

  async uploadFileTo(localPath: string, remotePath: string): Promise<void> {
    await this.exec(async (client) => {
      await client.ensureDir(path.posix.dirname(remotePath));
      await client.uploadFrom(localPath, remotePath);

      // Clock skew calibration — non-blocking if the server doesn't
      // support MDTM.
      try {
        const remoteDate = await client.lastMod(remotePath);
        this.clockSkewMs = remoteDate.getTime() - Date.now();
      } catch {
        // no worries, just no calibration this time
      }
    });
  }

  // Returns a remote file's modification date, or null if it doesn't
  // exist yet server-side (or if MDTM isn't supported).
  private async getRemoteModifiedTime(
    remotePath: string
  ): Promise<Date | null> {
    return this.exec(async (client) => {
      try {
        return await client.lastMod(remotePath);
      } catch {
        return null;
      }
    });
  }

  // Before an upload: conflict if the remote file was modified after the
  // local file (e.g. a teammate uploaded in the meantime) — the remote
  // date is corrected by the estimated clock skew, then a tolerance is
  // applied to absorb residual imprecision.
  async checkUploadConflict(
    localPath: string,
    remotePath: string
  ): Promise<{ conflict: boolean; remoteDate?: Date }> {
    if (this.config.checkRemoteModifiedTime === false) {
      return { conflict: false };
    }

    const remoteDate = await this.getRemoteModifiedTime(remotePath);
    if (!remoteDate) return { conflict: false };

    const skew = this.clockSkewMs ?? 0;
    const adjustedRemoteMs = remoteDate.getTime() - skew;
    const localMs = fs.statSync(localPath).mtime.getTime();
    const toleranceMs = (this.config.clockToleranceSeconds ?? 5) * 1000;

    return {
      conflict: adjustedRemoteMs > localMs + toleranceMs,
      remoteDate,
    };
  }

  // Before a download: conflict if the local file is newer than the
  // remote version — downloading would overwrite local changes that
  // haven't been uploaded yet.
  async checkDownloadConflict(
    localPath: string,
    remotePath: string
  ): Promise<{ conflict: boolean; localDate?: Date; remoteDate?: Date }> {
    if (
      this.config.checkRemoteModifiedTime === false ||
      !fs.existsSync(localPath)
    ) {
      return { conflict: false };
    }

    const remoteDate = await this.getRemoteModifiedTime(remotePath);
    if (!remoteDate) return { conflict: false };

    const skew = this.clockSkewMs ?? 0;
    const adjustedRemoteMs = remoteDate.getTime() - skew;
    const localDate = fs.statSync(localPath).mtime;
    const toleranceMs = (this.config.clockToleranceSeconds ?? 5) * 1000;

    return {
      conflict: localDate.getTime() > adjustedRemoteMs + toleranceMs,
      localDate,
      remoteDate,
    };
  }

  private async uploadOne(item: QueuedUpload): Promise<void> {
    const fileName = path.basename(item.localPath);

    const { conflict, remoteDate } = await this.checkUploadConflict(
      item.localPath,
      item.remotePath
    );

    if (conflict) {
      this.statusBar.text = vscode.l10n.t("$(warning) Conflict {0}", fileName);
      const when = remoteDate ? remoteDate.toLocaleString() : "";
      const uploadAnyway = vscode.l10n.t("Upload anyway");
      vscode.window
        .showWarningMessage(
          vscode.l10n.t(
            "FTP: \"{0}\" was modified on the server ({1}) after your last local save — automatic upload skipped.",
            fileName,
            when
          ),
          uploadAnyway
        )
        .then((choice) => {
          if (choice === uploadAnyway) {
            this.uploadFileTo(item.localPath, item.remotePath).catch((err) =>
              vscode.window.showErrorMessage(
                vscode.l10n.t(
                  "FTP Upload: failed for {0} — {1}",
                  fileName,
                  String(err)
                )
              )
            );
          }
        });
      return;
    }

    this.statusBar.text = vscode.l10n.t("$(sync~spin) Uploading {0}...", fileName);

    try {
      await this.uploadFileTo(item.localPath, item.remotePath);

      const now = new Date().toLocaleTimeString();
      this.statusBar.text = vscode.l10n.t("$(check) Synced {0} ({1})", fileName, now);
      this.onUploadComplete?.();
    } catch (err) {
      this.statusBar.text = vscode.l10n.t("$(error) Upload failed {0}", fileName);
      vscode.window.showErrorMessage(
        vscode.l10n.t("FTP Upload: failed for {0} — {1}", fileName, String(err))
      );
    }
  }

  // Manual upload (right-click) of a file OR a directory (recursive),
  // respecting "ignore" patterns and cancellation — unlike enqueueUpload
  // which feeds the silent queue triggered on save.
  async uploadPath(
    localPath: string,
    onFile?: (fileName: string) => void,
    token?: vscode.CancellationToken,
    onConflict?: (fileName: string) => void
  ): Promise<void> {
    if (token?.isCancellationRequested) throw new OperationCancelledError();

    const relative = path.relative(this.workspaceFolder.uri.fsPath, localPath);
    if (this.isIgnored(relative)) return;

    const stat = fs.statSync(localPath);

    if (stat.isDirectory()) {
      const entries = fs.readdirSync(localPath, { withFileTypes: true });
      for (const entry of entries) {
        if (token?.isCancellationRequested) {
          throw new OperationCancelledError();
        }
        await this.uploadPath(
          path.join(localPath, entry.name),
          onFile,
          token,
          onConflict
        );
      }
    } else if (stat.isFile()) {
      const remotePath = path
        .join(this.config.remoteRoot, relative)
        .split(path.sep)
        .join("/");

      const { conflict } = await this.checkUploadConflict(
        localPath,
        remotePath
      );
      if (conflict) {
        onConflict?.(path.basename(localPath));
        return;
      }

      await this.uploadFileTo(localPath, remotePath);
      onFile?.(path.basename(localPath));
    }
  }

  // Lists the contents of a remote directory — used by the tree view.
  async listDirectory(remotePath: string): Promise<RemoteEntry[]> {
    return this.exec(async (client) => {
      const list = await client.list(remotePath);
      return list
        .filter((f) => f.name !== "." && f.name !== "..")
        .map((f) => ({
          name: f.name,
          isDirectory: f.type === FileType.Directory,
          size: f.size,
          modifiedAt: f.modifiedAt,
        }));
    });
  }

  // Downloads a temporary copy of a remote file for read-only preview —
  // not a real mounted remote filesystem (the model stays "edit locally,
  // upload on save").
  async downloadToTemp(remotePath: string): Promise<string> {
    const client = await this.ensureConnected();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ftp-preview-"));
    const localPath = path.join(tmpDir, path.basename(remotePath));
    await client.downloadTo(localPath, remotePath);
    return localPath;
  }

  // Downloads a remote file to a specific local path (not a temp one) —
  // used by the tree view's "Download" action.
  async downloadFileTo(remotePath: string, localPath: string): Promise<void> {
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    await this.exec((client) => client.downloadTo(localPath, remotePath));
  }

  // Custom recursive download rather than basic-ftp's built-in
  // downloadToDir: if the control socket resets mid-way (long transfer,
  // server timeout), we reconnect and retry only the failed file instead
  // of losing everything.
  // onFile is called after each downloaded file, for progress reporting on
  // the caller's side. A single file failing (e.g. a broken symlink or a
  // permission issue causing "550 Failed to open file") is reported via
  // onError and skipped, rather than aborting the rest of the folder.
  async downloadDirectoryTo(
    remotePath: string,
    localPath: string,
    onFile?: (fileName: string) => void,
    token?: vscode.CancellationToken,
    onError?: (fileName: string, err: unknown) => void
  ): Promise<void> {
    if (token?.isCancellationRequested) throw new OperationCancelledError();

    fs.mkdirSync(localPath, { recursive: true });
    const entries = await this.listDirectory(remotePath);

    for (const entry of entries) {
      if (token?.isCancellationRequested) throw new OperationCancelledError();

      const childRemote = remotePath.replace(/\/$/, "") + "/" + entry.name;
      const childLocal = path.join(localPath, entry.name);

      if (entry.isDirectory) {
        try {
          await this.downloadDirectoryTo(childRemote, childLocal, onFile, token, onError);
        } catch (err) {
          if (err instanceof OperationCancelledError) throw err;
          onError?.(entry.name + "/", err);
        }
      } else {
        try {
          await this.downloadFileTo(childRemote, childLocal);
          onFile?.(entry.name);
        } catch (err) {
          if (err instanceof OperationCancelledError) throw err;
          onError?.(entry.name, err);
        }
      }
    }
  }

  async deleteFile(remotePath: string): Promise<void> {
    await this.exec((client) => client.remove(remotePath));
  }

  // basic-ftp recursively removes the directory's contents before
  // removing the directory itself.
  async deleteDirectory(remotePath: string): Promise<void> {
    await this.exec((client) => client.removeDir(remotePath));
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.ensureConnected();
      vscode.window.showInformationMessage(
        vscode.l10n.t("FTP: connection successful ✓")
      );
      return true;
    } catch (err) {
      vscode.window.showErrorMessage(
        vscode.l10n.t("FTP: connection failed — {0}", String(err))
      );
      return false;
    }
  }

  dispose() {
    this.client?.close();
    this.statusBar.dispose();
  }
}
