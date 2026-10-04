# Image Guard

[![npm version](https://img.shields.io/npm/v/image-guard.svg)](https://www.npmjs.com/package/image-guard) [![Build status](https://github.com/j9t/image-guard/workflows/Tests/badge.svg)](https://github.com/j9t/image-guard/actions) [![Socket](https://badge.socket.dev/npm/package/image-guard)](https://socket.dev/npm/package/image-guard) [![GitHub Sponsors](https://badgen.net/static/Support/Open%20Source/cyan)](https://github.com/sponsors/j9t)

(This project was based on [sum.cumo’s imagemin-merlin](https://github.com/sumcumo/imagemin-merlin). [Changes are documented](https://github.com/sumcumo/imagemin-merlin/compare/master...j9t:master), and include this README. Image Guard supports additional file formats—WebP, AVIF, and HEIC/HEIF—, comes with improved code and documentation, and is being maintained. For this reason, it’s [not based on any Imagemin packages](https://meiert.com/blog/image-guard-4/) anymore.)

Image Guard takes care of near-lossless compression of your images, to help you avoid bloat in your repositories. It makes it convenient and as safe as possible to automatically compress PNG, JPG, GIF, WebP, and AVIF images. It can also convert HEIC/HEIF files to AVIF.

It’s convenient because setup is simple. Run it right away—done. Or install, run, add hook—done.

It’s as safe as possible because compression happens losslessly (near-lossless for JPG and GIF images). That allows you to stop worrying about forgetting to compress images, but also about sacrificing too much quality. (You can take care of additional optimizations manually or through other tooling.)

## Installation and Use

(Note available parameters below.)

### Ways to Use Image Guard

#### Option 1: Immediate Manual Use

You can use Image Guard right away, without installation, by running

```shell
npx image-guard
```

#### Option 2: Project-Linked Manual Use

Install Image Guard in your project:

```shell
npm i -D image-guard
```

Run Image Guard by calling

```shell
npx image-guard
```

To make sure that _all_ images are being compressed, it’s recommended to run Image Guard like this at least once, after installation.

#### Option 3: Automated Use

Install Image Guard in your project:

```shell
npm i -D image-guard
```

To compress images already in the codebase, run Image Guard once by calling

```shell
npx image-guard
```

For automated use, Image Guard should be triggered through a [Git hook](https://git-scm.com/book/en/v2/Customizing-Git-Git-Hooks) on `pre-commit`. You can choose between native Git hooks (recommended for simple projects) or [Husky](https://github.com/typicode/husky).

##### Native Git Hooks

Native Git hooks are simpler to set up and don’t require additional dependencies. Run these commands from your project root:

```shell
mkdir -p .githooks;\
cat > .githooks/pre-commit << 'EOF'
#!/bin/sh
./node_modules/.bin/image-guard --staged
EOF
chmod +x .githooks/pre-commit;\
git config core.hooksPath .githooks;\
git add .githooks/pre-commit;\
git commit -m "feat: add Git pre-commit hook for Image Guard";\
npm pkg set scripts.postprepare="mkdir -p .githooks && cat > .githooks/pre-commit << 'EOF'
#\!/bin/sh
./node_modules/.bin/image-guard --staged
EOF
chmod +x .githooks/pre-commit && git config core.hooksPath .githooks"
```

##### Husky

If you already use [Husky](https://typicode.github.io/husky/), run the following commands in your project root (you can copy and execute them at once):

```shell
grep -qxF "./node_modules/.bin/image-guard --staged" .husky/pre-commit || printf '\n./node_modules/.bin/image-guard --staged' >> .husky/pre-commit;\
git add .husky/pre-commit;\
git commit -m "feat: add Husky pre-commit hook for Image Guard";\
npm pkg set scripts.postprepare="grep -qxF './node_modules/.bin/image-guard --staged' .husky/pre-commit || printf '\\n./node_modules/.bin/image-guard --staged' >> .husky/pre-commit"
```

If you don’t yet but want to use Husky, run the following commands from your project root:

```shell
npm i -D husky;\
npx husky init;\
echo "./node_modules/.bin/image-guard --staged" > .husky/pre-commit;\
git add .husky/pre-commit;\
git commit -m "feat: add Husky pre-commit hook for Image Guard";\
npm pkg set scripts.postprepare="grep -qxF './node_modules/.bin/image-guard --staged' .husky/pre-commit || printf '\\n./node_modules/.bin/image-guard --staged' >> .husky/pre-commit"
```

(The `postprepare` script ensures that the hook is added to the repository whenever someone installs the package.)

If you give the hook options like `--ignore`, add them to the `postprepare` script as well—the hook command is the only place to configure Image Guard, and the next install rewrites that line.

**Important:** When you commit images that have not yet been compressed, the automated compression process (triggered by the pre-commit hook) will modify those image files to reduce their size. As a result, after your initial commit attempt, you will see these images appear as changed files in Git. To include the optimized images in your repository, you need to stage and commit them again. In rare cases, if further compression is possible, you may need to repeat this process until no further changes are detected. This workflow is intentional and ensures that only optimally compressed images are committed. Many editors can display diffs for images, helping you review these changes.

### Parameters

Image Guard takes an optional path to the directory to process—`npx image-guard assets`—and works on the current directory when that path is omitted.

* `--heic-to-avif` converts HEIC/HEIF files to AVIF. Because HEIC sources are already lossy-compressed (HEVC), the conversion uses lossy AVIF encoding (quality 80) to produce files smaller than the originals at near-identical visual quality. Original HEIC/HEIF files are deleted after conversion by default. (Note: The conversion maps Display P3 colors—common on iPhones—to sRGB, which may result in slightly less vivid colors.)

  - `--keep-heic` (used with `--heic-to-avif`) preserves the original HEIC/HEIF files instead of deleting them after conversion.

* `--ignore`/`-i` allows you to specify paths to be ignored (as in `--ignore=example,test`). Multiple paths must be separated by commas. Naming a directory excludes everything inside it. The option supports glob patterns (e.g., `assets/**`, `**/*.png`); matching is case-insensitive and honors .gitignore. Patterns are relative to the directory being processed—with `--staged`, to the repository root.

* `--quiet`/`-q` suppresses per-file logs and prints only the final summary (plus errors). This reduces console noise and speeds up runs in CI and Git hooks.

* `--dry`/`-d` allows you to run Image Guard in “dry mode.” All changes are shown in the terminal (unless combined with `--quiet`, which leaves just the summary).

* `--staged` (recommended with automated use) triggers a mode that watches PNG, JPG, GIF, WebP, and AVIF files (and HEIC/HEIF, when `--heic-to-avif` is used) from staged changes (`git diff --cached`) and only processes those files—that approach makes Image Guard more efficient in operation. Because the file set comes from Git, `--staged` can’t be combined with a path.

* `--no-cache` processes all images, including those recorded as already processed (see [“Record of Processed Images”](#record-of-processed-images)).

* `--help`/`-h` lists the arguments and options.

* `--version`/`-V` prints the version number.

## What Does the Output Look Like?

Roughly like this:

![Screenshot of Image Guard in operation.](https://raw.githubusercontent.com/j9t/image-guard/master/media/output.png)

* Green: The image file has been compressed.
* Cyan: The image file has been converted (HEIC/HEIF to AVIF).
* White (light gray): The image file has not been changed.
* Blue: The image file had already been compressed more effectively than the new result, and was therefore skipped, too.

Tip: Use `--quiet` to suppress these per-file lines and keep only the final summary.

## How Does Image Guard Work?

Image Guard is a Node script that uses [sharp](https://www.npmjs.com/package/sharp) under the hood.

Automated compression works by monitoring whether a given [change list](https://webglossary.info/terms/change-list/) includes any PNGs, JPGs, GIFs, WebPs, or AVIFs (and HEIC/HEIF when opted in). It’s initiated by a Git hook. Only those images are compressed where there is an improvement. HEIC conversion uses [heic-decode](https://www.npmjs.com/package/heic-decode) for patent-free decoding and sharp for lossy AVIF encoding (quality 80). The processed images can then be committed to the underlying repository.

Through this approach, though glossed over here, Image Guard makes up for what’s missing or complicated in other packages, namely easy, near-riskless, automatable, resource-friendly in-repo optimization.

### Record of Processed Images

To keep repeat runs fast, Image Guard remembers which images it has already processed (compressed, or found not to shrink any further) by their content, and skips them in later runs. This also protects JPG and GIF images from being re-encoded over and over. An image is processed again as soon as its content changes, and all images are when the compression settings or the underlying image libraries change (as through an update).

The record is kept in node_modules/.cache/image-guard of the project being processed, or—where there is no node_modules folder, as is common with `npx`—in the per-user cache folder (~/Library/Caches/image-guard on macOS, %LOCALAPPDATA%\image-guard\Cache on Windows, and ~/.cache/image-guard elsewhere). The `IMAGE_GUARD_CACHE_DIR` environment variable sets a different folder—for example, to persist the record in CI. Deleting the folder, or using `--no-cache`, makes Image Guard process all images again.

## Why Use Image Guard?

You use Image Guard when you need a simple, automatable, robust solution to compress images in a way that limits unnecessary image payload right from the start, in your repositories, and that reduces the risk that entirely uncompressed images go into production.

As Image Guard compresses near-losslessly, there’s little risk of quality issues from compression. (Lossless compression is not possible for every image format, however, so there’s a risk when excessively iterating over the same images. Doing so may eventually degrade quality. The [record of processed images](#record-of-processed-images) prevents this, unless it’s bypassed or cleared.)

## What Does Image Guard _Not_ Do?

Image Guard is no substitute for image fine-tuning and micro-optimization. That’s difficult to do in an automated fashion, because this type of compression requires [balancing quality and performance](https://meiert.com/blog/understanding-image-compression/) and is context-dependent. In its most extreme form, when maximum quality at maximum performance is required from each graphic, micro-optimization is even challenging to do manually.

That is, micro-optimization still needs to be taken care of through other means, whether manually or through tools. Image Guard just solves the problem that images are checked in or go live that are not compressed _at all_.

## Working on Image Guard

### Benchmarking

To check how a change affects speed, memory, and compression, run the benchmark on any local folder with images:

```shell
npm run benchmark -- ~/Projects
```

The benchmark copies a deterministic sample of the images (honoring .gitignore) to a temporary folder, runs Image Guard on fresh copies of it several times (each without a record of processed images), and reports the median time, peak memory, and bytes saved. Your images are not modified.

* `--runs <n>` sets the number of runs (default: 3).
* `--sample <n>` sets the approximate sample size (default: 300). Each format is sampled in proportion to its share, with at least 10 files per format where available.
* `--save` saves the result as the baseline (benchmark/baseline.json, ignored by Git), which later runs on the same sample compare against.
* `--profile` additionally compresses each image on its own, in dry mode, and reports the time per format and the slowest files.

To compare a branch with `main`, run the benchmark with `--save` on `main`, then without it on the branch. Differences of around 10% can be noise; use more runs, and repeat a run on `main`, before relying on smaller ones.

## License

Copyright 2019 [sum.cumo GmbH](https://web.archive.org/web/20191208211414/https://www.sumcumo.com/)<br>
Copyright 2022 [Jens Oliver Meiert](https://meiert.com/)

Licensed under the Apache License, Version 2.0 (the “License”); you may not use this file except in compliance with the License. You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an “AS IS” BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.

***

You might like some of my other work:

* Optimization tools: [hihtml](https://github.com/j9t/hihtml) · [HTML Minifier Next](https://github.com/j9t/html-minifier-next) · [ObsoHTML](https://github.com/j9t/obsohtml) · [CSS Dedup](https://github.com/j9t/css-dedup) · Image Guard · [Compressor.js Next](https://github.com/j9t/compressorjs-next) · [.htaccess Punk](https://github.com/j9t/htaccess-punk)
* Defense tools: [IA Defensa](https://iadefensa.com/solutions/)
* Resources for quality web development: [Articles](https://meiert.com/topics/development/) · [Books](https://meiert.com/topics/books/) (including [_On Web Development_](https://meiert.com/blog/on-web-development-2/)) · [News](https://frontenddogma.com/) · [Terminology](https://webglossary.info/)