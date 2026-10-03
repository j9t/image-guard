# Changelog

Starting with version 5.2.0, all notable changes to Image Guard are documented in this file, which is (mostly) AI-generated and (always) human-edited. Dependency updates may or may not be called out specifically.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [5.4.2] - 2026-10-03

### Changed

* Replaced globby with tinyglobby and ignore, removing the dependency on braces (GHSA-vfj7-8cjw-p6xm), which has no fixed release

## [5.4.1] - 2026-09-24

### Changed

* Forced update with the latest dependencies

## [5.4.0] - 2026-08-13

### Fixed

* Ensured an unknown option points at `--help` instead of passing on the `parseArgs` note about `--`
* Ensured a path or option error prints on its own, reserving the “Error running Image Guard” prefix (now with the full error) for what isn’t the user’s to fix
* Ensured errors and warnings check STDERR—not STDOUT—for color support, so a redirected STDERR no longer collects escape codes

### Added

* Added `--help`/`-h` flag listing arguments and options
* Added `--version`/`-V` flag printing the version number
* Added important additional short forms: `-i` (`--ignore`), `-q` (`--quiet`), `-d` (`--dry`)

## [5.3.1] - 2026-08-12

### Fixed

* Ensured to report a path that exists but isn’t a directory as “Not a directory” (rather than as “No such directory”)

## [5.3.0] - 2026-08-12

### Fixed

* Fixed `--ignore` so that a directory pattern (as in `--ignore=assets`) excludes the images inside that directory, which previously still got compressed with `--staged` and, without it, on case-sensitive file systems; single-file patterns were unaffected

### Added

* Accepted an optional path to the directory to process (e.g., `image-guard assets`), which previously errored out

### Changed

* Resolved `--ignore` patterns and .gitignore lookup relative to the directory being processed
* Rejected `--staged` combined with a path, whose file set comes from Git rather than from a directory walk

## [5.2.6] - 2026-07-24

### Changed

* Forced update with the latest dependencies

## [5.2.5] - 2026-03-17

### Changed

* Added recommended ESLint rules to config (and fixed resulting warnings)
* Promoted `no-unused-vars` and `eqeqeq` from warnings to errors in ESLint config

## [5.2.4] - 2026-03-04

### Fixed

* Changed bin entry from a Node.js script to a shell wrapper that locates node from common version managers (nvm, Volta, asdf, mise) and package managers (Homebrew) before invocation, resolving hook failures in GUI Git clients that don’t inherit the shell’s PATH
  - **Migration:** If you set up hooks, replace `npx image-guard --staged` with `./node_modules/.bin/image-guard --staged` in your `.githooks/pre-commit` or `.husky/pre-commit`.

## [5.2.3] - 2026-02-21

### Fixed

* Improved corrupt-file error detection to cover WebP and AVIF formats, normalize message casing before matching, and avoid false positives from the overly broad `Invalid` string match
* Warned when a `.bak` file is left behind after a failed file replacement
* Removed a dead code branch in result processing

### Changed

* Moved to compression and conversion running in parallel (non-overlapping file sets), reducing wall-clock time when `--heic-to-avif` is active
* Reduced directory traversals from two to one in non-staged mode when `--heic-to-avif` is active
* Extracted shared `MAX_FILE_SIZE` constant; aligned `node:fs` and `node:path` import style in `utils.js`
* Extended test coverage for corrupt file detection and reporting

## [5.2.2] - 2026-02-17

### Fixed

* Updated HEIC dry run to report actual file sizes instead of omitting size data

## [5.2.1] - 2026-02-17

### Changed

* Adjusted HEIC-to-AVIF conversion to use lossy instead of lossless encoding (quality 80), to produce files smaller than the HEIC originals but still at high quality
* Removed redundant lossless compression pass after HEIC conversion
* Documented Display P3 to sRGB color space mapping during HEIC conversion

## [5.2.0] - 2026-02-17

### Added

* Added opt-in HEIC/HEIF-to-AVIF conversion via `--heic-to-avif` (with `--keep-heic` to preserve originals)
* Introduced changelog