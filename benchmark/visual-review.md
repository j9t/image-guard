# Visual Review of PNG Palette Reduction

This review, from October 2026, calibrated the comparison (`isVisiblySame` in src/utils.js) that decides whether a PNG image with more than 256 colors may be reduced to a 256-color palette. Image Guard runs unattended and replaces originals, so the comparison should let no visible change through, even at the cost of compression.

## What Was Compared

Each image was reduced as Image Guard does it (sharp with libimagequant, `palette: true, quality: 100, effort: 7`, with and without dithering) and compared with the original. The comparison blurs both versions lightly (sigma 1), takes the largest difference per pixel across red, green, blue, and alpha (colors weighted by opacity), and then looks at:

* the average difference (limit: 3, on a 0–255 scale),
* the difference that 99.9% of pixels stay within (limit: 20), and—added through this review—
* the largest average difference of any 16×16 area, with areas overlapping by half (“worst area”).

## Procedure

For every image, a review page showed the most-changed areas (“spots”) of the reduced versions next to the original, at actual pixels and enlarged. One reviewer judged each spot at actual pixels as “looks the same” or “visibly different,” using the enlargement only to find where to look. An image counted as visibly different if any of its spots was.

## Images

Round 1 used 11 images:

* 8 photos from Unsplash (2480×3508 to 6016×4016), converted from JPEG to PNG: marble, stone, studio and pastel backgrounds, grass, and a black-and-white photo
* 1 macOS screenshot (2802×2266) of a browser with a colorful gradient, icons, and emoji
* 2 small WebP graphics (a logo and an anti-aliasing illustration), converted to PNG

Round 2 used 15 photos from haikuhaikulove.com (768 to 1200 pixels wide, converted from JPEG to PNG), chosen to cover worst areas from 5.9 to 11.7.

The images aren’t part of the repository, as their licenses don’t allow redistribution.

## Results

The black-and-white photo and the 2 graphics have 256 colors or fewer, so their palettes are exact.

Worst area of the dithered version, by verdict:

| Verdict | Round 1 | Round 2 |
| --- | --- | --- |
| Looks the same | 4.9, 5.7 | 6.6, 6.8, 7.4, 8.0, 9.2, 11.7 |
| Visibly different | 11.1, 12.9, 13.8, 18.7, 21.5, 23.5 (screenshot) | 5.9, 6.4, 7.0, 7.3, 7.8, 8.4, 8.8, 9.5, 10.2 |

Visible changes included small icons and emoji losing their color, tinted patches in smooth areas, and contours in gradients. All 23 images passed the comparison without the worst-area limit.

Without dithering, reduced images were 10–65% smaller, but showed banding in smooth areas that the comparison didn’t register (it often scored banded versions as closer to the original). Dithering stays.

### Other Metrics

The verdicts were also used to test established metrics, computed per spot (94 spots of dithered versions) and per image (23 images). The score is the probability that a visibly different case rates worse than one that looks the same (0.5 is chance, 1 is perfect):

| Metric | Per spot | Per image |
| --- | --- | --- |
| Worst area (Image Guard) | 0.79 | 0.75 |
| SSIMULACRA2 (Rust `ssimulacra2` crate) | 0.68 | 0.54 |
| SSIM (`@blazediff/ssim`) | 0.62 | 0.33 |
| DSSIM 3.5 | 0.58 | 0.36 |

These metrics pool differences over the whole image, which hides local changes like a discolored icon. On all 134 rated spots (including undithered versions), two variants of the worst area were tested, too: average color differences in Lab per area did worse (0.67, against 0.78), and discounting differences by local texture did slightly better (0.82), not enough to adopt. SSIMULACRA2 rated no reduced photo as visually lossless (90 or more; the range was 64–85), which agrees with the verdicts.

## Decision

The worst-area limit is 5.5, the highest value that lets none of the visibly different images through. In consequence, most photos are compressed losslessly, while graphics and screenshots with 256 colors or fewer keep being reduced to exact palettes. On a corpus of 116 PNG images (76 from websites, mostly already compressed, and 40 photos as uncompressed PNG), this cut the bytes saved from 29.9 MB to 15.4 MB, all of it from the photos.

The verdicts come from one reviewer and 23 images, and the limits depend on sharp’s and libimagequant’s output. To revisit them—after major updates of either, or to try a new metric—repeat the review with images whose worst area lies near the limit.