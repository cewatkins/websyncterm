# Performance

The performance budget is defined in [SPEC.md §10](./SPEC.md#10-performance-budget).
This document records how it is measured and what the engine actually achieves.

## Measuring

```bash
pnpm --filter @websyncterm/core run build
node tools/benchmark.mjs
```

The benchmark builds a 4 MiB stream of representative ANSI — SGR colour changes,
cursor positioning, CP437 line-drawing characters and wrapping text — and feeds
it to the engine in one call against a 132×60 screen.

## Measured results

Recorded on the development machine (Node 22, x86-64):

| Metric | Target | Measured |
|---|---|---|
| ANSI throughput | > 1 Mbit/s | **145 Mbit/s** (18 MB/s) |
| Parse cost per 64 KiB chunk | < 8 ms | **3.6 ms** |
| Parse cost per 4 MiB stream | < 512 ms | **231 ms** |
| Web app bundle | < 400 kB gzipped | **102 kB** gzipped (329 kB raw) |
| Embed bundle | < 400 kB gzipped | **30 kB** gzipped (97 kB raw) |

The engine is comfortably inside the budget; the 1 Mbit/s requirement is
reached with roughly a 140× margin.

## Where the time goes

Profiling with `node --cpu-prof` on a 4 MiB stream shows:

| Function | Share | Notes |
|---|---|---|
| `putChar` / `writeCell` | ~10 % | the per-character path |
| `eraseInDisplay` / `eraseCells` | ~15 % | only when the stream clears the screen |
| `scrollUp` / `copyRows` | ~20 % | scrolling is the most common bulk operation |
| `commitParam` / `csi` | ~5 % | escape-sequence parsing |
| garbage collection | ~5 % | |

Two optimisations dominate the result:

* **Bulk row copies.** Scrolling used to copy one row at a time through six
  separate `set()` calls. It now uses `TypedArray.copyWithin()`, which has
  memmove semantics and therefore handles the overlapping source and
  destination correctly in a single call per array.
* **Reused scrollback rows.** The scrollback ring reuses its row buffers
  instead of allocating a new `ScreenBuffer` for every scrolled line.

Together these raised the plain-text throughput from 3.0 MB/s to 13.9 MB/s
(7.4 MB/s with the scrollback enabled).

## Rendering

The renderer draws from a glyph atlas and tracks its own dirty rectangle, so a
frame that changes a handful of cells only redraws those cells. The RIP
graphics layer is composited separately beneath the text and is redrawn on
every frame, because it changes independently of the text grid.

The CRT post-processor uses a WebGL2 fragment shader when one is available and
falls back to plain Canvas2D (no post-processing) otherwise, so a machine
without WebGL2 still renders correctly, just without the effects.

## Parsing off the main thread

`packages/core` has no DOM dependencies, so the engine can be driven from a
Web Worker. The RIP interpreter is likewise DOM-free. The current web app
parses on the main thread because the measured parse cost (3.6 ms per 64 KiB)
leaves ample headroom at 60 fps; the worker boundary is available for
lower-powered devices.

## Known costs

* A stream that issues `CSI 2 J` repeatedly pays a full-screen erase each
  time. This is inherent to the operation and matches upstream behaviour.
* The scrollback keeps 5000 rows by default, each 132 cells across seven typed
  arrays — about 9 MB at 132 columns. This is configurable.
