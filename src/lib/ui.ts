// Small UI helpers — color output, error formatting, scramble animations.
// Kept minimal; no fancy spinners (Bun build --compile chokes on some). For
// long-running ops we print incremental status lines instead.
//
// `scramble` is the marquee effect: a target string materialises one
// character at a time, left to right, with the still-unresolved tail
// rendered as random glyphs. Mirrors apps/web/components/home/decrypt-button.tsx
// so the CLI feels visually consistent with the marketing site — the same
// "encrypted message landing" cue every Zavu surface uses.

import kleur from "kleur"

const SCRAMBLE_CHARS = "!@#$%^&*()_+-=[]{}|;:,.<>?/~`0123456789"
const FRAME_MS = 28        // ~36 fps — fast enough to feel slick, slow enough to read
const FRAMES_PER_CHAR = 2  // every 2 frames, one more char locks in

function pickGlyph(): string {
  return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)]
}

function isInteractive(): boolean {
  // Skip animations in CI / non-TTY (logs become unreadable). The `?? true`
  // is for runtimes that don't expose isTTY (Bun in some contexts).
  return (process.stdout.isTTY ?? true) && !process.env.CI && !process.env.ZAVU_NO_ANIMATE
}

/**
 * Scramble-resolve a line in place. Resolves with the final string already
 * printed and the cursor on the next line, so callers don't have to think
 * about \r or \n.
 *
 * @param target  final string to land on
 * @param colorize  optional color function applied to the *whole* line each
 *                  frame (e.g. kleur.green for the success line)
 */
export async function scramble(
  target: string,
  colorize: (s: string) => string = (s) => s
): Promise<void> {
  if (!isInteractive() || target.length === 0) {
    process.stdout.write(colorize(target) + "\n")
    return
  }
  const totalFrames = target.length * FRAMES_PER_CHAR + 1
  for (let f = 0; f < totalFrames; f++) {
    const resolved = Math.floor(f / FRAMES_PER_CHAR)
    let line = ""
    for (let i = 0; i < target.length; i++) {
      if (i < resolved) {
        line += target[i]
      } else if (target[i] === " ") {
        line += " "
      } else {
        line += pickGlyph()
      }
    }
    process.stdout.write("\r" + colorize(line))
    await sleep(FRAME_MS)
  }
  process.stdout.write("\r" + colorize(target) + "\n")
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// Solid-color box drawn with Unicode box characters. Centred ASCII brand
// shown at the top of `zavu login` so the dev sees something striking the
// moment the flow kicks off. Width is fixed; lines longer than the inner
// width are clipped (we control the strings so this is fine in practice).
const BANNER_WIDTH = 56

function banner(lines: string[], colorize: (s: string) => string = (s) => s) {
  const top = "╭" + "─".repeat(BANNER_WIDTH - 2) + "╮"
  const bot = "╰" + "─".repeat(BANNER_WIDTH - 2) + "╯"
  process.stdout.write(kleur.gray(top) + "\n")
  for (const line of lines) {
    const padded = line.padStart(line.length + Math.floor((BANNER_WIDTH - 2 - line.length) / 2)).padEnd(BANNER_WIDTH - 2)
    process.stdout.write(kleur.gray("│") + colorize(padded) + kleur.gray("│") + "\n")
  }
  process.stdout.write(kleur.gray(bot) + "\n")
}

// ASCII brand for the login intro. ANSI Shadow-style block letters spelling
// "ZAVU" — small enough to fit a standard 80-col terminal, distinctive
// enough that devs recognise the moment.
const ZAVU_LOGO = [
  "███████╗ █████╗ ██╗   ██╗██╗   ██╗",
  "╚══███╔╝██╔══██╗██║   ██║██║   ██║",
  "  ███╔╝ ███████║██║   ██║██║   ██║",
  " ███╔╝  ██╔══██║╚██╗ ██╔╝██║   ██║",
  "███████╗██║  ██║ ╚████╔╝ ╚██████╔╝",
  "╚══════╝╚═╝  ╚═╝  ╚═══╝   ╚═════╝ ",
]

export function brandIntro(subtitle?: string) {
  if (!isInteractive()) return
  process.stdout.write("\n")
  for (const line of ZAVU_LOGO) {
    process.stdout.write("  " + kleur.cyan(line) + "\n")
  }
  if (subtitle) {
    process.stdout.write("  " + kleur.gray(subtitle) + "\n")
  }
  process.stdout.write("\n")
}

export const ui = {
  info: (msg: string) => process.stdout.write(`${kleur.cyan("ℹ")} ${msg}\n`),
  success: (msg: string) => process.stdout.write(`${kleur.green("✓")} ${msg}\n`),
  warn: (msg: string) => process.stdout.write(`${kleur.yellow("!")} ${msg}\n`),
  step: (msg: string) => process.stdout.write(`${kleur.gray("›")} ${msg}\n`),
  hint: (msg: string) => process.stdout.write(`  ${kleur.gray(msg)}\n`),
  brandIntro,
  banner,
  scramble,
  // Convenience wrappers that scramble-print common log levels.
  scrambleStep: (msg: string) => scramble(`› ${msg}`, kleur.gray),
  scrambleSuccess: (msg: string) => scramble(`✓ ${msg}`, kleur.green),
  table: (rows: Array<Record<string, string | number>>) => {
    if (rows.length === 0) return
    const keys = Object.keys(rows[0])
    const widths = keys.map((k) =>
      Math.max(k.length, ...rows.map((r) => String(r[k] ?? "").length))
    )
    const fmt = (vals: string[]) =>
      vals.map((v, i) => v.padEnd(widths[i])).join("  ")
    process.stdout.write(kleur.bold(fmt(keys)) + "\n")
    process.stdout.write(kleur.gray(widths.map((w) => "─".repeat(w)).join("  ")) + "\n")
    for (const row of rows) {
      process.stdout.write(fmt(keys.map((k) => String(row[k] ?? ""))) + "\n")
    }
  },
}

export function fail(msg: string, code = 1): never {
  process.stderr.write(`${kleur.red("✗")} ${msg}\n`)
  process.exit(code)
}

// Pull the human-readable message out of a non-2xx response so failures get
// reported as `[invalid_request] Slug "x" is …` rather than a raw JSON blob.
// API returns `{ code, message, details? }`; if the body isn't JSON we fall
// back to the raw text.
export async function extractServerError(
  res: Response,
  prefix: string
): Promise<string> {
  const text = await res.text().catch(() => "")
  try {
    const parsed = JSON.parse(text) as { message?: string; code?: string }
    if (parsed?.message) {
      return parsed.code
        ? `${prefix}: ${parsed.message} [${parsed.code}]`
        : `${prefix}: ${parsed.message}`
    }
  } catch {
    /* fall through */
  }
  return text ? `${prefix}: ${text.slice(0, 500)}` : prefix
}
