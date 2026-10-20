from contextlib import ExitStack
from io import BytesIO
import json
import os
from pathlib import Path
import struct
import tempfile
import threading
import time
import unittest
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import urlopen

from PIL import Image
from server import CaseError, CaseRegistry, Handler, LocalServer, ROOT

EXAMPLE = ROOT / "data" / "2606J01_511_2_Liv_19"


class CaseFileDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        base = Path(self.temporary.name)
        self.root = base / "data"
        self.folder = self.root / "test link [copy]"
        self.folder.mkdir(parents=True)
        self.names = {
            "he": "original_HE.tif",
            "ihc": "original_IHC.tiff",
            "mask": "original_HE.png",
            "annotations": "original_IHC.geojson",
        }
        for name in self.names.values():
            (self.folder / name).touch()
        self.registry = CaseRegistry(self.root, base / "cache")

    def tearDown(self):
        self.registry.close()
        self.temporary.cleanup()

    def test_folder_can_be_renamed_without_renaming_any_files(self):
        for name in ("test link [copy]", "test_link", "whatever α"):
            target = self.root / name
            if target != self.folder:
                self.folder.rename(target)
                self.folder = target
            actual = self.registry.files(name)
            self.assertEqual({key: source.name for key, source in actual.items()}, self.names)
            self.assertTrue(all(source.parent == target.resolve() for source in actual.values()))

    def test_suffix_matching_ignores_case_and_unrelated_or_hidden_files(self):
        for name in self.names.values():
            (self.folder / name).rename(self.folder / name.upper())
        for name in ("notes.txt", "preview.png", "._original_HE.tif", ".backup_IHC.tiff"):
            (self.folder / name).touch()
        actual = self.registry.files(self.folder.name)
        self.assertEqual({key: source.name for key, source in actual.items()},
                         {key: name.upper() for key, name in self.names.items()})

    def test_ambiguous_assets_are_rejected_even_if_one_matches_folder_name(self):
        duplicate = self.folder / f"{self.folder.name}_HE.tiff"
        duplicate.touch()
        with self.assertRaises(CaseError) as caught:
            self.registry.files(self.folder.name)
        self.assertEqual(caught.exception.status, 422)
        self.assertIn("Multiple files match H&E slide", str(caught.exception))
        self.assertIn(duplicate.name, str(caught.exception))
        self.assertIn(self.names["he"], str(caught.exception))

    def test_missing_assets_report_the_required_suffix(self):
        (self.folder / self.names["annotations"]).unlink()
        with self.assertRaises(CaseError) as caught:
            self.registry.files(self.folder.name)
        self.assertEqual(caught.exception.status, 422)
        self.assertIn("Missing IHC annotations", str(caught.exception))
        self.assertIn("_IHC.geojson", str(caught.exception))

    def test_discovered_files_cannot_escape_the_data_root(self):
        outside = self.root.parent / "outside.png"
        outside.touch()
        mask = self.folder / self.names["mask"]
        mask.unlink()
        mask.symlink_to(outside)
        with self.assertRaises(CaseError) as caught:
            self.registry.files(self.folder.name)
        self.assertEqual(caught.exception.status, 422)
        self.assertIn("inside the configured data root", str(caught.exception))


