/**
 * dsh-photo-pet host half — photo storage + API routes + the 'photo-pet'
 * settings namespace.
 *
 * The browser half (the './client' entry) renders a floating pet whose body
 * is a photo the user uploads. Photos live on the host under
 * '$DSH_HOME/photo-pet/photo.<ext>' and are served through the same-origin
 * '/api/photo-pet/*' family — the same pattern as dsh-remote-web-ui's
 * '/api/pair' family: RPC domains are platform-registered, so a plugin
 * serves its own API.
 *
 * Routes (all loopback-only):
 *   GET    /api/photo-pet/state    → { photo: boolean, photoUrl: string|null }
 *   GET    /api/photo-pet/photo    → the current photo (image/*) or 404
 *   POST   /api/photo-pet/photo    → { dataUrl } stores the photo (max 8 MiB)
 *   DELETE /api/photo-pet/photo    → removes the photo, back to the default
 *   GET    /api/photo-pet/activity → { working: boolean } — any session is
 *                                    generating (thinking/tool/review/waiting)
 *   GET    /api/photo-pet/ai/*     → AI cutout assets (patched resources.json
 *                                    + content-addressed model/wasm chunks,
 *                                    mirrored from npmmirror, disk-cached)
 *
 * The 'photo-pet' settings namespace (enabled / visible / size / right /
 * bottom) is installed through the official settings section so the settings
 * surface and the browser scope stay in sync.
 * @module dsh-photo-pet
 */

import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

/** Stable cordis plugin name (matches cordis.patch.yml insert id). */
export const name = 'photo-pet'

/** Services required before the plugin can mount its surfaces. */
export const inject = ['webServer']

/** Settings namespace owned by the photo pet. */
export const PHOTO_PET_NAMESPACE = 'photo-pet'

/** Data directory for uploaded photos under DSH_HOME. */
export const PHOTO_PET_DIR = 'photo-pet'

/** Upload cap for one photo: 8 MiB raw bytes. */
export const PHOTO_MAX_BYTES = 8 * 1024 * 1024

/** JSON body cap for the data-url payload (base64 inflates ~4/3). */
export const PHOTO_BODY_MAX_BYTES = 12 * 1024 * 1024

/** Display config bounds (shared with the browser scope). */
export const DISPLAY_SIZE_MIN = 80
export const DISPLAY_SIZE_MAX = 320
export const DISPLAY_INSET_MAX = 800

/** Activity phases that count as "the model is working". */
const WORKING_PHASES = new Set(['waiting', 'thinking', 'tool', 'review'])

/** Every activity phase the pet understands. */
const ACTIVITY_PHASES = new Set(['idle', 'waiting', 'thinking', 'tool', 'review', 'done', 'failed'])

/**
 * AI cutout (browser-side matting) assets. The browser loads the
 * @imgly/background-removal module from esm.sh and fetches the segmentation
 * model + onnxruntime wasm from THIS host (same-origin, no CORS) through the
 * '/api/photo-pet/ai/*' prefix route. Chunks are content-addressed sha256
 * filenames, disk-cached per source under $DSH_HOME/photo-pet/ai/<version>/.
 *
 * Two upstream mirrors, tried in order:
 *   1.5.5 staticimgly.com (the official imgly data host; its manifest already
 *        carries the /models/isnet_quint8 … keys the library requests)
 *   1.4.5 npmmirror (China-friendly npm mirror; manifest patched with aliases
 *        bridging /models/isnet_quint8 → /models/small etc.)
 */
const AI_SOURCES = [
  {
    version: '1.5.5',
    base: 'https://staticimgly.com/@imgly/background-removal-data/1.5.5/dist/',
    aliases: null,
  },
  {
    version: '1.4.5',
    base: 'https://registry.npmmirror.com/@imgly/background-removal-data/1.4.5/files/dist/',
    aliases: {
      '/models/isnet_quint8': '/models/small',
      '/models/isnet_fp16': '/models/medium',
      '/models/isnet': '/models/medium',
    },
  },
]

/** Timeout for one upstream manifest/chunk fetch (ms). */
const AI_FETCH_TIMEOUT_MS = 25000

/**
 * Project one durable DSH session event onto a pet activity phase (a
 * simplified slice of the official session vocabulary — just enough to tell
 * "working" from "not working"). Unknown/log-only events return undefined and
 * do not disturb the last known phase.
 */
