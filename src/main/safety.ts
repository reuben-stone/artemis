/**
 * Shared safety primitives for any agent loop (main or worker) — kept dependency-free
 * so both can import them without a circular reference.
 */

// Commands we refuse to run without asking, in any context.
export const DANGEROUS =
  /\b(rm\s+-rf?\s+[~/]|mkfs|dd\s+if=|:\(\)\s*\{|shutdown|reboot|>\s*\/dev\/sd)/i

// ── Safe read-only command classifier (for "Smart" permission mode) ──────────
// Auto-approve only commands we can PROVE are read-only and un-chained. Conservative
// by construction: any shell metacharacter that could chain, redirect, expand, or spawn
// a writer (| & ; < > ` $ ( ) globs, sudo, ../) drops the command back to a prompt. The
// bar is "obviously harmless", not "probably fine" — better to occasionally ask.
const SAFE_PROGRAMS = new Set([
  'ls', 'pwd', 'cat', 'head', 'tail', 'echo', 'date', 'cal', 'whoami', 'hostname',
  'uname', 'which', 'type', 'env', 'printenv', 'df', 'du', 'uptime', 'id', 'file',
  'wc', 'stat', 'basename', 'dirname', 'realpath', 'tree', 'grep', 'rg', 'sleep'
])
// git subcommands that only ever read. (`config` is read-only only as a getter; a
// `tag`/`branch` with extra args may create — handled below.)
const SAFE_GIT = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse', 'describe',
  'config', 'ls-files', 'blame', 'tag', 'shortlog', 'rev-list', 'for-each-ref',
  'cat-file', 'name-rev', 'whatchanged'
])
// Anything that could chain/redirect/expand/escape — present ⇒ not auto-safe.
const SHELL_META = /[|&;<>`$(){}\\!*?]|\bsudo\b|\.\.\//

export function isSafeReadOnly(command: string): boolean {
  const cmd = command.trim()
  if (!cmd || DANGEROUS.test(cmd) || SHELL_META.test(cmd)) return false
  const tokens = cmd.split(/\s+/)
  const base = tokens[0]

  if (base === 'git') {
    const sub = tokens[1] ?? ''
    if (!SAFE_GIT.has(sub)) return false
    // `git config X Y` (3+ args after sub) is a SET — not read-only.
    if (sub === 'config' && tokens.length > 3) return false
    // `git branch <name>` / `git tag <name>` create refs; only the list forms are safe.
    if ((sub === 'branch' || sub === 'tag') && tokens.length > 2) {
      return tokens.slice(2).every((t) => ['-l', '--list', '-a', '--all', '-v'].includes(t))
    }
    return true
  }

  // version/list-style package-manager reads only.
  if (['npm', 'pnpm', 'yarn', 'node'].includes(base)) {
    return tokens
      .slice(1)
      .every((t) => ['-v', '--version', 'ls', 'list', 'view', 'outdated', '--depth'].includes(t) || /^\d+$/.test(t))
  }

  return SAFE_PROGRAMS.has(base)
}

// Hard ceiling on any single tool result fed back to a model — protects the context
// window from a runaway Read/Grep/Bash (e.g. globbing node_modules → millions of tokens).
const MAX_TOOL_OUTPUT = 60_000
export function clampToolOutput(s: string): string {
  if (s.length <= MAX_TOOL_OUTPUT) return s
  return (
    s.slice(0, MAX_TOOL_OUTPUT) +
    `\n\n…[truncated ${s.length - MAX_TOOL_OUTPUT} chars to protect the context window — narrow your query]`
  )
}
