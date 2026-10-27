// This file, which had been forked from imagemin-merlin, was modified for image-guard: https://github.com/sumcumo/imagemin-merlin/compare/master...j9t:master

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { styleText } from 'node:util'
import decode from 'heic-decode'

const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100 MB
// Limits palette reduction, as checking it holds two decoded copies of the image (320 MB at the limit)
const MAX_PIXELS_QUANTIZED = 40 * 1000 * 1000 // 40 megapixels

// Compression configuration for each format (as sharp names them)
const formatConfigs = {
  jpeg: {
    options: {},
    settings: { quality: 100 }
  },
  png: {
    options: {},
    settings: { compressionLevel: 9 },
    // Lossless for images that already use a palette
    settingsPalette: { palette: true, quality: 100, dither: 0, effort: 10 },
    // Reduces other images to 256 colors, kept only where that doesn’t visibly change them
    // (effort 7 being as small and as close to the original as 10, in two-thirds of the time)
    settingsQuantized: { palette: true, quality: 100, effort: 7 }
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

// Checks the profile description, as sRGB profiles only add bytes (sRGB being
// what images without a profile are taken to be)
const isSrgbProfile = (icc) => {
  try {
    const count = icc.readUInt32BE(128)
    for (let i = 0; i < count; i++) {
      const entry = 132 + i * 12
      if (icc.toString('latin1', entry, entry + 4) !== 'desc') continue
      const offset = icc.readUInt32BE(entry + 4)
      // Removing null bytes covers both ASCII and UTF-16 descriptions
      return icc.toString('latin1', offset, offset + icc.readUInt32BE(entry + 8)).replaceAll('\0', '').includes('sRGB')
    }
  } catch {
    // Malformed profiles are kept
  }
  return false
}

// Keeps what affects how the image looks—orientation, color profile, CMYK, grayscale, and
// high bit depth—while dropping all other metadata
const createPipeline = (input, format, metadata, quantize = false) => {
  const { options, settings, settingsPalette, settingsQuantized } = formatConfigs[format]
  const settingsImage = quantize ? settingsQuantized : metadata.isPalette && settingsPalette ? settingsPalette : settings
  let pipeline = sharp(input, options)
  if (metadata.icc && !isSrgbProfile(metadata.icc)) pipeline = pipeline.keepIccProfile()
  if (metadata.orientation > 1) pipeline = pipeline.withExif({ IFD0: { Orientation: String(metadata.orientation) } })
  if (metadata.space === 'cmyk') pipeline = pipeline.pipelineColourspace('cmyk').toColourspace('cmyk')
  if (format === 'png' && !quantize && (metadata.bitsPerSample > 8 || metadata.space === 'b-w')) {
    return pipeline.toColourspace(metadata.space).toFormat(format, settingsImage)
  }
  if (format === 'avif' && metadata.bitsPerSample > 8) {
    return pipeline.toColourspace(metadata.space).toFormat(format, { ...settingsImage, bitdepth: metadata.bitsPerSample })
  }
  return pipeline.toFormat(format, settingsImage)
}

// Compares lightly blurred pixels, so that dithering, which the eye blends, counts less than
// shifted colors and blotches—overall, and in every 16×16 area, so that small changes, like
// icons losing their color, count, too; the limits follow a visual review, in which established
// metrics (SSIMULACRA2, DSSIM, SSIM) predicted visible changes less well
const isVisiblySame = async (input, output) => {
  const read = (data) => sharp(data).toColourspace('srgb').ensureAlpha().blur(1).raw().toBuffer({ resolveWithObject: true })
  const [{ data: pixelsInput, info: { width, height } }, { data: pixelsOutput }] = await Promise.all([read(input), read(output)])
  // Counts differences by value, as sorting them would hold up other images for longer
  const histogram = new Uint32Array(256)
  // Sums differences in 8×8 cells, of which 2×2 make up an area
  const widthCells = Math.ceil(width / 8)
  const heightCells = Math.ceil(height / 8)
  const cells = new Float64Array(widthCells * heightCells)
  let sum = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      // Weighs colors by opacity, as colors of transparent pixels don’t show
      const alphaInput = pixelsInput[i + 3]
      const alphaOutput = pixelsOutput[i + 3]
      let diff = Math.abs(alphaInput - alphaOutput) * 255
      for (let c = i; c < i + 3; c++) {
        const diffColor = Math.abs(pixelsInput[c] * alphaInput - pixelsOutput[c] * alphaOutput)
        if (diffColor > diff) diff = diffColor
      }
      histogram[(diff / 255) | 0]++
      sum += diff / 255
      cells[(y >> 3) * widthCells + (x >> 3)] += diff / 255
    }
  }
  const count = width * height
  // The difference that 99.9% of pixels stay within
  let seen = 0
  let diffTop = 0
  while ((seen += histogram[diffTop]) <= Math.floor(count * 0.999)) diffTop++
  // The largest average difference of an area, with areas overlapping by half
  let diffArea = 0
  for (let y = 0; y < heightCells - 1; y++) {
    for (let x = 0; x < widthCells - 1; x++) {
      const k = y * widthCells + x
      const diffAverage = (cells[k] + cells[k + 1] + cells[k + widthCells] + cells[k + widthCells + 1]) / 256
      if (diffAverage > diffArea) diffArea = diffAverage
    }
  }
  return sum / count <= 3 && diffTop <= 20 && diffArea <= 5.5
}

