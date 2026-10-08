/**
 * dsh-plugin-repowiki — Qoder-style Repo Wiki for DeepSeek Harness.
 *
 * Host half: registers the `repowiki_*` model tools that let an agent scan a
 * repository, plan a catalog, and write a Chinese repo wiki in a layout
 * compatible with Qoder's `.qoder/repowiki` on-disk structure
 * (`<locale>/content` pages, `<locale>/meta/repowiki-metadata.json`,
 * `knowledge/<locale>/…`), plus an incremental index that powers stale-page
 * detection. It also serves three same-origin JSON routes that the browser
 * half (lib/client.js) reads, so no custom remote namespace is needed.
 *
 * All file writes go through `ctx.fs` (resolve → fs/write-intent waterfall →
 * writeText → fs/observed) so the sandbox and the fs-observation policy stay
 * consistent with the built-in read/write tools.
 *
 * @module dsh-plugin-repowiki
 */
import { randomUUID } from 'node:crypto'
import { promises as nfs } from 'node:fs'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Stable Cordis plugin name for the host half. */
export const name = 'dsh-plugin-repowiki'

/** Host services required at activation time. */
export const inject = ['tools', 'fs']

/** The Qoder-compatible placeholder branch marker used in metadata. */
const QODER_BRANCH = 'Q0DeR-MaG1C-BrAnCh-Fo2-NoN-GiT-Or-No-C0MmIt'
/** Placeholder commit id Qoder writes when the repo is not a git checkout. */
const ZERO_COMMIT = '0000000000000000000000000000000000000000'

/** Plugin configuration, resolved by the loader from patch `config`. */
export const Config = z.object({
  wikiRoot: z.string().default('.qoder/repowiki'),
  locale: z.string().default('zh'),
  /** Content page (without .md) that mirrors into `wiki_overview.content`. */
  overviewPage: z.string().default('项目概述'),
  /** Directory base names skipped by scan/status walks. */
  excludeDirs: z.array(z.string()).default([
    'node_modules', 'Library', 'Logs', 'obj', 'bin', 'Temp', 'Build', 'Builds',
    '.git', '.svn', '.idea', '.vs', '.vscode', '.qoder', '.workbuddy', '.dsh',
    'UserSettings', 'Packages', 'AddressableAssetsData',
  ]),
  /** File extensions scanned/hashed by `repowiki_scan` (lowercase, with dot). */
  sourceExts: z.array(z.string()).default([
    '.cs', '.asmdef', '.json', '.md', '.yaml', '.yml', '.js', '.ts', '.lua',
    '.py', '.xml', '.txt', '.shader', '.unity', '.prefab',
  ]),
  /** Hard cap on files recorded by one scan walk. */
  maxScanFiles: z.number().default(3000),
  /** Name of the incremental index file inside the wiki root. */
  indexName: z.string().default('.repowiki-index.json'),
})

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** ISO timestamp with the host's local offset, matching Qoder's style. */
function nowIso() {
  const d = new Date()
  const off = d.getTimezoneOffset()
  const sign = off <= 0 ? '+' : '-'
  const abs = Math.abs(off)
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds())}` +
    `${sign}${pad(abs / 60 | 0)}:${pad(abs % 60)}`
  )
}

/** Normalize a content-relative page path: forward slashes, no .md, no `..`. */
function normalizePagePath(input) {
  let p = String(input ?? '').trim().replace(/\\/g, '/')
  p = p.replace(/\.md$/i, '')
  const segments = p.split('/').filter((s) => s.length > 0 && s !== '.' && s !== '..')
  if (segments.some((s) => /[\\:*?"<>|]/.test(s))) {
    throw new Error(`page path contains reserved characters: ${JSON.stringify(p)}`)
  }
  if (segments.length === 0) throw new Error('page path is empty')
  return segments.join('/')
}

/** Filesystem-safe directory/file base name (Qoder keeps CJK, strips junk). */
function safeName(input) {
  return String(input ?? '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+$/g, '')
    .trim() || '_'
}

/** Quote a scalar for the hand-rolled YAML emitter when necessary. */
function yamlScalar(value) {
  const s = String(value ?? '')
  if (s === '') return "''"
  if (/[:#"'{}\[\],&*?|>%@`]/.test(s) || s !== s.trim() || /^[a-z0-9_.-]+$/i.test(s) === false) {
    return JSON.stringify(s)
  }
  return s
}

/** Emit a tiny YAML mapping suitable for the knowledge index/module files. */
function yamlDump(obj, indent = 0) {
  const pad = ' '.repeat(indent)
  const lines = []
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      lines.push(`${pad}${key}:`)
      for (const item of value) lines.push(`${pad}    - ${yamlScalar(item)}`)
      if (value.length === 0) lines.push(`${pad}${key}: []`)
    } else if (value !== null && typeof value === 'object') {
      lines.push(`${pad}${key}:`)
      lines.push(yamlDump(value, indent + 4))
    } else {
      lines.push(`${pad}${key}: ${yamlScalar(value)}`)
    }
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// ctx.fs helpers (read-before-write keeps the observation policy happy)
// ---------------------------------------------------------------------------

/** Resolve a workspace-relative path against this call's session cwd. */
function sessionCwd(exec) {
  return exec?.agent?.session?.header?.cwd ?? undefined
}

/** Resolve `relPath` through the fs service; returns an FsTarget. */
async function resolveFs(ctx, relPath, cwd, signal) {
  const options = { ...(cwd !== undefined ? { cwd } : {}) }
  return ctx.fs.resolve(relPath, options, signal)
}

/** Stat a target defensively; null when absent or the backend disagrees. */
async function statFs(ctx, target, signal) {
  try {
    const info = await ctx.fs.stat(target, signal)
    return info && typeof info === 'object' ? info : null
  } catch {
    return null
  }
}

