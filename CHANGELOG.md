# Changelog

## 0.4.0

- Downloading a folder no longer stops at the first file that fails (e.g. a
  broken symlink or a permission issue causing a server "550 Failed to open
  file"): that file is now skipped and reported in a summary at the end,
  and the rest of the folder still downloads.

## 0.3.0

- French translation of the whole interface (commands, views, settings, messages), following VS Code's display language.
- `FTP: Toggle Auto-Upload on Save` now works: session-only pause/resume of upload on save (never writes `ftp-sync.json`), with a status bar reminder while paused.
- Explorer right-click actions are grouped in an **FTP** submenu.

## 0.2.0

- Optional integration with DeploySafe: auto-upload on save is checked for critical
  issues (exposed secrets, hardcoded credentials) first when DeploySafe is installed.
  Configurable via `scanBeforeUpload` in `ftp-sync.json` (default `true`); no effect if
  DeploySafe isn't present.

## 0.1.0

- Initial release: upload on save to FTP/FTPS, remote file explorer, conflict detection based on remote modification time, secure password storage via VS Code SecretStorage, folder upload/download, setup wizard.
