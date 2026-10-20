from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import json
from pathlib import Path
import struct
import tempfile
import time
import unittest

from PIL import Image
from prepare import prepare_points
from server import mask_rgba, TileCache, ViewerData, CaseRegistry, ROOT


class DataTests(unittest.TestCase):
    def test_streaming_roots_properties_after_coordinates_and_cache(self):
        features = [
            {"type": "Feature", "geometry": {"type": "MultiPoint", "coordinates": [[1.25, 2.5], [1001, 4, 9]]},
             "properties": {"classification": {"name": "positive", "color": [255, 0, 0]}}},
            {"type": "Feature", "geometry": {"type": "Point", "coordinates": [5, 6]},
             "properties": {"classification": {"name": "negative", "color": [0, 255, 0]}}},
        ]
        for document, count in [(features, 3), ({"type": "FeatureCollection", "features": features}, 3), (features[0], 2)]:
            with self.subTest(root=type(document).__name__), tempfile.TemporaryDirectory() as directory:
                source = Path(directory) / "source.geojson"
                source.write_text(json.dumps(document))
                manifest, binary = prepare_points(source, Path(directory) / "cache", (1000, 1000))
                self.assertEqual(manifest["count"], count)
                self.assertEqual(manifest["outside"], 1)
                self.assertEqual(list(struct.iter_unpack("<fff", binary.read_bytes()))[0], (1.25, 2.5, 0))
                before = binary.stat().st_mtime_ns
                self.assertEqual(prepare_points(source, Path(directory) / "cache", (1000, 1000))[0], manifest)
                self.assertEqual(binary.stat().st_mtime_ns, before)

    def test_unsupported_geometry_reports_error_without_a_partial_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.geojson"
            source.write_text(json.dumps({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": []}}))
            with self.assertRaisesRegex(ValueError, "Unsupported geometry"):
                prepare_points(source, Path(directory) / "cache", (1000, 1000))
            self.assertEqual(list((Path(directory) / "cache").glob("*")), [])

    def test_mask_keeps_labels_and_removes_only_black(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "mask.png"
            image = Image.new("RGB", (3, 1))
            image.putdata([(0, 0, 0), (0, 128, 0), (0, 0, 128)])
            image.save(source)
            result = mask_rgba(source)
            self.assertEqual(list(result.get_flattened_data()), [(0, 0, 0, 0), (0, 128, 0, 255), (0, 0, 128, 255)])

    def test_tile_cache_deduplicates_concurrent_reads_and_obeys_byte_budget(self):
        cache = TileCache(budget=10)
        calls = []
        def render():
            calls.append(True)
            time.sleep(.02)
            return b"123456"
        with ThreadPoolExecutor(max_workers=4) as pool:
            values = list(pool.map(lambda _: cache.get("tile", render), range(4)))
        self.assertEqual(len(calls), 1)
        self.assertEqual(values, [b"123456"] * 4)
        cache.get("other", lambda: b"abcdef")
        self.assertLessEqual(cache.size, 10)
        self.assertNotIn("tile", cache.items)

    @unittest.skipUnless((ROOT / "data" / "2606J01_511_2_Liv_19").exists(), "Provided slides are not present")
    def test_real_slide_overview_detail_and_edge_tiles(self):
        with tempfile.TemporaryDirectory() as cache:
            registry = CaseRegistry(ROOT / "data", Path(cache))
            data = ViewerData("2606J01_511_2_Liv_19", registry.files("2606J01_511_2_Liv_19"), Path(cache))
            try:
                for key in ("he", "ihc"):
                    self.assertEqual(data.slides[key].dimensions, (22970, 30170))
                    generator = data.generators[key]
                    for level in (0, 10, generator.level_count - 1):
                        columns, rows = generator.level_tiles[level]
                        for x, y in [(0, 0), (columns - 1, rows - 1)]:
                            tile = Image.open(BytesIO(data.tile(key, level, x, y)))
                            self.assertEqual(tile.size, generator.get_tile_dimensions(level, (x, y)))
                    with self.assertRaises(ValueError):
                        data.tile(key, 99, 0, 0)
                self.assertEqual(data.metadata["he"]["mask"]["width"], 717)
                self.assertEqual(data.metadata["he"]["mask"]["height"], 942)
            finally:
                data.close()
                registry.close()
