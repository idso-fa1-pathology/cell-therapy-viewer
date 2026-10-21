# Dual-slide Pathology Viewer

A folder-based viewer with one URL per case. H&E is on the left, IHC on the right. **Sync views is enabled by default**: zooming, panning, or using Fit in either panel moves both views to the same image coordinates and scale. Turn off the header toggle to navigate independently. Turning it back on aligns both views to the slide you navigated most recently. Both overlays have independent visibility and opacity controls; **Reset views** fits both slides without changing the sync setting.

The toolbar above the IHC slide lets you click a class's color swatch to recolor its points and adjust **Size** from **0.5× to 3×**. Size scales the existing zoom-aware point diameter. The circular-arrow **Reset style** button restores the GeoJSON class colors and the default size. Controls stay above the image and remain available when annotations are hidden. Both slide canvases share the same top edge and height, including when the controls wrap on smaller windows. Changes apply immediately, survive pan/zoom and hiding/showing annotations, and work in both WebGL and Canvas. They apply only to the current page; reloading restores the defaults. The source GeoJSON stays unchanged.

## Data folders and URLs

Choose one data root, anywhere on the host machine. Put each case in its own folder, directly under the root or nested inside group folders. **The folder path determines the URL only.** Files are discovered by their `_HE` / `_IHC` suffixes, so you can copy or rename a folder without renaming its contents:

```text
/path/to/slide-data/
├── 2606J01_511_2_Liv_19/
│   ├── 2606J01_511_2_Liv_19_HE.tiff
│   ├── 2606J01_511_2_Liv_19_HE.png
│   ├── 2606J01_511_2_Liv_19_IHC.tiff
│   └── 2606J01_511_2_Liv_19_IHC.geojson
└── project_A/
    └── test_link/
        ├── 2606J01_511_2_Liv_19_HE.tiff
        ├── 2606J01_511_2_Liv_19_HE.png
        ├── 2606J01_511_2_Liv_19_IHC.tiff
        └── 2606J01_511_2_Liv_19_IHC.geojson
```

These open at:

- `http://127.0.0.1:8000/2606J01_511_2_Liv_19/`
- `http://127.0.0.1:8000/project_A/test_link/`

On a remote machine, replace `127.0.0.1` with that machine's hostname or IP address. Opening `/` lists the discovered cases with their full relative paths, or opens the case directly when there is only one. Direct links and browser refresh work; a missing trailing slash is added automatically. Existing top-level URLs such as `/test_link/` continue to work. Cases in different groups can share the same name without sharing slides or caches.

Each case must contain one file for each role. Default discovery uses `*_HE.tiff` (or `.tif`), `*_IHC.tiff` (or `.tif`), `*_HE.png`, and `*_IHC.geojson` directly in the case folder. Optional settings below select a different subdirectory or an exact file path for each role. With suffix discovery, the filename prefixes can be anything; they do not have to match the folder name. Suffix matching is case-insensitive. Missing or multiple matches produce a visible error instead of guessing which slide or overlay to open. Unrelated files and hidden files such as macOS `._` sidecars are ignored during discovery.

The supplied case is in `data/2606J01_511_2_Liv_19/`. Spaces and Unicode in folder names are URL-encoded by the case list: `project A/test link` opens at `/project%20A/test%20link/`. Hidden folders and the top-level reserved names `api`, `assets`, and `favicon.svg` are excluded. Discovery does not follow directory symlinks.

Discovery walks group folders until it finds a folder containing at least one expected asset in its configured location. That folder is listed as a case, including incomplete cases so they can report missing files. Discovery stops below a case; put additional cases in sibling or group folders, not inside another case. Empty folders and folders containing only unrelated files are skipped.

New folders are discovered on request, without rebuilding or restarting. Copy a complete case under the data root before opening its URL. Restart the viewer after replacing files in an existing case. Slides and overlays are opened on demand; each case has separate, versioned resource URLs and annotation caches.

### Files in subdirectories within a case

For example, every case can use this layout, with or without group folders:

```text
data/
└── project_A/
    └── test_link/
        ├── slides/
        │   ├── original_HE.tiff
        │   └── original_IHC.tiff
        └── results/
            ├── masks/
            │   └── original_HE.png
            └── annotations/
                └── original_IHC.geojson
```

Add these optional settings to your existing `.env`:

```dotenv
HE_SLIDE_SUBDIR=slides
IHC_SLIDE_SUBDIR=slides
HE_MASK_SUBDIR=results/masks
IHC_ANNOTATIONS_SUBDIR=results/annotations
```

