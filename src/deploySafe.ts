import * as vscode from "vscode";

// Structural types matching DeploySafe's exported API (proPublisher.deploy-safe).
// Not imported from that project directly — it isn't published as an npm
// dependency, so we just mirror the shape here.
export interface DeploySafeFinding {
  file: string;
  line: number;
  ruleId: string;
  message: string;
  severity: "error" | "warning" | "info";
}

interface DeploySafeApi {
  scanFile(absolutePath: string): DeploySafeFinding[];
}

const EXTENSION_ID = "proPublisher.deploy-safe";

async function getApi(): Promise<DeploySafeApi | undefined> {
  const ext = vscode.extensions.getExtension<DeploySafeApi>(EXTENSION_ID);
  if (!ext) return undefined;
  return ext.isActive ? ext.exports : await ext.activate();
}

/**
 * Checks a file with DeploySafe (if installed) before it gets uploaded.
 * Resolves to false only when the user explicitly cancels after being shown
 * critical findings — every other outcome (extension missing, scan throws,
 * no critical findings) resolves to true so this check can never be the
 * reason an upload silently gets stuck.
 */
export async function confirmSafeToUpload(
  absolutePath: string,
  relativeLabel: string
): Promise<boolean> {
  let api: DeploySafeApi | undefined;
  try {
    api = await getApi();
  } catch {
    return true;
  }
  if (!api) return true;

  let findings: DeploySafeFinding[];
  try {
    findings = api.scanFile(absolutePath);
  } catch {
    return true;
  }

  const critical = findings.filter((f) => f.severity === "error");
  if (critical.length === 0) return true;

  const shown = critical.slice(0, 3).map((f) => `• ${f.message}`).join("\n");
  const more = critical.length > 3 ? `\n+${critical.length - 3} more` : "";

  const choice = await vscode.window.showWarningMessage(
    `FTP: DeploySafe found ${critical.length} critical issue(s) in "${relativeLabel}":\n${shown}${more}`,
    { modal: true },
    "Upload Anyway"
  );

  return choice === "Upload Anyway";
}
