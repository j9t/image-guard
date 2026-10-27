import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import { spawnSync } from 'child_process'
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import sharp from 'sharp'
import { testFolder, imageGuardScript } from './helpers.js'

describe('Image fidelity', () => {
  const run = (args, options = {}) => spawnSync(process.execPath, [imageGuardScript, '--no-cache', ...args], { encoding: 'utf8', ...options })
  // Reads from buffers, as libvips caches what it reads by path
  const pixels = (file) => sharp(fs.readFileSync(file)).raw().toBuffer()
  // Reads 16-bit samples, which `raw()` alone reduces to 8 bits
  const pixels16 = async (file) => new Uint16Array((await sharp(fs.readFileSync(file)).toColourspace('rgb16').raw({ depth: 'ushort' }).toBuffer()).buffer)
  const metadata = (file) => sharp(fs.readFileSync(file)).metadata()

  // More than 256 colors, in a pattern a palette would visibly change
  const createPattern = (width = 320, height = 240) => {
    const data = Buffer.alloc(width * height * 3)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 3
        data[i] = (x * 3) & 255
        data[i + 1] = (y * 5) & 255
        data[i + 2] = ((x ^ y) * 3) & 255
      }
    }
    return sharp(data, { raw: { width, height, channels: 3 } })
  }

  // `scale` 257 maps the colors to 16 bits, keeping steps 8 bits can’t hold
  const colorGradient = (x, y, width, height, scale = 1) => [
    x / (width - 1),
    y / (height - 1),
    (x + y) / (width + height - 2)
  ].map((position) => Math.round((80 + position * 120) * scale))

  // More than 256 colors, in muted smooth transitions a palette with dithering renders
  // without visible change; `overlay` returns colors to draw over it, if any
  const createGradient = (width = 640, height = 480, overlay = () => undefined) => {
    const data = Buffer.alloc(width * height * 3)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        data.set(overlay(x, y) ?? colorGradient(x, y, width, height), (y * width + x) * 3)
      }
    }
    return sharp(data, { raw: { width, height, channels: 3 } })
  }

  // Pattern in the left half, nearly transparent, gradient in the right half, opaque
  const createTransparent = (width = 640, height = 480) => {
    const data = Buffer.alloc(width * height * 4)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const color = x < width / 2
          ? [(x * 3) & 255, (y * 5) & 255, ((x ^ y) * 3) & 255, 8]
          : [...colorGradient(x, y, width, height), 255]
        data.set(color, (y * width + x) * 4)
      }
    }
    return sharp(data, { raw: { width, height, channels: 4 } })
  }

  // Two-frame APNG, which libvips reads as a still image
  const createApng = (file) => {
    const crcTable = Array.from({ length: 256 }, (_, n) => {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      return c >>> 0
    })
    const crc = (data) => {
      let c = 0xffffffff
      for (const byte of data) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8)
      return (c ^ 0xffffffff) >>> 0
    }
    const chunk = (type, data) => {
      const head = Buffer.alloc(8)
      head.writeUInt32BE(data.length)
      head.write(type, 4)
      const tail = Buffer.alloc(4)
      tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])))
      return Buffer.concat([head, data, tail])
    }
    const size = 64
    const frame = (red) => {
      const rows = []
      for (let y = 0; y < size; y++) {
        const row = Buffer.alloc(1 + size * 3)
        for (let x = 0; x < size; x++) row.set([red ^ x, y, 255 - red], 1 + x * 3)
        rows.push(row)
      }
      return zlib.deflateSync(Buffer.concat(rows), { level: 0 })
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(size, 0)
    ihdr.writeUInt32BE(size, 4)
    ihdr.set([8, 2], 8)
    const actl = Buffer.alloc(8)
    actl.writeUInt32BE(2, 0)
    const fctl = (sequence) => {
      const data = Buffer.alloc(26)
      data.writeUInt32BE(sequence, 0)
      data.writeUInt32BE(size, 4)
      data.writeUInt32BE(size, 8)
      data.writeUInt16BE(1, 20)
      data.writeUInt16BE(2, 22)
      return data
    }
    const fdat = Buffer.concat([Buffer.alloc(4), frame(0)])
    fdat.writeUInt32BE(2, 0)
    fs.writeFileSync(file, Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('acTL', actl),
      chunk('fcTL', fctl(0)),
      chunk('IDAT', frame(255)),
      chunk('fcTL', fctl(1)),
      chunk('fdAT', fdat),
      chunk('IEND', Buffer.alloc(0))
    ]))
  }

  let tempDir
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-guard-fidelity-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('Reduces true-color PNG images to a palette where that doesn’t visibly change them', async () => {
    const file = path.join(tempDir, 'gradient.png')
    await createGradient().png({ compressionLevel: 0 }).toFile(file)
    const { stdout } = run([tempDir])

    assert.match(stdout, /Compressed .*gradient\.png/)
    assert.strictEqual((await metadata(file)).isPalette, true)
  })

  test('Keeps true-color PNG images lossless where a palette would visibly change them', async () => {
    const file = path.join(tempDir, 'truecolor.png')
    await createPattern().png({ compressionLevel: 0 }).toFile(file)
    const before = await pixels(file)
    const { stdout } = run([tempDir])

    assert.match(stdout, /Compressed .*truecolor\.png/)
    assert.strictEqual((await metadata(file)).isPalette, false)
    assert.ok(before.equals(await pixels(file)), 'Pixels should be unchanged')
  })

  test('Keeps PNG images with colorful smooth gradients lossless', async () => {
    const file = path.join(tempDir, 'colorful.png')
    const width = 320
    const height = 240
    const data = Buffer.alloc(width * height * 3)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        data.set([Math.round(x / (width - 1) * 255), Math.round(y / (height - 1) * 255), 128], (y * width + x) * 3)
      }
    }
    await sharp(data, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).toFile(file)
    const before = await pixels(file)
    const { stdout } = run([tempDir])

    assert.match(stdout, /Compressed .*colorful\.png/)
    assert.strictEqual((await metadata(file)).isPalette, false)
    assert.ok(before.equals(await pixels(file)), 'Pixels should be unchanged')
  })

  test('Keeps PNG images above 40 megapixels lossless', async () => {
    const file = path.join(tempDir, 'large.png')
    // 320 bands of similar shades, which a palette renders without visible change
    const bands = Buffer.alloc(320 * 3)
    for (let i = 0; i < 320; i++) bands.set([100 + i % 20, 120 + Math.floor(i / 20), 140], i * 3)
    await sharp(bands, { raw: { width: 1, height: 320, channels: 3 } }).resize(6400, 6400, { kernel: 'nearest' }).png({ compressionLevel: 1 }).toFile(file)
    const { stdout } = run([tempDir])

    assert.match(stdout, /Compressed .*large\.png/)
    assert.strictEqual((await metadata(file)).isPalette, false)
  })

  test('Compresses PNG images losslessly where a palette would make them larger', async () => {
    const file = path.join(tempDir, 'subtle.png')
    const width = 320
    const height = 240
    const data = Buffer.alloc(width * height * 3)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        data.set([150 + Math.floor(x / 4), 150 + Math.floor(y / 4), 200], (y * width + x) * 3)
      }
    }
    await sharp(data, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 6 }).toFile(file)
    const before = await pixels(file)
    const { stdout } = run([tempDir])

    assert.match(stdout, /Compressed .*subtle\.png/)
    assert.strictEqual((await metadata(file)).isPalette, false)
    assert.ok(before.equals(await pixels(file)), 'Pixels should be unchanged')
  })

  test('Keeps PNG images lossless where a palette would change the color of small elements', async () => {
    const file = path.join(tempDir, 'icons.png')
    const colors = [[0, 160, 160], [220, 30, 30], [230, 0, 230], [255, 200, 0], [40, 40, 200], [0, 200, 60], [140, 70, 20], [255, 120, 180]]
    // 6×6 icons in rare colors, taking up less than 0.1% of the image
    const icons = (x, y) => y >= 240 && y < 246 && x >= 16 && (x - 16) % 76 < 6 ? colors[Math.floor((x - 16) / 76)] : undefined
    await createGradient(640, 480, icons).png({ compressionLevel: 0 }).toFile(file)
    const before = await pixels(file)
    const { stdout } = run([tempDir])

    assert.match(stdout, /Compressed .*icons\.png/)
    assert.strictEqual((await metadata(file)).isPalette, false)
    assert.ok(before.equals(await pixels(file)), 'Pixels should be unchanged')
  })

  test('Reduces PNG images to a palette where only the colors of nearly transparent pixels change', async () => {
    const file = path.join(tempDir, 'transparent.png')
    await createTransparent().png({ compressionLevel: 0 }).toFile(file)
    const { stdout } = run([tempDir])

    assert.match(stdout, /Compressed .*transparent\.png/)
    assert.strictEqual((await metadata(file)).isPalette, true)
  })

  test('Keeps semi-transparent PNG images lossless where a palette would visibly change them', async () => {
    const file = path.join(tempDir, 'translucent.png')
    await createPattern().ensureAlpha(0.5).png({ compressionLevel: 0 }).toFile(file)
    const before = await pixels(file)
    const { stdout } = run([tempDir])

    assert.match(stdout, /Compressed .*translucent\.png/)
    assert.strictEqual((await metadata(file)).isPalette, false)
    assert.ok(before.equals(await pixels(file)), 'Pixels should be unchanged')
  })

  test('Keeps grayscale PNG images lossless and in grayscale', async () => {
    const file = path.join(tempDir, 'gray.png')
    await createGradient().toColourspace('b-w').png({ compressionLevel: 0 }).toFile(file)
    const before = await pixels(file)
    const { stdout } = run([tempDir])
    const metadataAfter = await metadata(file)

    assert.match(stdout, /Compressed .*gray\.png/)
    assert.strictEqual(metadataAfter.isPalette, false)
    assert.strictEqual(metadataAfter.channels, 1)
    assert.ok(before.equals(await pixels(file)), 'Pixels should be unchanged')
  })

  test('Keeps 16-bit PNG images lossless, even where a palette wouldn’t visibly change them', async () => {
    const file = path.join(tempDir, 'deep.png')
    const [width, height] = [640, 480]
    const data = new Uint16Array(width * height * 3)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        data.set(colorGradient(x, y, width, height, 257), (y * width + x) * 3)
      }
    }
    await sharp(data, { raw: { width, height, channels: 3 } }).toColourspace('rgb16').png({ compressionLevel: 0 }).toFile(file)
    const before = await pixels16(file)
    const { stdout } = run([tempDir])

    assert.ok(before.some((value) => value % 257 !== 0), 'Input should use 16-bit precision')
    assert.match(stdout, /Compressed .*deep\.png/)
    assert.strictEqual((await metadata(file)).bitsPerSample, 16)
    assert.deepStrictEqual(await pixels16(file), before)
  })

  test('Keeps palette PNG images lossless and compresses them as palette images', async () => {
    const file = path.join(tempDir, 'palette.png')
    await createPattern().png({ palette: true, colours: 200, dither: 0, compressionLevel: 0 }).toFile(file)
    const before = await pixels(file)
    const { stdout } = run([tempDir])

    assert.match(stdout, /Compressed .*palette\.png/)
    assert.strictEqual((await metadata(file)).isPalette, true)
    assert.ok(before.equals(await pixels(file)), 'Pixels should be unchanged')
  })

  for (const [format, settings, lossless] of [
    ['jpeg', { quality: 100, chromaSubsampling: '4:4:4', optimiseCoding: false }, false],
    ['png', { compressionLevel: 0 }, true],
    ['webp', { lossless: true, effort: 0 }, true],
    ['avif', { lossless: true, effort: 0 }, true]
  ]) {
    test(`Keeps the orientation and color profile of ${format.toUpperCase()} images`, async () => {
      const file = path.join(tempDir, `meta.${format}`)
      await createPattern().withMetadata({ orientation: 6 }).withIccProfile('p3').toFormat(format, settings).toFile(file)
      const { orientation } = await metadata(file)
      const before = await pixels(file)
      const { stdout } = run([tempDir])
      const metadataAfter = await metadata(file)

      assert.match(stdout, new RegExp(`Compressed .*meta\\.${format}`))
      assert.strictEqual(metadataAfter.orientation, orientation)
      assert.ok(metadataAfter.icc, 'The color profile should be kept')
      if (lossless) assert.ok(before.equals(await pixels(file)), 'Pixels should be unchanged')
    })
  }

  for (const [format, create] of [
    ['jpeg', () => createPattern().jpeg({ quality: 100, chromaSubsampling: '4:4:4', optimiseCoding: false })],
    ['png', () => createGradient().png({ compressionLevel: 0 })],
    ['gif', () => createPattern().gif({ effort: 1 })],
    ['webp', () => createPattern().webp({ lossless: true, effort: 0 })],
    ['avif', () => createPattern().avif({ lossless: true, effort: 0 })]
  ]) {
    test(`Leaves the pixels of ${format.toUpperCase()} images unchanged on repeat runs`, async () => {
      const file = path.join(tempDir, `repeat.${format}`)
      await create().toFile(file)
      run([tempDir])
      const after = await pixels(file)
      run([tempDir])

      assert.ok(after.equals(await pixels(file)), 'A repeat run should leave the pixels unchanged')
    })
  }

  test('Drops sRGB color profiles', async () => {
    const file = path.join(tempDir, 'srgb.png')
    await createPattern().withIccProfile('srgb').png({ compressionLevel: 0 }).toFile(file)
    const before = await pixels(file)
    const { stdout } = run([tempDir])

    assert.match(stdout, /Compressed .*srgb\.png/)
    assert.strictEqual((await metadata(file)).icc, undefined)
    assert.ok(before.equals(await pixels(file)), 'Pixels should be unchanged')
  })

  test('Keeps the bit depth of AVIF images', async () => {
    const file = path.join(tempDir, 'deep.avif')
    await createPattern().toColourspace('rgb16').avif({ lossless: true, bitdepth: 10, effort: 0 }).toFile(file)
    const { stdout } = run([tempDir])

    assert.match(stdout, /Compressed .*deep\.avif/)
    assert.strictEqual((await metadata(file)).bitsPerSample, 10)
  })

  test('Keeps CMYK JPEG images in CMYK', async () => {
    const file = path.join(tempDir, 'cmyk.jpg')
    await createPattern().toColourspace('cmyk').jpeg({ quality: 100, optimiseCoding: false }).toFile(file)
    const { stdout } = run([tempDir])

    assert.match(stdout, /Compressed .*cmyk\.jpg/)
    assert.strictEqual((await metadata(file)).space, 'cmyk')
  })

  test('Skips animated PNG images', () => {
    const file = path.join(tempDir, 'animated.png')
    createApng(file)
    const before = fs.readFileSync(file)
    const { stdout } = run([tempDir])

    assert.match(stdout, /Skipped .*animated\.png \(animated PNG\)/)
    assert.ok(before.equals(fs.readFileSync(file)), 'The file should be unchanged')
  })

  test('Skips files in an unsupported format', () => {
    fs.writeFileSync(path.join(tempDir, 'text.png'), 'Not an image')
    const { status, stdout } = run([tempDir])

    assert.strictEqual(status, 0)
    assert.match(stdout, /Skipped .*text\.png \(corrupt file\)/)
  })

  test('Fails on images it can’t read',{ skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
    const file = path.join(tempDir, 'test.png')
    fs.copyFileSync(path.join(testFolder, 'test.png'), file)
    fs.chmodSync(file, 0o000)
    const { status, stderr } = run([tempDir])

    assert.strictEqual(status, 1)
    assert.match(stderr, /Error compressing .*test\.png/)
  })
})