Compose passes them to the application; no separate mount or configuration entry is needed for each case or file. The URL stays `/project_A/test_link/`. These settings apply to **every case in this viewer instance** and select the exact directory to search for each role. Keep a setting as `.` (the default) if that file belongs directly in the case folder. Use relative paths inside the case, not absolute paths or `..`. Files elsewhere are ignored, so backups do not introduce ambiguous matches. To give H&E and IHC separate locations, for example, set `HE_SLIDE_SUBDIR=slides/he` and `IHC_SLIDE_SUBDIR=slides/ihc`.

After changing these settings, run `docker compose up -d --build` from the application directory.

### Cohort/slide layout with registered IHC files

For the layout on `rapuplabgpu04`, each case is `DATA_DIR/<cohort>/<slide>/`. Its full relative path becomes the URL. For example:

```text
/rsrch9/home/plm/idso_fa1_pathology/TIER2/ping-cell-therapy/
└── 26-490/
    └── 26-490-145-liver/
        ├── HE-Stains/
        │   └── 26-490-145-liver_HE.tiff
        ├── HE-Recogs/
        │   └── Segformer-mit_b5/
        │       └── 26-490-145-liver_HE.png
        └── IHC-Regs/
            └── 26-490-145-liver/
                ├── 26-490-145-liver_IHC_Reg.tiff
                └── Reg-cell_recog-IHC_to_HE_transformed_shapes.geojson
```

Use the updated `server.py` and `compose.yaml`, then set these values in `.env` on the deployment machine (also provided in [.env.ping.example](.env.ping.example)):

```dotenv
DATA_DIR=/rsrch9/home/plm/idso_fa1_pathology/TIER2/ping-cell-therapy
VIEWER_PORT=9877

HE_SLIDE_PATH=HE-Stains/{slide}_HE.tiff
HE_MASK_PATH=HE-Recogs/Segformer-mit_b5/{slide}_HE.png
IHC_SLIDE_PATH=IHC-Regs/{slide}/{slide}_IHC_Reg.tiff
IHC_ANNOTATIONS_PATH=IHC-Regs/{slide}/Reg-cell_recog-IHC_to_HE_transformed_shapes.geojson
```

`{slide}` is expanded by the viewer to the case folder name (`26-490-145-liver` here). Keep the braces exactly as shown, without a `$`. All paths are relative to that case folder; the cohort and slide names do not need separate Compose entries. This configuration works for every cohort and slide using this layout.

Each nonempty `*_PATH` selects an exact file and overrides the corresponding `*_SUBDIR` and suffix search. It supports the `{slide}` placeholder in directories and filenames. Paths must stay inside the case, with no absolute paths, `..`, or glob patterns. Filenames must match the actual filesystem, including capitalization on Linux. A missing configured file produces an error with its expanded path. Leave a `*_PATH` empty to use the existing suffix discovery for that role.

Rebuild and start from the application directory on `rapuplabgpu04`:

```sh
docker compose up -d --build
```

Open **http://rapuplabgpu04:9877/26-490/26-490-145-liver/**. The root **http://rapuplabgpu04:9877/** discovers cases automatically. Docker publishes host port `9877` to the application's container port `8000`; no Dockerfile edit is needed.

## Docker Compose

Requires Docker with Compose. The image builds the frontend and installs the Python/OpenSlide runtime; no host Node or Python installation is needed.

For a new installation, copy the example from this project directory. If `.env` already exists, keep it and add any desired settings:

```sh
cp .env.example .env
```

Set the host data root in `.env`:

```dotenv
DATA_DIR=/absolute/path/to/slide-data
VIEWER_PORT=8000
```

The default `DATA_DIR=./data` uses the supplied case. The folder must exist. You can also edit `volumes[0].source` in `compose.yaml` directly.

```sh
docker compose up -d --build
```

Compose passes `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`, and `https_proxy` to **both build stages and the running container**, using `http://1mcwebproxy01.mdanderson.edu:3128` by default. This lets `pip install` and `npm ci` use the institutional proxy during the build. `NO_PROXY` and `no_proxy` exclude `localhost`, `127.0.0.1`, and `::1`, keeping the container health check local.

