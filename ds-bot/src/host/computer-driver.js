// Real screen capture and input injection for computer.js, per platform. One `run`
// takes a list of primitive ops and executes them in order:
//   shot   {op, path, max}   — capture the screen to `path` as a JPEG whose longest
//                              side is `max` or less; its result is
//                              {left, top, width, height, image:{width,height}}:
//                              the screen region in input coordinates and the
//                              image's pixel size.
//   grab   {op, x, y, w, h, path, format, scale}
//                          — capture the w×h region at (x, y) to `path`: `bmp` for
//                              pixel-diffing anchors, `jpg` for TypeSafe; `scale`
//                              upscales the saved image (default 1). The result
//                              is {left, top, width, height} of the captured
//                              region in input coordinates.
//   screen {op}              — the region only, without saving an image.
//   move   {op, x, y, vs}    — pointer to (x, y), input coordinates; vs is the
//                              screen region {left, top, width, height} the
//                              coordinates are normalized against.
//   down/up{op, x, y, button}— a mouse button at (x, y): left, middle or right.
//   wheel  {op, dx, dy}      — scroll notches: dy > 0 up, dx > 0 right.
//   press  {op, codes, flags, chord} — a key chord: `codes` are virtual key codes,
//                              pressed in order and released in reverse; `flags` is
//                              the macOS modifier mask; `chord` is the xdotool
//                              syntax (Linux only).
//   text   {op, text}        — type a string at the current focus.
//
// Windows: one PowerShell process per run; SendInput absolute mouse coordinates are
// normalized over the virtual screen, so display scaling and multi-monitor offsets
// do not matter. macOS: `screencapture -m` + sips for shots, and one osascript JXA
// process per run posting CGEvents (main display; needs Accessibility permission).
// Linux: xdotool for input and ImageMagick's import/identify for shots.
import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

// TypeSafe rejects images with a side over 1568 px or over 1568 * 1568 pixels total.
export const IMAGE_MAX = 1568
const RUN_TIMEOUT_MS = 120_000
const MARKER = '___DSBOT_RESULT___'

