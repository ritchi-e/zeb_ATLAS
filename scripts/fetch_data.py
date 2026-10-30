#!/usr/bin/env python3
"""Snapshot mapZebrain metadata into ../data/ so the app works even if the API changes.

Uses the same (undocumented) endpoints the official mapzebrain.org atlas calls.
Images, meshes and SWC files are NOT copied; the app streams them from
https://api.mapzebrain.org/media/ on demand.

Usage:  python3 scripts/fetch_data.py            (full refresh, ~10 min)
        python3 scripts/fetch_data.py --skip-neurons   (skip per-neuron metadata)
"""
import json
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

API = "https://api.mapzebrain.org/api/"
OUT = Path(__file__).resolve().parent.parent / "data"
OUT.mkdir(exist_ok=True)
WORKERS = 4  # be polite to a free academic server

# Neuron search options understood by search_for_neurons_IDs_by_region
SEARCH_OPTIONS = {"soma": 1, "terminate": 2, "pass": 3}


def call(endpoint, payload=None, retries=4):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(API + endpoint + "/", data=data,
                                 headers={"Content-Type": "application/json"})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.loads(r.read())
        except Exception as e:  # noqa: BLE001
            if attempt == retries - 1:
                raise RuntimeError(f"{endpoint} {payload}: {e}") from e
            time.sleep(2 * (attempt + 1))


def save(name, obj):
    (OUT / name).write_text(json.dumps(obj, separators=(",", ":")))
    print(f"  saved {name} ({(OUT / name).stat().st_size / 1024:.0f} KB)")


def main():
    skip_neurons = "--skip-neurons" in sys.argv
    print("Fetching core datasets…")
    save("counts.json", call("get_items_count", {}))
    save("brain.json", call("load_brain_data")["data"])
    save("views.json", call("load_2d_views_images_info")["data"])
    save("labs.json", call("get_labs")["labs"])
    save("marker_types.json", call("get_markers_types")["markers_types"])
    save("mpin.json", call("search_for_MPIN_data", {})["data"])

    version = call("load_newest_region_version_data")["versionData"]
    regions = call("load_region_data_by_version", {"regionVersion": version["display_name"]})["data"]
    save("regions.json", regions)

    markers = call("load_markers_data", {"share_view_markers_ids": []})["data"]
    save("markers.json", markers)

    neuron_ids = call("load_all_neurons", {})["neuronsIDs"]
    print(f"{len(neuron_ids)} neurons")

    if not skip_neurons:
        print("Fetching per-neuron metadata (this takes a few minutes)…")
        meta = {}

        def one(nid):
            r = call("get_neuron_metadata", {"neuronID": nid})
            return nid, r.get("neuron_data")

        with ThreadPoolExecutor(WORKERS) as ex:
            for i, (nid, d) in enumerate(ex.map(one, neuron_ids)):
                if d:
                    meta[nid] = {"name": d["name"], "swc": d["files"].get("original"),
                                 **{k: d["info"].get(k, "") for k in ("lab", "marker", "cell_type", "publication", "function")}}
                if i % 250 == 0:
                    print(f"  {i}/{len(neuron_ids)}")
        save("neurons.json", meta)

    print("Fetching neuron ↔ region relationships for the connectivity matrix…")
    current = [r for r in regions["regions_dictionary"].values()
               if r["version"]["display_name"] == version["display_name"]]
    jobs = [(r["id"], opt) for r in current for opt in SEARCH_OPTIONS]

    def by_region(job):
        rid, opt = job
        r = call("search_for_neurons_IDs_by_region",
                 {"regionId": rid, "searchOption": SEARCH_OPTIONS[opt], "minimumNeuronLengthInRegion": 10})
        return rid, opt, r.get("neuronsIDs", [])

    rel = {}
    with ThreadPoolExecutor(WORKERS) as ex:
        for i, (rid, opt, ids) in enumerate(ex.map(by_region, jobs)):
            rel.setdefault(str(rid), {})[opt] = ids
            if i % 50 == 0:
                print(f"  {i}/{len(jobs)}")
    save("region_neurons.json", rel)

    save("meta.json", {"fetched": time.strftime("%Y-%m-%d %H:%M"), "regionVersion": version})
    print("Done.")


if __name__ == "__main__":
    main()
