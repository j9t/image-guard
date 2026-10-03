// Times full Image Guard runs on a deterministic sample of a local image directory

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { glob } from 'tinyglobby'
import { fileTypes } from '../src/index.js'
import { createGitignoreFilter } from '../src/gitignore.js'

const dirBenchmark = import.meta.dirname
const fileBaseline = path.join(dirBenchmark, 'baseline.json')
const scriptImageGuard = path.join(dirBenchmark, '../bin/image-guard.js')

// Lets the child process report its own peak memory, on any platform
const hookPeakMemory = 'data:text/javascript,process.on("exit",()=>process.stderr.write(`\\nmaxRSS=${process.resourceUsage().maxRSS}\\n`))'

const getFormat = (file) => path.extname(file).slice(1).toLowerCase().replace('jpeg', 'jpg')

export function parseOptions(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      runs: { type: 'string', default: '3' },
      sample: { type: 'string', default: '300' },
      save: { type: 'boolean', default: false },
      profile: { type: 'boolean', default: false }
    }
  })
  if (positionals.length !== 1) {
    throw new Error('Usage: npm run benchmark -- [--runs <n>] [--sample <n>] [--save] [--profile] <directory>')
  }
  const toCount = (name) => {
    const n = Number(values[name])
    if (!Number.isInteger(n) || n < 1) throw new Error(`\`--${name}\` must be a positive integer`)
    return n
  }
  return { dir: positionals[0], runs: toCount('runs'), sample: toCount('sample'), save: values.save, profile: values.profile }
}

