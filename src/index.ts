#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { runFixBashCommand } from './fix-bash-command';
import { runCheckFileContent } from './check-file-content';

// ---------------------------------------------------------------------------
// Embedded templates (inlined at build time)
// ---------------------------------------------------------------------------

const SETTINGS_TEMPLATE = {
  hooks: {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: 'npx -y claude-hooks-win' }],
      },
      {
        matcher: 'Write|Edit',
        hooks: [{ type: 'command', command: 'npx -y claude-hooks-win' }],
      },
    ],
  },
};

const CONFIG_SAMPLE = {
  _comment_nul_redirect: 'Auto-fix: > nul -> > /dev/null (nul creates undeletable files on Windows)',
  nul_redirect: true,

  _comment_msys2_drive_paths: 'Auto-fix: /c/Users/... -> C:/Users/... (MSYS2 paths fail with Windows tools)',
  msys2_drive_paths: true,

  _comment_backslash_paths: 'Block: C:\\Users\\... -> suggest C:/Users/... (backslashes break in bash)',
  backslash_paths: true,

  _comment_unc_paths: 'Block: \\\\server\\share -> suggest //server/share',
  unc_paths: true,

  _comment_wsl_paths: 'Block: /mnt/c/Users/... -> suggest C:/Users/... (WSL paths, not Git Bash)',
  wsl_paths: true,

  _comment_reserved_names: 'Block: > con, touch prn.txt (Windows reserved device names)',
  reserved_names: true,

  _comment_python3: 'Auto-fix: python3 -> python (python3 is a Windows Store alias)',
  python3: true,

  _comment_dir_windows_flags: 'Auto-fix: dir /b -> ls -1, dir /s -> ls -R (dir in Git Bash is GNU coreutils)',
  dir_windows_flags: true,

  _comment_doubled_flags: 'Block: tasklist //fi -> suggest tasklist /fi (doubled // breaks Windows commands)',
  doubled_flags: true,

  _comment_dir_in_pwsh: "Block: pwsh -Command 'dir /b' -> suggest Get-ChildItem (PowerShell dir != cmd dir)",
  dir_in_pwsh: true,

  _comment_pwsh_quoting: 'Auto-fix: pwsh -Command "$var" -> pwsh -Command \'$var\' (prevent bash $ expansion)',
  pwsh_quoting: true,

  _comment_wsl_invocation: "Block: wsl ls -> run ls directly (you're in Git Bash, not WSL)",
  wsl_invocation: true,

  _comment_git_commit_attribution: 'Block: git commit with Co-Authored-By lines',
  git_commit_attribution: false,

  _comment_git_commit_generated: "Block: git commit with 'Generated with' text",
  git_commit_generated: false,

  _comment_git_commit_emoji: 'Block: git commit messages containing emoji',
  git_commit_emoji: false,

  _comment_file_content_unicode: 'Block: Write/Edit with emoji or decorative unicode (box drawing, dingbats)',
  file_content_unicode: false,
};

// ---------------------------------------------------------------------------
// init subcommand
// ---------------------------------------------------------------------------

function runInit(args: string[]): void {
  let projectDir: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' && i + 1 < args.length) {
      projectDir = args[i + 1];
      i++;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: claude-hooks-win init [--project DIR]');
      console.log('');
      console.log('  --project DIR  Install to a specific project directory');
      console.log('                 (uses settings.local.json).');
      console.log('                 Omit for global install to ~/.claude/');
      process.exit(0);
    }
  }

  const baseDir = projectDir
    ? join(resolve(projectDir), '.claude')
    : join(homedir(), '.claude');
  const hooksDir = join(baseDir, 'hooks');
  const settingsFile = projectDir
    ? join(baseDir, 'settings.local.json')
    : join(baseDir, 'settings.json');
  const scope = projectDir
    ? `project (${resolve(projectDir)})`
    : `global (~/.claude/)`;

  console.log(`Installing Claude Code hooks (${scope})...\n`);

  // 1. Copy config.sample.json
  mkdirSync(hooksDir, { recursive: true });
  const sampleDst = join(hooksDir, 'config.sample.json');
  writeFileSync(sampleDst, JSON.stringify(CONFIG_SAMPLE, null, 2) + '\n', 'utf-8');
  console.log(`  config.sample.json -> ${sampleDst}`);

  const configDst = join(hooksDir, 'config.json');
  if (!existsSync(configDst)) {
    console.log('  No config.json found -- using built-in defaults');
    console.log('  Copy config.sample.json to config.json to customize checks');
  }
  console.log();

  // 2. Merge hook config into settings
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsFile)) {
    try {
      settings = JSON.parse(readFileSync(settingsFile, 'utf-8'));
    } catch {
      // Corrupted settings -- start fresh
      settings = {};
    }
  }

  settings.hooks = SETTINGS_TEMPLATE.hooks;

  mkdirSync(baseDir, { recursive: true });
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  console.log(`  Updated ${settingsFile}`);
  console.log();

  console.log('Done. Hooks will take effect on the next tool call.');
}

// ---------------------------------------------------------------------------
// Hook dispatch (default mode -- called by Claude Code via stdin)
// ---------------------------------------------------------------------------

function runHook(): void {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf-8');  // fd 0 = stdin
  } catch {
    process.exit(0);
  }

  let inputData: Record<string, unknown>;
  try {
    inputData = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const toolName = (inputData.tool_name as string) || '';

  if (toolName === 'Bash') {
    runFixBashCommand(inputData);
  } else if (toolName === 'Write' || toolName === 'Edit') {
    runCheckFileContent(inputData);
  }

  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args[0] === 'init') {
  runInit(args.slice(1));
} else {
  runHook();
}