export function projectActivityPhase(event) {
  if (event.type === 'activity/status') {
    const phase = event.data?.phase
    return typeof phase === 'string' && ACTIVITY_PHASES.has(phase) ? phase : undefined
  }
  switch (event.type) {
    case 'turn/start':
    case 'step/start':
      return 'waiting'
    case 'assistant/chunk': {
      const chunkType = event.data?.chunk?.type
      if (chunkType === 'reasoning-delta') return 'thinking'
      if (chunkType === 'text-delta') return 'review'
      return undefined
    }
    case 'assistant/message':
      return 'review'
    case 'tool/call':
      return 'tool'
    case 'tool/result': {
      const block = event.data?.message?.content?.[0]
      const failed = event.data?.error !== undefined || block?.isError === true
      return failed ? 'failed' : 'thinking'
    }
    case 'turn/end': {
      switch (event.data?.reason?.kind) {
        case 'completed':
          return 'done'
        case 'error':
        case 'max-tokens':
        case 'interrupted':
          return 'failed'
        case 'blocked':
          return 'waiting'
        default:
          return 'idle'
      }
    }
    default:
      return undefined
  }
}

/** Resolve DSH_HOME (env override, then ~/.dsh). */
export function dshHome(env = process.env, home = homedir()) {
  const raw = env.DSH_HOME
  if (raw !== undefined && raw.trim() !== '') {
    const expanded = raw.replace(/^~(?=$|[\\/])/, home)
    return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded)
  }
  return join(home, '.dsh')
}

/** The photo directory, created on demand. */
export function photoDir(base = dshHome()) {
  const dir = join(base, PHOTO_PET_DIR)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

const PHOTO_PATTERN = /^photo\.(png|jpe?g|webp|gif)$/i

/** The current photo file (photo.<ext>), or undefined when none is stored. */
export function currentPhotoFile(base = dshHome()) {
  const dir = photoDir(base)
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (PHOTO_PATTERN.test(entry)) {
      const file = join(dir, entry)
      try {
        if (statSync(file).isFile()) return file
      } catch {
        // stale entry; ignore
      }
    }
  }
  return undefined
}

/** Content type by photo extension. */
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** Parse a base64 image data URL into { ext, mime, buffer }, throwing on bad input. */
export function parsePhotoDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') throw new Error('missing-data-url')
  const match = /^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim())
  if (match === null) throw new Error('invalid-data-url')
  const mime = match[1]
  const buffer = Buffer.from(match[2], 'base64')
  if (buffer.length === 0) throw new Error('empty-image')
  if (buffer.length > PHOTO_MAX_BYTES) throw new Error('image-too-large')
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[mime]
  return { ext, mime, buffer }
}

/** Bounded request-body reader: accumulate at most maxBytes, then return the Buffer. */
function readBounded(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        req.destroy()
        reject(new Error('body-too-large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** Write one JSON response. */
function writeJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    ...headers,
  })
  res.end(payload)
}