// Reduces PNG images to 256 colors where that doesn’t visibly change them—once reduced, they
// use a palette, which later runs keep losslessly—and compresses all other images as configured
const encode = async (input, format) => {
  const metadata = await sharp(input).metadata()
  // Leaves out grayscale images, as palettes don’t make 8-bit ones smaller, and 16-bit images,
  // whose precision the comparison can’t see
  if (format === 'png' && !metadata.isPalette && metadata.channels > 1 && !(metadata.bitsPerSample > 8) && metadata.width * metadata.height <= MAX_PIXELS_QUANTIZED) {
    const output = await createPipeline(input, format, metadata, true).toBuffer()
    // Gives way to lossless compression where dithering makes images larger, as in some screenshots
    if (output.length < input.length && await isVisiblySame(input, output)) return output
  }
  return createPipeline(input, format, metadata).toBuffer()
}

// Detects APNG images, of which libvips would keep only the first frame
const isAnimatedPng = (data) => {
  const actl = data.indexOf('acTL')
  const idat = data.indexOf('IDAT')
  return actl !== -1 && (idat === -1 || actl < idat)
}

export const hash = (data) => createHash('sha256').update(data).digest('hex')

// Identifies what compression results depend on, to tell when recorded results no longer apply
const fingerprint = hash(JSON.stringify({ formatConfigs, MAX_PIXELS_QUANTIZED, pipeline: [encode, createPipeline, isSrgbProfile, isVisiblySame].map(String), versions: sharp.versions })).slice(0, 16)

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

// Bytes saved, and the paths written or removed (for staging)
const noChange = () => ({ saved: 0, changed: [] })

const compression = async (filename, dry, quiet = false, cache) => {
  const filenameBackup = `${filename}.bak`
  const fileSizeBefore = await size(filename)
  // Track whether original file was successfully replaced
  let replacementSucceeded = false

  if (fileSizeBefore === 0) {
    logMessage(`Skipped ${filename} (${sizeReadable(fileSizeBefore)})`, dry, 'yellow', quiet)
    return noChange()
  }

  if (fileSizeBefore > MAX_FILE_SIZE) {
    logMessage(`Skipped ${filename} (file too large: ${sizeReadable(fileSizeBefore)})`, dry, 'yellow', quiet)
    return noChange()
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
    if (!formatConfigs[outputFormat]) {
      throw new Error(`Unsupported file type for ${filename}`)
    }

    // The format follows the extension
    const toEntry = (data) => `${outputFormat}:${hash(data)}`

    const input = await fs.readFile(filename)
    const entryInput = cache ? toEntry(input) : undefined
    if (cache?.has(entryInput)) {
      logMessage(`Skipped ${filename} (already processed)`, dry, 'white', quiet)
      return noChange()
    }

    if (outputFormat === 'png' && isAnimatedPng(input)) {
      logMessage(`Skipped ${filename} (animated PNG)`, dry, 'yellow', quiet)
      return noChange()
    }

    const output = await encode(input, outputFormat)
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
      cache?.add(fileSizeAfter < fileSizeBefore ? toEntry(output) : entryInput)
    }

    logMessage(`${status} ${filename} (${details})`, dry, color, quiet)

    if (dry || !replacementSucceeded) {
      return noChange()
    }

    return { saved: fileSizeBefore - fileSizeAfter, changed: [filename] }

  } catch (err) {

    // Check if this is a file corruption error (sharp/libvips error messages)
    const msg = err.message ? err.message.toLowerCase() : ''
    if (msg.includes('corrupt header') ||
      msg.includes('unexpected end of') ||
      msg.includes('invalid image') ||
      msg.includes('unsupported image format') ||
      msg.includes('gifload:') ||
      msg.includes('pngload:') ||
      msg.includes('jpegload:') ||
      msg.includes('webpload:') ||
      msg.includes('avifload:')
    ) {
      logMessage(`Skipped ${filename} (corrupt file)`, dry, 'yellow', quiet)
      return noChange()
    }
    throw new Error(`Error compressing ${filename}`, { cause: err })

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
    return noChange()
  }

  if (fileSizeBefore > MAX_FILE_SIZE) {
    logMessage(`Skipped ${filename} (file too large: ${sizeReadable(fileSizeBefore)})`, dry, 'yellow', quiet)
    return noChange()
  }

  if (!/\.hei[cf]$/i.test(filename)) {
    logMessage(`Skipped ${filename} (not a HEIC/HEIF file)`, dry, 'yellow', quiet)
    return noChange()
  }

  const avifPath = filename.replace(/\.hei[cf]$/i, '.avif')

  // Avoid overwriting an existing AVIF file
  try {
    await fs.access(avifPath)
    logMessage(`Skipped ${filename} (${path.basename(avifPath)} already exists)`, dry, 'yellow', quiet)
    return noChange()
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
      return noChange()
    }

    // Delete original HEIC/HEIF file unless `--keep-heic` is set
    if (!keepOriginal) {
      await retryFileOperation(() => fs.unlink(filename))
    }

    return {
      saved: fileSizeAfter < fileSizeBefore ? fileSizeBefore - fileSizeAfter : 0,
      changed: keepOriginal ? [avifPath] : [avifPath, filename]
    }

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
      return noChange()
    }
    throw new Error(`Error converting ${filename}`, { cause: err })
  }
}

const size = async (file) => {
  const stats = await fs.stat(file)
  return stats.size
}

const sizeReadable = (size) => `${(size / 1024).toFixed(2)} KB` // eslint-disable-line no-irregular-whitespace

export const utils = { compression, conversion, sizeReadable, fingerprint }