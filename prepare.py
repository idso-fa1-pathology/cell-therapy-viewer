"""Stream point GeoJSON into a cached little-endian Float32 (x, y, class) file.

Two passes avoid materializing even a single huge MultiPoint. The first retains
only a uint32 class ID per feature; the second writes coordinates incrementally.
"""
from array import array
import hashlib
import json
import math
from pathlib import Path
import struct
import time

import ijson


def feature_prefix(source):
    with source.open("rb") as stream:
        while (char := stream.read(1)) in (b" ", b"\n", b"\r", b"\t"):
            pass
        if char == b"[":
            return "item"
        stream.seek(0)
        for prefix, event, value in ijson.parse(stream, use_float=True):
            if prefix == "type" and event == "string":
                if value == "FeatureCollection":
                    return "features.item"
                if value == "Feature":
                    return ""
                break
    raise ValueError("Expected a GeoJSON Feature, FeatureCollection, or feature array.")


def feature_events(source, root, progress, phase):
    with source.open("rb") as stream:
        for number, (prefix, event, value) in enumerate(ijson.parse(stream, use_float=True)):
            if number % 65536 == 0:
                progress(phase, min(1, stream.tell() / max(1, source.stat().st_size)))
            if prefix == root:
                yield "", event, value
            elif prefix.startswith(root + ".") if root else bool(prefix):
                yield prefix[len(root) + 1:] if root else prefix, event, value
    progress(phase, 1)


def prepare_points(source, cache, dimensions, progress=lambda *_: None):
    source, cache = Path(source), Path(cache)
    cache.mkdir(parents=True, exist_ok=True)
    stat = source.stat()
    signature = [2, str(source.resolve()), stat.st_size, stat.st_mtime_ns, *dimensions]
    version = hashlib.sha256(json.dumps(signature).encode()).hexdigest()[:16]
    binary = cache / f"points-{version}.bin"
    manifest = cache / f"points-{version}.json"
    if binary.exists() and manifest.exists():
        result = json.loads(manifest.read_text())
        if binary.stat().st_size == result["count"] * 12:
            return result, binary

    started = time.perf_counter()
    root = feature_prefix(source)
    classes, class_lookup, feature_classes = [], {}, array("I")
    name, color, geometry = None, [], None
    for prefix, event, value in feature_events(source, root, progress, "Reading classes"):
        if prefix == "" and event == "start_map":
            name, color, geometry = None, [], None
        elif prefix == "geometry.type" and event == "string":
            geometry = value
        elif prefix == "properties.classification.name" and event == "string":
            name = value
        elif prefix == "properties.classification.color.item" and event == "number":
            color.append(max(0, min(255, round(value))))
        elif prefix == "" and event == "end_map":
            if geometry not in ("Point", "MultiPoint"):
                raise ValueError(f"Unsupported geometry {geometry!r}; this viewer supports Point and MultiPoint.")
            rgb = tuple(color[:3]) if len(color) >= 3 else (30, 180, 145)
            key = (name or "Unclassified", rgb)
            if key not in class_lookup:
                class_lookup[key] = len(classes)
                classes.append({"name": key[0], "color": list(rgb), "count": 0})
            feature_classes.append(class_lookup[key])

    width, height = dimensions
    count = outside = invalid = 0
    bounds = [math.inf, math.inf, -math.inf, -math.inf]
    feature_index = -1
    xy = []
    temporary = binary.with_suffix(".partial")
    try:
        with temporary.open("wb", buffering=1024 * 1024) as output:
            for prefix, event, value in feature_events(source, root, progress, "Packing coordinates"):
                if prefix == "" and event == "start_map":
                    feature_index += 1
                # Point and MultiPoint both finish a numeric array here. Outer
                # MultiPoint arrays contain no numbers and therefore do not emit.
                if prefix in ("geometry.coordinates", "geometry.coordinates.item") and event == "start_array":
                    xy = []
                elif prefix in ("geometry.coordinates.item", "geometry.coordinates.item.item") and event == "number":
                    xy.append(value)
                elif prefix in ("geometry.coordinates", "geometry.coordinates.item") and event == "end_array" and xy:
                    if len(xy) < 2 or not all(math.isfinite(v) and abs(v) < 3e38 for v in xy[:2]):
                        invalid += 1
                        xy = []
                        continue
                    x, y = xy[:2]
                    class_id = feature_classes[feature_index]
                    output.write(struct.pack("<fff", x, y, class_id))
                    count += 1
                    classes[class_id]["count"] += 1
                    outside += not (0 <= x < width and 0 <= y < height)
                    bounds = [min(bounds[0], x), min(bounds[1], y), max(bounds[2], x), max(bounds[3], y)]
                    xy = []
        if not count:
            raise ValueError("No valid point coordinates were found.")
        result = {
            "version": version, "count": count, "featureCount": len(feature_classes),
            "classes": classes, "bounds": bounds, "outside": outside, "invalid": invalid,
            "bytes": count * 12, "sourceBytes": stat.st_size,
            "preparationSeconds": round(time.perf_counter() - started, 3),
            "coordinateSystem": "level-0 image pixels, origin top-left, y down",
        }
        temporary.replace(binary)
        temp_manifest = manifest.with_suffix(".partial")
        temp_manifest.write_text(json.dumps(result, indent=2))
        temp_manifest.replace(manifest)
        return result, binary
    finally:
        temporary.unlink(missing_ok=True)
