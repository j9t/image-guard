import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import { simpleGit } from 'simple-git'
import { testFolder, imageGuardScript, dirCache, resetRecord, copyFiles, isIgnoreCandidate } from './helpers.js'

resetRecord()

describe('Record of processed images', () => {
  const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const run = (args, options = {}) => execFileSync(process.execPath, [imageGuardScript, ...args], { encoding: 'utf8', cwd: os.tmpdir(), ...options })

  // Environment without the test override, so Image Guard picks the folder itself
  const envWithoutOverride = (extra = {}) => {
    const env = { ...process.env, ...extra }
    delete env.IMAGE_GUARD_CACHE_DIR
    return env
  }

  let tempDir
  let tempTestFolder
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-guard-record-'))
    tempTestFolder = path.join(tempDir, 'test')
    copyFiles(testFolder, tempTestFolder)
  })

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('Skips images processed in an earlier run', () => {
    run([tempTestFolder])
    const stdout = run([tempTestFolder])

    const candidates = fs.readdirSync(tempTestFolder).filter(isIgnoreCandidate)
    assert.ok(candidates.length > 0)
    for (const file of candidates) {
      assert.match(stdout, new RegExp(`Skipped .*${escapeRegExp(file)} \\(already processed\\)`))
    }
    assert.doesNotMatch(stdout, /Compressed/)
    assert.match(stdout, new RegExp(`${candidates.length} images were skipped as already processed\\.`))
  })

  test('Skips staged images processed in an earlier run', async () => {
    const git = simpleGit(tempTestFolder)
    await git.init()
    await git.add('.')
    run(['--staged'], { cwd: tempTestFolder })
    const stdout = run(['--staged'], { cwd: tempTestFolder })

    const candidates = fs.readdirSync(tempTestFolder).filter(isIgnoreCandidate)
    for (const file of candidates) {
      assert.match(stdout, new RegExp(`Skipped .*${escapeRegExp(file)} \\(already processed\\)`))
    }
    assert.doesNotMatch(stdout, /Compressed/)
  })

  test('Does not record corrupt files', () => {
    run([tempTestFolder])
    const stdout = run([tempTestFolder])

    assert.match(stdout, /Skipped.*test#corrupt\.gif.*corrupt file/i)
  })

  test('Processes a recorded image again once it changes', () => {
    run([tempTestFolder])
    fs.copyFileSync(path.join(testFolder, 'test.png'), path.join(tempTestFolder, 'test.png'))
    const stdout = run([tempTestFolder])

    assert.match(stdout, /Compressed .*test\.png/)
    assert.doesNotMatch(stdout, /test\.png \(already processed\)/)
  })

  test('Processes recorded content again under an extension for another format', () => {
    run([tempTestFolder])
    fs.copyFileSync(path.join(tempTestFolder, 'test.png'), path.join(tempTestFolder, 'test-png.webp'))
    const stdout = run([tempTestFolder])

    assert.match(stdout, /test\.png \(already processed\)/)
    assert.doesNotMatch(stdout, /test-png\.webp \(already processed\)/)
  })

  test('Processes all images with `--no-cache`', () => {
    run([tempTestFolder])
    const stdout = run(['--no-cache', tempTestFolder])

    assert.doesNotMatch(stdout, /already processed/)
    assert.strictEqual(fs.existsSync(dirCache), true, 'The record from the first run should be kept')
  })

  test('Does not write the record in dry runs', () => {
    run(['--dry', tempTestFolder])

    assert.strictEqual(fs.existsSync(dirCache), false)
  })

  test('Ignores records made with other compression settings', () => {
    // test.JPEG duplicates test.jpg, which the run would rightly skip once the other is processed
    fs.rmSync(path.join(tempTestFolder, 'test.JPEG'))
    run([tempTestFolder])
    const [fileRecord] = fs.readdirSync(dirCache)
    // Changes one character of the fingerprint, as another version or setting would
    const fileRecordOther = `${fileRecord[0] === '0' ? '1' : '0'}${fileRecord.slice(1)}`
    fs.renameSync(path.join(dirCache, fileRecord), path.join(dirCache, fileRecordOther))
    const stdout = run([tempTestFolder])

    assert.doesNotMatch(stdout, /already processed/)
  })

  test('Deletes outdated records but no other files', () => {
    fs.mkdirSync(dirCache, { recursive: true })
    const fileStale = path.join(dirCache, '0123456789abcdef.txt')
    const fileOther = path.join(dirCache, 'notes.txt')
    const timeOld = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
    for (const file of [fileStale, fileOther]) {
      fs.writeFileSync(file, '')
      fs.utimesSync(file, timeOld, timeOld)
    }
    const stdout = run([tempTestFolder])

    assert.strictEqual(fs.existsSync(fileStale), false)
    assert.strictEqual(fs.existsSync(fileOther), true)
    assert.strictEqual(fs.readdirSync(dirCache).length, 2, 'The current record should be kept, too')
    assert.doesNotMatch(stdout, /Could not/)
  })

  test('Marks the record as used when a run only skips images', () => {
    run([tempTestFolder])
    const [fileRecord] = fs.readdirSync(dirCache).map(name => path.join(dirCache, name))
    const timeOld = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
    fs.utimesSync(fileRecord, timeOld, timeOld)
    run([tempTestFolder])

    assert.ok(fs.statSync(fileRecord).mtimeMs > timeOld.getTime(), 'The record should count as recently used')
  })

  test('Keeps the record in the project’s node_modules/.cache', () => {
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{}\n')
    fs.mkdirSync(path.join(tempDir, 'node_modules'))
    run([tempTestFolder], { env: envWithoutOverride() })

    const dirRecord = path.join(tempDir, 'node_modules', '.cache', 'image-guard')
    assert.strictEqual(fs.readdirSync(dirRecord).length, 1)
  })

  test('Falls back to the per-user cache folder without node_modules', () => {
    const dirHome = path.join(tempDir, 'home')
    const dirLocalAppData = path.join(dirHome, 'AppData', 'Local')
    run([tempTestFolder], { env: envWithoutOverride({ HOME: dirHome, USERPROFILE: dirHome, LOCALAPPDATA: dirLocalAppData, XDG_CACHE_HOME: '' }) })

    const dirRecord = {
      darwin: path.join(dirHome, 'Library', 'Caches', 'image-guard'),
      win32: path.join(dirLocalAppData, 'image-guard', 'Cache')
    }[process.platform] ?? path.join(dirHome, '.cache', 'image-guard')
    assert.strictEqual(fs.readdirSync(dirRecord).length, 1)
  })
})
