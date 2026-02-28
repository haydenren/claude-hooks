/**
 * PreToolUse hook for Write and Edit tools.
 *
 * Blocks emoji and decorative unicode characters in file content.
 * These cause encoding issues, look AI-generated, and serve no purpose
 * in code or documentation.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function resolveHooksDir(): string {
  const projectDir = join(process.cwd(), '.claude', 'hooks');
  if (existsSync(join(projectDir, 'config.json'))) {
    return projectDir;
  }
  return join(homedir(), '.claude', 'hooks');
}

const HOOKS_DIR = resolveHooksDir();
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
  return false;  // file_content_unicode defaults to off
}

// Unicode ranges to block
const BLOCKED_RANGES: Array<[number, number, string]> = [
  [0x1F000, 0x1FFFF, 'emoji/symbols'],
  [0x2600, 0x27BF, 'misc symbols/dingbats'],
  [0xFE00, 0xFE0F, 'variation selectors'],
  [0x2500, 0x257F, 'box drawing'],
  [0x2190, 0x21FF, 'arrows'],
  [0x2700, 0x27BF, 'dingbats'],
];

function findBlockedChar(text: string): [string, number, string] | null {
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    for (const [low, high, category] of BLOCKED_RANGES) {
      if (cp >= low && cp <= high) {
        return [char, cp, category];
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Exported entry point
// ---------------------------------------------------------------------------

export function runCheckFileContent(inputData: Record<string, unknown>): void {
  const toolName = (inputData.tool_name as string) || '';
  const toolInput = (inputData.tool_input as Record<string, unknown>) || {};

  let content: string;
  if (toolName === 'Write') {
    content = (toolInput.content as string) || '';
  } else if (toolName === 'Edit') {
    content = (toolInput.new_string as string) || '';
  } else {
    return;
  }

  if (!content) return;

  if (!_isEnabled('file_content_unicode', false)) return;

  const result = findBlockedChar(content);
  if (result) {
    const [, cp, category] = result;
    const hex = cp.toString(16).toUpperCase().padStart(4, '0');
    process.stderr.write(
      `Blocked: found ${category} character U+${hex} in file content. ` +
      'Use plain ASCII unless specifically requested by the user.\n',
    );
    process.exit(2);
  }
}
