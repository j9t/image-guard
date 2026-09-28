import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert'
import simpleGit from 'simple-git'
import { fileTypes as allowedFileTypes } from '../src/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const testFolder = path.join(__dirname, '../media/test')
const testFolderGit = path.join(__dirname, '../media/test-git')
const imageGuardScript = path.join(__dirname, '../bin/image-guard.js')

// Function to copy files
function copyFiles(srcDir, destDir) {
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true })
  }
  fs.readdirSync(srcDir).forEach(file => {
    const srcFile = path.join(srcDir, file)
    const destFile = path.join(destDir, file)
    fs.copyFileSync(srcFile, destFile)
  })
}

// Function to check if images are compressed
const ignoreFiles = ['test#corrupt.gif']

// Supported image that the tool actually rewrites, making it a meaningful `--ignore` target
function isIgnoreCandidate(file) {
  if (ignoreFiles.includes(file)) return false
  return allowedFileTypes.includes(path.extname(file).slice(1).toLowerCase())
}

function areImagesCompressed(dir, originalDir = testFolder) {
  const uncompressedFiles = []
  const allCompressed = fs.readdirSync(dir).every(file => {
    if (ignoreFiles.includes(file)) {
      // console.info(`Ignoring file: ${file}`)
      return true
    }
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

// Function to check if images are already compressed
function areImagesAlreadyCompressed(dir) {
  return fs.readdirSync(dir).some(file => {
    const ext = path.extname(file).slice(1).toLowerCase()
    if (!allowedFileTypes.includes(ext)) return false
    const filePath = path.join(dir, file)
    const originalFilePath = path.join(testFolder, file)
    const originalStats = fs.statSync(originalFilePath)
    const compressedStats = fs.statSync(filePath)
    return compressedStats.size >= originalStats.size
  })
}

describe('Image Guard', () => {
  before(() => {
    // Back up original images
    copyFiles(testFolder, testFolderGit)
  })

  after(() => {
    // Clean up temporary directory
    if (fs.existsSync(testFolderGit)) {
      fs.rmSync(testFolderGit, { recursive: true, force: true })
    }
  })

  test('Compress images', () => {
    // Ensure images in temp folder are not already compressed
    assert.strictEqual(areImagesAlreadyCompressed(testFolderGit), true)

    // Run the script in a completely isolated temporary directory
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-guard-test-'))
    const tempTestFolder = path.join(tempDir, 'test')

    // Copy test files to isolated temp directory
    copyFiles(testFolder, tempTestFolder)

    // Run image-guard from temp directory—only files in “tempDir” will be processed
    const originalCwd = process.cwd()
    try {
      process.chdir(tempDir)
      execFileSync(process.execPath, [imageGuardScript])
    } finally {
      process.chdir(originalCwd)
    }

    // Check results from the isolated temp files
    const { allCompressed, uncompressedFiles } = areImagesCompressed(tempTestFolder, testFolder)

    // Clean up
    fs.rmSync(tempDir, { recursive: true, force: true })

    if (uncompressedFiles.length > 0) {
      console.log('The following files were not compressed:', uncompressedFiles.join(', '))
    }
    assert.strictEqual(allCompressed, true)
  })

  test('Compress only staged images', async () => {
    const git = simpleGit(testFolderGit)

    // Ensure the temp folder exists
    if (!fs.existsSync(testFolderGit)) {
      fs.mkdirSync(testFolderGit, { recursive: true })
    }

    // Initialize a temporary Git repository
    await git.init()
    await git.addConfig('user.name', 'Test User')
    await git.addConfig('user.email', 'test@example.com')

    // Stage files
    await git.add('.')

    // Run image-guard script with “--staged” option
    execFileSync(process.execPath, [imageGuardScript, '--staged'], { cwd: testFolderGit })

    // Verify images are compressed
    const { allCompressed, uncompressedFiles } = areImagesCompressed(testFolderGit)
    if (uncompressedFiles.length > 0) {
      console.log('The following files were not compressed:', uncompressedFiles.join(', '))
    }
    assert.strictEqual(allCompressed, true)
  })

  test('Ensure files are not modified in dry run', () => {
    const originalStats = fs.readdirSync(testFolderGit).sort().map(file => {
      const filePath = path.join(testFolderGit, file)
      return { file, stats: fs.statSync(filePath) }
    })
    execFileSync(process.execPath, [imageGuardScript, '--dry'], { cwd: testFolderGit, stdio: 'pipe' })
    const newStats = fs.readdirSync(testFolderGit).sort().map(file => {
      const filePath = path.join(testFolderGit, file)
      return { file, stats: fs.statSync(filePath) }
    })
    originalStats.forEach((original, index) => {
      const newFile = newStats[index]
      assert.strictEqual(newFile.file, original.file)
      assert.strictEqual(newFile.stats.size, original.stats.size)
      assert.strictEqual(newFile.stats.mtime.getTime(), original.stats.mtime.getTime())
    })
  })

  test('Ignore parity: single file (non-staged vs. staged)', async () => {
    // Prepare isolated temp directory
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-guard-ignore-one-'))
    const tempTestFolder = path.join(tempDir, 'test')
    copyFiles(testFolder, tempTestFolder)

    // Pick a known file from fixture folder
    const entries = fs.readdirSync(tempTestFolder).sort().filter(isIgnoreCandidate)
    assert.ok(entries.length >= 2, 'Fixtures must provide one image to ignore and one to process')
    const target = entries[0]
    const tempPath = path.join(tempTestFolder, target)
    // Snapshot the temp copy before running the CLI to ensure equality checks reflect true non-mutation
    const before = fs.statSync(tempPath)

    // Prepare a pre-run snapshot for non-ignored candidates to verify at least one gets compressed
    const preSnapshot = new Map()
    fs.readdirSync(tempTestFolder).sort().forEach(name => {
      if (name === target) return // excluded: explicitly ignored
      if (ignoreFiles.includes(name)) return // excluded: known corrupt fixture
      const ext = path.extname(name).slice(1).toLowerCase()
      if (!allowedFileTypes.includes(ext)) return
      const p = path.join(tempTestFolder, name)
      preSnapshot.set(name, fs.statSync(p))
    })

    // Patterns are relative to the base of each run: The non-staged run walks “tempDir”, the staged run takes its files from the repository in “tempTestFolder”
    const ignoreNonStaged = path.posix.join('test', target)
    const ignoreStaged = target

    // Non-staged: Run with `--ignore=<file>`
    const originalCwd = process.cwd()
    try {
      process.chdir(tempDir)
      execFileSync(process.execPath, [imageGuardScript, `--ignore=${ignoreNonStaged}`], { stdio: 'pipe' })
    } finally {
      process.chdir(originalCwd)
    }

    // Verify the ignored file was not modified (size and mtime unchanged vs. pre-run snapshot)
    const tempStats = fs.statSync(tempPath)
    assert.strictEqual(tempStats.size, before.size)
    assert.strictEqual(tempStats.mtime.getTime(), before.mtime.getTime())

    // Verify at least one non-ignored candidate was compressed in the non-staged run
    let shrunkCount = 0
    for (const [name, statBefore] of preSnapshot) {
      const statAfter = fs.statSync(path.join(tempTestFolder, name))
      if (statAfter.size < statBefore.size) shrunkCount++
    }
    assert.ok(shrunkCount >= 1, 'Expected at least one non-ignored file to be compressed')

    // Staged: Init repo, stage only target and another file, ensure ignore prevents its processing
    const git = simpleGit(tempTestFolder)
    await git.init()
    await git.addConfig('user.name', 'Test User')
    await git.addConfig('user.email', 'test@example.com')
    await git.add('.')

    // Run staged with `ignore`
    const stagedOutput = execFileSync(process.execPath, [imageGuardScript, '--staged', `--ignore=${ignoreStaged}`], { cwd: tempTestFolder, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })

    // The staged run must have had files to work on, or the ignore check below proves nothing
    assert.doesNotMatch(stagedOutput, /There were no images to compress\./)

    // Check file still not modified compared to its current state (size should not shrink due to ignore)
    const afterStats = fs.statSync(tempPath)
    assert.strictEqual(afterStats.size, tempStats.size)
    assert.strictEqual(afterStats.mtime.getTime(), tempStats.mtime.getTime())

    // Cleanup
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('Ignore supports multiple patterns and directories; case-insensitive', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-guard-ignore-multi-'))
    const tempTestFolder = path.join(tempDir, 'test')
    copyFiles(testFolder, tempTestFolder)

    // Create a subdirectory to simulate directory ignore
    const subDir = path.join(tempTestFolder, 'Assets')
    fs.mkdirSync(subDir, { recursive: true })
    // Copy one file into subdir
    const oneFile = fs.readdirSync(tempTestFolder).sort().find(isIgnoreCandidate)
    assert.ok(oneFile, 'Fixtures must provide an image to ignore')
    fs.copyFileSync(path.join(tempTestFolder, oneFile), path.join(subDir, oneFile))

    // Build ignore list: specific file and directory (case-insensitive path)
    const ignoreArg = `--ignore=test/${oneFile},test/assets/`

    // Snapshot the file placed in ignored directory, before running the CLI
    const preInside = fs.statSync(path.join(subDir, oneFile))

    // Snapshot before running CLI for file-level ignore check
    const preIgnored = fs.statSync(path.join(tempTestFolder, oneFile))

    // Build a pre-run snapshot of candidates that are not ignored
    const preSnapshot = new Map()
    fs.readdirSync(tempTestFolder).sort().forEach(name => {
      // Exclude the explicitly ignored file and anything inside the ignored directory
      if (name === oneFile) return
      if (ignoreFiles.includes(name)) return // exclude corrupt fixture
      const ext = path.extname(name).slice(1).toLowerCase()
      if (!allowedFileTypes.includes(ext)) return
      const p = path.join(tempTestFolder, name)
      preSnapshot.set(name, fs.statSync(p))
    })

    const originalCwd = process.cwd()
    try {
      process.chdir(tempDir)
      execFileSync(process.execPath, [imageGuardScript, ignoreArg], { stdio: 'pipe' })
    } finally {
      process.chdir(originalCwd)
    }

    // Assert ignored file unchanged
    const ignoredCopy = fs.statSync(path.join(tempTestFolder, oneFile))
    assert.strictEqual(ignoredCopy.size, preIgnored.size)
    assert.strictEqual(ignoredCopy.mtime.getTime(), preIgnored.mtime.getTime())

    // Assert that at least one non-ignored file in the root `tempTestFolder` was compressed
    let shrunkCount = 0
    for (const [name, statBefore] of preSnapshot) {
      const statAfter = fs.statSync(path.join(tempTestFolder, name))
      if (statAfter.size < statBefore.size) shrunkCount++
    }
    assert.ok(shrunkCount >= 1, 'Expected at least one non-ignored file to be compressed')

    // Assert file inside ignored directory unchanged, by comparing to its own pre-run snapshot—the original may change
    const inside = fs.statSync(path.join(subDir, oneFile))
    assert.strictEqual(inside.size, preInside.size)
    assert.strictEqual(inside.mtime.getTime(), preInside.mtime.getTime())

    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('Ignore a directory with `--staged`', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-guard-staged-dir-'))
    const subDir = path.join(tempDir, 'Assets')
    fs.mkdirSync(subDir, { recursive: true })

    const [ignored, processed] = fs.readdirSync(testFolder).sort().filter(isIgnoreCandidate)
    assert.ok(processed, 'Fixtures must provide one image to ignore and one to process')
    fs.copyFileSync(path.join(testFolder, ignored), path.join(subDir, ignored))
    fs.copyFileSync(path.join(testFolder, processed), path.join(tempDir, processed))

    const git = simpleGit(tempDir)
    await git.init()
    await git.addConfig('user.name', 'Test User')
    await git.addConfig('user.email', 'test@example.com')
    await git.add('.')

    const insideBefore = fs.statSync(path.join(subDir, ignored))
    const outsideBefore = fs.statSync(path.join(tempDir, processed))

    // Trailing slash and mismatched case both have to be handled, and `--staged` never expands directories
    execFileSync(process.execPath, [imageGuardScript, '--staged', '--ignore=assets/'], { cwd: tempDir, stdio: 'pipe' })

    const insideAfter = fs.statSync(path.join(subDir, ignored))
    const outsideAfter = fs.statSync(path.join(tempDir, processed))

    fs.rmSync(tempDir, { recursive: true, force: true })

    assert.strictEqual(insideAfter.size, insideBefore.size, `${ignored} should be untouched inside the ignored directory`)
    assert.strictEqual(insideAfter.mtime.getTime(), insideBefore.mtime.getTime())
    assert.ok(outsideAfter.size < outsideBefore.size, 'File outside the ignored directory should be compressed')
  })

  test('Ensure quiet mode suppresses per-file logs but keeps summary', () => {
    // Prepare isolated temp directory with test images
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-guard-quiet-'))
    const tempTestFolder = path.join(tempDir, 'test')
    copyFiles(testFolder, tempTestFolder)

    const originalCwd = process.cwd()
    let stdout
    try {
      process.chdir(tempDir)
      stdout = execFileSync(process.execPath, [imageGuardScript, '--quiet'], { encoding: 'utf8' })
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(tempDir, { recursive: true, force: true })
    }

    // Summary should be present
    assert.match(stdout, /Defensive base compression completed\./)
    // Per-file lines like “Compressed <file>” or “Skipped <file>” should be suppressed
    assert.strictEqual(!(/Compressed|Skipped/.test(stdout)), true)
  })

  test('Ensure dry and quiet runs leave no artifacts and do not mutate files', () => {
    // Use isolated temp directory
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-guard-dry-quiet-'))
    const tempTestFolder = path.join(tempDir, 'test')
    copyFiles(testFolder, tempTestFolder)

    // Snapshot sizes/mtimes
    const before = fs.readdirSync(tempTestFolder).sort().map(file => {
      const filePath = path.join(tempTestFolder, file)
      return { file, stats: fs.statSync(filePath) }
    })

    const originalCwd = process.cwd()
    let stdout
    try {
      process.chdir(tempDir)
      stdout = execFileSync(process.execPath, [imageGuardScript, '--dry', '--quiet'], { encoding: 'utf8' })
    } finally {
      process.chdir(originalCwd)
    }

    // Summary present; no per-file lines
    assert.match(stdout, /There were no images to compress\.|Defensive base compression completed\./)
    assert.strictEqual(!(/Compressed|Skipped/.test(stdout)), true)

    // Verify no mutations
    const after = fs.readdirSync(tempTestFolder).sort().map(file => {
      const filePath = path.join(tempTestFolder, file)
      return { file, stats: fs.statSync(filePath) }
    })
    before.forEach((b, i) => {
      const a = after[i]
      assert.strictEqual(a.file, b.file)
      assert.strictEqual(a.stats.size, b.stats.size)
      assert.strictEqual(a.stats.mtime.getTime(), b.stats.mtime.getTime())
    })

    // Ensure no temp or backup artifacts present
    const entries = fs.readdirSync(tempTestFolder)
    const hasTemp = entries.some(name => name.startsWith('.image-guard-'))
    const hasBak = entries.some(name => name.endsWith('.bak'))
    assert.strictEqual(hasTemp, false)
    assert.strictEqual(hasBak, false)

    // Cleanup
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('Ensure no .bak files remain after normal compression', () => {
    // Prepare isolated temp directory with test images
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-guard-bak-'))
    const tempTestFolder = path.join(tempDir, 'test')
    copyFiles(testFolder, tempTestFolder)

    const originalCwd = process.cwd()
    try {
      process.chdir(tempDir)
      execFileSync(process.execPath, [imageGuardScript], { stdio: 'pipe' })
    } finally {
      process.chdir(originalCwd)
    }

    const entries = fs.readdirSync(tempTestFolder)
    const hasBak = entries.some(name => name.endsWith('.bak'))
    assert.strictEqual(hasBak, false)

    // Cleanup
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('Convert HEIC to AVIF with `--heic-to-avif`', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-guard-heic-'))
    const tempTestFolder = path.join(tempDir, 'test')
    copyFiles(testFolder, tempTestFolder)

    // Ensure HEIC test fixture exists
    const heicFile = path.join(tempTestFolder, 'test.heic')
    assert.strictEqual(fs.existsSync(heicFile), true, 'HEIC test fixture must exist')

    // Remove pre-existing AVIF so we can verify the conversion actually creates it
    const avifFile = path.join(tempTestFolder, 'test.avif')
    if (fs.existsSync(avifFile)) {
      fs.unlinkSync(avifFile)
    }

    const originalCwd = process.cwd()
    try {
      process.chdir(tempDir)
      execFileSync(process.execPath, [imageGuardScript, '--heic-to-avif'], { stdio: 'pipe' })
    } finally {
      process.chdir(originalCwd)
    }

    // AVIF should be created by the conversion
    assert.strictEqual(fs.existsSync(avifFile), true, 'AVIF file should be created')
    const avifSize = fs.statSync(avifFile).size
    assert.ok(avifSize > 0, 'AVIF file should not be empty')

    // Lossy AVIF should not be larger than the HEIC source
    const heicSize = fs.statSync(path.join(testFolder, 'test.heic')).size
    assert.ok(avifSize <= heicSize, `AVIF (${avifSize}) should not be larger than HEIC (${heicSize})`)

    // Original HEIC should be deleted
    assert.strictEqual(fs.existsSync(heicFile), false, 'Original HEIC should be deleted')

    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('Ensure `--keep-heic` preserves original HEIC file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-guard-keep-heic-'))
    const tempTestFolder = path.join(tempDir, 'test')
    copyFiles(testFolder, tempTestFolder)

    const heicFile = path.join(tempTestFolder, 'test.heic')
    assert.strictEqual(fs.existsSync(heicFile), true, 'HEIC test fixture must exist')

    const originalCwd = process.cwd()
    try {
      process.chdir(tempDir)
      execFileSync(process.execPath, [imageGuardScript, '--heic-to-avif', '--keep-heic'], { stdio: 'pipe' })
    } finally {
      process.chdir(originalCwd)
    }

    // Both files should exist
    assert.strictEqual(fs.existsSync(path.join(tempTestFolder, 'test.avif')), true, 'AVIF file should be created')
    assert.strictEqual(fs.existsSync(heicFile), true, 'HEIC file should be preserved with `--keep-heic`')

    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('Ensure dry run does not convert HEIC files but reports sizes', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-guard-heic-dry-'))
    const tempTestFolder = path.join(tempDir, 'test')
    copyFiles(testFolder, tempTestFolder)

    // Remove pre-existing AVIF so the conversion path is exercised
    const avifFile = path.join(tempTestFolder, 'test.avif')
    if (fs.existsSync(avifFile)) {
      fs.unlinkSync(avifFile)
    }

    const heicFile = path.join(tempTestFolder, 'test.heic')
    const heicBefore = fs.statSync(heicFile)
    const filesBefore = fs.readdirSync(tempTestFolder).sort()

    const originalCwd = process.cwd()
    let output
    try {
      process.chdir(tempDir)
      output = execFileSync(process.execPath, [imageGuardScript, '--heic-to-avif', '--dry'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    } finally {
      process.chdir(originalCwd)
    }

    // HEIC should be unchanged
    const heicAfter = fs.statSync(heicFile)
    assert.strictEqual(heicAfter.size, heicBefore.size)
    assert.strictEqual(heicAfter.mtime.getTime(), heicBefore.mtime.getTime())

    // No files should be added or removed
    const filesAfter = fs.readdirSync(tempTestFolder).sort()
    assert.deepStrictEqual(filesAfter, filesBefore)

    // Dry run should report size data for HEIC conversion
    assert.match(output, /Converted.*test\.heic.*KB.*→.*KB/i, 'Dry run should report HEIC conversion sizes')

    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('Ensure HEIC files are ignored without `--heic-to-avif` flag', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-guard-heic-noflag-'))
    const tempTestFolder = path.join(tempDir, 'test')
    copyFiles(testFolder, tempTestFolder)

    const heicFile = path.join(tempTestFolder, 'test.heic')
    const heicBefore = fs.statSync(heicFile)

    const originalCwd = process.cwd()
    try {
      process.chdir(tempDir)
      execFileSync(process.execPath, [imageGuardScript], { stdio: 'pipe' })
    } finally {
      process.chdir(originalCwd)
    }

    // HEIC should be untouched
    const heicAfter = fs.statSync(heicFile)
    assert.strictEqual(heicAfter.size, heicBefore.size)
    assert.strictEqual(heicAfter.mtime.getTime(), heicBefore.mtime.getTime())

    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('Skip and report corrupt files', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-guard-corrupt-'))
    const tempTestFolder = path.join(tempDir, 'test')
    copyFiles(testFolder, tempTestFolder)

    const originalCwd = process.cwd()
    let output
    try {
      process.chdir(tempDir)
      output = execFileSync(process.execPath, [imageGuardScript], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(tempDir, { recursive: true, force: true })
    }

    assert.match(output, /Skipped.*test#corrupt\.gif.*corrupt file/i)
  })

  test('Ensure `--keep-heic` without `--heic-to-avif` issues warning', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-guard-keep-warn-'))
    const tempTestFolder = path.join(tempDir, 'test')
    copyFiles(testFolder, tempTestFolder)

    const originalCwd = process.cwd()
    let output
    try {
      process.chdir(tempDir)
      // The warning goes to STDERR, so both streams are combined here
      const run = spawnSync(process.execPath, [imageGuardScript, '--keep-heic'], { encoding: 'utf8' })
      output = `${run.stdout}${run.stderr}`
    } finally {
      process.chdir(originalCwd)
    }

    assert.match(output, /`--keep-heic` has no effect without `--heic-to-avif`/)

    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('Compress images in a directory given as an argument', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-guard-path-'))
    const tempTestFolder = path.join(tempDir, 'test')
    copyFiles(testFolder, tempTestFolder)

    // A .gitignore inside the selected directory must be honored, too
    const nestedDir = path.join(tempTestFolder, 'nested')
    fs.mkdirSync(nestedDir, { recursive: true })
    fs.copyFileSync(path.join(testFolder, 'test.png'), path.join(nestedDir, 'test.png'))
    fs.copyFileSync(path.join(testFolder, 'test.jpg'), path.join(nestedDir, 'test.jpg'))
    fs.writeFileSync(path.join(nestedDir, '.gitignore'), 'test.png\n')
    const nestedIgnoredBefore = fs.statSync(path.join(nestedDir, 'test.png'))
    const nestedProcessedBefore = fs.statSync(path.join(nestedDir, 'test.jpg'))

    // Run from somewhere else entirely, so only the argument can select the files
    execFileSync(process.execPath, [imageGuardScript, tempTestFolder], { cwd: os.tmpdir(), stdio: 'pipe' })

    const { allCompressed, uncompressedFiles } = areImagesCompressed(tempTestFolder, testFolder)

    const nestedIgnoredAfter = fs.statSync(path.join(nestedDir, 'test.png'))
    const nestedProcessedAfter = fs.statSync(path.join(nestedDir, 'test.jpg'))

    fs.rmSync(tempDir, { recursive: true, force: true })

    if (uncompressedFiles.length > 0) {
      console.log('The following files were not compressed:', uncompressedFiles.join(', '))
    }
    assert.strictEqual(allCompressed, true)
    assert.strictEqual(nestedIgnoredAfter.size, nestedIgnoredBefore.size, 'Gitignored file should be untouched')
    assert.strictEqual(nestedIgnoredAfter.mtime.getTime(), nestedIgnoredBefore.mtime.getTime())
    assert.ok(nestedProcessedAfter.size < nestedProcessedBefore.size, 'Non-ignored file in the same directory should be compressed')
  })

  test('Resolve `--ignore` relative to the directory argument', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-guard-path-ignore-'))
    const tempTestFolder = path.join(tempDir, 'test')
    copyFiles(testFolder, tempTestFolder)

    const [target, ...others] = fs.readdirSync(tempTestFolder).sort().filter(isIgnoreCandidate)
    const before = fs.statSync(path.join(tempTestFolder, target))
    const othersBefore = new Map(others.map(name => [name, fs.statSync(path.join(tempTestFolder, name))]))

    execFileSync(process.execPath, [imageGuardScript, `--ignore=${target}`, tempTestFolder], { cwd: os.tmpdir(), stdio: 'pipe' })

    const after = fs.statSync(path.join(tempTestFolder, target))

    // Verify the run was not a no-op: at least one non-ignored image must have been processed
    let shrunkCount = 0
    for (const [name, statBefore] of othersBefore) {
      if (fs.statSync(path.join(tempTestFolder, name)).size < statBefore.size) shrunkCount++
    }

    fs.rmSync(tempDir, { recursive: true, force: true })

    assert.strictEqual(after.size, before.size, `${target} should be untouched`)
    assert.strictEqual(after.mtime.getTime(), before.mtime.getTime())
    assert.ok(shrunkCount >= 1, 'Expected at least one non-ignored file to be compressed')
  })

  test('Fail on a directory that does not exist', () => {
    assert.throws(
      () => execFileSync(process.execPath, [imageGuardScript, './no-such-directory'], { cwd: os.tmpdir(), stdio: 'pipe' }),
      /No such directory/
    )
  })

  test('Fail on a file given instead of a directory', () => {
    const run = spawnSync(process.execPath, [imageGuardScript, path.join(testFolder, 'test.png')], { cwd: os.tmpdir(), encoding: 'utf8' })
    assert.strictEqual(run.status, 1)
    assert.match(run.stderr, /Not a directory/)
    assert.doesNotMatch(run.stderr, /Error running Image Guard:/)
  })

  test('Reject a path combined with `--staged`', () => {
    assert.throws(
      () => execFileSync(process.execPath, [imageGuardScript, '--staged', '.'], { cwd: os.tmpdir(), stdio: 'pipe' }),
      /takes its files from Git/
    )
  })

  test('Reject more than one path', () => {
    assert.throws(
      () => execFileSync(process.execPath, [imageGuardScript, '.', '..'], { cwd: os.tmpdir(), stdio: 'pipe' }),
      /Expected at most one path/
    )
  })

  test('Show help with `--help`', () => {
    const output = execFileSync(process.execPath, [imageGuardScript, '--help'], { cwd: os.tmpdir(), encoding: 'utf8' })
    assert.match(output, /Usage: image-guard \[options\] \[directory\]/)
    assert.match(output, /--heic-to-avif/)
    assert.match(output, /--staged/)
  })

  test('Show help with `-h`', () => {
    const output = execFileSync(process.execPath, [imageGuardScript, '-h'], { cwd: os.tmpdir(), encoding: 'utf8' })
    assert.match(output, /Usage: image-guard/)
  })

  test('Point at `--help` for an unknown option', () => {
    const run = spawnSync(process.execPath, [imageGuardScript, '--bogus'], { cwd: os.tmpdir(), encoding: 'utf8' })
    assert.strictEqual(run.status, 1)
    assert.match(run.stderr, /Unknown option .+image-guard --help/)

    // A setup failure is the user’s to fix, so it prints without the bug-report prefix
    assert.doesNotMatch(run.stderr, /Error running Image Guard:/)
  })

  test('List every short form in the help output', () => {
    const output = execFileSync(process.execPath, [imageGuardScript, '--help'], { cwd: os.tmpdir(), encoding: 'utf8' })
    for (const [short, long] of [['-i', '--ignore'], ['-q', '--quiet'], ['-d', '--dry'], ['-h', '--help'], ['-V', '--version']]) {
      assert.match(output, new RegExp(`${short}, ${long}\\b`), `Help should pair ${short} with ${long}`)
    }
  })

  test('Show the version with `--version` and `-V`', () => {
    const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'))
    for (const flag of ['--version', '-V']) {
      const output = execFileSync(process.execPath, [imageGuardScript, flag], { cwd: os.tmpdir(), encoding: 'utf8' })
      assert.strictEqual(output.trim(), version)
    }
  })

  test('Treat `-d` and `-q` like their long forms, including as a group', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-guard-short-flags-'))
    const tempTestFolder = path.join(tempDir, 'test')
    copyFiles(testFolder, tempTestFolder)

    const before = fs.readdirSync(tempTestFolder).sort().map(file => ({ file, stats: fs.statSync(path.join(tempTestFolder, file)) }))

    const output = execFileSync(process.execPath, [imageGuardScript, '-dq', tempTestFolder], { cwd: os.tmpdir(), encoding: 'utf8' })

    const after = fs.readdirSync(tempTestFolder).sort().map(file => ({ file, stats: fs.statSync(path.join(tempTestFolder, file)) }))

    fs.rmSync(tempDir, { recursive: true, force: true })

    // `-q`: Summary only, no per-file lines
    assert.match(output, /There were no images to compress\.|Defensive base compression completed\./)
    assert.doesNotMatch(output, /Compressed|Skipped/)

    // `-d`: No file touched
    before.forEach((b, i) => {
      assert.strictEqual(after[i].file, b.file)
      assert.strictEqual(after[i].stats.size, b.stats.size)
      assert.strictEqual(after[i].stats.mtime.getTime(), b.stats.mtime.getTime())
    })
  })

  test('Accept `-i` as the short form of `--ignore`', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-guard-short-ignore-'))
    const tempTestFolder = path.join(tempDir, 'test')
    copyFiles(testFolder, tempTestFolder)

    const [target, ...others] = fs.readdirSync(tempTestFolder).sort().filter(isIgnoreCandidate)
    const before = fs.statSync(path.join(tempTestFolder, target))
    const othersBefore = new Map(others.map(name => [name, fs.statSync(path.join(tempTestFolder, name))]))

    execFileSync(process.execPath, [imageGuardScript, '-i', target, tempTestFolder], { cwd: os.tmpdir(), stdio: 'pipe' })

    const after = fs.statSync(path.join(tempTestFolder, target))

    let shrunkCount = 0
    for (const [name, statBefore] of othersBefore) {
      if (fs.statSync(path.join(tempTestFolder, name)).size < statBefore.size) shrunkCount++
    }

    fs.rmSync(tempDir, { recursive: true, force: true })

    assert.strictEqual(after.size, before.size, `${target} should be untouched`)
    assert.strictEqual(after.mtime.getTime(), before.mtime.getTime())
    assert.ok(shrunkCount >= 1, 'Expected at least one non-ignored file to be compressed')
  })
})