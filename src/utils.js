// This file, which had been forked from imagemin-merlin, was modified for image-guard: https://github.com/sumcumo/imagemin-merlin/compare/master...j9t:master

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { styleText } from 'node:util'
import decode from 'heic-decode'

const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100 MB

// Compression configuration for each format (as sharp names them)
const formatConfigs = {
  jpeg: {
    options: {},
    settings: { quality: 100 }
  },
  png: {
    options: { pages: -1 },
    settings: { animated: true, compressionLevel: 9, quality: 100 } // Still waiting for APNG support though (`animated` doesn’t seem to have an effect), https://github.com/lovell/sharp/issues/2375
  },
  gif: {
    options: { pages: -1 },
    settings: {
      reuse: true,               // Preserve original palette for lossless quality (default)
      effort: 10,                // Maximum compression effort
      dither: 0,                 // No dithering = lossless quality
      interFrameMaxError: 0,     // No transparency errors = lossless (default)
      interPaletteMaxError: 0,   // Perfect palette match = lossless
      colors: 256                // Full palette available (default)
    }
  },
  webp: {
    options: { pages: -1 },
    settings: { animated: true, lossless: true }
  },
  avif: {
    options: {},
    settings: { effort: 5, lossless: true } // Temporarily specifying effort, too, as per https://github.com/lovell/sharp/issues/4370#issuecomment-2798848572
  }
}

export const hash = (data) => createHash('sha256').update(data).digest('hex')

// Identifies what compression results depend on, to tell when recorded results no longer apply
const fingerprint = hash(JSON.stringify({ formatConfigs, versions: sharp.versions })).slice(0, 16)

// `styleText` detects color on `process.stdout` by default, so anything bound
// for STDERR has to name that stream—otherwise a redirected STDERR collects
// escape codes whenever STDOUT happens to be a terminal
export const styleStderr = (format, text) => styleText(format, text, { stream: process.stderr })

const logMessage = (message, dry, color = 'yellow', quiet = false) => {
  if (quiet) return
  const prefix = dry ? 'Dry run: ' : ''
  console.info(styleText(color, `${prefix}${message}`))
}

// Retry file operations to handle file locking issues
const retryFileOperation = async (operation, maxRetries = 5, delayMs = 100) => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation()
    } catch (err) {
      if ((err.code === 'EPERM' || err.code === 'UNKNOWN') && i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs * (i + 1)))
      } else {
        throw err
      }
    }
  }
}

const compression = async (filename, dry, quiet = false, cache) => {
  const filenameBackup = `${filename}.bak`
  const fileSizeBefore = await size(filename)
  // Track whether original file was successfully replaced
  let replacementSucceeded = false

  if (fileSizeBefore === 0) {
    logMessage(`Skipped ${filename} (${sizeReadable(fileSizeBefore)})`, dry, 'yellow', quiet)
    return 0
  }

  if (fileSizeBefore > MAX_FILE_SIZE) {
    logMessage(`Skipped ${filename} (file too large: ${sizeReadable(fileSizeBefore)})`, dry, 'yellow', quiet)
    return 0
  }

  // Place temp file next to the original to maximize same-device atomic rename
  const tempFilePath = path.join(
    path.dirname(filename),
    `.image-guard-${Date.now()}-${Math.random().toString(36).slice(2)}-${path.basename(filename)}`
  )

  // Track whether the temporary file has been “consumed” (renamed into place or explicitly deleted after copy)
  let tempConsumed = false

  try {
    const ext = path.extname(filename).slice(1).toLowerCase()
    if (!ext) {
      throw new Error(`Cannot determine file type for ${filename}—no extension found`)
    }

    const outputFormat = ext === 'jpg' ? 'jpeg' : ext // sharp uses “jpeg” instead of “jpg”
    const config = formatConfigs[outputFormat]
    if (!config) {
      throw new Error(`Unsupported file type for ${filename}`)
    }

    const input = await fs.readFile(filename)
    const hashInput = cache ? hash(input) : undefined
    if (cache?.has(hashInput)) {
      logMessage(`Skipped ${filename} (already processed)`, dry, 'white', quiet)
      return 0
    }

    const output = await sharp(input, config.options)
      .toFormat(outputFormat, config.settings)
      .toBuffer()
    const fileSizeAfter = output.length
    if (fileSizeAfter === 0) {
      throw new Error('Compressed file size is 0')
    }

    let color = 'white'
    let status = 'Skipped'
    let details = 'already compressed'

    if (fileSizeAfter < fileSizeBefore) {
      color = 'green'
      status = 'Compressed'
      details = `${sizeReadable(fileSizeBefore)} → ${sizeReadable(fileSizeAfter)}`
      if (!dry) {
        // Only now create a backup and replace the original
        await retryFileOperation(() => fs.copyFile(filename, filenameBackup))
        await fs.writeFile(tempFilePath, output)
        // Prefer atomic rename when possible
        try {
          await retryFileOperation(() => fs.rename(tempFilePath, filename))
          // Temp file was renamed (consumed)
          tempConsumed = true
          replacementSucceeded = true
        } catch {
          // Fallback to copy when rename across devices isn’t possible
          await retryFileOperation(() => fs.copyFile(tempFilePath, filename))
          await retryFileOperation(() => fs.unlink(tempFilePath))
          // Temp file explicitly removed after copy
          tempConsumed = true
          replacementSucceeded = true
        }
      }
    } else if (fileSizeAfter > fileSizeBefore) {
      color = 'blue'
      status = 'Skipped'
      details = 'already compressed more effectively'
    }

    // Records the file as it now is, so compressed results aren’t re-encoded again either
    if (!dry) {
      cache?.add(fileSizeAfter < fileSizeBefore ? hash(output) : hashInput)
    }

    logMessage(`${status} ${filename} (${details})`, dry, color, quiet)

    if (dry) {
      return 0
    }

    return fileSizeAfter < fileSizeBefore ? fileSizeBefore - fileSizeAfter : 0

  } catch (err) {

    // Check if this is a file corruption error (sharp/libvips error messages)
    const msg = err.message ? err.message.toLowerCase() : ''
    if (msg.includes('corrupt header') ||
      msg.includes('unexpected end of') ||
      msg.includes('invalid image') ||
      msg.includes('gifload:') ||
      msg.includes('pngload:') ||
      msg.includes('jpegload:') ||
      msg.includes('webpload:') ||
      msg.includes('avifload:')
    ) {
      logMessage(`Skipped ${filename} (corrupt file)`, dry, 'yellow', quiet)
    } else {
      console.error(styleStderr('red', `Error compressing ${filename}:`), err)
    }
    return 0

  } finally {

    // Clean up temp file if it wasn’t consumed (covers error paths)
    if (!tempConsumed) {
      try {
        await retryFileOperation(() => fs.unlink(tempFilePath))
      } catch {
        // Best-effort cleanup—ignore all errors to avoid masking the original error
      }
    }

    // If backup created (i.e., only in improvement path), try to remove it
    if (!dry && replacementSucceeded) {
      try {
        await retryFileOperation(() => fs.unlink(filenameBackup))
      } catch (err) {
        if (err.code !== 'ENOENT') {
          console.warn(styleStderr('yellow', `Failed to delete backup file ${filenameBackup}:`), err)
        }
      }
    } else if (!dry && !replacementSucceeded) {
      // If a backup was created but replacement failed, warn so the user can recover it
      try {
        await fs.access(filenameBackup)
        console.warn(styleStderr('yellow', `Replacement failed for ${filename}; backup preserved at ${filenameBackup}`))
      } catch {
        // No backup exists—nothing to warn about
      }
    }

  }
}

