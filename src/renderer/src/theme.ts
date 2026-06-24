/**
 * Runtime accent theming. The CSS uses var(--accent) / var(--accent-rgb) /
 * var(--accent-bright) everywhere chrome is tinted; this swaps those on <html> and
 * persists the choice. Orb per-state colors are deliberately NOT themed — they're
 * state semantics, not UI accent.
 */
export interface Accent {
  id: string
  name: string
  hex: string
  /** bare "r, g, b" channels, for rgba(var(--accent-rgb), a) */
  rgb: string
  /** lighter tint for accent text/hover */
  bright: string
}

export const ACCENTS: Accent[] = [
  { id: 'violet', name: 'Violet', hex: '#9b6bff', rgb: '155, 107, 255', bright: '#c79bff' },
  { id: 'blue', name: 'Blue', hex: '#4f8cff', rgb: '79, 140, 255', bright: '#9cbcff' },
  { id: 'teal', name: 'Teal', hex: '#27e0a8', rgb: '39, 224, 168', bright: '#7af0d2' },
  { id: 'amber', name: 'Amber', hex: '#f5a623', rgb: '245, 166, 35', bright: '#ffd28a' },
  { id: 'rose', name: 'Rose', hex: '#ff6b9b', rgb: '255, 107, 155', bright: '#ff9cc0' }
]

const KEY = 'artemis.accent'

export function currentAccentId(): string {
  return localStorage.getItem(KEY) ?? ACCENTS[0].id
}

export function applyAccent(a: Accent): void {
  const r = document.documentElement
  r.style.setProperty('--accent', a.hex)
  r.style.setProperty('--accent-rgb', a.rgb)
  r.style.setProperty('--accent-bright', a.bright)
  localStorage.setItem(KEY, a.id)
}

/** Apply the saved accent at boot (call before first paint). */
export function initAccent(): void {
  const a = ACCENTS.find((x) => x.id === currentAccentId()) ?? ACCENTS[0]
  applyAccent(a)
}
