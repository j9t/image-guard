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

export function areImagesCompressed(dir, originalDir = testFolder) {
  const uncompressedFiles = []
  const allCompressed = fs.readdirSync(dir).every(file => {
    if (ignoreFiles.includes(file)) return true
    const ext = path.extname(file).slice(1).toLowerCase()
    if (!allowedFileTypes.includes(ext)) return true
    const filePath = path.join(dir, file)
    const originalFilePath = path.join(originalDir, file)
    try {
      const originalStats = fs.statSync(originalFilePath)
      const compressedStats = fs.statSync(filePath)
      const isCompressed = compressedStats.size < originalStats.size
      if (!isCompressed) {
        uncompressedFiles.push(file)
      }
      return isCompressed
    } catch (err) {
      console.warn(`Skipping possibly corrupt file: ${file} (${err.message})`)
      return true
    }
  })
  return { allCompressed, uncompressedFiles }
}