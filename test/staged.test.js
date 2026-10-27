import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import sharp from 'sharp'
import { simpleGit } from 'simple-git'
import { testFolder, imageGuardScript, copyFiles, isIgnoreCandidate, areImagesCompressed } from './helpers.js'

describe('Staged images', () => {
  const run = (args, options = {}) => spawnSync(process.execPath, [imageGuardScript, '--no-cache', '--staged', ...args], { encoding: 'utf8', ...options })

  let tempDir
  let git
  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-guard-staged-'))
    git = simpleGit(tempDir)
    await git.init()
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('Compresses only staged images', async () => {
    copyFiles(testFolder, tempDir)
    await git.add('.')
    run([], { cwd: tempDir })

    const { allCompressed, uncompressedFiles } = areImagesCompressed(tempDir)
    if (uncompressedFiles.length > 0) {
      console.log('The following files were not compressed:', uncompressedFiles.join(', '))
    }
    assert.strictEqual(allCompressed, true)
  })

  test('Fails outside a Git repository without claiming there were no images', () => {
    const dirOutside = fs.mkdtempSync(path.join(os.tmpdir(), 'image-guard-no-repo-'))
    const { status, stdout } = run([], { cwd: dirOutside })
    fs.rmSync(dirOutside, { recursive: true, force: true })

    assert.strictEqual(status, 1)
    assert.doesNotMatch(stdout, /There were no images/)
  })

  test('Ignores a directory with `--staged`', async () => {
    const subDir = path.join(tempDir, 'Assets')
    fs.mkdirSync(subDir, { recursive: true })

    const [ignored, processed] = fs.readdirSync(testFolder).sort().filter(isIgnoreCandidate)
    assert.ok(processed, 'Fixtures must provide one image to ignore and one to process')
    fs.copyFileSync(path.join(testFolder, ignored), path.join(subDir, ignored))
    fs.copyFileSync(path.join(testFolder, processed), path.join(tempDir, processed))
    await git.add('.')

    const insideBefore = fs.statSync(path.join(subDir, ignored))
    const outsideBefore = fs.statSync(path.join(tempDir, processed))

    // Trailing slash and mismatched case both have to be handled, and `--staged` never expands directories
    run(['--ignore=assets/'], { cwd: tempDir })

    const insideAfter = fs.statSync(path.join(subDir, ignored))
    const outsideAfter = fs.statSync(path.join(tempDir, processed))

    assert.strictEqual(insideAfter.size, insideBefore.size, `${ignored} should be untouched inside the ignored directory`)
    assert.strictEqual(insideAfter.mtime.getTime(), insideBefore.mtime.getTime())
    assert.ok(outsideAfter.size < outsideBefore.size, 'File outside the ignored directory should be compressed')
  })

  test('Stages the compressed images', async () => {
    fs.copyFileSync(path.join(testFolder, 'test.png'), path.join(tempDir, 'test.png'))
    await git.add('.')
    const { stdout } = run([], { cwd: tempDir })

    assert.match(stdout, /Compressed test\.png/)
    assert.strictEqual(await git.raw(['diff', '--name-only']), '', 'Nothing should be left unstaged')
  })

  test('Leaves images with unstaged changes unstaged', async () => {
    const file = path.join(tempDir, 'test.png')
    fs.copyFileSync(path.join(testFolder, 'test.png'), file)
    await git.add('.')
    const blobBefore = await git.revparse([':test.png'])
    await sharp(path.join(testFolder, 'test.png')).flop().png({ compressionLevel: 0 }).toFile(file)
    const { stdout, stderr } = run([], { cwd: tempDir })

    assert.match(stdout, /Compressed test\.png/)
    assert.match(stderr, /test\.png.*unstaged changes/)
    assert.strictEqual(await git.revparse([':test.png']), blobBefore)
  })

  test('Processes images with non-ASCII names', async () => {
    fs.copyFileSync(path.join(testFolder, 'test.png'), path.join(tempDir, 'bild-ä.png'))
    await git.add('.')
    const { stdout } = run([], { cwd: tempDir })

    assert.match(stdout, /Compressed bild-ä\.png/)
  })

  test('Processes images when run from a subdirectory', async () => {
    const subDir = path.join(tempDir, 'sub')
    fs.mkdirSync(subDir)
    fs.copyFileSync(path.join(testFolder, 'test.png'), path.join(tempDir, 'test.png'))
    await git.add('.')
    const { stdout, status } = run([], { cwd: subDir })

    assert.strictEqual(status, 0)
    assert.match(stdout, /Compressed test\.png/)
  })

  test('Stages the AVIF file and the removed HEIC file after conversion', async () => {
    fs.copyFileSync(path.join(testFolder, 'test.heic'), path.join(tempDir, 'new.heic'))
    await git.add('.')
    run(['--heic-to-avif'], { cwd: tempDir })

    const staged = (await git.raw(['diff', '--cached', '--name-status'])).trim().split('\n').sort()
    assert.deepStrictEqual(staged, ['A\tnew.avif'])
    assert.strictEqual(await git.raw(['diff', '--name-only']), '')
  })
})