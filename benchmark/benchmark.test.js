import { test, describe } from 'node:test'
import assert from 'node:assert'
import { parseOptions, sampleFiles, median, formatDelta } from './benchmark.js'

describe('Benchmark', () => {
  test('Parses options with defaults', () => {
    assert.deepStrictEqual(parseOptions(['images']), { dir: 'images', runs: 3, sample: 300, save: false, profile: false })
  })

  test('Parses all options', () => {
    assert.deepStrictEqual(
      parseOptions(['--runs', '5', '--sample=50', '--save', '--profile', 'images']),
      { dir: 'images', runs: 5, sample: 50, save: true, profile: true }
    )
  })

  test('Rejects a missing directory and invalid numbers', () => {
    assert.throws(() => parseOptions([]), /Usage/)
    assert.throws(() => parseOptions(['--runs', '0', 'images']), /`--runs` must be a positive integer/)
    assert.throws(() => parseOptions(['--sample', 'x', 'images']), /`--sample` must be a positive integer/)
  })

  test('Keeps every file, sorted, when the sample is larger than the input', () => {
    assert.deepStrictEqual(sampleFiles(['c.gif', 'a.png', 'b.jpg'], 10), ['a.png', 'b.jpg', 'c.gif'])
  })

  test('Samples proportionally per format, with a floor for rare formats', () => {
    const files = [
      ...Array.from({ length: 900 }, (_, i) => `${String(i).padStart(3, '0')}.png`),
      ...Array.from({ length: 100 }, (_, i) => `${String(i).padStart(3, '0')}.JPEG`),
      ...Array.from({ length: 3 }, (_, i) => `${i}.gif`)
    ]
    const sample = sampleFiles(files, 100)
    const count = (re) => sample.filter(file => re.test(file)).length
    assert.strictEqual(count(/\.png$/), 90)
    assert.strictEqual(count(/\.JPEG$/), 10)
    assert.strictEqual(count(/\.gif$/), 3)
  })

  test('Samples deterministically, regardless of input order', () => {
    const files = Array.from({ length: 500 }, (_, i) => `${i}.png`)
    assert.deepStrictEqual(sampleFiles(files, 40), sampleFiles([...files].reverse(), 40))
  })

  test('Computes the median', () => {
    assert.strictEqual(median([3, 1, 2]), 2)
    assert.strictEqual(median([4, 1, 3, 2]), 2.5)
  })

  test('Formats deltas relative to the baseline', () => {
    assert.strictEqual(formatDelta(110, 100), '+10.0%')
    assert.strictEqual(formatDelta(90, 100), '−10.0%')
    assert.strictEqual(formatDelta(100, 100), '±0%')
  })

  test('Reports no percentage against a zero baseline unless both are zero', () => {
    assert.strictEqual(formatDelta(0, 0), '±0%')
    assert.strictEqual(formatDelta(65740, 0), 'n/a')
  })
})