/** Read a text file through ctx.fs; null when it does not exist. */
async function readFsText(ctx, relPath, cwd, signal) {
  const target = await resolveFs(ctx, relPath, cwd, signal)
  const info = await statFs(ctx, target, signal)
  if (info === null || (info.type !== undefined && info.type !== 'file')) return null
  try {
    const raw = await ctx.fs.readText(target, signal)
    const text = typeof raw === 'string' ? raw : String(raw?.text ?? '')
    ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, undefined)
    return { text, target, version: info.version, size: info.size }
  } catch {
    return null
  }
}

/**
 * Write a text file through ctx.fs the same way the built-in write tool does:
 * observe existing content first, ask the fs/write-intent waterfall, write,
 * then record the new version. Keeps the sandbox + version guard consistent.
 */
async function writeFsText(ctx, exec, relPath, content, cwd) {
  const signal = exec?.signal
  const target = await resolveFs(ctx, relPath, cwd, signal)
  const info = await statFs(ctx, target, signal)
  if (info !== null && info.type === 'file') {
    try {
      await ctx.fs.readText(target, signal)
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
    } catch { /* unreadable-but-existing: let writeText surface the real error */ }
  }
  const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
  const outcome = await ctx.fs.writeText(target, content, intent, signal)
  ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
  return { target, outcome }
}

// ---------------------------------------------------------------------------
// wiki layout + metadata model
// ---------------------------------------------------------------------------

/** Where every wiki artifact lives, derived from config + session cwd. */
function wikiPaths(config, cwd) {
  const root = config.wikiRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  return {
    root,
    contentDir: `${root}/${config.locale}/content`,
    metaDir: `${root}/${config.locale}/meta`,
    metadataFile: `${root}/${config.locale}/meta/repowiki-metadata.json`,
    knowledgeDir: `knowledge/${config.locale}`,
    knowledgeIndex: `knowledge/${config.locale}/_index.yaml`,
    indexFile: `${root}/${config.indexName}`,
  }
}

/** Empty Qoder-shaped metadata skeleton for a fresh wiki. */
function freshMetadata(repoName) {
  const repoId = randomUUID()
  const now = nowIso()
  return {
    wiki_repo: {
      id: repoId,
      name: repoName,
      progress_status: 'completed',
      wiki_present_status: 'completed',
      optimized_catalog: [],
      current_document_structure: [],
      catalogue_think_content: '',
      recovery_checkpoint: 'wiki_generation_completed',
      last_commit_id: ZERO_COMMIT,
      last_commit_update: now,
      gmt_create: now,
      gmt_modified: now,
      extend_info: JSON.stringify({
        language: 'zh',
        active: true,
        branch: QODER_BRANCH,
        shareStatus: '',
        server_error_code: '',
        cosy_version: '',
      }),
    },
    wiki_catalogs: [],
    wiki_items: [],
    knowledge_relations: [],
    wiki_overview: { content: '', gmt_create: now, gmt_modified: now, id: randomUUID(), repo_id: repoId },
    wiki_readme: { content: 'No readme file', gmt_create: now, gmt_modified: now, id: randomUUID(), repo_id: repoId },
  }
}

/** Empty incremental index. */
function freshIndex(cwd) {
  return {
    version: 1,
    generatedAt: nowIso(),
    cwd: cwd ?? null,
    sourceExts: [],
    sources: {},
    pages: {},
    knowledge: {},
  }
}

/** Load the incremental index through ctx.fs; null when absent. */
async function loadIndex(ctx, config, cwd, signal) {
  const locations = wikiPaths(config, cwd)
  const read = await readFsText(ctx, locations.indexFile, cwd, signal)
  if (read === null) return null
  try {
    const parsed = JSON.parse(read.text)
    if (parsed !== null && typeof parsed === 'object' && parsed.version === 1) return parsed
    return null
  } catch {
    return null
  }
}

