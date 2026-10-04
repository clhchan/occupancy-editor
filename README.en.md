# Occupancy Editor

A lightweight LAN editor for ROS 2 occupancy maps and Nav2 Keepout masks. Open a map to edit occupancy cells, draw restricted areas on a separate layer, and define navigation waypoints in advance. Maps and masks are saved as separate PGM/YAML pairs; navigation waypoints are saved in their own YAML file.

The application runs on the same computer or robot that stores the map files. A browser on the local network connects to `http://<host-ip>:8080`; no map data is uploaded to a cloud service.

[简体中文](README.md)

## Acknowledgements

This project is based on and inspired by [serboba/occupancy-editor](https://github.com/serboba/occupancy-editor). Thanks to Servet Bora Bayraktar for the original MIT-licensed implementation. This version adds ROS PGM/YAML support, a local file API, independent map/Keepout layers, and Nav2-oriented workflows.

## Features

### 🗺️ Map and Mask Layers

- **ROS map I/O**: Read P2 and P5 PGM files and their matching ROS YAML metadata; export compact binary P5. Missing YAML uses default map parameters. Only `trinary` mode is supported.
- **Three-state map editing**: Preserve occupied, free, and unknown cells, including the ROS unknown sample value `205`.
- **Independent Keepout layer**: Draw a mask over the original map without modifying the source map. Restricted cells are highlighted in the editor and saved independently.

### 📍 Location Layer

- **Mark common locations**: Open a map, switch to **地点层** (Location Layer), and select one of the `A`–`J` cards (up to ten). Press at the desired position and drag to set the heading; the press point is the location.
- **Edit and view**: Double-click a card to rename it or adjust a placed location's coordinates and heading. Clear an individual location or use the eye button to hide all markers temporarily.
- **Save and load**: Select **保存地点** (Save Locations) to export only marked locations to YAML. Opening a map tries to load `waypoints.yaml` from the same directory; use **打开地点** (Open Locations) to choose a file manually.
- **Review before use**: Markers do not check Keepout areas or robot reachability. If the map origin is rotated, review exported headings.

### 🛠️ Editor Tools

- **Editing tools**: Pencil, line, rectangle, eraser, and an unknown-area tool available only on the map layer, with a `1-100 px` brush, wheel adjustment, and pre-click footprint preview.
- **Navigation-friendly canvas**: Undo/redo per layer, reset, fit-to-window, bounded edit history, zoom-to-fit minimum, and right/middle/`Alt`-drag panning.

### 📁 LAN File Browser

- **LAN file browser**: Browse directories, refresh, open maps, masks, or location files, save PGM/YAML pairs or a location YAML, and delete selected files with confirmation.
- **File pairing**: Look for same-name YAML files when opening maps and masks. Mask dimensions must match; resolution and origin are also checked when the mask has YAML metadata. Without mask YAML, the current map parameters are used.
- **Clear feedback**: Success and error notices are shown separately from the file picker.

### ⚡ Technical Highlights

- React, TypeScript, and Vite frontend with canvas-based rendering.
- Python local file service with paths confined to the configured data root (the running user's home directory by default).
- Designed for local-network operation without cloud storage.

## Demo

### 🖥️ Editor Interface

![Map, Keepout mask, and navigation waypoint editing interface](docs/images/editor-interface.png)

_Figure 1. Map, Keepout mask, and navigation waypoint editing interface._

![RViz/Nav2 navigation waypoints and Keepout zones illustration](docs/images/nav2-keepout-illustration.png)

_Figure 2. Navigation waypoints and Keepout zones in RViz/Nav2 (illustration)._

## Getting Started

### 🧰 Prerequisites

- Node.js 18 or newer
- Python 3

### Author Development Environment

- Ubuntu 22.04 arm64
- ROS 2 Humble

### 📦 Installation

Clone this repository and enter its root directory:

```bash
git clone https://github.com/clhchan/occupancy-editor.git
cd occupancy-editor
```

Install the frontend dependencies from that directory:

```bash
npm install
```

### ▶️ Running Locally

`start.sh` serves the built frontend and the local file API. If `dist/` does not exist, it builds the frontend automatically. If `dist/` already exists and the source has changed, run `npm run build` first.

```bash
./start.sh
```

Open `http://localhost:8080`. When the server listens on all interfaces, startup output also lists the available Ethernet and wireless URLs. From another device on the same LAN, use one of those addresses, for example `http://192.168.1.20:8080`.

The listener can be configured with environment variables:

```bash
OCCUPANCY_EDITOR_HOST=0.0.0.0 OCCUPANCY_EDITOR_PORT=8080 ./start.sh
```

### 🧪 Development Server

```bash
./start.sh --dev
```

Development mode runs the Python API on `127.0.0.1:8081` and the Vite frontend on port `8080`. The frontend proxies `/api` requests to the API. The two processes can also be started separately:

```bash
npm run dev:api
npm run dev
```

## Usage

Select **打开地图** (Open Map) to load a `.pgm` file. The editor looks for a same-name YAML file in the same directory and uses default map parameters if it is missing. Once the map is open, use any of the layers below as needed.

### 🗺️ Map Layer

- Select **原图层** (Map Layer) and edit occupancy cells with the drawing tools. Select **保存地图** (Save Map) to write a PGM/YAML pair.

### 🚧 Keepout Layer

- Select **禁行区层** (Keepout Layer) to draw restricted areas, or use **打开掩码** (Open Mask) for an existing mask. Loading checks dimensions and, when mask YAML is present, resolution and origin.
- Select **保存掩码** (Save Mask) to export a separate PGM/YAML pair. New masks default to `keepout_mask.pgm` and `keepout_mask.yaml`.
- **Nav2 integration**: The exported mask uses `mode: trinary` and preserves the source map's dimensions, resolution, and origin for use with a Nav2 Keepout Filter. See the [official Nav2 tutorial](https://docs.nav2.org/rolling/tutorials/general_tutorials/navigation2_with_keepout_filter/navigation2_with_keepout_filter/) for the runtime map server, filter, and costmap setup.

### 📍 Location Layer

- Select **地点层** (Location Layer) and an `A`–`J` card, then press at the desired position and drag to set the heading. Double-click a card to edit its name or a placed marker's coordinates and heading.
- Select **保存地点** (Save Locations) to export only placed markers to a separate YAML file. Opening a map tries to load `waypoints.yaml` from the same directory; use **打开地点** (Open Locations) to load one manually. Example file:

  ```yaml
  version: 1
  frame_id: map
  map: "home.pgm"
  resolution: 0.05
  origin: [0, 0, 0]
  size: [400, 300]
  waypoints:
    - id: "A"
      name: "Living Room"
      pose:
        position: {x: 1.2, y: 2.3, z: 0.0}
        orientation: {x: 0, y: 0, z: 0, w: 1}
  ```

## Local File API

`serve.py` exposes a small file API for the web client:

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/files?path=...` | List a directory |
| `GET` | `/api/file?path=...` | Read a PGM/YAML file |
| `POST` | `/api/save` | Save one file |
| `POST` | `/api/save-pair` | Save a PGM/YAML pair; attempt to roll back the first file if the second write fails |
| `POST` | `/api/delete` | Delete a selected PGM/YAML file |

Paths are restricted to the directory set by `--data-root`, which defaults to the running user's home directory. Keep the service on a trusted LAN and do not expose it directly to an untrusted network.

## Development

Run the test suite, linter, and production build with:

```bash
npm test -- --run
npm run lint
npm run build
```

The main application is in `src/`, ROS PGM/YAML conversion is in `src/utils/rosMap.ts`, and the local file service is implemented by `serve.py`.

## License

Distributed under the MIT License. See [LICENSE](LICENSE) for details.
