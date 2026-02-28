/**
 * PreToolUse hook for Bash commands.
 *
 * Intercepts commands before execution and applies fixes for common
 * Git Bash / MSYS2 mistakes on Windows.
 *
 * Tier 1 (auto-fix): silently rewrites the command via updatedInput.
 * Tier 2 (suggest):  blocks with exit 2 and a message showing the proposed fix.
 *                    Logs to ~/.claude/hooks/fixups.log for review.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Hooks directory resolution
// ---------------------------------------------------------------------------

function resolveHooksDir(): string {
  const projectDir = join(process.cwd(), '.claude', 'hooks');
  if (existsSync(join(projectDir, 'config.json'))) {
    return projectDir;
  }
  return join(homedir(), '.claude', 'hooks');
}

const HOOKS_DIR = resolveHooksDir();
const FIXUPS_LOG = join(HOOKS_DIR, 'fixups.log');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Built-in defaults: safety checks ON, style checks OFF
const _DEFAULTS: Record<string, boolean> = {
  nul_redirect: true,
  msys2_drive_paths: true,
  backslash_paths: true,
  unc_paths: true,
  wsl_paths: true,
  reserved_names: true,
  python3: true,
  dir_windows_flags: true,
  doubled_flags: true,
  dir_in_pwsh: true,
  pwsh_quoting: true,
  powershell_legacy: true,
  wsl_invocation: true,
  start_command: true,
  git_commit_attribution: false,
  git_commit_generated: false,
  git_commit_emoji: false,
};

let _configCache: Record<string, boolean> | null = null;

function _loadConfig(): Record<string, boolean> {
  if (_configCache !== null) return _configCache;

  const configPath = join(HOOKS_DIR, 'config.json');
  _configCache = {};
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw)) {
        if (!k.startsWith('_') && typeof v === 'boolean') {
          _configCache[k.toLowerCase()] = v as boolean;
        }
      }
    }
  } catch {
    // Missing file or invalid JSON — use defaults
  }
  return _configCache;
}

function _isEnabled(checkId: string, dflt?: boolean): boolean {
  const config = _loadConfig();
  if (checkId in config) return config[checkId];
  if (dflt !== undefined) return dflt;
  return _DEFAULTS[checkId] ?? true;
}

const MAX_LOG_LINES = 500;
const TRIM_TO_LINES = 250;

function _trimLogIfNeeded(): void {
  try {
    const lines = readFileSync(FIXUPS_LOG, 'utf-8').split('\n');
    if (lines.length > MAX_LOG_LINES) {
      writeFileSync(FIXUPS_LOG, lines.slice(-TRIM_TO_LINES).join('\n') + '\n', 'utf-8');
    }
  } catch {
    // File doesn't exist yet — nothing to trim
  }
}

function _logEntry(
  entryType: string,
  fixType: string,
  original: string,
  proposed: string | null = null,
  fixes: string[] | null = null,
): void {
  mkdirSync(dirname(FIXUPS_LOG), { recursive: true });
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const time = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const entry: Record<string, unknown> = { time, type: entryType, fix: fixType, cwd: process.cwd(), original };
  if (proposed !== null) entry.proposed = proposed;
  if (fixes !== null) entry.fixes = fixes;
  try {
    let existing = '';
    try { existing = readFileSync(FIXUPS_LOG, 'utf-8'); } catch { /* new file */ }
    writeFileSync(FIXUPS_LOG, existing + JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // Best-effort logging
  }
  _trimLogIfNeeded();
}

function logFixup(original: string, proposed: string | null, fixType: string): void {
  _logEntry('suggest', fixType, original, proposed);
}

function logAutofix(original: string, fixed: string, fixes: string[]): void {
  _logEntry('autofix', fixes.join(','), original, fixed, fixes);
}