/** Load the Qoder-shaped metadata through ctx.fs; null when absent. */
async function loadMetadata(ctx, config, cwd, signal) {
  const locations = wikiPaths(config, cwd)
  const read = await readFsText(ctx, locations.metadataFile, cwd, signal)
  if (read === null) return null
  try {
    const parsed = JSON.parse(read.text)
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.wiki_repo === 'object') {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

/** Build the <cite> block Qoder puts at the top of every content page. */
function citeBlock(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return ''
  const lines = ['', '<cite>', '**本文引用的文件**']
  for (const source of sources) lines.push(`- [${path.basename(String(source))}](file://${source})`)
  lines.push('</cite>', '')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// directory walking (scan / status / page tree)
// ---------------------------------------------------------------------------

/** Recursively walk via ctx.fs.listDir, pruning excluded dirs. Returns rows. */
async function walkWorkspace(ctx, cwd, options) {
  const {
    excludeDirs, sourceExts, maxFiles, signal,
  } = options
  const files = []
  const dirs = []
  let truncated = false
  let excludedHits = 0

  const excluded = new Set(excludeDirs.map((d) => d.toLowerCase()))
  const wantedExt = (name) => {
    const dot = name.lastIndexOf('.')
    if (dot < 0) return false
    return sourceExts.includes(name.slice(dot).toLowerCase())
  }

  async function walk(target, relPath, depth) {
    if (files.length >= maxFiles) {
      truncated = true
      return
    }
    let entries
    try {
      entries = await ctx.fs.listDir(target, signal)
    } catch {
      return // unreadable dir: skip silently
    }
    for (const entry of entries ?? []) {
      const name = entry?.name
      if (typeof name !== 'string' || name.length === 0) continue
      const rel = relPath ? `${relPath}/${name}` : name
      const isDir = entry.type === 'directory'
      if (isDir) {
        if (excluded.has(name.toLowerCase()) || name.startsWith('.')) {
          excludedHits += 1
          continue
        }
        dirs.push(rel)
        await walk(entry.target, rel, depth + 1)
      } else {
        if (!wantedExt(name)) continue
        if (files.length >= maxFiles) {
          truncated = true
          return
        }
        files.push({ rel, target: entry.target, version: entry.version, size: entry.size })
      }
    }
  }

  const rootTarget = await resolveFs(ctx, '.', cwd, signal)
  await walk(rootTarget, '', 0)
  return { files, dirs, truncated, excludedHits }
}

// ---------------------------------------------------------------------------
// the five model tools
// ---------------------------------------------------------------------------

/** Register `repowiki_init`: create or adopt the wiki skeleton. */
function applyInitTool(ctx, config, state) {
  ctx.tools.register(defineTool({
    name: 'repowiki_init',
    description:
      'Create (or adopt an existing) Qoder-style Repo Wiki skeleton inside this workspace: '
      + `content/meta/knowledge directories, an empty \`${config.indexName}\` index, and a fresh `
      + 'repowiki-metadata.json. Idempotent — existing pages and metadata are preserved. '
      + 'After init, write pages with repowiki_write_page and record sources with repowiki_scan.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          locale: { type: 'string', required: true },
          created: { type: 'array', items: { type: 'string' }, required: true },
          adopted: { type: 'boolean', required: true },
          pageCount: { type: 'integer', required: true },
          nextSteps: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Repo Wiki ${value.adopted ? 'adopted' : 'initialized'} at ${value.root} `
          + `(${value.pageCount} pages). Next: ${value.nextSteps.join(' ')}`,
      }],
    },
    async execute(_args, exec) {
      const cwd = sessionCwd(exec)
      if (cwd === undefined) throw new Error('repowiki_init requires an owning agent session workspace')
      const locations = wikiPaths(config, cwd)
      const repoName = path.basename(cwd)
      const created = []

      // 1) incremental index
      let index = await loadIndex(ctx, config, cwd, exec.signal)
      let adopted = true
      if (index === null) {
        adopted = false
        index = freshIndex(cwd)
        index.sourceExts = [...config.sourceExts]
        created.push(locations.indexFile)
        await writeFsText(ctx, exec, locations.indexFile, JSON.stringify(index, null, 2), cwd)
      }

      // 2) Qoder-shaped metadata
      let metadata = await loadMetadata(ctx, config, cwd, exec.signal)
      if (metadata === null) {
        metadata = freshMetadata(repoName)
        created.push(locations.metadataFile)
        await writeFsText(ctx, exec, locations.metadataFile, JSON.stringify(metadata), cwd)
      }

      // 3) knowledge index yaml
      const kIndex = await readFsText(ctx, locations.knowledgeIndex, cwd, exec.signal)
      if (kIndex === null) {
        const rootModule = {
          schema_version: 1,
          locale: 'zh-CN',
          branch: QODER_BRANCH,
          nodes_managed: true,
          exported_at: `${new Date().toISOString().slice(0, 19)}Z`,
          modules: {
            '': {
              dir_name: safeName(`${repoName} 仓库根`),
              title: `${repoName} 仓库根`,
              scope: [],
              source_files: [],
              children: [],
              depends_on: [],
              related_to: [],
            },
          },
        }
        created.push(locations.knowledgeIndex)
        await writeFsText(ctx, exec, locations.knowledgeIndex, yamlDump(rootModule), cwd)
      }

      // 4) overview placeholder page (only when missing)
      const overviewRel = `${locations.contentDir}/${config.overviewPage}.md`
      const overview = await readFsText(ctx, overviewRel, cwd, exec.signal)
      if (overview === null) {
        created.push(overviewRel)
        await writeFsText(ctx, exec, overviewRel, `# ${config.overviewPage}\n\n(待生成)\n`, cwd)
      }

      state.rememberRoot(cwd, config)
      return {
        root: locations.root,
        locale: config.locale,
        created,
        adopted,
        pageCount: Object.keys(index.pages ?? {}).length,
        nextSteps: [
          'run repowiki_scan to snapshot source files for incremental updates',
          'write pages with repowiki_write_page (call repowiki_status before refreshing stale ones)',
        ],
      }
    },
    presentCall() {
      return { card: 'generic', title: 'Repo Wiki: init', kind: 'other', rawInput: {} }
    },
  }))
}

/** Register `repowiki_scan`: snapshot source files into the index. */
function applyScanTool(ctx, config, state) {
  ctx.tools.register(defineTool({
    name: 'repowiki_scan',
    description:
      'Walk the workspace source tree (respecting the plugin excludes) and snapshot every scanned '
      + 'file (path, fs version, size) into the Repo Wiki index, replacing the previous snapshot. '
      + 'Returns a compact inventory (per-directory counts, largest files) — call repowiki_status '
      + 'later to detect what changed since this snapshot.',
    parameters: {
      includeExts: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional extension filter override for this scan, e.g. [".cs", ".md"]. Defaults to plugin config.',
      },
      excludeDirs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional directory-name exclude override for this scan.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cwd: { type: 'string', required: true },
          fileCount: { type: 'integer', required: true },
          totalBytes: { type: 'integer', required: true },
          topDirs: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
          largest: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
          truncated: { type: 'boolean', required: true },
          pageCount: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Repo Wiki scan: ${value.fileCount} files, ${(value.totalBytes / 1024).toFixed(0)} KiB `
          + `across ${value.topDirs.length}+ top dirs${value.truncated ? ' (truncated at cap)' : ''}.`,
      }],
    },
    async execute(args, exec) {
      const cwd = sessionCwd(exec)
      if (cwd === undefined) throw new Error('repowiki_scan requires an owning agent session workspace')
      const index = await loadIndex(ctx, config, cwd, exec.signal)
      if (index === null) {
        throw new Error('no Repo Wiki index found — run repowiki_init first')
      }
      const excludeDirs = Array.isArray(args.excludeDirs) && args.excludeDirs.length > 0
        ? args.excludeDirs
        : config.excludeDirs
      const sourceExts = Array.isArray(args.includeExts) && args.includeExts.length > 0
        ? args.includeExts.map((e) => String(e).toLowerCase())
        : config.sourceExts

      const walk = await walkWorkspace(ctx, cwd, {
        excludeDirs,
        sourceExts,
        maxFiles: config.maxScanFiles,
        signal: exec.signal,
      })

      const sources = {}
      let totalBytes = 0
      for (const file of walk.files) {
        sources[file.rel] = {
          ...(file.version !== undefined ? { version: file.version } : {}),
          ...(file.size !== undefined ? { size: file.size } : {}),
        }
        totalBytes += file.size ?? 0
      }
      index.sources = sources
      index.sourceExts = sourceExts
      index.generatedAt = nowIso()
      index.cwd = cwd
      await writeFsText(ctx, exec, wikiPaths(config, cwd).indexFile, JSON.stringify(index, null, 2), cwd)

      // per-top-directory aggregation for a compact planning summary
      const byTop = new Map()
      for (const file of walk.files) {
        const top = file.rel.includes('/') ? file.rel.split('/')[0] : '(root)'
        const row = byTop.get(top) ?? { dir: top, files: 0, bytes: 0 }
        row.files += 1
        row.bytes += file.size ?? 0
        byTop.set(top, row)
      }
      const topDirs = [...byTop.values()].sort((a, b) => b.files - a.files).slice(0, 12)
      const largest = [...walk.files]
        .sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
        .slice(0, 8)
        .map((f) => ({ path: f.rel, size: f.size }))

      state.rememberRoot(cwd, config)
      return {
        cwd,
        fileCount: walk.files.length,
        totalBytes,
        topDirs,
        largest,
        truncated: walk.truncated,
        pageCount: Object.keys(index.pages ?? {}).length,
      }
    },
    presentCall(args) {
      return { card: 'generic', title: 'Repo Wiki: scan', kind: 'other', rawInput: args }
    },
  }))
}

/** Register `repowiki_status`: diff workspace vs index → stale pages. */
function applyStatusTool(ctx, config, state) {
  ctx.tools.register(defineTool({
    name: 'repowiki_status',
    description:
      'Compare the current workspace against the Repo Wiki index snapshot: which source files '
      + 'changed/added/removed, and which wiki pages are therefore stale (each page records the '
      + 'source files it was written from). Also reports index pages whose .md is missing and '
      + 'content files missing from the index. Read-only.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          upToDate: { type: 'boolean', required: true },
          changedSources: { type: 'array', items: { type: 'string' }, required: true },
          addedSources: { type: 'array', items: { type: 'string' }, required: true },
          removedSources: { type: 'array', items: { type: 'string' }, required: true },
          stalePages: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
            },
            required: true,
          },
          missingPages: { type: 'array', items: { type: 'string' }, required: true },
          orphanPages: { type: 'array', items: { type: 'string' }, required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.upToDate
          ? 'Repo Wiki status: up to date (all indexed sources and pages consistent).'
          : `Repo Wiki status: ${value.summary}`,
      }],
    },
    async execute(_args, exec) {
      const cwd = sessionCwd(exec)
      if (cwd === undefined) throw new Error('repowiki_status requires an owning agent session workspace')
      const index = await loadIndex(ctx, config, cwd, exec.signal)
      if (index === null) throw new Error('no Repo Wiki index found — run repowiki_init first')

      const walk = await walkWorkspace(ctx, cwd, {
        excludeDirs: config.excludeDirs,
        sourceExts: index.sourceExts ?? config.sourceExts,
        maxFiles: config.maxScanFiles,
        signal: exec.signal,
      })
      const current = new Map(walk.files.map((f) => [f.rel, f]))

      const changedSources = []
      const removedSources = []
      for (const [rel, snapshot] of Object.entries(index.sources ?? {})) {
        const now2 = current.get(rel)
        if (now2 === undefined) {
          removedSources.push(rel)
          continue
        }
        if (
          (snapshot.version !== undefined && now2.version !== undefined && snapshot.version !== now2.version)
          || (snapshot.size !== undefined && now2.size !== undefined && snapshot.size !== now2.size)
        ) {
          changedSources.push(rel)
        }
      }
      const addedSources = [...current.keys()]
        .filter((rel) => index.sources?.[rel] === undefined)
        .sort()

      const changedSet = new Set([...changedSources, ...removedSources])
      const stalePages = []
      for (const [pagePath, page] of Object.entries(index.pages ?? {})) {
        const reasons = []
        for (const source of page.sources ?? []) {
          if (changedSet.has(source)) reasons.push(`source changed: ${source}`)
        }
        if (addedSources.length > 0 && Array.isArray(page.sources)) {
          const dirPrefixes = new Set(page.sources.map((s) => path.posix.dirname(s)))
          const relevant = addedSources.filter((added) => [...dirPrefixes].some((d) => added.startsWith(`${d}/`)))
          if (relevant.length > 0) reasons.push(`new sources near page scope: ${relevant.slice(0, 5).join(', ')}${relevant.length > 5 ? ' …' : ''}`)
        }
        if (reasons.length > 0) stalePages.push({ path: pagePath, title: page.title, reasons })
      }

      // content dir vs index pages
      const locations = wikiPaths(config, cwd)
      const onDisk = new Set()
      await collectPages(ctx, locations.contentDir, cwd, exec.signal, onDisk, 0)
      const indexed = new Set(Object.keys(index.pages ?? {}))
      const missingPages = [...indexed].filter((p) => !onDisk.has(p))
      const orphanPages = [...onDisk].filter((p) => !indexed.has(p))

      const upToDate = changedSources.length === 0 && removedSources.length === 0
        && stalePages.length === 0 && missingPages.length === 0 && orphanPages.length === 0
      const parts = []
      if (changedSources.length > 0) parts.push(`${changedSources.length} changed`)
      if (addedSources.length > 0) parts.push(`${addedSources.length} new`)
      if (removedSources.length > 0) parts.push(`${removedSources.length} removed`)
      if (stalePages.length > 0) parts.push(`${stalePages.length} stale pages`)
      if (missingPages.length > 0) parts.push(`${missingPages.length} missing pages`)
      if (orphanPages.length > 0) parts.push(`${orphanPages.length} unindexed pages`)
      return {
        upToDate,
        changedSources: changedSources.slice(0, 60),
        addedSources: addedSources.slice(0, 60),
        removedSources: removedSources.slice(0, 60),
        stalePages: stalePages.slice(0, 60),
        missingPages: missingPages.slice(0, 60),
        orphanPages: orphanPages.slice(0, 60),
        summary: parts.length > 0
          ? `workspace changed since last snapshot — ${parts.join(', ')}. Refresh affected pages with repowiki_write_page, then repowiki_scan again.`
          : 'all consistent',
      }
    },
    presentCall() {
      return { card: 'generic', title: 'Repo Wiki: status', kind: 'other', rawInput: {} }
    },
  }))
}

/** Collect existing content page paths (content-relative, no .md) on disk. */
async function collectPages(ctx, contentDir, cwd, signal, out, depth) {
  if (depth > 8) return
  let entries
  try {
    const target = await resolveFs(ctx, contentDir, cwd, signal)
    entries = await ctx.fs.listDir(target, signal)
  } catch {
    return
  }
  for (const entry of entries ?? []) {
    if (typeof entry?.name !== 'string') continue
    if (entry.type === 'directory') {
      await collectPages(ctx, `${contentDir}/${entry.name}`, cwd, signal, out, depth + 1)
    } else if (entry.name.toLowerCase().endsWith('.md')) {
      out.add(`${contentDir}/${entry.name}`.slice(contentDir.length + 1).replace(/\.md$/i, ''))
    }
  }
}

// ---------------------------------------------------------------------------
// page writing (content md + metadata + index)
// ---------------------------------------------------------------------------

/** Ensure the catalog chain for `pagePath` exists in metadata; returns leaf info. */
function ensureCatalogChain(metadata, pagePath, repoId) {
  const repo = metadata.wiki_repo
  const segments = pagePath.split('/')
  const parentCatalogs = segments.slice(0, -1) // directory nodes
  const pageTitle = segments[segments.length - 1]

  // root catalog: parent of every top-level node
  let rootCatalog = metadata.wiki_catalogs.find((c) => c.parent_id === repo.id)
  if (rootCatalog === undefined) {
    rootCatalog = {
      id: randomUUID(),
      repo_id: repoId,
      name: repo.name,
      description: safeName(`${repo.name} root`),
      prompt: '',
      parent_id: repo.id,
      progress_status: 'completed',
      dependent_files: '',
      gmt_create: nowIso(),
      gmt_modified: nowIso(),
    }
    metadata.wiki_catalogs.push(rootCatalog)
  }

  // directory chain
  let parentCatalogId = rootCatalog.id
  let prefix = ''
  for (const dirName of parentCatalogs) {
    prefix = prefix ? `${prefix}/${dirName}` : dirName
    let catalog = metadata.wiki_catalogs.find((c) => c.name === dirName && c.parent_id === parentCatalogId)
    if (catalog === undefined) {
      catalog = {
        id: randomUUID(),
        repo_id: repoId,
        name: dirName,
        description: safeName(dirName),
        prompt: '',
        parent_id: parentCatalogId,
        progress_status: 'completed',
        dependent_files: '',
        gmt_create: nowIso(),
        gmt_modified: nowIso(),
      }
      metadata.wiki_catalogs.push(catalog)
    }
    parentCatalogId = catalog.id
  }
  return { parentCatalogId, pageTitle }
}

/** Upsert the wiki_item for a page; keep knowledge_relations parent links. */
function upsertItem(metadata, pagePath, title, slug, parentCatalogId, repoId) {
  const now = nowIso()
  let item = metadata.wiki_items.find((it) => it.title === title && it.description === slug)
  if (item === undefined) {
    item = {
      catalog_id: parentCatalogId,
      title,
      description: slug,
      extend: '{}',
      progress_status: 'completed',
      repo_id: repoId,
      reference_count: 0,
      id: randomUUID(),
      gmt_create: now,
      gmt_modified: now,
    }
    metadata.wiki_items.push(item)
  } else {
    item.catalog_id = parentCatalogId
    item.gmt_modified = now
  }
  return item
}

/** Register `repowiki_write_page`: write one wiki page + metadata + index. */
function applyWritePageTool(ctx, config, state) {
  ctx.tools.register(defineTool({
    name: 'repowiki_write_page',
    description:
      'Write one Repo Wiki content page (Chinese markdown, Qoder style) and keep the Qoder-shaped '
      + 'metadata (wiki_catalogs/wiki_items/knowledge_relations/wiki_overview) and the incremental '
      + 'index in sync. Auto-prepends a <cite> block from `sources` when the markdown lacks one. '
      + 'Pass `sources` as repo-relative file paths — they power later stale detection.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Content-relative page path without .md, e.g. "项目概述" or "核心架构/事件驱动架构/事件总线核心". Directories are created as needed.',
      },
      title: {
        type: 'string',
        required: true,
        description: 'Page title (usually the last path segment).',
      },
      markdown: {
        type: 'string',
        required: true,
        description: 'Full page markdown. Include mermaid diagrams, tables and [文件名](file://path) citations as in Qoder pages.',
      },
      sources: {
        type: 'array',
        items: { type: 'string' },
        description: 'Repo-relative source files this page was written from (for <cite> and stale tracking).',
      },
      slug: {
        type: 'string',
        description: 'Optional ASCII description/slug stored in metadata (defaults to a sanitized title).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pagePath: { type: 'string', required: true },
          file: { type: 'string', required: true },
          operation: { type: 'string', enum: ['create', 'update'], required: true },
          warnings: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Repo Wiki page ${value.operation === 'create' ? 'created' : 'updated'}: ${value.file}`
          + (value.warnings.length > 0 ? ` — warnings: ${value.warnings.join('; ')}` : ''),
      }],
    },
    async execute(args, exec) {
      const cwd = sessionCwd(exec)
      if (cwd === undefined) throw new Error('repowiki_write_page requires an owning agent session workspace')
      const pagePath = normalizePagePath(args.path)
      const title = String(args.title ?? pagePath.split('/').pop())
      const locations = wikiPaths(config, cwd)
      const warnings = []

      let index = await loadIndex(ctx, config, cwd, exec.signal)
      if (index === null) throw new Error('no Repo Wiki index found — run repowiki_init first')
      let metadata = await loadMetadata(ctx, config, cwd, exec.signal)
      if (metadata === null) {
        metadata = freshMetadata(path.basename(cwd))
        warnings.push('metadata was missing; created a fresh one')
      }
      const repoId = metadata.wiki_repo.id

      // -- 1) content file
      const sources = Array.isArray(args.sources)
        ? args.sources.map((s) => String(s).replace(/\\/g, '/')).filter((s) => s.length > 0)
        : []
      let markdown = String(args.markdown)
      if (!markdown.startsWith('<cite>') && sources.length > 0) {
        markdown = `${citeBlock(sources)}\n${markdown}`
      }
      const fileRel = `${locations.contentDir}/${pagePath}.md`
      const written = await writeFsText(ctx, exec, fileRel, markdown, cwd)

      // -- 2) metadata upsert
      const slug = args.slug !== undefined && String(args.slug).length > 0
        ? safeName(args.slug)
        : safeName(title)
      const { parentCatalogId } = ensureCatalogChain(metadata, pagePath, repoId)
      const item = upsertItem(metadata, pagePath, title, slug, parentCatalogId, repoId)

      // catalog row for the page itself (Qoder keeps one per node)
      const pageCatalogName = title
      let pageCatalog = metadata.wiki_catalogs.find(
        (c) => c.name === pageCatalogName && c.parent_id === parentCatalogId,
      )
      const now = nowIso()
      if (pageCatalog === undefined) {
        pageCatalog = {
          id: randomUUID(),
          repo_id: repoId,
          name: pageCatalogName,
          description: slug,
          prompt: '',
          parent_id: parentCatalogId,
          progress_status: 'completed',
          dependent_files: sources.join(','),
          gmt_create: now,
          gmt_modified: now,
        }
        metadata.wiki_catalogs.push(pageCatalog)
      } else {
        pageCatalog.description = slug
        pageCatalog.dependent_files = sources.join(',')
        pageCatalog.gmt_modified = now
      }

      // knowledge relation: parent page item → this item (when a parent page exists)
      const parentSegments = pagePath.split('/').slice(0, -1)
      if (parentSegments.length > 0) {
        const parentTitle = parentSegments[parentSegments.length - 1]
        const parentItem = metadata.wiki_items.find((it) => it.title === parentTitle)
        if (parentItem !== undefined && parentItem.id !== item.id) {
          const exists = metadata.knowledge_relations.some(
            (r) => r.source_id === parentItem.id && r.target_id === item.id,
          )
          if (!exists) {
            metadata.knowledge_relations.push({
              id: metadata.knowledge_relations.length + 1,
              source_id: parentItem.id,
              target_id: item.id,
              source_type: 'WIKI_ITEM',
              target_type: 'WIKI_ITEM',
              relationship_type: 'PARENT_CHILD',
              extra: `Wiki parent-child relationship: ${parentItem.id} -> ${item.id}`,
              gmt_create: now,
              gmt_modified: now,
            })
          }
        }
      }

      if (pagePath === config.overviewPage) {
        metadata.wiki_overview.content = markdown.replace(/^<cite>[\s\S]*?<\/cite>\s*/, '')
        metadata.wiki_overview.gmt_modified = now
      }
      metadata.wiki_repo.gmt_modified = now
      await writeFsText(ctx, exec, locations.metadataFile, JSON.stringify(metadata), cwd)

      // -- 3) incremental index
      const sourceStats = {}
      for (const source of sources) {
        const snap = index.sources?.[source]
        if (snap !== undefined) {
          sourceStats[source] = snap
        } else {
          try {
            const target = await resolveFs(ctx, source, cwd, exec.signal)
            const info = await statFs(ctx, target, exec.signal)
            if (info !== null) {
              sourceStats[source] = {
                ...(info.version !== undefined ? { version: info.version } : {}),
                ...(info.size !== undefined ? { size: info.size } : {}),
              }
              warnings.push(`source not in scan snapshot; stat recorded: ${source}`)
            } else {
              warnings.push(`source file not found: ${source}`)
            }
          } catch {
            warnings.push(`source file not found: ${source}`)
          }
        }
      }
      index.pages = index.pages ?? {}
      index.pages[pagePath] = {
        title,
        slug,
        parent: parentSegments.length > 0 ? parentSegments.join('/') : null,
        sources,
        sourceStats,
        updatedAt: now,
        size: Buffer.byteLength(markdown, 'utf8'),
      }
      await writeFsText(ctx, exec, locations.indexFile, JSON.stringify(index, null, 2), cwd)

      state.rememberRoot(cwd, config)
      return {
        pagePath,
        file: written.target.displayPath,
        operation: written.outcome.operation,
        warnings,
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Repo Wiki: write ${args.path}`, kind: 'other', rawInput: { path: args.path, title: args.title } }
    },
  }))
}

/** Register `repowiki_write_knowledge`: write a Qoder-format knowledge module. */
function applyWriteKnowledgeTool(ctx, config, state) {
  ctx.tools.register(defineTool({
    name: 'repowiki_write_knowledge',
    description:
      'Write or update one Qoder-format knowledge module under knowledge/<locale>/: the module '
      + 'markdown, its _module.yaml (scope = repo-relative paths the module covers), and the root '
      + '_index.yaml export index. Use for durable cross-page knowledge cards.',
    parameters: {
      title: {
        type: 'string',
        required: true,
        description: 'Module title, e.g. "基于 Luban + Addressables 的配置系统".',
      },
      modulePath: {
        type: 'string',
        description: 'Module path key in _index.yaml ("" for the repo root module, default "").',
      },
      scope: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'Repo-relative paths/directories this module covers.',
      },
      markdown: {
        type: 'string',
        required: true,
        description: 'Module markdown content.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dir: { type: 'string', required: true },
          files: { type: 'array', items: { type: 'string' }, required: true },
          warnings: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Repo Wiki knowledge module written under ${value.dir} (${value.files.length} files).`,
      }],
    },
    async execute(args, exec) {
      const cwd = sessionCwd(exec)
      if (cwd === undefined) throw new Error('repowiki_write_knowledge requires an owning agent session workspace')
      const locations = wikiPaths(config, cwd)
      const title = String(args.title ?? '').trim()
      if (title.length === 0) throw new Error('title must be a non-empty string')
      const modulePath = String(args.modulePath ?? '').trim()
      const scope = Array.isArray(args.scope)
        ? args.scope.map((s) => String(s).replace(/\\/g, '/')).filter((s) => s.length > 0)
        : []
      const warnings = []

      const dirName = safeName(title)
      const dirRel = `${locations.knowledgeDir}/${dirName}`
      const files = []

      // module markdown
      const mdRel = `${dirRel}/${dirName}.md`
      await writeFsText(ctx, exec, mdRel, String(args.markdown), cwd)
      files.push(mdRel)

      // _module.yaml
      const moduleYaml = {
        schema_version: 1,
        module_path: modulePath,
        title,
        scope,
        source_files: [],
        children: [],
        depends_on: [],
        related_to: [],
      }
      const moduleYamlRel = `${dirRel}/_module.yaml`
      await writeFsText(ctx, exec, moduleYamlRel, yamlDump(moduleYaml), cwd)
      files.push(moduleYamlRel)

      // root _index.yaml upsert
      const kRead = await readFsText(ctx, locations.knowledgeIndex, cwd, exec.signal)
      if (kRead !== null) {
        // naive upsert: re-emit the modules map from index.knowledge + this module
        const index = await loadIndex(ctx, config, cwd, exec.signal)
        if (index === null) {
          warnings.push('no Repo Wiki index; run repowiki_init first')
        } else {
          index.knowledge = index.knowledge ?? {}
          index.knowledge[modulePath || ''] = { dirName, title, scope, updatedAt: nowIso() }
          const modules = {}
          for (const [key, value] of Object.entries(index.knowledge)) {
            modules[key] = {
              dir_name: value.dirName,
              title: value.title,
              scope: value.scope ?? [],
              source_files: [],
              children: [],
              depends_on: [],
              related_to: [],
            }
          }
          const rootModule = {
            schema_version: 1,
            locale: 'zh-CN',
            branch: QODER_BRANCH,
            nodes_managed: true,
            exported_at: `${new Date().toISOString().slice(0, 19)}Z`,
            modules,
          }
          await writeFsText(ctx, exec, locations.knowledgeIndex, yamlDump(rootModule), cwd)
          await writeFsText(ctx, exec, locations.indexFile, JSON.stringify(index, null, 2), cwd)
        }
      } else {
        warnings.push('knowledge/_index.yaml missing; run repowiki_init first')
      }

      state.rememberRoot(cwd, config)
      return { dir: dirRel, files, warnings }
    },
    presentCall(args) {
      return { card: 'generic', title: `Repo Wiki: knowledge ${args.title}`, kind: 'other', rawInput: { title: args.title } }
    },
  }))
}

