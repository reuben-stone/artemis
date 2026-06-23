/**
 * Spoken-summary helpers (renderer side).
 *
 * Artemis's voice should be conversational, so we never feed the full markdown
 * answer to TTS. The operator ends each reply with a `⟦say⟧` marker line: the
 * text before it is shown on screen, the text after it is the line spoken aloud.
 * Kept in sync with the main process (src/main/agent.ts).
 */

export const SAY_MARKER = '⟦say⟧'

/** Split a reply into the on-screen text and the (optional) spoken-aloud line. */
export function splitSpeech(text: string): { display: string; speech: string } {
  const i = text.indexOf(SAY_MARKER)
  if (i === -1) return { display: text, speech: '' }
  return {
    display: text.slice(0, i).trimEnd(),
    speech: text.slice(i + SAY_MARKER.length).trim()
  }
}

/**
 * Fallback when no `⟦say⟧` line was provided: derive something speakable by
 * stripping markdown/code noise and keeping the first sentence or two, so the
 * voice never reads a code dump aloud.
 */
export function speechFallback(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    .replace(/`[^`]*`/g, ' ') // inline code
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links/images → label
    .replace(/^[\s>#*\-+|]+/gm, ' ') // leading md punctuation per line
    .replace(/[*_~`#>|]/g, ' ') // stray md punctuation
    .replace(/\s+/g, ' ')
    .trim()
  if (!plain) return ''
  const sentences = plain.match(/[^.!?]+[.!?]+/g)
  const out = (sentences ? sentences.slice(0, 2).join(' ') : plain).trim()
  return out.length > 240 ? out.slice(0, 237).trimEnd() + '…' : out
}
