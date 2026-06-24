/**
 * Shared safety primitives for any agent loop (main or worker) — kept dependency-free
 * so both can import them without a circular reference.
 */

// Commands we refuse to run without asking, in any context.
export const DANGEROUS =
  /\b(rm\s+-rf?\s+[~/]|mkfs|dd\s+if=|:\(\)\s*\{|shutdown|reboot|>\s*\/dev\/sd)/i

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