// ---------------------------------------------------------------------------
// browser-facing same-origin routes (read-only, served from the last root)
// ---------------------------------------------------------------------------

/** Serve a JSON body with standard headers. */
function serveJson(res, status, body) {
  const buffer = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(buffer.length),
    'Cache-Control': 'no-store',
  })
  res.end(buffer)
}

/** Parse the query string of an incoming request. */
function queryParams(req) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  return Object.fromEntries(url.searchParams.entries())
}

/** Reject traversal; return the resolved absolute page file path or null. */
function safeContentFile(rootAbs, locale, relPagePath) {
  const p = String(relPagePath ?? '').replace(/\\/g, '/')
  if (p.length === 0 || p.includes('..')) return null
  const contentRoot = path.resolve(rootAbs, locale, 'content')
  const abs = path.resolve(contentRoot, `${p}.md`)
  if (abs !== contentRoot && !abs.startsWith(`${contentRoot}${path.sep}`)) return null
  if (!abs.toLowerCase().endsWith('.md')) return null
  return abs
}

/** Build the page tree (name, children, page meta) for the wiki route. */
async function buildTree(rootAbs, locale, index) {
  const contentRoot = path.resolve(rootAbs, locale, 'content')
  const pages = index?.pages ?? {}
  async function walk(abs, rel) {
    let entries = []
    try {
      entries = await nfs.readdir(abs, { withFileTypes: true })
    } catch {
      return null
    }
    const node = { name: rel ? path.posix.basename(rel) : '', children: [], page: null }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'zh'))
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const child = await walk(path.join(abs, entry.name), rel ? `${rel}/${entry.name}` : entry.name)
        if (child !== null && (child.children.length > 0 || child.page !== null)) node.children.push(child)
      } else if (entry.name.toLowerCase().endsWith('.md')) {
        const pagePath = rel ? `${rel}/${entry.name.replace(/\.md$/i, '')}` : entry.name.replace(/\.md$/i, '')
        const meta = pages[pagePath] ?? null
        const child = { name: entry.name.replace(/\.md$/i, ''), children: [], page: { path: pagePath, ...meta } }
        node.children.push(child)
      }
    }
    return node
  }
  return walk(contentRoot, '')
}