const execFileAsync = promisify(execFile)
const defaultExec = (file, args) => execFileAsync(file, args, { timeout: RUN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
const fail = (error, what) => {
  const tail = [error?.stderr, error?.stdout, error?.message].filter(Boolean).join(' ').trim().slice(0, 400)
  return new Error(`${what}: ${tail || 'it printed nothing'}`)
}

// Canonical key names -> per-platform codes. `keys` chords use these names
// (plus the aliases below): "ctrl+c", "enter", "alt+f4", "ctrl+shift+esc".
const KEYS = {
  ctrl: { win: 0x11, mac: 0x3B, x: 'ctrl', flag: 0x40000 },
  shift: { win: 0x10, mac: 0x38, x: 'shift', flag: 0x20000 },
  alt: { win: 0x12, mac: 0x3A, x: 'alt', flag: 0x80000 },
  meta: { win: 0x5B, mac: 0x37, x: 'super', flag: 0x100000 },
  enter: { win: 0x0D, mac: 0x24, x: 'Return' },
  esc: { win: 0x1B, mac: 0x35, x: 'Escape' },
  tab: { win: 0x09, mac: 0x30, x: 'Tab' },
  backspace: { win: 0x08, mac: 0x33, x: 'BackSpace' },
  delete: { win: 0x2E, mac: 0x75, x: 'Delete' },
  space: { win: 0x20, mac: 0x31, x: 'space' },
  left: { win: 0x25, mac: 0x7B, x: 'Left' },
  up: { win: 0x26, mac: 0x7E, x: 'Up' },
  right: { win: 0x27, mac: 0x7C, x: 'Right' },
  down: { win: 0x28, mac: 0x7D, x: 'Down' },
  home: { win: 0x24, mac: 0x73, x: 'Home' },
  end: { win: 0x23, mac: 0x77, x: 'End' },
  pageup: { win: 0x21, mac: 0x74, x: 'Page_Up' },
  pagedown: { win: 0x22, mac: 0x79, x: 'Page_Down' },
  insert: { win: 0x2D, mac: 0x72, x: 'Insert' },
  capslock: { win: 0x14, mac: 0x39, x: 'Caps_Lock' },
  printscreen: { win: 0x2C, mac: 0x69, x: 'Print' },
}
const ALIASES = { control: 'ctrl', cmd: 'meta', command: 'meta', win: 'meta', super: 'meta', option: 'alt', return: 'enter', escape: 'esc', esc: 'esc', del: 'delete', pgup: 'pageup', pgdn: 'pagedown', arrowleft: 'left', arrowright: 'right', arrowup: 'up', arrowdown: 'down' }
for (let i = 1; i <= 12; i += 1) KEYS[`f${i}`] = { win: 0x6F + i, mac: [0x7A, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6D, 0x67, 0x6F][i - 1], x: `F${i}` }
const MAC_LETTERS = { a: 0x00, s: 0x01, d: 0x02, f: 0x03, g: 0x04, h: 0x05, j: 0x06, k: 0x07, l: 0x08, q: 0x0C, w: 0x0D, e: 0x0E, r: 0x0F, t: 0x10, y: 0x11, u: 0x12, i: 0x13, o: 0x14, p: 0x15, z: 0x06, x: 0x07, c: 0x08, v: 0x09, b: 0x0B, n: 0x2D, m: 0x2E }
const MAC_DIGITS = { 1: 0x12, 2: 0x13, 3: 0x14, 4: 0x15, 5: 0x17, 6: 0x16, 7: 0x1A, 8: 0x1C, 9: 0x19, 0: 0x1D }
for (const [key, code] of Object.entries(MAC_LETTERS)) KEYS[key] = { win: key.toUpperCase().charCodeAt(0), mac: code, x: key }
for (const [key, code] of Object.entries(MAC_DIGITS)) KEYS[key] = { win: key.charCodeAt(0), mac: code, x: key }

// "ctrl+c" -> canonical names, or throws naming the part that is unknown.
export function parseChord(chord) {
  const names = String(chord ?? '').trim().toLowerCase().split('+').map(part => ALIASES[part.trim()] ?? part.trim())
  if (names.length === 0 || names.some(name => name === '')) throw new Error(`"${chord}" is not a key chord — e.g. "enter", "ctrl+c", "alt+f4".`)
  const unknown = names.find(name => KEYS[name] === undefined)
  if (unknown !== undefined) throw new Error(`No key named "${unknown}" — use ctrl, shift, alt, meta, enter, esc, tab, backspace, delete, space, the arrows, home, end, pageup, pagedown, insert, capslock, printscreen, f1–f12, or a letter or digit.`)
  return names
}

// What a press op needs on one platform: win32/mac use `codes` (and `flags`),
// linux uses the xdotool `chord` string.
export function keyPlan(names, platform) {
  if (platform === 'linux') return { chord: names.map(name => KEYS[name].x).join('+') }
  const field = platform === 'darwin' ? 'mac' : 'win'
  const codes = names.map(name => KEYS[name]?.[field]).filter(code => code !== undefined)
  if (codes.length !== names.length) throw new Error(`A key in "${names.join('+')}" has no key code on this platform.`)
  const flags = platform === 'darwin' ? names.reduce((mask, name) => mask | (KEYS[name].flag ?? 0), 0) : 0
  return { codes, flags }
}

// Image pixels -> screen coordinates: a shot maps its `image` size onto the
// `width` x `height` screen region starting at (`left`, `top`).
export const toScreen = (shot, p) => ({
  x: Math.round(shot.left + (p.x / shot.image.width) * shot.width),
  y: Math.round(shot.top + (p.y / shot.image.height) * shot.height),
})

const region = ({ left, top, width, height }) => ({ left, top, width, height })
export const moveOp = (p, vs) => ({ op: 'move', x: Math.round(p.x), y: Math.round(p.y), vs: region(vs) })
const BUTTONS = new Set(['left', 'middle', 'right'])
export function clickOps(p, vs, { button = 'left', count = 1 } = {}) {
  if (!BUTTONS.has(button)) throw new Error(`No mouse button "${button}" — left, middle or right.`)
  const ops = [moveOp(p, vs)]
  for (let i = 0; i < Math.min(3, Math.max(1, count)); i += 1) {
    ops.push({ op: 'down', x: Math.round(p.x), y: Math.round(p.y), button }, { op: 'up', x: Math.round(p.x), y: Math.round(p.y), button })
  }
  return ops
}
const DRAG_STEPS = 8
export const dragOps = (from, to, vs) => {
  const ops = [moveOp(from, vs), { op: 'down', x: Math.round(from.x), y: Math.round(from.y), button: 'left' }]
  for (let i = 1; i <= DRAG_STEPS; i += 1) ops.push(moveOp({ x: from.x + ((to.x - from.x) * i) / DRAG_STEPS, y: from.y + ((to.y - from.y) * i) / DRAG_STEPS }, vs))
  ops.push({ op: 'up', x: Math.round(to.x), y: Math.round(to.y), button: 'left' })
  return ops
}
export const scrollOps = (p, vs, direction, amount) => {
  const n = Math.min(20, Math.max(1, amount))
  const delta = { up: { dx: 0, dy: n }, down: { dx: 0, dy: -n }, left: { dx: -n, dy: 0 }, right: { dx: n, dy: 0 } }[direction]
  if (delta === undefined) throw new Error('scroll needs direction up, down, left or right.')
  return [moveOp(p, vs), { op: 'wheel', ...delta }]
}
export const typeOps = text => [{ op: 'text', text }]
export const pressOp = (names, platform) => [{ op: 'press', ...keyPlan(names, platform) }]

// The Windows driver: one PowerShell file executed per run, reading the ops from a
// JSON file and printing the results after a marker line.
export const WINDOWS_PS1 = `param([Parameter(Mandatory = $true)][string]$OpsFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NativeInput {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public int mouseData; public int dwFlags; public int time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public int dwFlags; public int time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public int uMsg; public short wParamL; public short wParamH; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public int type; public UNION u; }
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(int n, INPUT[] inputs, int cb);
  const int MOUSE = 0, KBD = 1;
  const int MOVE = 0x0001, WHEEL = 0x0800, HWHEEL = 0x1000, ABS = 0x8000, VDESK = 0x4000;
  const int KEYUP = 0x0002, UNICODE = 0x0004;
  public static readonly int[] DOWN = { 0x0002, 0x0020, 0x0008 };
  public static readonly int[] UP = { 0x0004, 0x0040, 0x0010 };
  static INPUT Mouse(int dx, int dy, int flags, int data) {
    return new INPUT { type = MOUSE, u = new UNION { mi = new MOUSEINPUT { dx = dx, dy = dy, mouseData = data, dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero } } };
  }
  static INPUT Key(ushort vk, ushort scan, int flags) {
    return new INPUT { type = KBD, u = new UNION { ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero } } };
  }
  static void Send(INPUT[] inputs) {
    if (SendInput(inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length) throw new Exception("SendInput injected nothing — another app may be running elevated.");
  }
  static int Norm(int v, int lo, int span) { return (int)Math.Round((v - lo) * 65535.0 / Math.Max(1, span - 1)); }
  public static void Move(int x, int y, int left, int top, int w, int h) {
    Send(new[] { Mouse(Norm(x, left, w), Norm(y, top, h), MOVE | ABS | VDESK, 0) });
  }
  public static void Inject(int flags, int data) { Send(new[] { Mouse(0, 0, flags, data) }); }
  public static void Press(ushort[] codes) {
    var inputs = new INPUT[codes.Length * 2];
    for (var i = 0; i < codes.Length; i++) {
      inputs[i] = Key(codes[i], 0, 0);
      inputs[codes.Length + i] = Key(codes[codes.Length - 1 - i], 0, KEYUP);
    }
    Send(inputs);
  }
  public static void Text(string s) {
    var inputs = new INPUT[s.Length * 2];
    for (var i = 0; i < s.Length; i++) {
      inputs[2 * i] = Key(0, (ushort)s[i], UNICODE);
      inputs[2 * i + 1] = Key(0, (ushort)s[i], UNICODE | KEYUP);
    }
    Send(inputs);
  }
}
'@

function Send($result) { Write-Output ('${MARKER}' + ($result | ConvertTo-Json -Compress -Depth 6)) }
function Region() {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  return @{ left = $vs.Left; top = $vs.Top; width = $vs.Width; height = $vs.Height }
}

$i = -1
$results = @()
try {
  $ops = Get-Content -LiteralPath $OpsFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($ops -isnot [array]) { $ops = @($ops) }
  $buttons = @{ left = 0; middle = 1; right = 2 }
  for ($i = 0; $i -lt $ops.Count; $i++) {
    $op = $ops[$i]
    switch ($op.op) {
      'shot' {
        $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
        $bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
        try {
          $g = [System.Drawing.Graphics]::FromImage($bmp)
          $g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
          $g.Dispose()
        } catch {
          $bmp.Dispose()
          throw
        }
        $scale = [Math]::Min(1.0, [double]$op.max / [Math]::Max($vs.Width, $vs.Height))
        $w = [Math]::Max(1, [int][Math]::Round($vs.Width * $scale))
        $h = [Math]::Max(1, [int][Math]::Round($vs.Height * $scale))
        if ($scale -lt 1.0) {
          $scaled = New-Object System.Drawing.Bitmap $bmp, $w, $h
          $bmp.Dispose()
        } else { $scaled = $bmp }
        try { $scaled.Save($op.path, [System.Drawing.Imaging.ImageFormat]::Jpeg) } finally { $scaled.Dispose() }
        $results += @{ ok = $true; left = $vs.Left; top = $vs.Top; width = $vs.Width; height = $vs.Height; image = @{ width = $w; height = $h } }
      }
      'grab' {
        $w = [int]$op.w; $h = [int]$op.h; $x = [int]$op.x; $y = [int]$op.y
        $bmp = New-Object System.Drawing.Bitmap $w, $h
        try {
          $g = [System.Drawing.Graphics]::FromImage($bmp)
          $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
          $g.Dispose()
        } catch {
          $bmp.Dispose()
          throw
        }
        $scale = [double]$op.scale
        if ($scale -gt 0 -and $scale -ne 1) {
          $sw = [Math]::Max(1, [int][Math]::Round($w * $scale))
          $sh = [Math]::Max(1, [int][Math]::Round($h * $scale))
          $zoomed = New-Object System.Drawing.Bitmap $bmp, $sw, $sh
          $bmp.Dispose()
          $bmp = $zoomed
        }
        $fmt = if ($op.format -eq 'jpg') { [System.Drawing.Imaging.ImageFormat]::Jpeg } else { [System.Drawing.Imaging.ImageFormat]::Bmp }
        try { $bmp.Save($op.path, $fmt) } finally { $bmp.Dispose() }
        $results += @{ ok = $true; left = $x; top = $y; width = $w; height = $h }
      }
      'screen' { $results += (@{ ok = $true } + (Region)) }
      'move' { [NativeInput]::Move([int]$op.x, [int]$op.y, [int]$op.vs.left, [int]$op.vs.top, [int]$op.vs.width, [int]$op.vs.height); $results += @{ ok = $true } }
      'down' { [NativeInput]::Inject([NativeInput]::DOWN[$buttons[$op.button]], 0); $results += @{ ok = $true } }
      'up' { [NativeInput]::Inject([NativeInput]::UP[$buttons[$op.button]], 0); $results += @{ ok = $true } }
      'wheel' {
        if ([int]$op.dy -ne 0) { [NativeInput]::Inject(0x0800, [int]($op.dy * 120)) }
        if ([int]$op.dx -ne 0) { [NativeInput]::Inject(0x1000, [int]($op.dx * 120)) }
        $results += @{ ok = $true }
      }
      'press' { [NativeInput]::Press([ushort[]]($op.codes)); $results += @{ ok = $true } }
      'text' { [NativeInput]::Text([string]$op.text); $results += @{ ok = $true } }
      default { throw "unknown op $($op.op)" }
    }
  }
  Send @{ ok = $true; results = $results }
} catch {
  Send @{ ok = $false; error = $_.Exception.Message; at = $i }
}
`

// The macOS driver: one osascript JXA process per run of input ops. Shots are not
// done here — `screencapture` and `sips` handle them in macDriver below.
export const MACOS_JXA = `ObjC.import('Quartz')
ObjC.import('stdlib')
const systemEvents = Application('System Events')
const POST = event => $.CGEventPost($.kCGHIDEventTap, event)
const MOUSE = {
  left: [$.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp, $.kCGMouseButtonLeft],
  middle: [$.kCGEventOtherMouseDown, $.kCGEventOtherMouseUp, $.kCGMouseButtonCenter],
  right: [$.kCGEventRightMouseDown, $.kCGEventRightMouseUp, $.kCGMouseButtonRight],
}
const mouse = (type, x, y, button) => POST($.CGEventCreateMouseEvent(null, type, $.CGPointMake(x, y), button))
function step(op) {
  switch (op.op) {
    case 'screen': {
      const frame = $.NSScreen.mainScreen.frame
      return { ok: true, left: frame.origin.x, top: frame.origin.y, width: frame.size.width, height: frame.size.height }
    }
    case 'move': mouse($.kCGEventMouseMoved, op.x, op.y, $.kCGMouseButtonLeft); return { ok: true }
    case 'down': { const b = MOUSE[op.button] ?? MOUSE.left; mouse(b[0], op.x, op.y, b[2]); return { ok: true } }
    case 'up': { const b = MOUSE[op.button] ?? MOUSE.left; mouse(b[1], op.x, op.y, b[2]); return { ok: true } }
    case 'wheel': {
      POST($.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitLine, 2, -(op.dy ?? 0), -(op.dx ?? 0)))
      return { ok: true }
    }
    case 'press': {
      const codes = op.codes ?? []
      const flags = op.flags ?? 0
      for (const code of codes) { const e = $.CGEventCreateKeyboardEvent(null, code, true); $.CGEventSetFlags(e, flags); POST(e) }
      for (const code of [...codes].reverse()) { const e = $.CGEventCreateKeyboardEvent(null, code, false); $.CGEventSetFlags(e, flags); POST(e) }
      return { ok: true }
    }
    case 'text': systemEvents.keystroke(op.text); return { ok: true }
    default: throw new Error('unknown op ' + op.op)
  }
}
function run(argv) {
  const raw = $.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null)
  const ops = JSON.parse(ObjC.unwrap(raw))
  const results = []
  for (const op of ops) {
    try {
      results.push(step(op))
    } catch (error) {
      return '${MARKER}' + JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) })
    }
  }
  return '${MARKER}' + JSON.stringify({ ok: true, results })
}
`

// Reads the marker line a driver prints last, or turns the process output into an
// error when it is absent or reports failure.
function parseResults(stdout, stderr, what) {
  const line = String(stdout).split('\n').map(row => row.trim()).filter(row => row.startsWith(MARKER)).pop()
  if (line === undefined) throw fail({ stderr, stdout }, what)
  const parsed = JSON.parse(line.slice(MARKER.length))
  if (parsed.ok !== true) throw new Error(`${what}: ${parsed.error ?? 'an op failed'}${Number.isInteger(parsed.at) ? ` (op ${parsed.at + 1})` : ''}`)
  return parsed.results
}

// Windows: all ops, shots included, go through the PowerShell driver in one run.
function windowsDriver({ dir, exec }) {
  const script = join(dir, 'computer-driver.ps1')
  let wrote = false
  let seq = 0
  return async (ops) => {
    await mkdir(dir, { recursive: true })
    if (!wrote) {
      await writeFile(script, WINDOWS_PS1, 'utf8')
      wrote = true
    }
    const opsFile = join(dir, `ops-${process.pid}-${++seq}.json`)
    await writeFile(opsFile, JSON.stringify(ops), 'utf8')
    try {
      let out
      try {
        out = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', script, opsFile])
      } catch (error) {
        throw fail(error, 'The input driver (PowerShell) failed')
      }
      return parseResults(out.stdout, out.stderr, 'The input driver (PowerShell) failed')
    } finally {
      await rm(opsFile, { force: true })
    }
  }
}

// macOS: consecutive non-shot ops batch into one osascript run; each shot is
// `screencapture` + `sips` resize + one osascript screen query, in op order.
function macDriver({ dir, exec }) {
  const script = join(dir, 'computer-driver.jxa')
  let wrote = false
  let seq = 0
  const jxa = async (ops) => {
    const opsFile = join(dir, `ops-${process.pid}-${++seq}.json`)
    await writeFile(opsFile, JSON.stringify(ops), 'utf8')
    try {
      let out
      try {
        out = await exec('osascript', ['-l', 'JavaScript', script, opsFile])
      } catch (error) {
        const message = String(error?.stderr ?? error?.message ?? '')
        if (/not allowed|permitted|assistive|accessibility|keystroke/i.test(message)) {
          throw new Error('The input driver cannot send events: allow the app under System Settings → Privacy & Security → Accessibility (and Screen Recording for screenshots).')
        }
        throw fail(error, 'The input driver (osascript) failed')
      }
      return parseResults(out.stdout, out.stderr, 'The input driver (osascript) failed')
    } finally {
      await rm(opsFile, { force: true })
    }
  }
  const shot = async (op) => {
    const raw = join(dir, `raw-${process.pid}-${++seq}.png`)
    try {
      await exec('screencapture', ['-x', '-m', '-t', 'png', raw])
      await exec('sips', ['-Z', String(op.max), '-s', 'format', 'jpeg', '-s', 'formatOptions', '80', raw, '--out', op.path])
      const { stdout } = await exec('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', op.path])
      const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1])
      const height = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1])
      if (!width || !height) throw new Error('sips did not report the image size')
      const [screen] = await jxa([{ op: 'screen' }])
      return { ok: true, left: screen.left, top: screen.top, width: screen.width, height: screen.height, image: { width, height } }
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error('screencapture or sips is missing — they ship with macOS, so the PATH is broken.')
      throw error
    } finally {
      await rm(raw, { force: true })
    }
  }
  const grab = async (op) => {
    const raw = join(dir, `grab-${process.pid}-${++seq}.png`)
    try {
      await exec('screencapture', ['-x', '-R', `${op.x},${op.y},${op.w},${op.h}`, '-t', 'png', raw])
      const args = ['-s', 'format', op.format === 'jpg' ? 'jpeg' : 'bmp']
      if (op.scale && op.scale !== 1) args.push('-z', String(Math.round(op.h * op.scale)), String(Math.round(op.w * op.scale)))
      await exec('sips', [...args, raw, '--out', op.path])
      return { ok: true, left: op.x, top: op.y, width: op.w, height: op.h }
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error('screencapture or sips is missing — they ship with macOS, so the PATH is broken.')
      throw error
    } finally {
      await rm(raw, { force: true })
    }
  }
  return async (ops) => {
    await mkdir(dir, { recursive: true })
    if (!wrote) {
      await writeFile(script, MACOS_JXA, 'utf8')
      wrote = true
    }
    const results = Array.from({ length: ops.length })
    let batch = []
    let indexes = []
    const flush = async () => {
      if (batch.length === 0) return
      const done = await jxa(batch)
      done.forEach((r, i) => { results[indexes[i]] = r })
      batch = []
      indexes = []
    }
    for (const [index, op] of ops.entries()) {
      if (op.op === 'shot' || op.op === 'grab') {
        await flush()
        results[index] = await (op.op === 'shot' ? shot(op) : grab(op))
      } else {
        batch.push(op)
        indexes.push(index)
      }
    }
    await flush()
    return results
  }
}

