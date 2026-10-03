import fs from 'node:fs'
import path from 'node:path'
import ignore from 'ignore'

function findGitRoot(dir) {
  for (let current = dir; ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) return current
    if (path.dirname(current) === current) return undefined
  }
}

// Returns a predicate for absolute paths under `cwd` that applies .gitignore
// files from the repository root (or `cwd` outside a repository) down to each
// path, as Git does: Deeper rules take precedence, and nothing inside an
// ignored directory can be re-included
export function createGitignoreFilter(cwd) {
  const base = path.resolve(cwd)
  const top = findGitRoot(base) ?? base
  const rulesByDir = new Map()

  const getRules = (dir) => {
    if (!rulesByDir.has(dir)) {
      let rules
      try {
        rules = ignore().add(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'))
      } catch (err) {
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err
      }
      rulesByDir.set(dir, rules)
    }
    return rulesByDir.get(dir)
  }

  return (file) => {
    const segments = path.relative(top, file).split(path.sep)
    for (let i = 1; i <= segments.length; i++) {
      const suffix = i < segments.length ? '/' : ''
      let ignored = false
      for (let j = 0; j < i; j++) {
        const rules = getRules(path.join(top, ...segments.slice(0, j)))
        if (!rules) continue
        const result = rules.test(segments.slice(j, i).join('/') + suffix)
        if (result.ignored) ignored = true
        else if (result.unignored) ignored = false
      }
      if (ignored) return true
    }
    return false
  }
}