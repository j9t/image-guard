import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { beforeEach, after } from 'node:test'
import { fileTypes as allowedFileTypes } from '../src/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export { allowedFileTypes }
export const testFolder = path.join(__dirname, '../media/test')
export const imageGuardScript = path.join(__dirname, '../bin/image-guard.js')

// Keeps every run from reading or writing the real record of processed images (one per test file, as each runs in its own process)
export const dirCache = path.join(os.tmpdir(), `image-guard-cache-${process.pid}`)
process.env.IMAGE_GUARD_CACHE_DIR = dirCache

// Starts each test without a record, so earlier tests can’t make it skip images
export function resetRecord() {
  beforeEach(() => {
    fs.rmSync(dirCache, { recursive: true, force: true })
  })
  after(() => {
    fs.rmSync(dirCache, { recursive: true, force: true })
  })
}

export function copyFiles(srcDir, destDir) {
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true })
  }
  fs.readdirSync(srcDir).forEach(file => {
    const srcFile = path.join(srcDir, file)
    const destFile = path.join(destDir, file)
    fs.copyFileSync(srcFile, destFile)
  })
}

export const ignoreFiles = ['test#corrupt.gif']

// Supported image that the tool actually rewrites, making it a meaningful `--ignore` target
export function isIgnoreCandidate(file) {
  if (ignoreFiles.includes(file)) return false
  return allowedFileTypes.includes(path.extname(file).slice(1).toLowerCase())
}

// Checks every original, so images missing from `dir` count as uncompressed
export function areImagesCompressed(dir, originalDir = testFolder) {
  const uncompressedFiles = []
  for (const file of fs.readdirSync(originalDir)) {
    if (ignoreFiles.includes(file)) continue
    const ext = path.extname(file).slice(1).toLowerCase()
    if (!allowedFileTypes.includes(ext)) continue
    try {
      const originalStats = fs.statSync(path.join(originalDir, file))
      const compressedStats = fs.statSync(path.join(dir, file))
      if (compressedStats.size >= originalStats.size) uncompressedFiles.push(file)
    } catch (err) {
      console.warn(`Could not compare ${file} (${err.message})`)
      uncompressedFiles.push(file)
    }
  }
  return { allCompressed: uncompressedFiles.length === 0, uncompressedFiles }
}