#!/usr/bin/env python3
"""
Download the WANDS dataset (wayfair/WANDS, official repo), join query + product
+ label, and write a raw CSV for the node-side label mapping step to consume.

Source: https://github.com/wayfair/WANDS (dataset/query.csv, product.csv,
label.csv -- tab-separated despite the .csv extension).

Per handoff 00: if a source is unreachable, STOP and report the exact URL/error
-- do not fabricate or sample-generate data.
"""
import os
import sys

import pandas as pd
import requests

BASE = "https://raw.githubusercontent.com/wayfair/WANDS/main/dataset"
QUERY_URL = f"{BASE}/query.csv"
PRODUCT_URL = f"{BASE}/product.csv"
LABEL_URL = f"{BASE}/label.csv"

HERE = os.path.dirname(os.path.abspath(__file__))
RAW_DIR = os.path.join(HERE, "..", "data", "raw")
os.makedirs(RAW_DIR, exist_ok=True)

QUERY_LOCAL = os.path.join(RAW_DIR, "wands_query.csv")
PRODUCT_LOCAL = os.path.join(RAW_DIR, "wands_product.csv")
LABEL_LOCAL = os.path.join(RAW_DIR, "wands_label.csv")
OUT_CSV = os.path.join(RAW_DIR, "wands_raw.csv")


def fetch(url, local_path):
    if os.path.exists(local_path) and os.path.getsize(local_path) > 0:
        print(f"  already downloaded: {local_path} ({os.path.getsize(local_path)} bytes)")
        return
    print(f"  GET {url}")
    resp = requests.get(url, timeout=120)
    if resp.status_code != 200:
        raise RuntimeError(f"Failed to download {url}: HTTP {resp.status_code} {resp.text[:300]}")
    with open(local_path, "wb") as f:
        f.write(resp.content)
    print(f"  wrote {local_path} ({len(resp.content)} bytes)")


def main():
    print("Downloading WANDS query.csv, product.csv, label.csv...")
    fetch(QUERY_URL, QUERY_LOCAL)
    fetch(PRODUCT_URL, PRODUCT_LOCAL)
    fetch(LABEL_URL, LABEL_LOCAL)

    queries = pd.read_csv(QUERY_LOCAL, sep="\t")
    products = pd.read_csv(PRODUCT_LOCAL, sep="\t")
    labels = pd.read_csv(LABEL_LOCAL, sep="\t")

    print(f"  queries: {len(queries)}, products: {len(products)}, labels: {len(labels)}")

    merged = labels.merge(queries[["query_id", "query"]], on="query_id", how="left")
    merged = merged.merge(products[["product_id", "product_name"]], on="product_id", how="left")

    missing_query = merged["query"].isna().sum()
    missing_title = merged["product_name"].isna().sum()
    print(f"  merged rows: {len(merged)}, missing query: {missing_query}, missing product_name: {missing_title}")

    merged = merged.dropna(subset=["query", "product_name"])
    out = merged[["query_id", "query", "product_id", "product_name", "label"]].rename(
        columns={"product_name": "title", "label": "wands_label"}
    )
    out.to_csv(OUT_CSV, index=False)
    print(f"Wrote {OUT_CSV} ({len(out)} rows)")
    print("wands_label distribution:")
    print(out["wands_label"].value_counts())


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"STOP: {e}", file=sys.stderr)
        sys.exit(1)
