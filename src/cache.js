import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { styleStderr } from './utils.js'

// Records made with other settings or encoder versions are deleted once unused for this long
const MAX_AGE_STALE = 30 * 24 * 60 * 60 * 1000

// The nearest project’s node_modules/.cache, else the per-user cache folder
export function findDirCache(dirStart) {
  if (process.env.IMAGE_GUARD_CACHE_DIR) return path.resolve(process.env.IMAGE_GUARD_CACHE_DIR)
  for (let current = path.resolve(dirStart); ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, 'package.json'))) {
      const dirModules = path.join(current, 'node_modules')
      if (fs.existsSync(dirModules)) return path.join(dirModules, '.cache', 'image-guard')
      break
    }
    if (path.dirname(current) === current) break
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'image-guard')
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'image-guard', 'Cache')
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'image-guard')
}

// Remembers the content hashes of images that compression can’t shrink any
// further; the fingerprint keeps records apart per compression settings and
// encoder version, so changing either processes all images again
export function createCache(dirStart, fingerprint) {
  const dirCache = findDirCache(dirStart)
  const fileRecord = path.join(dirCache, `${fingerprint}.txt`)
  const added = []
  let hashes = new Set()
  let hits = 0

  try {
    hashes = new Set(fs.readFileSync(fileRecord, 'utf8').split('\n').filter(Boolean))
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(styleStderr('yellow', `Could not read the record of processed images (${err.message})`))
  }

  return {
    has(hashFile) {
      const found = hashes.has(hashFile)
      if (found) hits++
      return found
    },
    add(hashFile) {
      if (hashes.has(hashFile)) return
      hashes.add(hashFile)
      added.push(hashFile)
    },
    get hits() {
      return hits
    },
    save() {
      if (added.length === 0) return
      try {
        fs.mkdirSync(dirCache, { recursive: true })
        // Appending (rather than rewriting) keeps what concurrent runs add
        fs.appendFileSync(fileRecord, added.map(hashFile => `${hashFile}\n`).join(''))
        for (const name of fs.readdirSync(dirCache)) {
          const file = path.join(dirCache, name)
          if (file !== fileRecord && name.endsWith('.txt') && Date.now() - fs.statSync(file).mtimeMs > MAX_AGE_STALE) {
            fs.rmSync(file, { force: true })
          }
        }
      } catch (err) {
        console.warn(styleStderr('yellow', `Could not save the record of processed images (${err.message})`))
      }
    }
  }
}