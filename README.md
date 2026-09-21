# FTP/FTPS Upload on Save

Automatic upload to an FTP/FTPS server on every file save. No remote editing — the model is "edit locally, push on save", similar to SFTP-Simple.

## Installation

Install from the VS Code Marketplace, or grab the `.vsix` file and use:
`Extensions > ... > Install from VSIX`

## Project configuration

Two ways to create `.vscode/ftp-sync.json`:

- **Setup wizard (recommended)**: right-click a folder in the explorer → **FTP: Configure Connection...**. It asks for the host, port, FTP/FTPS, username, and remote folder, writes the file, then tests the connection. If you click a subfolder rather than the root, `remoteRoot` is pre-filled based on the clicked path.
- **Manual**: create the file by hand (see `.vscode-sample/ftp-sync.json` for an example), then **commit it** — it's the team config, not credentials.

```json
{
  "host": "ftp.example.com",
  "port": 21,
  "secure": true,
  "user": "mylogin",
  "localRoot": ".",
  "remoteRoot": "/www/site",
  "ignore": [".git/**", "node_modules/**", "*.log", ".vscode/**"],
  "uploadOnSave": true
}
```

⚠️ `ignore` patterns use glob syntax (`minimatch`): `.vscode` alone only matches that exact name, not its contents — you need `.vscode/**` to exclude everything inside it. That said, the `ftp-sync.json` file itself is **never** uploaded, even without this exception in `ignore` or with a badly written pattern — it's protected at the code level, not just by config.

The password is **never** stored in this file. On first connection, the extension asks for it via a dialog and stores it encrypted in VSCode's `SecretStorage` (per-user, never committed).

## Conflict detection (file changed in the meantime)

The extension compares local and remote modification dates before overwriting anything, with automatic correction for clock skew between your machine and the server (measured on every upload from the date the server reports for the file just sent — no need for both clocks to be in sync).

- **On upload (auto-save)**: if the remote file was modified after your local file (e.g. a teammate uploaded from their machine), the automatic upload is **silently skipped** with an "Upload anyway" notification — no interruptive blocking while typing.
- **On manual upload** (`FTP: Upload to Server`): conflicting files are skipped, with a summary listed at the end.
- **On download**: if your local copy is newer than the remote version, the confirmation message says so explicitly.

Configurable in `ftp-sync.json`:
```json
{
  "checkRemoteModifiedTime": true,
  "clockToleranceSeconds": 5
}
```
Set `checkRemoteModifiedTime` to `false` to disable this check entirely. `clockToleranceSeconds` absorbs residual measurement imprecision (increase it if you get false positives).

## Optional: DeploySafe integration

If [DeploySafe](https://marketplace.visualstudio.com/items?itemName=proPublisher.deploy-safe)
is also installed, every auto-upload on save is checked against it first. If it finds a
critical issue in the file (an exposed secret, hardcoded credentials...), a dialog lists
what was found and lets you cancel that upload or send it anyway. Nothing changes if
DeploySafe isn't installed — this is entirely optional.

```json
{
  "scanBeforeUpload": true
}
```
Set to `false` to skip this check even with DeploySafe installed.

## Browsing remote files

An **"FTP Remote Files"** view appears in the explorer (below the workspace folders), with one node per configured folder. Expanding it browses the remote tree; clicking a file downloads a read-only temporary copy.

⚠️ This is **not** a real mounted remote filesystem: editing that temporary copy does not re-upload it automatically — it's just for quickly checking what's on the server (confirming an upload went through, comparing a file, etc.), not for remote editing.

The ↻ button in the view's title refreshes manually; the view also refreshes automatically after every successful upload.

Hovering a file or folder in the view reveals two icons (also available via right-click):
- **☁⬇ Download** — downloads to the matching local path (via the config's `remoteRoot`/`localRoot` mapping), with confirmation if it would overwrite an existing local file
- **🗑 Delete** — deletes the file or folder **on the server**, with a mandatory confirmation dialog (irreversible, no FTP trash can)

**Multi-select**: `Ctrl`/`Cmd`+click or `Shift`+click to select several files/folders in the view, then right-click → Download or Delete applies to the whole selection.

**Cancellation**: downloads (folder or multi-select) and multi-deletes show a progress notification with a cancel button. Cancellation takes effect between two files/items (not mid-transfer).

## Fetching the server version of a local file/folder

Right-click any file or folder in the explorer (local, not the remote view) → **FTP: Download from Server**. Downloads the matching version from the server and overwrites local content — with a mandatory confirmation dialog, since un-uploaded local changes would be lost.

## Uploading an entire folder

Right-click a folder (or several files/folders via `Ctrl`/`Cmd`+click) → **FTP: Upload to Server**. Recursively uploads all content to the server, respecting the config's `ignore` patterns — handy for first-time project setup or after a `git pull` that touches many files at once. Unlike auto-upload on save, this shows progress and can be cancelled.

## Available commands

- `FTP: Configure Connection...` — also available via right-click on a folder in the explorer; opens the setup wizard
- `FTP: Sync All Files` — full workspace upload (useful after a `git pull` or for initial setup)
- `FTP: Test Connection` — checks that credentials and connectivity work
- `FTP: Reset Password` — clears the stored password, asks for a new one, and tests the connection (useful after a server-side password change)
- `FTP: Toggle Auto-Upload on Save` — pauses/resumes auto-upload for the current session without touching the config file (it takes precedence over `uploadOnSave` until VS Code is closed; a status bar item reminds you while it is paused, and clicking it re-enables it)

The file/folder actions (**Upload to Server**, **Download from Server**, **Configure Connection...**) are grouped in an **FTP** submenu of the explorer's right-click menu.

## Languages

The interface (commands, messages, settings) is available in **English** and **French**. It follows VS Code's display language — install the *French Language Pack* and set `Configure Display Language` to `fr` to get it in French; any other language falls back to English.

## Known limitations (v0.1)

- One FTP connection per workspace folder, reused across uploads (no real connection pooling yet)