const conversion = async (filename, dry, keepOriginal, quiet = false) => {
  const fileSizeBefore = await size(filename)

  if (fileSizeBefore === 0) {
    logMessage(`Skipped ${filename} (${sizeReadable(fileSizeBefore)})`, dry, 'yellow', quiet)
    return 0
  }

  if (fileSizeBefore > MAX_FILE_SIZE) {
    logMessage(`Skipped ${filename} (file too large: ${sizeReadable(fileSizeBefore)})`, dry, 'yellow', quiet)
    return 0
  }

  if (!/\.hei[cf]$/i.test(filename)) {
    logMessage(`Skipped ${filename} (not a HEIC/HEIF file)`, dry, 'yellow', quiet)
    return 0
  }

  const avifPath = filename.replace(/\.hei[cf]$/i, '.avif')

  // Avoid overwriting an existing AVIF file
  try {
    await fs.access(avifPath)
    logMessage(`Skipped ${filename} (${path.basename(avifPath)} already exists)`, dry, 'yellow', quiet)
    return 0
  } catch {
    // File does not exist—proceed with conversion
  }

  try {
    // Decode HEIC/HEIF to raw pixel data
    const inputBuffer = await fs.readFile(filename)
    const { width, height, data } = await decode({ buffer: inputBuffer })

    // Encode as lossy AVIF—HEIC sources are already lossy (HEVC), so lossless
    // re-encoding would inflate file sizes without any quality benefit
    await sharp(data, { raw: { width, height, channels: 4 } })
      .toFormat('avif', { quality: 80, effort: 5 })
      .toFile(avifPath)

    const fileSizeAfter = await size(avifPath)

    logMessage(`Converted ${filename} → ${path.basename(avifPath)} (${sizeReadable(fileSizeBefore)} → ${sizeReadable(fileSizeAfter)})`, dry, 'cyan', quiet)

    if (dry) {
      await retryFileOperation(() => fs.unlink(avifPath))
      return 0
    }

    // Delete original HEIC/HEIF file unless `--keep-heic` is set
    if (!keepOriginal) {
      await retryFileOperation(() => fs.unlink(filename))
    }

    return fileSizeAfter < fileSizeBefore ? fileSizeBefore - fileSizeAfter : 0

  } catch (err) {
    // Clean up partial AVIF if it was created
    try {
      await retryFileOperation(() => fs.unlink(avifPath))
    } catch (cleanupErr) {
      if (cleanupErr.code !== 'ENOENT') {
        console.warn(styleStderr('yellow', `Failed to clean up ${avifPath}:`), cleanupErr)
      }
    }

    if (err.message && (
      err.message.includes('not a HEIC image') ||
      err.message.includes('HEIF image not found')
    )) {
      logMessage(`Skipped ${filename} (corrupt or unsupported HEIC/HEIF file)`, dry, 'yellow', quiet)
    } else {
      console.error(styleStderr('red', `Error converting ${filename}:`), err)
    }
    return 0
  }
}

const size = async (file) => {
  const stats = await fs.stat(file)
  return stats.size
}

const sizeReadable = (size) => `${(size / 1024).toFixed(2)} KB` // eslint-disable-line no-irregular-whitespace

export const utils = { compression, conversion, sizeReadable, fingerprint }