import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const MCP_NAME = 'coagent';
/** wait_for_agents and inline approvals keep a tool call open; both clients default to far shorter limits. */
export const TOOL_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export interface RegistrationPaths {
  claudeJson: string;
  codexToml: string;
}
const defaultPaths = (): RegistrationPaths => ({
  claudeJson: path.join(os.homedir(), '.claude.json'),
  codexToml: path.join(os.homedir(), '.codex', 'config.toml'),
});

const tomlStr = (s: string) => JSON.stringify(s); // TOML basic strings share JSON's escaping for our inputs

export function codexBlock(node: string, shim: string): string {
  return [
    `[mcp_servers.${MCP_NAME}]`,
    `command = ${tomlStr(node)}`,
    `args = [${tomlStr(shim)}]`,
    // Without this, Codex asks for approval on every MCP tool call and non-interactive workers fail the call.
    'default_tools_approval_mode = "approve"',
    `tool_timeout_sec = ${TOOL_TIMEOUT_MS / 1000}`,
  ].join('\n');
}

const SECTION_RE = new RegExp(String.raw`^\[mcp_servers\.${MCP_NAME}\][^\n]*\n(?:(?!\[)[^\n]*\n?)*`, 'm');

/** Returns the new TOML text, or null if it already contains exactly our block. Pure for testing. */
export function upsertCodexToml(current: string, block: string): string | null {
  const m = current.match(SECTION_RE);
  if (m) {
    if (m[0].trim() === block.trim()) return null;
    return current.replace(SECTION_RE, `${block}\n\n`);
  }
  return `${current.replace(/\s*$/, '')}${current.trim() ? '\n\n' : ''}${block}\n`;
}

export function removeCodexSection(current: string): string | null {
  return SECTION_RE.test(current) ? current.replace(SECTION_RE, '') : null;
}

function claudeEntryMatches(file: string, node: string, shim: string): boolean {
  try {
    const e = JSON.parse(fs.readFileSync(file, 'utf8'))?.mcpServers?.[MCP_NAME];
    return !!e && e.command === node && Array.isArray(e.args) && e.args.length === 1 && e.args[0] === shim
      && e.timeout === TOOL_TIMEOUT_MS;
  } catch {
    return false;
  }
}

function writeAtomic(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && !fs.existsSync(`${file}.coagent.bak`)) fs.copyFileSync(file, `${file}.coagent.bak`);
  const tmp = `${file}.coagent.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * Registers the shim as a user-level MCP server for Claude and Codex, idempotently.
 * Claude's ~/.claude.json is rewritten by running Claude processes, so we go through `claude mcp` instead of editing it.
 */
export async function ensureRegistered(shim: string, node = process.execPath, p = defaultPaths()): Promise<Record<string, string>> {
  const status: Record<string, string> = {};

  try {
    if (claudeEntryMatches(p.claudeJson, node, shim)) {
      status.claude = 'registered';
    } else {
      await exec('claude', ['mcp', 'remove', '-s', 'user', MCP_NAME]).catch(() => undefined);
      // add-json, because `timeout` (per-server tool-call and idle limit) has no flag on `claude mcp add`.
      await exec('claude', ['mcp', 'add-json', '-s', 'user', MCP_NAME,
        JSON.stringify({ type: 'stdio', command: node, args: [shim], timeout: TOOL_TIMEOUT_MS })]);
      status.claude = claudeEntryMatches(p.claudeJson, node, shim) ? 'registered (updated)' : 'failed: entry not found after add';
    }
  } catch (e) {
    status.claude = `failed: ${(e as Error).message.split('\n')[0]}`;
  }

  try {
    const current = fs.existsSync(p.codexToml) ? fs.readFileSync(p.codexToml, 'utf8') : '';
    const next = upsertCodexToml(current, codexBlock(node, shim));
    if (next === null) status.codex = 'registered';
    else { writeAtomic(p.codexToml, next); status.codex = 'registered (updated)'; }
  } catch (e) {
    status.codex = `failed: ${(e as Error).message.split('\n')[0]}`;
  }
  return status;
}

export async function unregister(p = defaultPaths()): Promise<Record<string, string>> {
  const status: Record<string, string> = {};
  try {
    await exec('claude', ['mcp', 'remove', '-s', 'user', MCP_NAME]);
    status.claude = 'removed';
  } catch (e) {
    status.claude = `not removed: ${(e as Error).message.split('\n')[0]}`;
  }
  try {
    const current = fs.existsSync(p.codexToml) ? fs.readFileSync(p.codexToml, 'utf8') : '';
    const next = removeCodexSection(current);
    if (next !== null) writeAtomic(p.codexToml, next);
    status.codex = 'removed';
  } catch (e) {
    status.codex = `not removed: ${(e as Error).message.split('\n')[0]}`;
  }
  return status;
}