/** Mount the three browser routes on the (optional) webServer service. */
function applyRoutes(ctx, config, state) {
  ctx.inject(['webServer'], (webCtx) => {
    try {
      const disposeWiki = webCtx.webServer.register({
        kind: 'exact',
        path: '/plugins/dsh-plugin-repowiki/api/wiki',
        handler: async (req, res) => {
          try {
            const root = state.resolveRoot()
            if (root === null) {
              serveJson(res, 200, { state: 'no-wiki', reason: 'Run repowiki_init in a session workspace first.' })
              return
            }
            const rootAbs = path.resolve(root.cwd, config.wikiRoot)
            const index = await nfs.readFile(path.join(rootAbs, config.indexName), 'utf8')
              .then((t) => JSON.parse(t)).catch(() => null)
            const metadata = await nfs.readFile(
              path.join(rootAbs, config.locale, 'meta', 'repowiki-metadata.json'),
              'utf8',
            ).then((t) => JSON.parse(t)).catch(() => null)
            const tree = await buildTree(rootAbs, config.locale, index)
            serveJson(res, 200, {
              state: 'ok',
              workspace: path.basename(root.cwd),
              locale: config.locale,
              generatedAt: index?.generatedAt ?? null,
              updatedAt: metadata?.wiki_repo?.gmt_modified ?? null,
              pageCount: Object.keys(index?.pages ?? {}).length,
              sourceCount: Object.keys(index?.sources ?? {}).length,
              tree: tree?.children ?? [],
            })
          } catch (error) {
            serveJson(res, 500, { state: 'error', error: String(error?.message ?? error) })
          }
        },
      })
      const disposePage = webCtx.webServer.register({
        kind: 'exact',
        path: '/plugins/dsh-plugin-repowiki/api/page',
        handler: async (req, res) => {
          try {
            const root = state.resolveRoot()
            if (root === null) {
              serveJson(res, 404, { state: 'no-wiki' })
              return
            }
            const abs = safeContentFile(path.resolve(root.cwd, config.wikiRoot), config.locale, queryParams(req).path)
            if (abs === null) {
              serveJson(res, 400, { state: 'bad-path' })
              return
            }
            const markdown = await nfs.readFile(abs, 'utf8').catch(() => null)
            if (markdown === null) {
              serveJson(res, 404, { state: 'not-found' })
              return
            }
            const rootAbs = path.resolve(root.cwd, config.wikiRoot)
            const index = await nfs.readFile(path.join(rootAbs, config.indexName), 'utf8')
              .then((t) => JSON.parse(t)).catch(() => null)
            const pagePath = String(queryParams(req).path ?? '')
            const meta = index?.pages?.[pagePath] ?? null
            serveJson(res, 200, {
              state: 'ok',
              path: pagePath,
              markdown,
              title: meta?.title ?? path.posix.basename(pagePath),
              sources: meta?.sources ?? [],
              sourceStats: meta?.sourceStats ?? {},
              updatedAt: meta?.updatedAt ?? null,
              size: meta?.size ?? Buffer.byteLength(markdown, 'utf8'),
            })
          } catch (error) {
            serveJson(res, 500, { state: 'error', error: String(error?.message ?? error) })
          }
        },
      })
      const disposeStatus = webCtx.webServer.register({
        kind: 'exact',
        path: '/plugins/dsh-plugin-repowiki/api/status',
        handler: async (req, res) => {
          try {
            const root = state.resolveRoot()
            if (root === null) {
              serveJson(res, 200, { state: 'no-wiki' })
              return
            }
            const rootAbs = path.resolve(root.cwd, config.wikiRoot)
            const index = await nfs.readFile(path.join(rootAbs, config.indexName), 'utf8')
              .then((t) => JSON.parse(t)).catch(() => null)
            if (index === null) {
              serveJson(res, 200, { state: 'no-index' })
              return
            }
            // stat every page source through node:fs and diff size/mtime
            const result = []
            for (const [pagePath, page] of Object.entries(index.pages ?? {})) {
              const reasons = []
              for (const [source, snapshot] of Object.entries(page.sourceStats ?? {})) {
                const abs = path.resolve(root.cwd, source)
                const info = await nfs.stat(abs).catch(() => null)
                if (info === null) {
                  reasons.push(`missing: ${source}`)
                } else if (snapshot.size !== undefined && snapshot.size !== info.size) {
                  reasons.push(`changed: ${source}`)
                }
              }
              result.push({ path: pagePath, title: page.title, updatedAt: page.updatedAt, stale: reasons.length > 0, reasons: reasons.slice(0, 8) })
            }
            serveJson(res, 200, { state: 'ok', pages: result })
          } catch (error) {
            serveJson(res, 500, { state: 'error', error: String(error?.message ?? error) })
          }
        },
      })
      ctx.effect(() => () => {
        disposeWiki()
        disposePage()
        disposeStatus()
      }, 'repowiki: browser routes')
    } catch (error) {
      ctx.logger?.warn?.(`dsh-plugin-repowiki: could not mount browser routes: ${error?.message ?? error}`)
    }
  })
}

// ---------------------------------------------------------------------------
// plugin entry
// ---------------------------------------------------------------------------

/**
 * Register the five Repo Wiki tools and the browser routes.
 * @param ctx - host plugin context carrying the tools and fs services.
 * @param config - deployment configuration from the patch layer.
 */
export function apply(ctx, config) {
  /** Last workspace this plugin touched; the browser routes read from it. */
  const state = {
    last: null,
    rememberRoot(cwd, cfg) {
      this.last = { cwd, wikiRoot: cfg.wikiRoot, locale: cfg.locale, at: nowIso() }
    },
    resolveRoot() {
      return this.last
    },
  }

  applyInitTool(ctx, config, state)
  applyScanTool(ctx, config, state)
  applyStatusTool(ctx, config, state)
  applyWritePageTool(ctx, config, state)
  applyWriteKnowledgeTool(ctx, config, state)
  applyRoutes(ctx, config, state)
}