/** Loopback-only fence: the web UI is same-origin, so any browser request arrives from loopback. */
function isLoopback(req) {
  const addr = req.socket.remoteAddress
  return addr === undefined || addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function guard(req, res) {
  if (isLoopback(req)) return true
  writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
  return false
}

function requireMethod(req, res, method) {
  if (req.method === method) return true
  writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
  return false
}

/** One GET route helper. */
function getRoute(path, run) {
  return {
    kind: 'exact',
    path,
    handler: (req, res) => {
      if (!guard(req, res)) return
      if (!requireMethod(req, res, 'GET')) return
      run(req, res)
    },
  }
}

/** Build the photo-pet route family. */
export function makePhotoPetRoutes(activity) {
  const stateRoute = (req, res) => {
    const file = currentPhotoFile()
    writeJson(res, 200, {
      photo: file !== undefined,
      photoUrl: file === undefined ? null : '/api/photo-pet/photo',
    })
  }

  const photoRoute = (req, res) => {
    if (!requireMethod(req, res, 'GET')) return
    const file = currentPhotoFile()
    if (file === undefined) {
      writeJson(res, 404, { ok: false, error: 'no-photo' })
      return
    }
    const dot = file.lastIndexOf('.')
    const ext = dot < 0 ? '' : file.slice(dot).toLowerCase()
    try {
      const body = readFileSync(file)
      res.writeHead(200, {
        'content-type': MIME_BY_EXT[ext] ?? 'application/octet-stream',
        'content-length': String(body.length),
        'cache-control': 'no-cache',
      })
      res.end(body)
    } catch {
      writeJson(res, 404, { ok: false, error: 'no-photo' })
    }
  }

  const uploadRoute = (req, res) => {
    if (!requireMethod(req, res, 'POST')) return
    readBounded(req, PHOTO_BODY_MAX_BYTES).then((body) => {
      let parsed
      try {
        parsed = JSON.parse(body.toString('utf8'))
      } catch {
        writeJson(res, 400, { ok: false, error: 'invalid-json' })
        return
      }
      let photo
      try {
        photo = parsePhotoDataUrl(parsed?.dataUrl)
      } catch (error) {
        writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : 'invalid-photo' })
        return
      }
      const dir = photoDir()
      const file = join(dir, `photo.${photo.ext}`)
      try {
        writeFileSync(file, photo.buffer)
      } catch (error) {
        writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : 'write-failed' })
        return
      }
      // Remove any other stored photo format so exactly one file remains.
      for (const entry of readdirSync(dir)) {
        if (PHOTO_PATTERN.test(entry) && entry !== `photo.${photo.ext}`) {
          try { rmSync(join(dir, entry), { force: true }) } catch { /* best effort */ }
        }
      }
      writeJson(res, 200, { ok: true, photoUrl: '/api/photo-pet/photo' })
    }, (error) => {
      writeJson(res, error instanceof Error && error.message === 'body-too-large' ? 413 : 400, {
        ok: false,
        error: error instanceof Error ? error.message : 'read-failed',
      })
    })
  }

  const deleteRoute = (req, res) => {
    if (!requireMethod(req, res, 'DELETE')) return
    const file = currentPhotoFile()
    if (file !== undefined) {
      try { rmSync(file, { force: true }) } catch { /* best effort */ }
    }
    writeJson(res, 200, { ok: true })
  }

  // ------------------------------------------------------------------
  // AI cutout asset proxy: same-origin model/wasm chunks + a resources.json
  // manifest. Anything under /api/photo-pet/ai/ is loopback-only.
  // ------------------------------------------------------------------
  let aiActiveSource = null // resolved lazily: the first mirror that answers
  const aiFetch = (url) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), AI_FETCH_TIMEOUT_MS)
    return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer))
  }
  const aiResolveSource = async () => {
    if (aiActiveSource !== null) return aiActiveSource
    for (const source of AI_SOURCES) {
      try {
        const response = await aiFetch(source.base + 'resources.json')
        if (!response.ok) continue
        const map = await response.json()
        if (typeof map !== 'object' || map === null) continue
        aiActiveSource = { ...source, map }
        return aiActiveSource
      } catch { /* try the next mirror */ }
    }
    throw new Error('ai-mirrors-unreachable')
  }
  const aiManifest = (source) => {
    const map = source.map
    if (source.aliases === null) return map
    const patched = { ...map }
    for (const [alias, target] of Object.entries(source.aliases)) {
      if (patched[target] !== undefined && patched[alias] === undefined) patched[alias] = patched[target]
    }
    return patched
  }
  const aiChunkFile = (source, hash) => join(photoDir(), 'ai', source.version, hash)

  const aiAssetRoute = (req, res) => {
    if (!guard(req, res)) return
    if (!requireMethod(req, res, 'GET')) return
    let pathname = ''
    try { pathname = new URL(req.url ?? '', 'http://localhost').pathname } catch { pathname = String(req.url ?? '') }
    const name = pathname.replace(/^\/api\/photo-pet\/ai/, '')
    if (name === '' || name === '/') {
      writeJson(res, 404, { ok: false, error: 'ai-asset-missing' })
      return
    }
    if (name === '/resources.json') {
      aiResolveSource().then((source) => {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-cache',
        })
        res.end(JSON.stringify(aiManifest(source)))
      }, (error) => {
        writeJson(res, 502, { ok: false, error: error instanceof Error ? error.message : 'ai-upstream' })
      })
      return
    }
    const hash = name.replace(/^\//, '')
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      writeJson(res, 404, { ok: false, error: 'ai-asset-missing' })
      return
    }
    aiResolveSource().then((source) => {
      const file = aiChunkFile(source, hash)
      try {
        mkdirSync(join(photoDir(), 'ai', source.version), { recursive: true })
        if (existsSync(file)) {
          const body = readFileSync(file)
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': String(body.length),
            'cache-control': 'public, max-age=31536000, immutable',
          })
          res.end(body)
          return
        }
      } catch { /* fall through to fetch */ }
      aiFetch(source.base + hash).then(async (response) => {
        if (!response.ok) throw new Error('ai-chunk ' + response.status)
        const body = Buffer.from(await response.arrayBuffer())
        try { writeFileSync(file, body) } catch { /* cache best effort */ }
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(body.length),
          'cache-control': 'public, max-age=31536000, immutable',
        })
        res.end(body)
      }, (error) => {
        writeJson(res, 502, { ok: false, error: error instanceof Error ? error.message : 'ai-upstream' })
      })
    }, (error) => {
      writeJson(res, 502, { ok: false, error: error instanceof Error ? error.message : 'ai-upstream' })
    })
  }

  const photoDispatch = (req, res) => {
    if (!guard(req, res)) return
    if (req.method === 'GET') return photoRoute(req, res)
    if (req.method === 'POST') return uploadRoute(req, res)
    if (req.method === 'DELETE') return deleteRoute(req, res)
    writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
  }

  return [
    getRoute('/api/photo-pet/state', stateRoute),
    { kind: 'exact', path: '/api/photo-pet/photo', handler: photoDispatch },
    getRoute('/api/photo-pet/activity', (req, res) => {
      writeJson(res, 200, { working: activity.working() })
    }),
    { kind: 'prefix', path: '/api/photo-pet/ai', handler: aiAssetRoute },
  ]
}

