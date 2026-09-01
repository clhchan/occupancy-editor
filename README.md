# Nav2 Keepout Mask Editor

A lightweight LAN web editor for ROS 2 occupancy maps and Nav2 Keepout masks. Open a map,
draw restricted areas on a separate mask layer, and export a matching PGM/YAML pair for
`nav2_map_server` and the Nav2 Costmap Filter system.

The application runs on the same computer or robot that stores the map files. A browser on
the local network connects to `http://<host-ip>:8080`; no map data is uploaded to a cloud service.

[简体中文](README.zh-CN.md)

## Acknowledgements

This project is based on and inspired by [serboba/occupancy-editor](https://github.com/serboba/occupancy-editor).
Thanks to Servet Bora Bayraktar for the original MIT-licensed implementation. This version adds
ROS PGM/YAML support, a local file API, independent map/Keepout layers, and Nav2-oriented workflows.

## Features

### 🗺️ Map and Mask Layers

- **ROS map I/O**: Read P2 and P5 PGM files with ROS map YAML metadata; export compact binary P5.
- **Three-state map editing**: Preserve occupied, free, and unknown cells, including the ROS
  unknown sample value `205`.
- **Independent Keepout layer**: Draw a mask over the original map without modifying the source
  map. Restricted cells are highlighted in the editor and saved independently.

### 🛠️ Editor Tools

- **Editing tools**: Pencil, line, rectangle, eraser, and unknown-area tools with a `1-100 px`
  brush, wheel adjustment, and pre-click footprint preview.
- **Navigation-friendly canvas**: Undo/redo per layer, reset, fit-to-window, bounded edit history,
  zoom-to-fit minimum, and right/middle/`Alt`-drag panning.

### 📁 LAN File Browser

- **LAN file browser**: Browse directories, refresh, open maps or masks, save PGM/YAML pairs, and
  delete selected files with confirmation.
- **Safe pairing**: Automatically match same-name YAML files and validate mask dimensions,
  resolution, and origin before loading.
- **Clear feedback**: Success and error notices are shown separately from the file picker.

### ⚡ Technical Highlights

- React, TypeScript, and Vite frontend with canvas-based rendering.
- Python local file service with home-directory path confinement.
- Designed for local-network operation without cloud storage.

## Demo

### 🖥️ Editor and Keepout Workflow

![Complete browser editor interface](1.png)

_Figure 1. Complete map and Keepout mask editing interface._

![Nav2 Keepout effect](2.png)

_Figure 2. Keepout zones visible during Nav2 navigation._

## Getting Started

### 🧰 Prerequisites

- Node.js 18 or newer
- Python 3

### Author Development Environment

- Ubuntu 22.04 arm64
- ROS 2 Humble

### 📦 Installation

Clone the repository and enter its root directory first. Replace the example URL with the URL of
your GitHub repository:

```bash
git clone https://github.com/<your-account>/<your-repository>.git
cd <your-repository>
```

Install the frontend dependencies from that directory:

```bash
npm install
```

### ▶️ Running Locally

`start.sh` serves the built frontend and the local file API. If `dist/` does not exist, it builds
the frontend automatically.

```bash
./start.sh
```

Open `http://localhost:8080`. When the server listens on all interfaces, startup output also lists
the available Ethernet and wireless URLs. From another device on the same LAN, use one of those
addresses, for example `http://192.168.1.20:8080`.

The listener can be configured with environment variables:

```bash
OCCUPANCY_EDITOR_HOST=0.0.0.0 OCCUPANCY_EDITOR_PORT=8080 ./start.sh
```

### 🧪 Development Server

```bash
./start.sh --dev
```

Development mode runs the Python API on `127.0.0.1:8081` and the Vite frontend on port `8080`.
The frontend proxies `/api` requests to the API. The two processes can also be started separately:

```bash
npm run dev:api
npm run dev
```

## Usage

1. Select **Open Map** and choose a `.pgm` file. The editor automatically looks for a same-name
   YAML file in the same directory.
2. Select the **Keepout Layer** and draw restricted areas. The original map remains visible as the
   background layer.
3. For a new mask, choose **Save Mask**. To continue editing an existing mask, choose **Open Mask**
   while the original map is still loaded. The mask PGM and its YAML metadata must match the map's
   size, resolution, and origin.
4. Choose a directory and filename in the file browser. Saving writes a PGM/YAML pair; the default
   mask names are `keepout_mask.pgm` and `keepout_mask.yaml`.
5. Use the exported mask pair with your Nav2 Keepout configuration (see the official tutorial below).

## Nav2 Keepout Integration

The editor exports a ROS-compatible `keepout_mask.pgm` and `keepout_mask.yaml` pair. The mask uses
`mode: trinary`, keeps the source map's size/resolution/origin, and is ready to be loaded by a
Nav2 Keepout Filter setup.

For the runtime configuration, map server, and costmap filter setup, follow the official Nav2
tutorial: [Navigation2 with Keepout Filter](https://docs.nav2.org/rolling/tutorials/general_tutorials/navigation2_with_keepout_filter/navigation2_with_keepout_filter/).

## Local File API

`serve.py` exposes a small file API for the web client:

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/files?path=...` | List a directory |
| `GET` | `/api/file?path=...` | Read a PGM/YAML file |
| `POST` | `/api/save` | Save one file |
| `POST` | `/api/save-pair` | Atomically save a PGM/YAML pair |
| `POST` | `/api/delete` | Delete a selected PGM/YAML file |

Paths are restricted to the home directory of the user running the service. Keep the service on a
trusted LAN and do not expose it directly to an untrusted network.

## Development

Run the test suite, linter, and production build with:

```bash
npm test -- --run
npm run lint
npm run build
```

The main application is in `src/`, ROS PGM/YAML conversion is in `src/utils/rosMap.ts`, and the
local file service is implemented by `serve.py`.

## License

Distributed under the MIT License. See [LICENSE](LICENSE) for details.
