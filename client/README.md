# phynetpy_datastore

A zero-dependency Python client that lets your **PhyNetPy** code pull data
files, networks, and alignments straight from a running **BioStore** hub —
so those files never have to live in your git repo.

## Install

From this folder, into whatever environment PhyNetPy runs in:

```bash
py -m pip install -e .
```

(Or just copy the `phynetpy_datastore/` package next to your project — it only
uses the standard library.)

## Use

Make sure the BioStore server is running (`py backend/app.py`), then:

```python
from phynetpy_datastore import BioStore

store = BioStore()  # http://127.0.0.1:8765 by default
# Logs in automatically using BIOSTORE_PASSWORD / BIOSTORE_DISPLAY_NAME

# Download a file to a local cache and get its path (great for readers that
# expect a filename):
nexus_path = store.fetch("datasets/DEFJ/defj.nex")

# Or read content directly:
text = store.read_text("trees/true_network.nwk")

# Pull parsed structures:
networks = store.network("trees/true_network.nwk")   # list of graph dicts
aln = store.alignment("datasets/DEFJ/defj.nex")        # taxa/sequences/stats

# Handy for feeding a PhyNetPy newick reader:
for s in store.newick_strings("trees/gene_trees.nwk"):
    ...  # parse s with PhyNetPy
```

If another lab mate has a file open in the BioStore UI, `fetch` / `read_text`
will fail with HTTP 423 until they close the tab.

### Shared lab server

```python
store = BioStore(
    "http://lab-pc-name:8765",
    password="your-shared-lab-password",
    display_name="Marky",
)
```

Or set env vars (see below) and keep using `BioStore()`.

### Wiring into PhyNetPy

A common pattern is a thin helper in your codebase:

```python
from phynetpy_datastore import BioStore
_STORE = BioStore()

def data(rel_path: str):
    """Resolve a BioStore-relative path to a local file for PhyNetPy readers."""
    return _STORE.fetch(rel_path)
```

Then anywhere in PhyNetPy: `NetworkReader.read(data("datasets/DEFJ/defj.nex"))`.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `BIOSTORE_URL` | `http://127.0.0.1:8765` | Server address |
| `BIOSTORE_CACHE` | `~/.phynetpy_datastore_cache` | Where `fetch()` caches files |
| `BIOSTORE_PASSWORD` | *(empty)* | Shared lab password (required if the server set one) |
| `BIOSTORE_DISPLAY_NAME` | `phynetpy-client` | Name shown on locks if the client ever acquires one |
