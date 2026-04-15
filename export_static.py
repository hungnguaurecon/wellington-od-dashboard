"""
Export parquet data to optimized GeoJSON files for the static site.

Usage:
    python export_static.py

Reads from ../outgoing_shapefiles and ../incoming_shapefiles,
writes optimized GeoJSON + manifest.json to data/.
"""

import json
import sys
from pathlib import Path

import geopandas as gpd
from shapely import set_precision

# ── Configuration ────────────────────────────────────────────────────────

LINE_MIN_PCT = 5            # Filter out features below this threshold
SIMPLIFY_TOLERANCE = 0.0001 # ~10 m geometry simplification
COORD_PRECISION = 5         # Decimal places for coordinates (~1 m)
KEEP_COLS = ["geometry", "pct_trips", "trips"]

BASE_DIR = Path(__file__).resolve().parent.parent
OUTGOING_DIR = BASE_DIR / "outgoing_shapefiles"
INCOMING_DIR = BASE_DIR / "incoming_shapefiles"
OUTPUT_DIR = Path(__file__).resolve().parent / "data"


def _load_parquet(parquet_path: Path) -> gpd.GeoDataFrame | None:
    """Load a parquet file and ensure pct_trips is computed."""
    if not parquet_path.exists():
        return None
    try:
        gdf = gpd.read_parquet(parquet_path)
    except Exception as e:
        print(f"  WARN: Failed to read {parquet_path}: {e}")
        return None

    if gdf.empty:
        return None

    # Compute pct_trips if missing
    if "trips" in gdf.columns and "pct_trips" not in gdf.columns:
        max_trips = gdf["trips"].max()
        gdf["pct_trips"] = (gdf["trips"] / max_trips * 100) if max_trips > 0 else 0

    return gdf


def _optimize_gdf(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Filter, simplify, round, and strip a GeoDataFrame for export."""
    # Filter low-percentage features
    if "pct_trips" in gdf.columns:
        gdf = gdf[gdf["pct_trips"] >= LINE_MIN_PCT].copy()

    if gdf.empty:
        return gdf

    # Simplify geometries
    gdf.geometry = gdf.geometry.simplify(
        tolerance=SIMPLIFY_TOLERANCE, preserve_topology=True,
    )

    # Round coordinates
    gdf.geometry = gdf.geometry.apply(
        lambda g: set_precision(g, 10 ** -COORD_PRECISION) if g is not None else g,
    )

    # Round pct_trips to 1 decimal
    if "pct_trips" in gdf.columns:
        gdf["pct_trips"] = gdf["pct_trips"].round(1)

    # Keep only essential columns
    cols = [c for c in KEEP_COLS if c in gdf.columns]
    return gdf[cols]


def _get_time_period_folders(analysis_dir: Path) -> list[str]:
    """List time-period subfolders for an analysis directory."""
    periods = []
    for sub in sorted(analysis_dir.iterdir()):
        if sub.is_dir() and (sub / "data.parquet").exists():
            periods.append(sub.name)
    return periods


def _is_consolidated(analysis_dir: Path) -> bool:
    """Check if analysis uses consolidated format (root data.parquet)."""
    root_pq = analysis_dir / "data.parquet"
    if not root_pq.exists():
        return False
    try:
        gdf = gpd.read_parquet(root_pq, columns=["time_period"])
        return "time_period" in gdf.columns
    except Exception:
        return False


def export_direction(source_dir: Path, direction: str, manifest: dict):
    """Export all analyses for one direction (outgoing or incoming)."""
    if not source_dir.exists():
        print(f"  Skipping {direction}: {source_dir} does not exist")
        return

    folders = sorted(f for f in source_dir.iterdir() if f.is_dir())
    total = len(folders)

    for i, analysis_dir in enumerate(folders, 1):
        folder_name = analysis_dir.name
        print(f"  [{i}/{total}] {folder_name}")

        out_dir = OUTPUT_DIR / direction / folder_name
        consolidated = _is_consolidated(analysis_dir)
        consolidated_gdf = None

        if consolidated:
            consolidated_gdf = _load_parquet(analysis_dir / "data.parquet")
            if consolidated_gdf is None:
                continue
            time_periods = sorted(consolidated_gdf["time_period"].unique().tolist())
        else:
            time_periods = _get_time_period_folders(analysis_dir)

        exported_periods = []

        for tp in time_periods:
            if consolidated:
                gdf = consolidated_gdf[consolidated_gdf["time_period"] == tp].copy()
                gdf = gdf.drop(columns=["time_period"], errors="ignore")
                # Compute pct_trips per time period
                if "trips" in gdf.columns:
                    max_trips = gdf["trips"].max()
                    gdf["pct_trips"] = (gdf["trips"] / max_trips * 100) if max_trips > 0 else 0
            else:
                gdf = _load_parquet(analysis_dir / tp / "data.parquet")

            if gdf is None or gdf.empty:
                continue

            gdf = _optimize_gdf(gdf)
            if gdf.empty:
                continue

            # Ensure WGS84
            if gdf.crs is not None and gdf.crs != "EPSG:4326":
                gdf = gdf.to_crs("EPSG:4326")

            # Write GeoJSON
            out_dir.mkdir(parents=True, exist_ok=True)
            out_path = out_dir / f"{tp}.geojson"
            gdf.to_file(out_path, driver="GeoJSON")
            exported_periods.append(tp)

        if exported_periods:
            key = f"{direction}/{folder_name}"
            manifest[key] = exported_periods


def main():
    print("=== Static Site Data Export ===\n")

    # Clean output
    manifest: dict[str, list[str]] = {}

    print("Exporting outgoing data...")
    export_direction(OUTGOING_DIR, "outgoing", manifest)

    print("\nExporting incoming data...")
    export_direction(INCOMING_DIR, "incoming", manifest)

    # Copy metadata.json
    metadata_src = BASE_DIR / "link_metadata.json"
    metadata_dst = OUTPUT_DIR / "metadata.json"
    if metadata_src.exists():
        import shutil
        shutil.copy2(metadata_src, metadata_dst)
        print(f"\nCopied metadata.json ({metadata_src.stat().st_size / 1024:.1f} KB)")

    # Write manifest
    manifest_path = OUTPUT_DIR / "manifest.json"
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"Wrote manifest.json ({len(manifest)} entries)")

    # Summary
    total_files = sum(len(v) for v in manifest.values())
    total_size = sum(
        f.stat().st_size
        for f in OUTPUT_DIR.rglob("*.geojson")
    )
    print(f"\nTotal: {total_files} GeoJSON files, {total_size / 1024 / 1024:.1f} MB")


if __name__ == "__main__":
    main()