// Linux: each op is one xdotool/ImageMagick call. Buttons: 1 left, 2 middle, 3
// right, 4/5 wheel up/down, 6/7 horizontal.
function linuxDriver({ exec }) {
  const BUTTON = { left: '1', middle: '2', right: '3' }
  const commands = (op) => {
    switch (op.op) {
      case 'move': return [['xdotool', 'mousemove', String(op.x), String(op.y)]]
      case 'down': return [['xdotool', 'mousedown', BUTTON[op.button] ?? '1']]
      case 'up': return [['xdotool', 'mouseup', BUTTON[op.button] ?? '1']]
      case 'wheel': {
        const clicks = []
        for (let i = 0; i < Math.abs(op.dy ?? 0); i += 1) clicks.push(['xdotool', 'click', op.dy > 0 ? '4' : '5'])
        for (let i = 0; i < Math.abs(op.dx ?? 0); i += 1) clicks.push(['xdotool', 'click', op.dx > 0 ? '7' : '6'])
        return clicks
      }
      case 'press': return [['xdotool', 'key', '--clearmodifiers', op.chord]]
      case 'text': return [['xdotool', 'type', '--clearmodifiers', op.text]]
      case 'grab': {
        const out = [['import', '-window', 'root', '-crop', `${op.w}x${op.h}+${op.x}+${op.y}`]]
        const resize = op.scale && op.scale !== 1 ? ['-resize', `${Math.round(op.scale * 100)}%`] : []
        return [[...out[0], ...resize, `${op.format === 'jpg' ? 'JPEG' : 'BMP3'}:${op.path}`]]
      }
      default: throw new Error(`unknown op ${op.op}`)
    }
  }
  const run = async (ops) => {
    const results = []
    for (const op of ops) {
      if (op.op === 'shot') {
        let out
        try {
          await exec('import', ['-window', 'root', '-resize', `${op.max}x${op.max}>`, op.path])
          const dims = await exec('identify', ['-format', '%w %h', op.path])
          const geo = await exec('xdotool', ['getdisplaygeometry'])
          const [width, height] = String(dims.stdout).trim().split(/\s+/).map(Number)
          const [screenW, screenH] = String(geo.stdout).trim().split(/\s+/).map(Number)
          if (!width || !height || !screenW || !screenH) throw new Error('identify/getdisplaygeometry printed no size')
          out = { ok: true, left: 0, top: 0, width: screenW, height: screenH, image: { width, height } }
        } catch (error) {
          if (error?.code === 'ENOENT') throw new Error('Computer control on Linux needs xdotool and ImageMagick (import, identify) installed, under X11 — Wayland blocks it.')
          throw fail(error, 'The screenshot failed')
        }
        results.push(out)
        continue
      }
      if (op.op === 'screen') {
        try {
          const geo = await exec('xdotool', ['getdisplaygeometry'])
          const [w, h] = String(geo.stdout).trim().split(/\s+/).map(Number)
          results.push({ ok: true, left: 0, top: 0, width: w, height: h })
        } catch (error) {
          if (error?.code === 'ENOENT') throw new Error('Computer control on Linux needs xdotool installed, under X11 — Wayland blocks it.')
          throw fail(error, 'Reading the screen size failed')
        }
        continue
      }
      try {
        for (const [file, ...args] of commands(op)) await exec(file, args)
        results.push(op.op === 'grab' ? { ok: true, left: op.x, top: op.y, width: op.w, height: op.h } : { ok: true })
      } catch (error) {
        if (error?.code === 'ENOENT') throw new Error('Computer control on Linux needs xdotool installed, under X11 — Wayland blocks it.')
        throw fail(error, `The input driver (xdotool) failed on ${op.op}`)
      }
    }
    return results
  }
  return run
}

/**
 * The driver for this machine: `run(ops)` executes the ops in order and returns one
 * result object per op (shot/screen carry the region). `dir` holds the driver
 * scripts and the per-run ops files.
 */
export function createDriver({ platform = process.platform, dir = tmpdir(), exec } = {}) {
  const run = { win32: windowsDriver, darwin: macDriver, linux: linuxDriver }[platform]?.({ dir, exec: exec ?? defaultExec })
  if (run === undefined) {
    return {
      platform,
      run: () => { throw new Error(`Computer control is not available on ${platform}: it works on Windows, macOS and Linux (X11).`) },
    }
  }
  return { platform, run }
}
