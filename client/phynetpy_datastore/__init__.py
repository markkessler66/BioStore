"""phynetpy_datastore — access your BioStore data hub from PhyNetPy code.

Typical use::

    from phynetpy_datastore import BioStore

    store = BioStore()                      # defaults to http://127.0.0.1:8765
    path = store.fetch("datasets/DEFJ/defj.nex")   # local cached Path
    text = store.read_text("trees/true.nwk")

The client fetches files over the local HTTP API and caches them under
``~/.phynetpy_datastore_cache`` so repeated loads are fast and offline-friendly.
"""

from .client import BioStore, BioStoreError

__all__ = ["BioStore", "BioStoreError"]
__version__ = "0.1.0"
