/**
 * Pure helpers for GitHub remotes — no Electron/Node deps, so both the renderer
 * (project list links) and the smoke harness can import them.
 */

/**
 * Normalise a git remote URL to an owner/repo slug and an https web URL.
 * Handles both SSH (git@github.com:owner/repo.git) and HTTPS forms.
 * Returns null for non-GitHub or unparseable remotes.
 */
export function parseGitRemote(remote: string | null | undefined): { slug: string; url: string } | null {
  if (!remote) return null
  const m = remote.trim().match(/github\.com[:/]([^/\s]+)\/(.+?)(?:\.git)?\/?$/i)
  if (!m) return null
  const slug = `${m[1]}/${m[2]}`
  return { slug, url: `https://github.com/${slug}` }
}
