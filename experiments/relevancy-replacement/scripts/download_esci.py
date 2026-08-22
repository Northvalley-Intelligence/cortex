#!/usr/bin/env python3
"""
Download the official Amazon ESCI dataset (amazon-science/esci-data), filter to
the English-small variant (product_locale == 'us', small_version == 1), join
examples to product titles, and write a raw CSV for the node-side label
mapping step to consume.

Source (official repo, not a mirror): https://github.com/amazon-science/esci-data
Files are stored via git-lfs; fetched through the LFS media endpoint
(media.githubusercontent.com/media/...) since raw.githubusercontent.com only
serves the LFS pointer file for these paths.

Per handoff 00: if a source is unreachable, STOP and report the exact URL/error
-- do not fabricate or sample-generate data. This script raises on any HTTP
error rather than falling back to synthetic rows.
"""
import io
import os
import sys

import pandas as pd
import requests

BASE = "https://media.githubusercontent.com/media/amazon-science/esci-data/main/shopping_queries_dataset"
EXAMPLES_URL = f"{BASE}/shopping_queries_dataset_examples.parquet"
PRODUCTS_URL = f"{BASE}/shopping_queries_dataset_products.parquet"

HERE = os.path.dirname(os.path.abspath(__file__))
RAW_DIR = os.path.join(HERE, "..", "data", "raw")
os.makedirs(RAW_DIR, exist_ok=True)

EXAMPLES_LOCAL = os.path.join(RAW_DIR, "esci_examples.parquet")
PRODUCTS_LOCAL = os.path.join(RAW_DIR, "esci_products.parquet")
OUT_CSV = os.path.join(RAW_DIR, "esci_small_us_raw.csv")


def fetch(url, local_path):
    if os.path.exists(local_path) and os.path.getsize(local_path) > 0:
        print(f"  already downloaded: {local_path} ({os.path.getsize(local_path)} bytes)")
        return
    print(f"  GET {url}")
    resp = requests.get(url, stream=True, timeout=120)
    if resp.status_code != 200:
        raise RuntimeError(f"Failed to download {url}: HTTP {resp.status_code} {resp.text[:300]}")
    total = 0
    with open(local_path, "wb") as f:
        for chunk in resp.iter_content(chunk_size=1024 * 1024):
            f.write(chunk)
            total += len(chunk)
    print(f"  wrote {local_path} ({total} bytes)")


def main():
    print("Downloading ESCI examples parquet...")
    fetch(EXAMPLES_URL, EXAMPLES_LOCAL)
    print("Downloading ESCI products parquet (large, ~1.1GB)...")
    fetch(PRODUCTS_URL, PRODUCTS_LOCAL)

    print("Reading examples parquet...")
    examples = pd.read_parquet(EXAMPLES_LOCAL)
    print(f"  total examples rows: {len(examples)}")
    print(f"  columns: {list(examples.columns)}")

    small_us = examples[(examples["product_locale"] == "us") & (examples["small_version"] == 1)]
    print(f"  small_version==1 & product_locale=='us' rows: {len(small_us)}")
    if len(small_us) == 0:
        raise RuntimeError(
            "No rows matched product_locale=='us' & small_version==1 in ESCI examples -- "
            "schema may differ from expected; STOPPING rather than fabricating rows."
        )

    print("Reading products parquet (filtering to us locale + needed product_ids)...")
    needed_ids = set(small_us["product_id"].unique())
    products = pd.read_parquet(
        PRODUCTS_LOCAL,
        columns=["product_id", "product_locale", "product_title"],
        filters=[("product_locale", "==", "us")],
    )
    print(f"  us-locale product rows: {len(products)}")
    products = products[products["product_id"].isin(needed_ids)]
    print(f"  us-locale product rows matching needed ids: {len(products)}")

    merged = small_us.merge(products, on=["product_id", "product_locale"], how="left")
    missing_title = merged["product_title"].isna().sum()
    print(f"  merged rows: {len(merged)}, missing product_title after join: {missing_title}")
    merged = merged.dropna(subset=["product_title"])

    out = merged[["query_id", "query", "product_id", "product_title", "esci_label", "split"]].rename(
        columns={"product_title": "title"}
    )
    out.to_csv(OUT_CSV, index=False)
    print(f"Wrote {OUT_CSV} ({len(out)} rows)")
    print("esci_label distribution:")
    print(out["esci_label"].value_counts())
    print("split distribution:")
    print(out["split"].value_counts())


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"STOP: {e}", file=sys.stderr)
        sys.exit(1)
