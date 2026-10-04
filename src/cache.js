import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { styleStderr } from './utils.js'

// Records made with other settings or encoder versions are deleted once unused for this long
const MAX_AGE_STALE = 30 * 24 * 60 * 60 * 1000

// Matches record files only, as the folder may be shared (see `IMAGE_GUARD_CACHE_DIR`)
const PATTERN_RECORD = /^[0-9a-f]{16}\.txt$/

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

// Remembers images that compression can’t shrink any further (as format and
// content hash); the fingerprint keeps records apart per compression settings
// and encoder version, so changing either processes all images again
export function createCache(dirStart, fingerprint) {
  const dirCache = findDirCache(dirStart)
  const fileRecord = path.join(dirCache, `${fingerprint}.txt`)
  const added = []
  let entries = new Set()
  let hits = 0

  try {
    entries = new Set(fs.readFileSync(fileRecord, 'utf8').split('\n').filter(Boolean))
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(styleStderr('yellow', `Could not read the record of processed images (${err.message})`))
  }

  return {
    has(entry) {
      const found = entries.has(entry)
      if (found) hits++
      return found
    },
    add(entry) {
      if (entries.has(entry)) return
      entries.add(entry)
      added.push(entry)
    },
    get hits() {
      return hits
    },
    save() {
      if (added.length === 0) return
      try {
        fs.mkdirSync(dirCache, { recursive: true })
        // Appending (rather than rewriting) keeps what concurrent runs add
        fs.appendFileSync(fileRecord, added.map(entry => `${entry}\n`).join(''))
      } catch (err) {
        console.warn(styleStderr('yellow', `Could not save the record of processed images (${err.message})`))
        return
      }
      let names = []
      try {
        names = fs.readdirSync(dirCache)
      } catch {
        // Nothing to clean up if the folder can’t be read
      }
      for (const name of names) {
        const file = path.join(dirCache, name)
        if (file === fileRecord || !PATTERN_RECORD.test(name)) continue
        try {
          if (Date.now() - fs.statSync(file).mtimeMs > MAX_AGE_STALE) fs.rmSync(file)
        } catch (err) {
          // Another run may have deleted it already
          if (err.code !== 'ENOENT') console.warn(styleStderr('yellow', `Could not delete outdated record ${file} (${err.message})`))
        }
      }
    }
  }
}