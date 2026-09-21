import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

export interface FtpSyncConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  localRoot: string;
  remoteRoot: string;
  ignore: string[];
  uploadOnSave: boolean;
  scanBeforeUpload: boolean;
  checkRemoteModifiedTime: boolean;
  clockToleranceSeconds: number;
}

const DEFAULTS: Partial<FtpSyncConfig> = {
  port: 21,
  secure: true,
  localRoot: ".",
  ignore: [".git/**", "node_modules/**"],
  uploadOnSave: true,
  scanBeforeUpload: true,
  checkRemoteModifiedTime: true,
  clockToleranceSeconds: 5,
};

// Key used in SecretStorage — one per workspace, to support multiple
// projects with different credentials.
function secretKey(workspaceFolder: vscode.WorkspaceFolder): string {
  return `ftpUpload.password.${workspaceFolder.uri.toString()}`;
}

export function loadConfig(
  workspaceFolder: vscode.WorkspaceFolder
): FtpSyncConfig | null {
  const configPath = vscode.workspace
    .getConfiguration("ftpUpload", workspaceFolder.uri)
    .get<string>("configFile", ".vscode/ftp-sync.json");

  const fullPath = path.join(workspaceFolder.uri.fsPath, configPath);

  if (!fs.existsSync(fullPath)) {
    return null;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
    return { ...DEFAULTS, ...raw } as FtpSyncConfig;
  } catch (err) {
    vscode.window.showErrorMessage(
      vscode.l10n.t(
        "FTP Upload: invalid config file ({0}) — {1}",
        configPath,
        String(err)
      )
    );
    return null;
  }
}

export function configFilePath(workspaceFolder: vscode.WorkspaceFolder): string {
  const configPath = vscode.workspace
    .getConfiguration("ftpUpload", workspaceFolder.uri)
    .get<string>("configFile", ".vscode/ftp-sync.json");
  return path.join(workspaceFolder.uri.fsPath, configPath);
}

export function saveConfig(
  workspaceFolder: vscode.WorkspaceFolder,
  config: FtpSyncConfig
): void {
  const fullPath = configFilePath(workspaceFolder);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export async function getPassword(
  context: vscode.ExtensionContext,
  workspaceFolder: vscode.WorkspaceFolder
): Promise<string | undefined> {
  const key = secretKey(workspaceFolder);
  let pw = await context.secrets.get(key);

  if (!pw) {
    pw = await vscode.window.showInputBox({
      prompt: vscode.l10n.t("FTP password for {0}", workspaceFolder.name),
      password: true,
      ignoreFocusOut: true,
    });
    if (pw) {
      await context.secrets.store(key, pw);
    }
  }

  return pw;
}

export async function resetPassword(
  context: vscode.ExtensionContext,
  workspaceFolder: vscode.WorkspaceFolder
): Promise<void> {
  await context.secrets.delete(secretKey(workspaceFolder));
}
