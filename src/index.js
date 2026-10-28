// This file, which had been forked from imagemin-merlin, was modified for image-guard: https://github.com/sumcumo/imagemin-merlin/compare/master...j9t:master

import { glob, convertPathToPattern } from 'tinyglobby'
import { simpleGit } from 'simple-git'
import { parseArgs, styleText } from 'node:util'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { createCache } from './cache.js'
import { createGitignoreFilter } from './gitignore.js'
import { styleStderr, utils } from './utils.js'

// Files to be compressed
export const fileTypes = ['avif', 'gif', 'jpg', 'jpeg', 'png', 'webp'];

// Files to be converted (require explicit opt-in)
export const convertTypes = ['heic', 'heif'];

// Marks a failure as the user’s to fix rather than a bug
function setupError(message) {
  const err = new Error(message)
  err.setupFailed = true
  return err
}

export async function runImageGuard() {
  const options = {
    'heic-to-avif': { type: 'boolean', default: false },
    'keep-heic': { type: 'boolean', default: false },
    ignore: { type: 'string', short: 'i', multiple: false, default: '' },
    quiet: { type: 'boolean', short: 'q', default: false },
    dry: { type: 'boolean', short: 'd', default: false },
    staged: { type: 'boolean', default: false },
    'no-cache': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
    version: { type: 'boolean', short: 'V', default: false }
  }

  let argv, positionals
  try {
    ({ values: argv, positionals } = parseArgs({ options, allowPositionals: true }))
  } catch (err) {
    // `parseArgs` appends guidance about `--` that only muddies a plain typo
    const [summary] = err.message.split('. ')
    throw setupError(`${summary}—run \`image-guard --help\` for the available options.`)
  }

  if (argv.help) {
    console.log(`Usage: image-guard [options] [directory]

Compress images in place, and optionally convert HEIC/HEIF files to AVIF.

Arguments:
  directory  Directory to process (default: current directory)

Options:
      --heic-to-avif    Also convert HEIC/HEIF files to AVIF
      --keep-heic       Keep the original HEIC/HEIF files as backups (only with \`--heic-to-avif\`)
  -i, --ignore <paths>  Comma-separated paths or glob patterns to exclude
  -q, --quiet           Print only the final summary
  -d, --dry             Show what would change without writing any files
      --staged          Process only images staged in Git (not combinable with a directory)
      --no-cache        Process images even if recorded as already processed
  -h, --help            Show this help
  -V, --version         Show the version number`)
    return
  }

  if (argv.version) {
    const pkg = JSON.parse(fsSync.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    console.log(pkg.version)
    return
  }

  if (positionals.length > 1) {
    throw setupError(`Expected at most one path, got ${positionals.length}: ${positionals.join(', ')}`)
  }

  const dir = positionals[0] || '.'

  if (positionals.length && argv.staged) {
    throw setupError('`--staged` takes its files from Git, not from a path—pass one or the other.')
  }

  if (!fsSync.existsSync(dir)) {
    throw setupError(`No such directory: ${dir}`)
  }

  // A path that is there but isn’t a directory gets its own message
  if (!fsSync.statSync(dir).isDirectory()) {
    throw setupError(`Not a directory: ${dir}`)
  }

  // Remembers images that can’t be compressed further, so later runs can skip them
  const cache = argv['no-cache'] ? undefined : createCache(argv.staged ? '.' : dir, utils.fingerprint)

  const noteCached = () => {
    const hits = cache?.hits ?? 0
    if (hits === 0) return ''
    return hits === 1 ? ' 1 image was skipped as already processed.' : ` ${hits} images were skipped as already processed.`
  }

  // Share status; dry runs tell what a real run would save
  const summary = (run, includesConversion = false, partial = false) => {
    if (!run) {
      const what = includesConversion ? 'images to compress or convert' : 'images to compress'
      console.info(styleText(['bold'], `There were no ${what}.`))
      return
    }
    const action = includesConversion ? 'compression and conversion' : 'compression'
    const outcome = partial ? 'partially completed (some tasks failed)' : 'completed'
    const size = utils.sizeReadable(savedBytes)
    const status = argv.dry ? `Dry run ${outcome}.` : `Defensive base ${action} ${outcome}.`
    const originals = keptOriginals === 1 ? '1 HEIC/HEIF original' : `${keptOriginals} HEIC/HEIF originals`
    const backups = keptOriginals === 1 ? 'a backup' : 'backups'
    const noteKept = keptOriginals === 0 ? '' : ` (not counting ${originals} kept as ${backups})`
    let savings = argv.dry ? ` Defensive base ${action} would save ${size}${noteKept}.` : ` You saved ${size}${noteKept}.`
    // Partial runs only mention savings if there are any,
    // but always note HEIC/HEIF backups
    if (partial && savedBytes === 0) savings = keptOriginals === 0 ? '' : ` Kept ${originals} as ${backups}.`
    console.info(styleText(['bold'], `\n${status}${savings}${noteCached()}`))
  }

  if (argv['keep-heic'] && !argv['heic-to-avif']) {
    console.warn(styleStderr('yellow', '`--keep-heic` has no effect without `--heic-to-avif`'))
  }

  const allTypes = argv['heic-to-avif'] ? [...fileTypes, ...convertTypes] : fileTypes
  if (!argv.quiet) {
    const where = dir === '.' ? '' : `, in ${dir}`
    console.log(`(Search pattern: ${allTypes.join(', ')}${where})\n`)
  }

  let savedBytes = 0
  let keptOriginals = 0

  // Tiny in-house concurrency limiter
  const createLimiter = (concurrency) => {
    concurrency = Math.max(1, Number(concurrency) || 1)
    let active = 0
    const queue = []
    let head = 0 // Index-based queue head to avoid O(n) shift

    const maybeCompact = () => {
      // Compact when a lot of items have been consumed to avoid unbounded growth
      // Heuristic: When head is large and at least half was consumed
      if (head > 1024 && head >= (queue.length - head)) {
        queue.splice(0, head)
        head = 0
      }
    }

    const next = () => {
      if (active >= concurrency) return
      if (head >= queue.length) return
      active++
      const { fn, resolve, reject } = queue[head++]
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          active--
          maybeCompact()
          next()
        })
    }
    return fn => new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject })
      next()
    })
  }

  // Capped to bound memory, as each file in flight holds its decoded pixels
  const desiredFileConcurrency = Math.min(os.availableParallelism(), 8)
  const perTaskThreads = Math.max(1, Math.floor(os.availableParallelism() / desiredFileConcurrency))

  // sharp runs on libuv’s thread pool (4 threads by default), which caps files
  // in flight regardless of the limiter; this must happen before the first
  // asynchronous I/O and respects a user setting
  process.env.UV_THREADPOOL_SIZE ??= String(desiredFileConcurrency)
  try {
    sharp.concurrency(perTaskThreads)
  } catch {
    // Best-effort; ignore if not supported
  }
  const limit = createLimiter(desiredFileConcurrency)

  // Paths written or removed, by the image they came from
  const changesBySource = new Map()

  const processResults = (results, files) => {
    let hadFailures = false
    let addedBytes = 0
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        addedBytes += r.value.saved
        if (r.value.changed.length) changesBySource.set(files[i], r.value.changed)
      } else {
        hadFailures = true
        if (r.reason?.cause) {
          console.error(styleStderr('red', `${r.reason.message}:`), r.reason.cause)
        } else {
          console.error(styleStderr('red', 'Task failed:'), r.reason?.message ?? String(r.reason))
        }
      }
    })
    return { hadFailures, addedBytes }
  }

  const compress = async (files, dry) => {
    if (files.length === 0) return false

    const tasks = files.map(file => limit(() => utils.compression(file, dry, argv.quiet, cache)))
    const results = await Promise.allSettled(tasks)

    const { hadFailures, addedBytes } = processResults(results, files)
    savedBytes += addedBytes
    return hadFailures
  }

  const convert = async (files, dry, keepOriginal) => {
    if (files.length === 0) return false

    const tasks = files.map(file => limit(() => utils.conversion(file, dry, keepOriginal, argv.quiet)))
    const results = await Promise.allSettled(tasks)

    const { hadFailures, addedBytes } = processResults(results, files)
    savedBytes += addedBytes
    keptOriginals += results.filter(r => r.status === 'fulfilled' && r.value.kept).length
    return hadFailures
  }

  // Plain patterns also get a “/**” variant so directories are excluded with
  // their contents: “dir/” resolves only where tinyglobby can stat it, and a bare
  // “dir” only covers what the walk descends into
  const getIgnorePatterns = (ignore) => {
    return (ignore || '')
      .split(',')
      .map(s => s.trim().replace(/^!/, '').replace(/\/+$/, ''))
      .filter(Boolean)
      .flatMap(p => (/[*?[\]{}]/.test(p) ? [`!${p}`] : [`!${p}`, `!${p}/**`]))
  }

  const getFilePattern = (ignore, types = fileTypes) => {
    const patterns = []

    // Rely on `caseSensitiveMatch: false` instead of duplicating upper/lower-case
    for (const fileType of types) {
      patterns.push(`**/*.${fileType}`)
    }

    for (const p of getIgnorePatterns(ignore)) {
      patterns.push(p)
    }

    return patterns
  }

  // Globbing runs with `dir` as its base—so ignore patterns and .gitignore
  // lookup are relative to the searched directory, not to the shell’s—and the
  // results are rejoined for display and file access
  const findFiles = async (patterns, options = {}) => {
    const files = await glob(patterns, {
      cwd: dir,
      onlyFiles: true,
      caseSensitiveMatch: false,
      ...options
    })
    const isGitignored = createGitignoreFilter(dir)
    return files.map(file => path.join(dir, file)).filter(file => !isGitignored(path.resolve(file)))
  }

  const filterStagedFiles = async (stagedFiles, types) => {
    const allowedExts = new Set(types)
    const byExt = stagedFiles.filter(f => allowedExts.has(path.extname(f).slice(1).toLowerCase()))
    const ignoreList = getIgnorePatterns(argv.ignore)

    if (ignoreList.length > 0) {
      const escapedPaths = byExt.map(p => convertPathToPattern(p))
      const files = await glob([...escapedPaths, ...ignoreList], {
        expandDirectories: false,
        onlyFiles: true,
        caseSensitiveMatch: false
      })
      const isGitignored = createGitignoreFilter('.')
      return files.filter(file => !isGitignored(path.resolve(file)))
    }
    return byExt
  }

  const doConversion = argv['heic-to-avif']
  let hadFailures
  let totalFiles = 0

  if (argv.staged) {
    try {
      // Git reports paths relative to the repository root
      process.chdir((await simpleGit().revparse(['--show-toplevel'])).trim())
      const git = simpleGit()
      // `-z` keeps Git from quoting names with non-ASCII characters
      const listFiles = async (args) => (await git.raw(['diff', '--name-only', '-z', ...args])).split('\0').filter(Boolean)
      const stagedFiles = await listFiles(['--cached', '--diff-filter=ACMRT'])
      const unstagedFiles = new Set(await listFiles([]))

      // Collect compression and conversion candidates in parallel
      const [compressionFiles, conversionFiles] = await Promise.all([
        filterStagedFiles(stagedFiles, fileTypes),
        doConversion ? filterStagedFiles(stagedFiles, convertTypes) : Promise.resolve([])
      ])
      totalFiles += compressionFiles.length + conversionFiles.length

      // Run compression and conversion in parallel (non-overlapping file sets)
      const [compFailed, convFailed] = await Promise.all([
        compress(compressionFiles, argv.dry),
        convert(conversionFiles, argv.dry, argv['keep-heic'])
      ])
      hadFailures = compFailed || convFailed

      // Stages the results so the commit includes them, except where that would
      // also stage changes the user left unstaged
      const pathsToStage = []
      for (const [file, changed] of changesBySource) {
        if (unstagedFiles.has(file)) {
          console.warn(styleStderr('yellow', `Didn’t stage ${changed.join(', ')}, as ${file} has unstaged changes`))
        } else {
          pathsToStage.push(...changed)
        }
      }
      // Batched to stay within command-line length limits
      for (let i = 0; i < pathsToStage.length; i += 100) {
        await git.raw(['add', '--all', '--', ...pathsToStage.slice(i, i + 100).map(p => `:(literal)${p}`)])
      }
    } catch (err) {
      console.error(err)
      hadFailures = true
    }
  } else {
    // Single directory traversal for all relevant types
    const allFiles = await findFiles(getFilePattern(argv.ignore, allTypes))

    const compExts = new Set(fileTypes)
    const compressionFiles = allFiles.filter(f => compExts.has(path.extname(f).slice(1).toLowerCase()))
    totalFiles += compressionFiles.length

    if (doConversion) {
      const convExts = new Set(convertTypes)
      const conversionFiles = allFiles.filter(f => convExts.has(path.extname(f).slice(1).toLowerCase()))
      totalFiles += conversionFiles.length

      // Run compression and conversion in parallel (non-overlapping file sets)
      const [compFailed, convFailed] = await Promise.all([
        compress(compressionFiles, argv.dry),
        convert(conversionFiles, argv.dry, argv['keep-heic'])
      ])
      hadFailures = compFailed || convFailed
    } else {
      hadFailures = await compress(compressionFiles, argv.dry)
    }
  }

  if (!argv.dry) cache?.save()

  if (hadFailures) process.exitCode = 1

  // A run that failed before finding files has nothing to sum up
  if (!hadFailures || totalFiles > 0) summary(totalFiles > 0, doConversion, hadFailures)
}