# Zebrafish Brain Explorer

A research interface for the [mapZebrain](https://mapzebrain.org/atlas/) larval zebrafish (6 dpf) brain atlas.
All data (images, meshes, neuron morphologies, annotations) comes from mapZebrain. Please cite them (see *About & data* in the app).

## Run it

```bash
cd zebrafish-atlas
python3 -m http.server 8000
```

Then open <http://localhost:8000>. It must be served over http, not opened as a file, because ES modules and `fetch` need it.
You need an internet connection: slice images, meshes and SWC files stream from `api.mapzebrain.org`, and Three.js loads from jsDelivr.

## Refresh the data snapshot

```bash
python3 scripts/fetch_data.py            # full refresh, ~15–25 min, 4 parallel requests
python3 scripts/fetch_data.py --skip-neurons
```

This writes `data/*.json`. Without a snapshot the app falls back to the live API for everything except the
connectivity matrix and the neuron metadata filters, which need the precomputed files.

## Features

- **Explorer.** Linked dorsal, sagittal and coronal slice viewers plus a 3D view.
  - Click to set the crosshair; the other two planes follow.
  - Wheel steps through slices (Shift = 10 slices). Ctrl/⌘+wheel zooms; drag pans; double-click maximises a pane.
  - Layers:
    - reference brain with adjustable brightness
    - marker expression, blended additively like fluorescence
    - region fills and/or outlines
    - neuron skeletons: bright within ±N µm of the slice, faint full projection
  - Hovering a slice shows the region and neuron under the mouse. `R` asks mapZebrain which regions contain the cursor.
  - 3D view:
    - brain outline, cell-body and neuropil surfaces
    - region meshes and neuron skeletons
    - the current slices as textured planes
    - camera presets, spin, PNG export
    - Shift+click a 3D object to move the crosshair there
  - Copy-link button: the URL restores the cursor and all loaded layers.
- **Regions.** Hierarchy for every atlas version, with search and per-region neuron counts. Each detail page has:
  - slice previews through the region's centre
  - mesh and mask downloads
  - neuron queries: soma in, terminates in, or passes through the region
- **Markers.** Table of 760+ lines and stains, filterable by category, lab and whether traced neurons exist. Details include ZFIN, publication links and average-expression previews.
- **Neurons.** Table of 4,400+ traced cells, filterable by cell type, labelling line, lab and region relationship.
  - CSV export
  - per-neuron morphology statistics (cable length, branch points, tips, extent)
  - SWC download
  - mapZebrain's similarity search
- **Connectivity.** Matrix of soma region × termination (or pass-through) region at three levels of the hierarchy. Click a cell to get the neurons behind it.
- **Overview.** Counts by category, lab, cell type, line and soma location. Every chart has a table view and is clickable.

## Coordinates

Reference volume 597 × 974 × 359 voxels (≈ µm). Slice number equals the coordinate on the slicing axis:
dorsal → z, sagittal → x, coronal → y. Small y is anterior and large z is dorsal. Region meshes and SWC files share this space.

## Files

```
index.html          page shell
css/style.css       styles (dark default, light theme toggle)
js/data.js          API/snapshot loading, coordinate helpers
js/state.js         shared selection state + events
js/slice.js         orthogonal slice viewer
js/viewer3d.js      Three.js viewer
js/explorer.js      layer panel, search, inspector
js/details.js       region/marker/neuron detail panels
js/catalogs.js      Regions / Markers / Neurons pages
js/charts.js        Overview + Connectivity
js/swc.js           SWC parser
scripts/fetch_data.py  snapshot downloader
```
