// This file, which had been forked from imagemin-merlin, was modified for image-guard: https://github.com/sumcumo/imagemin-merlin/compare/master...j9t:master

import { globby, convertPathToPattern } from 'globby'
import { simpleGit } from 'simple-git'
import { parseArgs, styleText } from 'node:util'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
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
      --keep-heic       Keep the original HEIC/HEIF files (only with \`--heic-to-avif\`)
  -i, --ignore <paths>  Comma-separated paths or glob patterns to exclude
  -q, --quiet           Print only the final summary
  -d, --dry             Show what would change without writing any files
      --staged          Process only images staged in Git (not combinable with a directory)
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

  // Share status
  const summary = (run, includesConversion = false) => {
    if (run) {
      const action = includesConversion ? 'compression and conversion' : 'compression'
      console.info(styleText(['bold'], `\nDefensive base ${action} completed. You saved ${utils.sizeReadable(savedKB)}.`))
    } else {
      const what = includesConversion ? 'images to compress or convert' : 'images to compress'
      console.info(styleText(['bold'], `There were no ${what}.`))
    }
  }

  if (argv['keep-heic'] && !argv['heic-to-avif']) {
    console.warn(styleStderr('yellow', '`--keep-heic` has no effect without `--heic-to-avif`'))
  }

  const allTypes = argv['heic-to-avif'] ? [...fileTypes, ...convertTypes] : fileTypes
  if (!argv.quiet) {
    const where = dir === '.' ? '' : `, in ${dir}`
    console.log(`(Search pattern: ${allTypes.join(', ')}${where})\n`)
  }

  let savedKB = 0

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

  const desiredFileConcurrency = Math.min(os.cpus().length, 4)
  const perTaskThreads = Math.max(1, Math.floor(os.cpus().length / Math.max(1, desiredFileConcurrency)))
  try {
    sharp.concurrency(perTaskThreads)
  } catch {
    // Best-effort; ignore if not supported
  }
  const limit = createLimiter(desiredFileConcurrency)

  const processResults = (results) => {
    let hadFailures = false
    let addedKB = 0
    for (const r of results) {
      if (r.status === 'fulfilled') {
        addedKB += r.value
      } else {
        hadFailures = true
        const reason = r.reason && r.reason.message ? r.reason.message : String(r.reason)
        console.error(styleStderr('red', 'Task failed:'), reason)
      }
    }
    return { hadFailures, addedKB }
  }

  const compress = async (files, dry) => {
    if (files.length === 0) return false

    const tasks = files.map(file => limit(() => utils.compression(file, dry, argv.quiet)))
    const results = await Promise.allSettled(tasks)

    const { hadFailures, addedKB } = processResults(results)
    savedKB += addedKB
    return hadFailures
  }

  const convert = async (files, dry, keepOriginal) => {
    if (files.length === 0) return false

    const tasks = files.map(file => limit(() => utils.conversion(file, dry, keepOriginal, argv.quiet)))
    const results = await Promise.allSettled(tasks)

    const { hadFailures, addedKB } = processResults(results)
    savedKB += addedKB
    return hadFailures
  }

  // Plain patterns also get a “/**” variant so directories are excluded with
  // their contents: “dir/” resolves only where globby can stat it, and a bare
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
    const files = await globby(patterns, {
      cwd: dir,
      gitignore: true,
      onlyFiles: true,
      caseSensitiveMatch: false,
      ...options
    })
    return files.map(file => path.join(dir, file))
  }

  const filterStagedFiles = async (stagedFiles, types) => {
    const allowedExts = new Set(types)
    const byExt = stagedFiles.filter(f => allowedExts.has(path.extname(f).slice(1).toLowerCase()))
    const ignoreList = getIgnorePatterns(argv.ignore)

    if (ignoreList.length > 0) {
      const escapedPaths = byExt.map(p => convertPathToPattern(p))
      return globby([...escapedPaths, ...ignoreList], {
        gitignore: true,
        expandDirectories: false,
        onlyFiles: true,
        caseSensitiveMatch: false
      })
    }
    return byExt
  }

  const doConversion = argv['heic-to-avif']
  let hadFailures
  let totalFiles = 0

  if (argv.staged) {
    const git = simpleGit()
    try {
      const diffOutput = await git.raw(['diff', '--name-only', '--cached', '--diff-filter=ACMRT'])
      const stagedFiles = diffOutput.split('\n').map(s => s.trim()).filter(Boolean)

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

  if (hadFailures) {
    process.exitCode = 1
    if (totalFiles > 0) {
      const action = doConversion ? 'compression and conversion' : 'compression'
      const savings = savedKB > 0 ? ` You saved ${utils.sizeReadable(savedKB)}.` : ''
      console.info(styleText(['bold'], `\nDefensive base ${action} partially completed (some tasks failed).${savings}`))
    } else {
      summary(false, doConversion)
    }
  } else if (totalFiles > 0) {
    summary(true, doConversion)
  } else {
    summary(false, doConversion)
  }
}