@unittest.skipUnless(EXAMPLE.exists(), "Provided slides are not present")
class CaseRoutingTests(unittest.TestCase):
    def setUp(self):
        (ROOT / ".cache").mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=ROOT / ".cache")
        self.root = Path(self.temporary.name) / "data"
        self.root.mkdir()
        self.make_case("case-A", 101)
        self.make_case("case-B", 202, swap=True)
        self.registry = CaseRegistry(self.root, Path(self.temporary.name) / "cache", max_open=2)
        self.server = LocalServer(("127.0.0.1", 0), Handler, self.registry)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()
        self.temporary.cleanup()

    def make_case(self, name, x, swap=False):
        folder = self.root / name
        folder.mkdir()
        for stain in ("HE", "IHC"):
            source = "HE" if swap else stain
            os.link(EXAMPLE / f"2606J01_511_2_Liv_19_{source}.tiff", folder / f"{name}_{stain}.tiff")
        if swap:
            Image.new("RGB", (717, 942), (0, 128, 0)).save(folder / f"{name}_HE.png")
        else:
            os.link(EXAMPLE / "2606J01_511_2_Liv_19_HE.png", folder / f"{name}_HE.png")
        (folder / f"{name}_IHC.geojson").write_text(json.dumps({
            "type": "Feature", "geometry": {"type": "Point", "coordinates": [x, 300]},
            "properties": {"classification": {"name": name, "color": [255, 0, 0]}},
        }))

    def request(self, path):
        with urlopen(self.base + path, timeout=5) as response:
            return response.read()

    def manifest(self, name):
        url = f"/api/cases/{quote(name, safe='')}/manifest"
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            result = json.loads(self.request(url))
            if result["annotations"]["state"] != "preparing":
                self.assertEqual(result["annotations"]["state"], "ready")
                return result
            time.sleep(.01)
        self.fail("Annotation preparation did not finish.")

    def test_case_specific_images_masks_annotations_and_cache_isolation(self):
        a, b = self.manifest("case-A"), self.manifest("case-B")
        self.assertEqual(a["case"]["id"], "case-A")
        self.assertEqual(b["case"]["id"], "case-B")
        self.assertIn("/case-A/", a["slides"]["ihc"]["dzi"])
        self.assertIn("/case-B/", b["slides"]["ihc"]["dzi"])
        tile_a = self.request(a["slides"]["ihc"]["dzi"].replace(".dzi", "_files/10/0_0.jpeg"))
        tile_b = self.request(b["slides"]["ihc"]["dzi"].replace(".dzi", "_files/10/0_0.jpeg"))
        self.assertNotEqual(tile_a, tile_b)
        self.assertGreater(Image.open(BytesIO(tile_a)).width, 0)
        self.assertNotEqual(self.request(a["slides"]["he"]["mask"]["url"]), self.request(b["slides"]["he"]["mask"]["url"]))
        self.assertEqual(struct.unpack("<fff", self.request(a["annotations"]["url"])), (101, 300, 0))
        self.assertEqual(struct.unpack("<fff", self.request(b["annotations"]["url"])), (202, 300, 0))

    def test_duplicate_folder_keeps_original_filenames_and_serves_all_assets(self):
        original = self.manifest("case-A")
        original_tile = self.request(original["slides"]["ihc"]["dzi"].replace(".dzi", "_files/10/0_0.jpeg"))
        original_mask = self.request(original["slides"]["he"]["mask"]["url"])
        original_points = self.request(original["annotations"]["url"])
        for name in ("test_link", "test link"):
            copied_folder = self.root / name
            copied_folder.mkdir()
            for source in (self.root / "case-A").iterdir():
                os.link(source, copied_folder / source.name)
            copied = self.manifest(name)
            self.assertEqual(copied["case"]["id"], name)
            self.assertEqual(copied["slides"]["he"]["filename"], "case-A_HE.tiff")
            self.assertEqual(copied["slides"]["ihc"]["filename"], "case-A_IHC.tiff")
            self.assertIn(f"/api/cases/{quote(name, safe='')}/", copied["slides"]["ihc"]["dzi"])
            self.assertIn(b"<Image", self.request(copied["slides"]["ihc"]["dzi"]))
            self.assertEqual(self.request(copied["slides"]["ihc"]["dzi"].replace(".dzi", "_files/10/0_0.jpeg")), original_tile)
            self.assertEqual(self.request(copied["slides"]["he"]["mask"]["url"]), original_mask)
            self.assertEqual(self.request(copied["annotations"]["url"]), original_points)
            if (ROOT / "dist" / "index.html").exists():
                self.assertIn(b"Pathology Viewer", self.request(f"/{quote(name, safe='')}/"))

    def test_new_folders_are_discovered_and_encoded_names_work(self):
        for name in ("case space α", "api-prefixed-case"):
            self.make_case(name, 303)
            cases = json.loads(self.request("/api/cases"))["cases"]
            self.assertIn(name, [case["id"] for case in cases])
            manifest = self.manifest(name)
            self.assertEqual(manifest["case"]["id"], name)
            self.assertEqual(struct.unpack("<fff", self.request(manifest["annotations"]["url"])), (303, 300, 0))
            if (ROOT / "dist" / "index.html").exists():
                self.assertIn(b"Pathology Viewer", self.request(f"/{quote(name, safe='')}/"))

    @unittest.skipUnless((ROOT / "dist" / "index.html").exists(), "Run npm run build for page routing checks")
    def test_deep_links_refresh_and_trailing_slash(self):
        for suffix in ("/case-A", "/case-A/", "/case-B/"):
            with urlopen(self.base + suffix, timeout=5) as response:
                self.assertTrue(response.url.endswith("/"))
                self.assertIn(b"Pathology Viewer", response.read())
        self.assertIn(b'href="/case-A/"', self.request("/"))
        self.assertIn(b'href="/case-B/"', self.request("/"))
        # The same running server also handles an empty root and the transition
        # to a single case, without loading or rebuilding the frontend.
        for name in ("case-A", "case-B"):
            (self.root / name).rename(self.root.parent / name)
        empty = self.request("/")
        self.assertIn(b"No case folders found.", empty)
        self.assertIn(b"data/CASE_ID/\n", empty)
        (self.root.parent / "case-A").rename(self.root / "case-A")
        with urlopen(self.base + "/", timeout=5) as response:
            self.assertEqual(response.url, self.base + "/case-A/")
            self.assertIn(b"Pathology Viewer", response.read())

    def test_missing_cases_files_and_path_escape_are_explicit_errors(self):
        (self.root / "incomplete").mkdir()
        outside = Path(self.temporary.name) / "outside"
        outside.mkdir()
        (self.root / "escape").symlink_to(outside)
        for path, status in [
            ("/api/cases/unknown/manifest", 404),
            ("/api/cases/incomplete/manifest", 422),
            ("/api/cases/%2e%2e/manifest", 404),
            ("/api/cases/escape/manifest", 404),
            ("/api/cases/case-A/../../server.py", 404),
            ("/assets/../../server.py", 404),
        ]:
            with self.subTest(path=path), self.assertRaises(HTTPError) as caught:
                self.request(path)
            self.assertEqual(caught.exception.code, status)
            self.assertIn("error", json.loads(caught.exception.read()))
        self.assertEqual(json.loads(self.request("/api/health")), {"status": "ok"})

    def test_open_case_limit_protects_active_readers_and_reopens_evicted_cases(self):
        self.manifest("case-A")
        self.manifest("case-B")
        self.make_case("case-C", 303)
        with ExitStack() as stack:
            a = stack.enter_context(self.registry.acquire("case-A"))
            stack.enter_context(self.registry.acquire("case-B"))
            before = a.tile("ihc", 10, 0, 0)
            with self.assertRaises(CaseError) as caught:
                with self.registry.acquire("case-C"):
                    pass
            self.assertEqual(caught.exception.status, 503)
            self.assertEqual(a.tile("ihc", 10, 0, 0), before)
        self.manifest("case-C")
        self.assertLessEqual(len(self.registry.cases), 2)
        reopened = self.manifest("case-A")
        self.assertEqual(self.request(reopened["slides"]["ihc"]["dzi"].replace(".dzi", "_files/10/0_0.jpeg")), before)
        self.assertLessEqual(len(self.registry.cases), 2)