To use another proxy, set `VIEWER_PROXY=http://your-proxy:port` in `.env`. Outside the institutional network, explicitly set `VIEWER_PROXY=` to disable it. Docker handles these [predefined proxy build arguments](https://docs.docker.com/build/building/variables/#proxy-arguments) without adding `ARG` or `ENV` instructions to the Dockerfile.

Open **http://127.0.0.1:8000/2606J01_511_2_Liv_19/**, or use another case folder's name. The service publishes port 8000 on the host by default. Set `VIEWER_BIND_ADDRESS=127.0.0.1` in `.env` if you want it bound only to localhost.

The host data root is mounted **read-only** at `/data`. Generated annotation caches live in the separate `viewer-cache` Docker volume at `/cache`, and survive container replacement. Slide files are excluded from the build context and image. Copy this project to another machine, set its data path, and run the same command.

Useful commands:

```sh
docker compose ps                  # Includes container health
docker compose logs -f viewer      # Startup / preprocessing messages
docker compose restart viewer     # After replacing existing case files
docker compose up -d --build       # After code or .env changes
docker compose down               # Stop; keep source data and caches
```

Configuration:

| `.env` setting | Default | Purpose |
| --- | --- | --- |
| `DATA_DIR` | `./data` | Host folder containing the case subfolders |
| `HE_SLIDE_SUBDIR` | `.` | Directory within each case containing the H&E TIFF |
| `IHC_SLIDE_SUBDIR` | `.` | Directory within each case containing the IHC TIFF |
| `HE_MASK_SUBDIR` | `.` | Directory within each case containing the H&E PNG |
| `IHC_ANNOTATIONS_SUBDIR` | `.` | Directory within each case containing the IHC GeoJSON |
| `HE_SLIDE_PATH` | Empty | Exact H&E TIFF path relative to each case; supports `{slide}` |
| `IHC_SLIDE_PATH` | Empty | Exact IHC TIFF path relative to each case; supports `{slide}` |
| `HE_MASK_PATH` | Empty | Exact H&E PNG path relative to each case; supports `{slide}` |
| `IHC_ANNOTATIONS_PATH` | Empty | Exact IHC GeoJSON path relative to each case; supports `{slide}` |
| `VIEWER_PORT` | `8000` | Host port; the container always listens on port 8000 |
| `VIEWER_BIND_ADDRESS` | `0.0.0.0` | Host interface on which to publish the port |
| `VIEWER_IMAGE` | `pathology-viewer:local` | Image name/tag to build and run |
| `MAX_OPEN_CASES` | `4` | Maximum simultaneously open cases per server |
| `VIEWER_PROXY` | `http://1mcwebproxy01.mdanderson.edu:3128` | Proxy for builds and containers; set an empty value to disable |

To use the image without Compose:

```sh
docker build -t pathology-viewer:local .
docker run -d --name pathology-viewer --init --restart unless-stopped \
  -p 8000:8000 \
  --mount type=bind,source=/absolute/path/to/slide-data,target=/data,readonly \
  --mount type=volume,source=pathology-viewer-cache,target=/cache \
  pathology-viewer:local
```

## Run locally without Docker

Requires Python 3.11+ and Node.js 20.19+ (or 22.12+). Run these commands from this directory:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:8000**. One Python process serves the built app, slide tiles, and prepared annotations. The native server binds only to loopback by default. No external services or CDN requests are needed at runtime.

`openslide-bin` supplies the native OpenSlide library on supported macOS, Windows, and Linux platforms. If a wheel is unavailable, install the native OpenSlide library using your platform's package manager and install the remaining requirements without `openslide-bin`.

Opening a case for the first time automatically streams and prepares its annotation file. Slides are usable during preparation. Native caches live in `.cache/cases/<case>/`; subsequent starts reuse them. Changes to the annotation source path, size, modification time, or slide dimensions invalidate the cache.

Use another data root:

```sh
DATA_DIR=/absolute/path/to/slide-data npm start
```

To prepare all cases, or just one case, without starting a server:

```sh
npm run prepare:data
npm run prepare:data -- --case 2606J01_511_2_Liv_19
npm run prepare:data -- --case "project A/test link"
```

For frontend development, keep `npm start` running in one terminal, run `npm run dev` in another, and open the Vite URL. Vite proxies `/` and `/api` to port 8000 and serves the frontend at each case path. A production build needs only `npm start`.

The Python server accepts `--data-dir`, `--cache-dir`, `--host`, `--port`, and `--max-open-cases`, or their environment equivalents `DATA_DIR`, `CACHE_DIR`, `VIEWER_HOST`, `VIEWER_PORT`, and `MAX_OPEN_CASES`. The subdirectory settings also work natively through the environment or `--he-slide-subdir`, `--ihc-slide-subdir`, `--he-mask-subdir`, and `--ihc-annotations-subdir`. Exact paths can likewise be set through the environment or `--he-slide-path`, `--ihc-slide-path`, `--he-mask-path`, and `--ihc-annotations-path`. Unlike Docker Compose, native startup does not load `.env` automatically.

```sh
.venv/bin/python server.py --data-dir /path/to/slide-data --host 0.0.0.0 --port 8001
```

## Inspection of the supplied files

| File | Actual contents | Coordinate mapping |
| --- | --- | --- |
| `2606J01_511_2_Liv_19_HE.tiff` | 22,970 × 30,170, 8-bit RGB, eight pyramid levels, 256 × 256 native tiles | Level-0 pixels, top-left origin |
| `2606J01_511_2_Liv_19_HE.png` | 717 × 942, RGB categorical mask, seven exact colors including black; no alpha channel | Exactly matches H&E pyramid level 5; mapped to full H&E extent |
| `2606J01_511_2_Liv_19_IHC.tiff` | 22,970 × 30,170, 8-bit RGB, nine pyramid levels, 128 × 128 native tiles | Level-0 pixels, top-left origin |
| `2606J01_511_2_Liv_19_IHC.geojson` | An array of two MultiPoint features, 298,344 coordinates, 18,159,549 bytes | Direct IHC pixel coordinates; no geographic projection, scaling, or axis inversion |

The mask colors are black `(0,0,0)`, green `(0,128,0)`, navy `(0,0,128)`, blue `(0,0,255)`, maroon `(128,0,0)`, magenta `(255,0,255)`, and purple `(128,0,128)`. Only black becomes transparent. Label colors are preserved; class meanings are not supplied, so the app does not invent names. Nearest-neighbor display preserves discrete mask labels. The mask remains a low-resolution segmentation: magnification does not add detail.

Mask scale is **22,970 / 717 = 32.0362622** horizontally and **30,170 / 942 = 32.0276008** vertically. Using a rounded `32×` factor would drift at the right and bottom edges. The implementation follows Polyscope's full-extent overlay convention. Matching pyramid dimensions and the visible tissue landmarks support this placement; the PNG has no independent registration metadata.

The two annotation classes are **hCD45+** (10,553 points, red) and **hCD45−** (287,791 points, green). Bounds are `(488.4212, 487.9823)` through `(23747.0858, 29893.0226)`. **Two source points lie outside the image**, one in each class. They are retained in the prepared data, excluded from drawing outside the slide, and reported in the annotation status tooltip. The dataset is not stretched to force these outliers into the image.

Overview inspection confirms that annotation density follows the IHC tissue and its internal landmarks. This establishes the pixel-coordinate convention, not independent validation of every biological detection. Both slides have orientation 1. The IHC TIFF contains a rotated tissue image within its existing pixel canvas; no extra viewer rotation is applied. Its physical-resolution metadata is not credible for microscopy, so the UI uses image pixels and image zoom percentages rather than inferred magnification or micrometers.

## Rendering and performance

- **Plain JavaScript + OpenSeadragon 6**, built with Vite. Two viewer instances, no application framework or per-point DOM objects.
- **OpenSlide Deep Zoom** reads the existing TIFF pyramids and returns only requested 256-pixel JPEG tiles with one-pixel overlap. Neither TIFF is decoded in full or downloaded to the browser.
- The server shares a **64 MiB decoded tile cache** and a **64 MiB encoded tile cache**, deduplicates in-flight tile requests, and limits simultaneous tile generation to four jobs. Each viewer limits loading to four requests and caches at most 140 tiles.
- At most **four cases** are held open by default. Idle cases are closed when another case needs their slot; active requests and annotation preparation protect their handles from eviction. Both tile caches are shared across cases and keyed by case/version. Two background workers prepare annotations, so the server does not load the whole data root at startup.
- **Streaming preprocessing** uses `ijson`. Two passes retain only one uint32 class ID per feature and write little-endian Float32 `(x, y, class)` records. Even a single huge MultiPoint is never materialized as a Python coordinate list. The supplied file becomes **3,580,128 bytes**.
- A **Web Worker** downloads the packed buffer, builds an adaptive spatial index and typed colors, then transfers buffer ownership to the UI and terminates. The main thread never parses GeoJSON.
- **WebGL** uploads coordinates once and updates the color buffer only when the user edits class colors. Size changes use a shader uniform. Neither style control rebuilds the spatial index or downloads annotations again. A viewport query submits at most 15,000 / 30,000 / 50,000 point indices, depending on zoom. Low-zoom views use a stable spatial sample; sparse detailed views show every visible point. Extremely dense detailed regions still respect the budget. The footer indicates sampling.
- **Canvas fallback** uses the same index with 1,000 / 3,000 / 10,000 point budgets and small drawing batches. It is also used after WebGL context loss.
- Point projection comes from the IHC tiled image's current transform on OpenSeadragon's draw event. The mask uses H&E's own overlay transform. Device pixel ratio is handled separately from image coordinates; point raster resolution is capped at DPR 2.

The supplied file and synthetic million-point indexes are covered by tests. No universal frame-rate guarantee is implied: GPU, display refresh rate, browser, slide compression, and point density affect performance. Browser memory for the packed point data and index grows linearly with coordinate count, even though work per draw is bounded. Arbitrarily large datasets beyond available browser memory would need server-side annotation tiling.

This deliberately supports **Point and MultiPoint** annotations, including feature arrays, a single Feature, and FeatureCollections. Unsupported geometry fails with a visible error rather than silently disappearing. Polygon editing and other annotation types are outside this viewer's scope.

## Tests

```sh
npm test
npx playwright install chromium
npm run test:browser
```

To use an installed Google Chrome instead:

```sh
PLAYWRIGHT_CHANNEL=chrome npm run test:browser
```

Tests cover case-specific tiles/masks/annotations, cache isolation and eviction, copied folders with unchanged filenames, nested cases sharing a leaf name, configured asset subdirectories, exact file-path templates with `{slide}` expansion, case-insensitive suffix discovery, ambiguous matches, encoded names, deep links and refresh, missing files, and path confinement. Rendering tests cover streaming formats, class/color preservation, mask transparency, cache reuse and bounds, real overview/detail/edge tiles, spatial culling, a million coincident points with a sparse neighbor, affine projection, synchronized and independent navigation, re-syncing from either panel, toggles and opacity, pan/zoom/reset, resizing, high DPI, and Canvas fallback. Browser tests write screenshots and navigation metrics to `.cache/verification/`. They start the local server automatically if needed or use the running Docker service; the supplied case must be available under `data/2606J01_511_2_Liv_19/` for data integration tests. The nested-layout browser tests start separate temporary native servers to verify environment configuration, URL decoding, slide and overlay loading, and refresh together, including the cohort/slide layout with registered IHC filenames.

Verification on October 21, 2026: all **40 tests passed** (3 JavaScript, 27 Python, 10 Chrome browser tests), including the cohort/slide layout with exact path templates, nested case URLs with configured asset subdirectories, copied folders with unchanged filenames, bidirectional view synchronization, a synthetic million-point browser layer, and recovery from WebGL context loss. Pixel checks verify class recoloring, size changes, and style reset in both WebGL and Canvas; custom styles also survive a switch from WebGL to Canvas. The existing browser suite ran against the rebuilt Compose service; the nested-layout tests used isolated native servers. The deployment example was checked with `docker compose config`, including literal `{slide}` placeholders, the data mount, and host port `9877`. Earlier Docker builds succeeded for Linux ARM64 and AMD64; both read the supplied TIFFs and prepared all 298,344 points (AMD64 ran under emulation). The data bind mount was verified read-only.

A previous exhaustive comparison verified all 298,344 source coordinates and class IDs; maximum Float32 coordinate error was 0.0009766 image pixels. Cellular-resolution inspection at approximately 115% image zoom showed points tracking individual cells.

## Polyscope reference

The original `../polyscope-new` project was inspected without modification:

- `frontend/src/viewers/OpenSeadragonViewer.jsx`: tiled rendering, image-coordinate transforms, and full-extent raster overlays.
- `frontend/src/overlays/PointOverlay.jsx`, `pointSpatialIndex.js`, and `pointProjection.js`: typed buffers, GPU point drawing, viewport culling, adaptive indexing, and bounded level of detail.
- `frontend/src/workers/geojsonImport.worker.js`: moving heavy preparation off the UI thread.
- `backend/main.py` and `backend/services/tile_cache_service.py`: tile-source reuse, concurrency limits, and byte-bounded caches.

Only the standalone spatial-index and projection utilities were adapted; their MIT license is preserved in `THIRD_PARTY_NOTICES.txt`. The backend, preprocessing, UI, and overlay integration here are independent.

API references: [OpenSlide Python / Deep Zoom](https://openslide.org/api/python/), [OpenSeadragon](https://openseadragon.github.io/docs/), and [ijson streaming parser](https://github.com/ICRAR/ijson).