// Takes evenly spaced files per format, proportional to each format’s share, but at least 10 (or all) of each
export function sampleFiles(files, size) {
  const sorted = [...files].sort()
  if (sorted.length <= size) return sorted
  const byFormat = Map.groupBy(sorted, getFormat)
  const sample = []
  for (const list of byFormat.values()) {
    const n = Math.min(list.length, Math.max(10, Math.round(size * list.length / files.length)))
    const step = list.length / n
    for (let i = 0; i < n; i++) sample.push(list[Math.floor(i * step)])
  }
  return sample
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const formatBytes = (bytes) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`

export const formatDelta = (current, baseline) => {
  if (baseline === 0) return current === 0 ? '±0%' : 'n/a'
  const delta = (current - baseline) / baseline * 100
  if (Math.abs(delta) < 0.05) return '±0%'
  return `${delta > 0 ? '+' : '−'}${Math.abs(delta).toFixed(1)}%`
}

const dirSize = (dir) => fs.readdirSync(dir).reduce((sum, file) => sum + fs.statSync(path.join(dir, file)).size, 0)

function runImageGuard(dirCorpus, dirWork) {
  fs.rmSync(dirWork, { recursive: true, force: true })
  fs.cpSync(dirCorpus, dirWork, { recursive: true })
  const start = performance.now()
  const run = spawnSync(process.execPath, ['--import', hookPeakMemory, scriptImageGuard, '-q', dirWork], { encoding: 'utf8' })
  const time = (performance.now() - start) / 1000
  // The child shares the terminal, so Ctrl + C stops it, too
  if (run.signal) throw Object.assign(new Error(`Interrupted (${run.signal})`), { signal: run.signal })
  if (run.status !== 0) throw new Error(`Image Guard failed:\n${run.stderr}`)
  const peakMemory = Number(run.stderr.match(/maxRSS=(\d+)/)[1]) * 1024
  return { time, peakMemory, saved: dirSize(dirCorpus) - dirSize(dirWork) }
}

// Compresses each file on its own, in dry mode, to show which formats and files dominate
async function profile(dirCorpus, names, sample) {
  const { utils } = await import('../src/utils.js')
  const stats = new Map()
  const times = []
  for (const [i, name] of names.entries()) {
    const file = path.join(dirCorpus, name)
    const start = performance.now()
    await utils.compression(file, true, true)
    const time = performance.now() - start
    times.push({ file: sample[i], size: fs.statSync(file).size, time })
    const entry = stats.get(getFormat(name)) ?? { files: 0, time: 0 }
    entry.files++
    entry.time += time
    stats.set(getFormat(name), entry)
  }
  const total = [...stats.values()].reduce((sum, entry) => sum + entry.time, 0)
  console.log('\nTime per format (one file at a time):')
  for (const [format, entry] of [...stats].sort((a, b) => b[1].time - a[1].time)) {
    console.log(`  ${format.padEnd(5)} ${String(entry.files).padStart(4)} files  ${(entry.time / 1000).toFixed(1).padStart(6)} s  ${String(Math.round(entry.time / total * 100)).padStart(3)}%  ${Math.round(entry.time / entry.files)} ms/file`)
  }
  console.log('\nSlowest files:')
  for (const { file, size, time } of times.sort((a, b) => b.time - a.time).slice(0, 10)) {
    console.log(`  ${String(Math.round(time)).padStart(6)} ms  ${file} (${formatBytes(size)})`)
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const dirSource = path.resolve(options.dir)
  if (!fs.existsSync(dirSource) || !fs.statSync(dirSource).isDirectory()) throw new Error(`Not a directory: ${options.dir}`)

  const isGitignored = createGitignoreFilter(dirSource)
  const found = (await glob(fileTypes.map(type => `**/*.${type}`), { cwd: dirSource, onlyFiles: true, caseSensitiveMatch: false }))
    .filter(file => !isGitignored(path.join(dirSource, file)))
  if (found.length === 0) throw new Error(`No images found in ${options.dir}`)
  const sample = sampleFiles(found, options.sample)

  const dirTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'image-guard-benchmark-'))
  const dirCorpus = path.join(dirTemp, 'corpus')
  const dirWork = path.join(dirTemp, 'work')
  const cleanUp = () => fs.rmSync(dirTemp, { recursive: true, force: true })

  // A signal skips `finally`, which would leave the copied images behind
  const onSignal = (signal) => {
    cleanUp()
    process.exit(128 + os.constants.signals[signal])
  }
  process.once('SIGINT', onSignal).once('SIGTERM', onSignal)

  try {
    // Prefixing the index keeps files from different folders apart
    fs.mkdirSync(dirCorpus)
    const names = sample.map((file, i) => `${String(i).padStart(4, '0')}-${path.basename(file)}`)
    sample.forEach((file, i) => fs.copyFileSync(path.join(dirSource, file), path.join(dirCorpus, names[i])))

    const formats = [...Map.groupBy(sample, getFormat)].sort((a, b) => b[1].length - a[1].length).map(([format, list]) => `${format} ${list.length}`).join(', ')
    console.log(`Sample: ${sample.length.toLocaleString('en-US')} of ${found.length.toLocaleString('en-US')} images (${formats}), ${formatBytes(dirSize(dirCorpus))}\n`)

    const runs = []
    for (let i = 1; i <= options.runs; i++) {
      const run = runImageGuard(dirCorpus, dirWork)
      runs.push(run)
      console.log(`Run ${i}: ${run.time.toFixed(2)} s, ${formatBytes(run.peakMemory)} peak memory, ${formatBytes(run.saved)} saved`)
    }

    const result = {
      time: median(runs.map(run => run.time)),
      peakMemory: median(runs.map(run => run.peakMemory)),
      saved: median(runs.map(run => run.saved))
    }
    console.log(`\nMedian: ${result.time.toFixed(2)} s, ${formatBytes(result.peakMemory)} peak memory, ${formatBytes(result.saved)} saved`)

    if (options.save) {
      fs.writeFileSync(fileBaseline, JSON.stringify({ date: new Date().toISOString(), dir: dirSource, sample, ...result }, null, 2) + '\n')
      console.log(`Saved as baseline (${path.relative(process.cwd(), fileBaseline)})`)
    } else if (fs.existsSync(fileBaseline)) {
      const baseline = JSON.parse(fs.readFileSync(fileBaseline, 'utf8'))
      if (baseline.dir !== dirSource || JSON.stringify(baseline.sample) !== JSON.stringify(sample)) {
        console.log('Baseline skipped: It was taken on a different sample—rerun it with `--save`')
      } else {
        console.log(`vs. baseline: ${formatDelta(result.time, baseline.time)} time, ${formatDelta(result.peakMemory, baseline.peakMemory)} peak memory, ${formatDelta(result.saved, baseline.saved)} saved`)
      }
    }

    if (options.profile) await profile(dirCorpus, names, sample)
  } finally {
    cleanUp()
  }
}

// Not `import.meta.main`, which needs Node 24.2 or later
if (fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main()
  } catch (err) {
    if (err.signal) process.exit(128 + os.constants.signals[err.signal])
    console.error(err.message)
    process.exit(1)
  }
}