/**
 * Session-activity tracker: listen to the durable session event stream and
 * keep a per-session phase map so "working" means *any* session is currently
 * generating. Returns a disposer.
 */
export function trackSessionActivity(ctx) {
  const sessionPhases = new Map()
  let working = false
  const recompute = () => {
    working = [...sessionPhases.values()].some((phase) => WORKING_PHASES.has(phase))
  }
  const setPhase = (session, phase) => {
    const id = String(session?.id ?? session)
    sessionPhases.set(id, phase)
    recompute()
  }
  const disposers = [
    ctx.on('session/event', (session, event) => {
      const phase = projectActivityPhase(event)
      if (phase !== undefined) setPhase(session, phase)
    }),
    ctx.on('session/disposed', (session) => {
      sessionPhases.delete(String(session?.id ?? session))
      recompute()
    }),
  ]
  return {
    working: () => working,
    dispose: () => { for (const dispose of disposers) dispose() },
  }
}

/** Settings schema: display + visibility fields the settings surface edits. */
export function makePhotoPetSettingsSchema() {
  return z.object({
    enabled: z.boolean().default(true),
    visible: z.boolean().default(true),
    size: z.number().step(1).min(DISPLAY_SIZE_MIN).max(DISPLAY_SIZE_MAX).default(140),
    right: z.number().step(1).min(0).max(DISPLAY_INSET_MAX).default(40),
    bottom: z.number().step(1).min(0).max(DISPLAY_INSET_MAX).default(40),
    name: z.string().max(12).default('小宠'),
    smartTrim: z.boolean().default(true),
    aiCutout: z.boolean().default(true),
    /** Working-state bubble lines, one per line. */
    workLines: z.string().default(
      '努力工作中…\n正在思考…\n灵感加载中…\n脑内风暴进行中…\n等一个回音…\n忙着呢,先不闹～',
    ),
    /** Seconds between working-bubble swaps. */
    workInterval: z.number().min(1).max(60).default(4.8),
    /** Which hover fan-menu items are shown (comma-separated ids). */
    fanMenuItems: z.string().default('hide,shrink,rename,photo,cutout,enlarge,reset'),
  })
}

/** Default section value (also the composition base layer). */
export function defaultPhotoPetSettings() {
  return {
    enabled: true,
    visible: true,
    size: 140,
    right: 40,
    bottom: 40,
    name: '小宠',
    smartTrim: true,
    aiCutout: true,
    workLines: '努力工作中…\n正在思考…\n灵感加载中…\n脑内风暴进行中…\n等一个回音…\n忙着呢,先不闹～',
    workInterval: 4.8,
    fanMenuItems: 'hide,shrink,rename,photo,cutout,enlarge,reset',
  }
}

/**
 * Cordis plugin body: register the photo API routes and the settings
 * section. The routes stay up while the plugin row is enabled; the browser
 * half reacts to the settings scope itself.
 */
export function apply(ctx, config = {}) {
  const base = { ...defaultPhotoPetSettings(), ...config }
  let current = () => base

  const activity = trackSessionActivity(ctx)
  const routes = makePhotoPetRoutes(activity)
  const disposers = routes.map((route) => ctx.webServer.register(route))
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
    activity.dispose()
  }, 'photo-pet: routes + activity')

  installSettingsSection(ctx, settingsNamespace(PHOTO_PET_NAMESPACE), makePhotoPetSettingsSchema(), base, {
    setSource: (source) => { current = source },
    onChange: () => { /* the browser half derives everything from the scope */ },
  })
}
