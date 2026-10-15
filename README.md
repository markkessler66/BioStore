# BioStore

A **local, git-free data hub** for phylogenetic-network development with
[PhyNetPy]. Store the data files, data sets, and examples you constantly
generate and copy around — organised in arbitrarily nested folders — and open
them in purpose-built viewers:

- **Phylogenetic network viewer** — renders newick / extended-newick networks
  as clean diagrams. Taxa sit at the leaves; every internal and reticulation
  node is hoverable for its label, branch lengths, and inheritance
  probabilities (γ). Zoom, pan, and "Fit".
- **Alignment studio** — click a `.nex` / `.fasta` / `.phy` file and edit the
  taxa names and sequence data in a colored, spreadsheet-style grid with live
  statistics (columns, gaps, composition). One-click **format conversion**
  (FASTA ↔ PHYLIP ↔ NEXUS) and save. Networks embedded in a NEXUS `TREES`
  block open in the network viewer with a click.
- **Everything else** — opens in a fast text editor (Ctrl/⌘+S to save).

Plus the developer niceties: fuzzy **filename + content search**, drag-and-drop
**upload**, folder create / rename / delete, a **storage dashboard**, and a
**"Copy PhyNetPy snippet"** button on every file that hands you the exact Python
to load it from code.

## Why it's not in your repo

All data lives under a **data root** (`./biostore_data` by default) that is
`.gitignore`d. Your PhyNetPy repo stays lean; the data is reachable over a tiny
local HTTP API and via the bundled Python client.

## Quick start

```powershell
# from this folder (Windows PowerShell)
./start.ps1
```

or manually:

```bash
py -m pip install -r backend/requirements.txt
py run.py
```

Then open <http://127.0.0.1:8765>. Some sample data (including a `DEFJ`-style
dataset and an extended-newick network) is already there to explore.

### Configuration

| Env var | Default | Meaning |
|---|---|---|
| `BIOSTORE_DATA_ROOT` | `./biostore_data` | Where all files are stored |
| `BIOSTORE_HOST` | `127.0.0.1` | Bind host |
| `BIOSTORE_PORT` | `8765` | Bind port |
| `BIOSTORE_PUBLIC_URL` | `http://{HOST}:{PORT}` | URL used in PhyNetPy snippets |
| `BIOSTORE_PASSWORD` | *(unset)* | Shared lab password (recommended for sharing) |
| `BIOSTORE_LOCK_LEASE` | `60` | File-lock lease length (seconds) |
| `BIOSTORE_LOCK_HEARTBEAT` | `15` | How often open tabs renew locks |

Point `BIOSTORE_DATA_ROOT` anywhere you like — e.g. a big folder on another
drive — and BioStore will manage it.

## Desktop window

A [Tauri](https://tauri.app) shell opens the same UI in a native window and
starts the local server when port 8765 is free. `start.ps1`, `launch.ps1`, and
`py run.py` are unchanged.

`py run.py --desktop` (what the shell runs) binds `127.0.0.1:8765` with the
reloader off. The data root is still `./biostore_data`, or `BIOSTORE_DATA_ROOT`
if you set it. If BioStore is already serving that port, the window attaches
and closing it leaves that server running. A server the shell itself started
stops when you close the window.

You need Node.js, Rust, the WebView2 runtime, and the same Python environment
you already use for BioStore. PhyNetPy only needs to be importable for Analyses.

```powershell
cd desktop
npm install
npm run tauri dev
```

If startup fails, the window shows the error and the last lines of
`%LOCALAPPDATA%\BioStore\desktop.log`.

## Lab sharing

Run **one** BioStore server that everyone connects to. Opening a file takes an
**exclusive lock**: other lab mates cannot read or write that file until the
holder closes the tab (locks auto-expire after ~60s if a browser crashes).

On the host machine:

```powershell
$env:BIOSTORE_HOST = "0.0.0.0"
$env:BIOSTORE_PASSWORD = "your-shared-lab-password"
$env:BIOSTORE_PUBLIC_URL = "http://lab-pc-name:8765"   # whatever others will type
./start.ps1
```

Lab mates open `http://lab-pc-name:8765`, sign in with the shared password and
their own display name, then use the UI as usual. For PhyNetPy:

```powershell
$env:BIOSTORE_URL = "http://lab-pc-name:8765"
$env:BIOSTORE_PASSWORD = "your-shared-lab-password"
$env:BIOSTORE_DISPLAY_NAME = "Marky"
```

If `BIOSTORE_PASSWORD` is unset, anyone who can reach the server can log in
(any password works) — fine for solo localhost use, not for a shared host.

## Linking to PhyNetPy

Install the client (see [`client/README.md`](client/README.md)) and load files
from code:

```python
from phynetpy_datastore import BioStore
store = BioStore()
path = store.fetch("datasets/DEFJ/defj.nex")   # cached local Path for readers
nets = store.network("trees/true_network.nwk")  # parsed graph dicts
```

The **Copy PhyNetPy snippet** button in the UI generates this for any file.

## Layout

```
BioStore/
├── backend/            Flask API + parsers
│   ├── app.py          REST endpoints, serves the frontend
│   ├── auth.py         shared-password sessions
│   ├── locks.py        exclusive per-file locks
│   ├── storage.py      safe filesystem access under the data root
│   ├── config.py       paths / host / port / password
│   └── parsers/        extended-newick + alignment parsers
├── frontend/           vanilla-JS single-page app (D3 for networks)
├── client/             phynetpy_datastore — Python client for PhyNetPy
├── desktop/            Tauri shell (native window)
├── biostore_data/      default data root (git-ignored)
├── run.py / start.ps1  launchers
└── README.md
```

## Supported file types

| Kind | Extensions | Opens as |
|---|---|---|
| Network / tree | `.nwk .newick .tree .tre .net .gt` | network viewer |
| Alignment | `.nex .nexus .fasta .fa .fna .phy .phylip .aln` | alignment studio |
| Anything else | * | text editor |

## Notes on the network parser

The extended-newick parser understands PhyloNet/PhyNetPy reticulation notation,
where a hybrid node appears once with its subtree and again as a pointer
(`#H1`, `#LGT2`, …). Both occurrences are merged into a single node with
multiple parents, and each incoming edge keeps its own branch length / γ.
```