function block(message: string): never {
  process.stderr.write(message + '\n');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Windows reserved device names
// ---------------------------------------------------------------------------

const WINDOWS_RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

const _RESERVED_RE = new RegExp(
  '(?<!/dev/)((?:&|[012])?>)\\s*(' +
  [...WINDOWS_RESERVED_NAMES].join('|') +
  ')(?:\\.[\\w.]+)?\\s*$',
  'im',
);

// ---------------------------------------------------------------------------
// WSL environment detection (cached)
// ---------------------------------------------------------------------------

const _inWsl = 'WSL_DISTRO_NAME' in process.env;
let _wslInstalled: boolean | null = null;

function _isWslInstalled(): boolean {
  if (_wslInstalled === null) {
    _wslInstalled = existsSync('C:/Windows/System32/wsl.exe');
  }
  return _wslInstalled;
}

const EMOJI_RE = new RegExp(
  '[' +
  '\u{1F600}-\u{1F64F}' +  // emoticons
  '\u{1F300}-\u{1F5FF}' +  // misc symbols & pictographs
  '\u{1F680}-\u{1F6FF}' +  // transport & map
  '\u{1F1E0}-\u{1F1FF}' +  // flags
  '\u{1F900}-\u{1F9FF}' +  // supplemental symbols
  '\u{1FA00}-\u{1FA6F}' +  // chess symbols
  '\u{1FA70}-\u{1FAFF}' +  // symbols extended-A
  '\u{2600}-\u{27BF}' +    // misc symbols & dingbats
  '\u{FE00}-\u{FE0F}' +    // variation selectors
  ']',
  'u',
);

// ---------------------------------------------------------------------------
// Tier 2 -- blocking checks
// ---------------------------------------------------------------------------

function checkGitCommitAttribution(cmd: string): void {
  if (!/\bgit\s+commit\b/.test(cmd)) return;
  if (/co-authored-by/i.test(cmd)) {
    block('Commit message contains Co-Authored-By. ' +
      'Remove AI attribution from commit messages.');
  }
}

function checkGitCommitGenerated(cmd: string): void {
  if (!/\bgit\s+commit\b/.test(cmd)) return;
  if (/generated with/i.test(cmd)) {
    block("Commit message contains 'Generated with'. " +
      'Remove AI attribution from commit messages.');
  }
}

function checkGitCommitEmoji(cmd: string): void {
  if (!/\bgit\s+commit\b/.test(cmd)) return;
  if (EMOJI_RE.test(cmd)) {
    block('Commit message contains emoji. ' +
      'Use plain text in commit messages.');
  }
}

function checkDoubledFlags(cmd: string): void {
  // Skip URLs
  if (/https?:\/\//.test(cmd)) return;
  for (const m of cmd.matchAll(/(?:^|\s)(\/\/([a-zA-Z]{1,4}))(?=\s|$|")/g)) {
    const flagFull = m[1];
    const flagName = m[2];
    // Skip if it looks like a UNC path (//server/share)
    const after = cmd.slice(m.index! + m[0].indexOf(flagFull) + flagFull.length);
    if (after.startsWith('/')) continue;
    const start = m.index! + m[0].indexOf(flagFull);
    const proposed = cmd.slice(0, start) + '/' + flagName + cmd.slice(start + flagFull.length);
    logFixup(cmd, proposed, 'doubled_flag');
    block('Doubled // flags break Windows commands in Git Bash. ' +
      'Single / works.\n' +
      `Original:  ${cmd}\n` +
      `Suggested: ${proposed}`);
  }
}

function _stripHeredocs(cmd: string): string {
  return cmd.replace(/<<-?\s*['"]?(\w+)['"]?.*?\n([\s\S]*?\n)\1/g, '');
}

function checkBackslashPaths(cmd: string): void {
  const stripped = _stripHeredocs(cmd);
  for (const m of stripped.matchAll(/(?<![A-Za-z])([A-Za-z]):\\([A-Za-z])/g)) {
    // Skip if inside single quotes (count odd quotes before match)
    const before = stripped.slice(0, m.index);
    if ((before.split("'").length - 1) % 2 === 1) continue;
    const proposed = cmd.replace(
      /(?<![A-Za-z])[A-Za-z]:\\[^\s'"]*/g,
      (match) => match.replace(/\\/g, '/'),
    );
    logFixup(cmd, proposed, 'backslash_path');
    block("Windows backslash paths don't work reliably in Git Bash.\n" +
      `Original:  ${cmd}\n` +
      `Suggested: ${proposed}`);
  }
}

function checkUncPaths(cmd: string): void {
  const stripped = _stripHeredocs(cmd);
  const uncRe = /(?:^|(?<=[\s"'=]))\\\\([A-Za-z0-9._-]+)\\([^\s'"]*)/g;
  for (const m of stripped.matchAll(uncRe)) {
    // Skip if inside single quotes
    const before = stripped.slice(0, m.index);
    if ((before.split("'").length - 1) % 2 === 1) continue;
    const proposed = cmd.replace(
      /(?:^|(?<=[\s"'=]))\\\\([A-Za-z0-9._-]+)\\([^\s'"]*)/g,
      (_: string, server: string, rest: string) => '//' + server + '/' + rest.replace(/\\/g, '/'),
    );
    logFixup(cmd, proposed, 'unc_path');
    block("UNC paths with backslashes don't work in Git Bash.\n" +
      `Original:  ${cmd}\n` +
      `Suggested: ${proposed}`);
  }
}

function checkWslInvocation(cmd: string): void {
  const trimmed = cmd.trimStart();
  if (!/^wsl(\.exe)?\s/i.test(trimmed)) return;
  // Allow full-path invocations as an intentional escape hatch
  if (/^[A-Za-z]:\//i.test(trimmed)) return;
  if (_isWslInstalled()) {
    block(
      'You are running in Git Bash on native Windows, not inside WSL.\n' +
      'Run the command directly instead of prefixing it with wsl.\n' +
      'If you specifically need to run a command inside WSL, ' +
      'use the full path: C:/Windows/System32/wsl.exe',
    );
  } else {
    block(
      'WSL is not installed. You are running in Git Bash on native Windows.\n' +
      'Run the command directly instead of prefixing it with wsl.',
    );
  }
}

function checkWslPaths(cmd: string): void {
  if (_inWsl) return;
  const stripped = _stripHeredocs(cmd);
  const m = stripped.match(/\/mnt\/([a-zA-Z])\//);
  if (!m) return;
  const proposed = cmd.replace(
    /\/mnt\/([a-zA-Z])\//g,
    (_: string, letter: string) => letter.toUpperCase() + ':/',
  );
  logFixup(cmd, proposed, 'wsl_path');
  block(
    `/mnt/${m[1]}/ is a WSL mount path. ` +
    'You are in Git Bash on native Windows.\n' +
    `Original:  ${cmd}\n` +
    `Suggested: ${proposed}`,
  );
}

function checkReservedNames(cmd: string): void {
  // Check redirects: > con, 2> prn, &> aux, > lpt1.txt, etc.
  const m = _RESERVED_RE.exec(cmd);
  if (m) {
    const name = m[2].toLowerCase();
    if (name !== 'nul') {  // nul is auto-fixed in tier 1
      logFixup(cmd, null, 'reserved_name_redirect');
      block(`'${m[2]}' is a Windows reserved device name. ` +
        'Redirecting to it will either send output to a hardware ' +
        'device or create an undeletable file.\n' +
        'Use > /dev/null to discard output.');
    }
  }

  // Check file arguments: touch con, mkdir prn, etc.
  const fileCmds = /\b(?:touch|mkdir|cp|mv|cat\s*>|tee)\s+(\S+)/;
  const fm = fileCmds.exec(cmd);
  if (fm) {
    const filename = fm[1].replace(/^["']|["']$/g, '');
    const basename = filename.split('/').pop()!.split('\\').pop()!;
    // Strip extension: con.txt -> con
    const stem = basename.split('.')[0].toLowerCase();
    if (WINDOWS_RESERVED_NAMES.has(stem)) {
      logFixup(cmd, null, 'reserved_name_file');
      block(`'${basename}' uses Windows reserved name '${stem}'. ` +
        'This will create an undeletable file on Windows. ' +
        'Choose a different filename.');
    }
  }
}

function checkPowershellLegacy(cmd: string): void {
  const stripped = cmd.trimStart();
  if (/^powershell(\.exe)?\s/i.test(stripped)) {
    block(
      'Use pwsh (PowerShell 7+) instead of powershell.exe. ' +
      'powershell.exe invokes the legacy Windows PowerShell 5.1.\n' +
      'If you specifically need PowerShell 5.1 for legacy compatibility, ' +
      'use the full path: ' +
      'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    );
  }
}

function checkDirInPwsh(cmd: string): void {
  if (!/\bpwsh(?:\.exe)?\s+(?:-Command|-c)\b/i.test(cmd)) return;
  const dm = /\bdir\s+(\/[a-zA-Z])/i.exec(cmd);
  if (!dm) return;
  const flag = dm[1].toLowerCase();
  const suggestions: Record<string, string> = {
    '/b': 'Get-ChildItem path | Select-Object -ExpandProperty Name',
    '/s': 'Get-ChildItem path -Recurse',
    '/a': 'Get-ChildItem path -Force',
  };
  const suggestion = suggestions[flag] || 'Get-ChildItem path';
  logFixup(cmd, null, 'dir_in_pwsh');
  block(
    `'dir ${flag}' is a cmd.exe flag; PowerShell's dir (Get-ChildItem) ` +
    'does not accept it and will treat it as a path.\n' +
    `Use: ${suggestion}`,
  );
}

// ---------------------------------------------------------------------------
// Tier 1 -- auto-fixes
// ---------------------------------------------------------------------------

function fixNulRedirect(cmd: string): string {
  return cmd.replace(
    /(?<![/]dev[/])((?:&|[012])?>)\s*nul\b/gi,
    '$1 /dev/null',
  );
}

function fixMsys2DrivePaths(cmd: string): string {
  return cmd.replace(
    /(?:^|(?<=\s))\/([a-zA-Z])\//g,
    (_: string, letter: string) => letter.toUpperCase() + ':/',
  );
}

function fixPython3(cmd: string): string {
  return cmd.replace(/\bpython3\b/g, 'python');
}

// Mapping of Windows cmd.exe 'dir' flags to GNU 'ls' equivalents
const _DIR_FLAG_MAP: Record<string, string> = {
  b: '-1',    // bare names only, one per line
  s: '-R',    // recursive (subdirectories)
  a: '-la',   // all files including hidden (dotfiles)
  w: '',      // wide format (ls default, no extra flag needed)
  n: '-l',    // new long format
  q: '-l',    // show owner (ls -l includes owner)
};

function fixDirWindowsFlags(cmd: string): string {
  const trimmed = cmd.trim();
  if (!/^dir\b/i.test(trimmed)) return cmd;

  let rest = trimmed.slice(3).trimStart();  // everything after 'dir'

  // Consume leading /flag tokens (e.g. /b, /s, /a:h)
  const flags: string[] = [];
  while (true) {
    const fm = rest.match(/^(\/[a-zA-Z])(?::[a-zA-Z]*)?\s*([\s\S]*)/i);
    if (!fm) break;
    flags.push(fm[1].toLowerCase());
    rest = fm[2];
  }

  if (flags.length === 0) return cmd;  // no Windows-style flags found

  // Only auto-fix when all flags are known
  if (flags.some((f) => !(f[1] in _DIR_FLAG_MAP))) return cmd;

  const lsFlags: string[] = [];
  for (const f of flags) {
    const mapped = _DIR_FLAG_MAP[f[1]];
    if (mapped && !lsFlags.includes(mapped)) lsFlags.push(mapped);
  }

  const pathPart = rest.trim();
  let lsCmd = 'ls';
  if (lsFlags.length) lsCmd += ' ' + lsFlags.join(' ');
  if (pathPart) lsCmd += ' ' + pathPart;
  return lsCmd.trim();
}

function fixPwshQuoting(cmd: string): [string, string | null] {
  const m = cmd.match(/(pwsh(?:\.exe)?\s+(?:-Command|-c)\s+)"([^"]*)"/i);
  if (!m) return [cmd, null];

  const content = m[2];
  if (!content.includes('$')) return [cmd, null];

  if (content.includes("'")) {
    return [cmd, (
      'pwsh -Command with $ and embedded single quotes: ' +
      'bash will expand $ in double quotes and single quotes ' +
      'prevent nesting. Use pwsh -File script.ps1 instead.'
    )];
  }

  const fixed = cmd.slice(0, m.index!) + m[1] + "'" + content + "'" + cmd.slice(m.index! + m[0].length);
  return [fixed, null];
}

function fixStartCommand(cmd: string): string {
  const trimmed = cmd.trim();
  let m = trimmed.match(/^start\s+""\s+"([^"]+)"$/);
  if (!m) {
    // Also match without the empty title: start "path"
    m = trimmed.match(/^start\s+"([^"]+)"$/);
  }
  if (!m) {
    // Unquoted: start path (no spaces in path)
    m = trimmed.match(/^start\s+(\S+)$/);
  }
  if (!m) return cmd;
  const path = m[1].replace(/\\/g, '/');
  const escaped = path.replace(/'/g, "\\'");
  return `python -c "import os; os.startfile('${escaped}')"`;
}

// ---------------------------------------------------------------------------
// Exported entry point
// ---------------------------------------------------------------------------

export function runFixBashCommand(inputData: Record<string, unknown>): void {
  const toolInput = (inputData.tool_input as Record<string, unknown>) || {};
  let command = (toolInput.command as string) || '';
  if (!command) return;

  const original = command;
  const fixes: string[] = [];

  // -- Tier 2 checks (blocking) ------------------------------------------
  if (_isEnabled('git_commit_attribution', false)) checkGitCommitAttribution(command);
  if (_isEnabled('git_commit_generated', false)) checkGitCommitGenerated(command);
  if (_isEnabled('git_commit_emoji', false)) checkGitCommitEmoji(command);
  if (_isEnabled('powershell_legacy')) checkPowershellLegacy(command);
  if (_isEnabled('wsl_invocation')) checkWslInvocation(command);
  if (_isEnabled('wsl_paths')) checkWslPaths(command);
  if (_isEnabled('dir_in_pwsh')) checkDirInPwsh(command);
  if (_isEnabled('reserved_names')) checkReservedNames(command);
  if (_isEnabled('doubled_flags')) checkDoubledFlags(command);
  if (_isEnabled('backslash_paths')) checkBackslashPaths(command);
  if (_isEnabled('unc_paths')) checkUncPaths(command);

  // -- Tier 1 auto-fixes --------------------------------------------------

  if (_isEnabled('nul_redirect')) {
    command = fixNulRedirect(command);
    if (command !== original) fixes.push('replaced > nul with > /dev/null');
  }

  if (_isEnabled('msys2_drive_paths')) {
    const prev = command;
    command = fixMsys2DrivePaths(command);
    if (command !== prev) fixes.push('converted MSYS2 drive paths to Windows style');
  }

  if (_isEnabled('python3')) {
    const prev = command;
    command = fixPython3(command);
    if (command !== prev) fixes.push('replaced python3 with python');
  }

  if (_isEnabled('dir_windows_flags')) {
    const prev = command;
    command = fixDirWindowsFlags(command);
    if (command !== prev) fixes.push('converted Windows dir /flags to ls equivalent');
  }

  if (_isEnabled('pwsh_quoting')) {
    const prev = command;
    let pwshErr: string | null;
    [command, pwshErr] = fixPwshQuoting(command);
    if (pwshErr) block(pwshErr);
    if (command !== prev) fixes.push('swapped pwsh -Command quotes from double to single');
  }

  if (_isEnabled('start_command')) {
    const prev = command;
    command = fixStartCommand(command);
    if (command !== prev) fixes.push('replaced start with os.startfile()');
  }

  // -- Emit result --------------------------------------------------------
  if (fixes.length) {
    logAutofix(original, command, fixes);
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          command,
          description: (toolInput.description as string) || '',
        },
        additionalContext: 'Hook auto-fixed: ' + fixes.join(', '),
      },
    };
    process.stdout.write(JSON.stringify(output));
  }
}
