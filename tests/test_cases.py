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
COHORT_PATHS = {
    "he": "HE-Stains/{slide}_HE.tiff",
    "mask": "HE-Recogs/Segformer-mit_b5/{slide}_HE.png",
    "ihc": "IHC-Regs/{slide}/{slide}_IHC_Reg.tiff",
    "annotations": "IHC-Regs/{slide}/Reg-cell_recog-IHC_to_HE-transformed_shapes.geojson",
}


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

    def test_nested_cases_are_discovered_with_full_encoded_paths(self):
        target = self.root / "project A" / "batch α" / self.folder.name
        target.parent.mkdir(parents=True)
        self.folder.rename(target)
        (self.root / "empty group" / "notes").mkdir(parents=True)
        name = target.relative_to(self.root).as_posix()
        self.assertEqual(self.registry.list_cases(), [
            {"id": name, "url": "/" + quote(name, safe="/") + "/"},
        ])
        self.assertEqual({key: source.name for key, source in self.registry.files(name).items()}, self.names)

    def test_discovery_stops_at_cases_and_skips_hidden_folders_and_symlink_cycles(self):
        for folder in (self.folder / "backup", self.root / ".hidden"):
            folder.mkdir()
            for name in self.names.values():
                (folder / name).touch()
        (self.root / "loop").symlink_to(self.root, target_is_directory=True)
        self.assertEqual([case["id"] for case in self.registry.list_cases()], [self.folder.name])

    def test_each_asset_can_use_a_configured_subdirectory(self):
        layout = {"he": "slides/he", "ihc": "slides/ihc",
                  "mask": "overlays/masks", "annotations": "analysis/geojson"}
        self.registry.close()
        self.registry = CaseRegistry(self.root, self.root.parent / "cache", file_subdirs=layout)
        for key, name in self.names.items():
            destination = self.folder / layout[key] / name
            destination.parent.mkdir(parents=True)
            (self.folder / name).rename(destination)
            # Files elsewhere must not be selected or cause ambiguous matches.
            (self.folder / name).touch()
        found = self.registry.files(self.folder.name)
        for key, source in found.items():
            self.assertEqual(source, (self.folder / layout[key] / self.names[key]).resolve())
        self.assertEqual([case["id"] for case in self.registry.list_cases()], [self.folder.name])
        found["annotations"].unlink()
        with self.assertRaises(CaseError) as caught:
            self.registry.files(self.folder.name)
        self.assertIn("analysis/geojson", str(caught.exception))

    def test_invalid_configured_subdirectories_and_case_paths_are_rejected(self):
        for value in ("../sibling", "/absolute", "slides/../../outside", "slides\\outside", "slides//he"):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "HE_SLIDE_SUBDIR"):
                CaseRegistry(self.root, self.root.parent / "cache", file_subdirs={"he": value})
        for name in ("../outside", "project/../case", "/case", "project//case", "project/.hidden/case"):
            with self.subTest(name=name), self.assertRaises(CaseError):
                self.registry.directory(name)
        # A configured path must stay within its case even if a symlink points
        # elsewhere inside the data root.
        (self.root / "other").mkdir()
        (self.folder / "slides").symlink_to(self.root / "other", target_is_directory=True)
        self.registry.file_subdirs["he"] = "slides"
        with self.assertRaisesRegex(CaseError, "inside their case folder"):
            self.registry.files(self.folder.name)

    def test_cohort_path_templates_discover_each_slide_and_exact_files(self):
        self.registry.close()
        self.registry = CaseRegistry(self.root, self.root.parent / "cache", file_paths=COHORT_PATHS)
        names = ("26-490/26-490-145-liver", "26-491/another slide α [copy]")
        for name in names:
            folder = self.root / name
            expected = {}
            for key, template in COHORT_PATHS.items():
                source = folder / template.replace("{slide}", folder.name)
                source.parent.mkdir(parents=True, exist_ok=True)
                source.touch()
                expected[key] = source.resolve()
            # Exact templates choose the intended registered result even if
            # an unregistered slide or a backup sits beside it.
            (expected["ihc"].parent / "unregistered_IHC.tiff").touch()
            (expected["annotations"].parent / "other_IHC.geojson").touch()
            self.assertEqual(self.registry.files(name), expected)
        self.assertEqual(self.registry.list_cases(), [
            {"id": name, "url": f"/{quote(name, safe='/')}/"} for name in names
        ])

    def test_exact_path_overrides_one_role_and_reports_missing_file_without_fallback(self):
        template = "results/registered.geojson"
        self.registry.close()
        self.registry = CaseRegistry(self.root, self.root.parent / "cache",
                                     file_paths={"annotations": template})
        expected = self.folder / template
        expected.parent.mkdir()
        expected.touch()
        found = self.registry.files(self.folder.name)
        self.assertEqual(found["annotations"], expected.resolve())
        self.assertEqual(found["he"].name, self.names["he"])
        expected.unlink()
        with self.assertRaises(CaseError) as caught:
            self.registry.files(self.folder.name)
        self.assertEqual(caught.exception.status, 422)
        self.assertIn("Expected file: results/registered.geojson", str(caught.exception))

    def test_invalid_asset_path_templates_fail_at_startup(self):
        for template in ("../outside.tiff", "/outside.tiff", "slides/../x.tiff", "slides//x.tiff",
                         "slides\\x.tiff", "{cohort}/x.tiff", "{slide.name}.tiff", "{slide:>20}.tiff",
                         "slides/*.tiff", "slides/?.tiff", "slides/[ab].tiff"):
            with self.subTest(template=template), self.assertRaisesRegex(ValueError, "HE_SLIDE_PATH"):
                CaseRegistry(self.root, self.root.parent / "cache", file_paths={"he": template})

    def test_exact_path_rejects_symlink_escape_from_case_folder(self):
        other = self.root / "other"
        other.mkdir()
        (other / "registered.tiff").touch()
        (self.folder / "registered").symlink_to(other, target_is_directory=True)
        self.registry.close()
        self.registry = CaseRegistry(self.root, self.root.parent / "cache",
                                     file_paths={"he": "registered/registered.tiff"})
        with self.assertRaisesRegex(CaseError, "inside their case folder"):
            self.registry.files(self.folder.name)


class CohortDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "data"
        self.root.mkdir()
        self.registry = CaseRegistry(self.root, self.root.parent / "cache",
                                     file_paths=COHORT_PATHS, layout="cohort")

    def tearDown(self):
        self.registry.close()
        self.temporary.cleanup()

    def make_slide(self, cohort, slide):
        files = {}
        for key, template in COHORT_PATHS.items():
            source = self.root / cohort / template.replace("{slide}", slide)
            source.parent.mkdir(parents=True, exist_ok=True)
            source.touch()
            files[key] = source.resolve()
        return files

    def test_discovery_uses_he_filenames_across_cohorts_without_slide_folders(self):
        self.assertEqual(self.registry.list_cases(), [])
        ids = []
        for cohort, slide in (("26-490", "26-490-145-liver"), ("26-490", "26-490-146-liver"),
                              ("cohort α", "26-490-145-liver"), ("cohort α", "slide [copy]")):
            expected = self.make_slide(cohort, slide)
            case_id = f"{cohort}/{slide}"
            ids.append(case_id)
            self.assertFalse((self.root / case_id).exists())
            self.assertEqual(self.registry.directory(case_id), (self.root / cohort).resolve())
            self.assertEqual(self.registry.files(case_id), expected)
            # New slides appear without restarting or reconfiguring the registry.
            self.assertEqual({item["id"] for item in self.registry.list_cases()}, set(ids))
        for path in ("26-490/HE-Stains/preview_HE.png", "26-490/HE-Stains/._hidden_HE.tiff",
                     "26-490/HE-Stains/_HE.tiff", "26-490/HE-Recogs-bk/backup_HE.tiff",
                     "26-490/RawScans/other_HE.tiff", ".hidden/HE-Stains/hidden_HE.tiff"):
            source = self.root / path
            source.parent.mkdir(parents=True, exist_ok=True)
            source.touch()
        self.assertEqual(self.registry.list_cases(), [
            {"id": name, "url": f"/{quote(name, safe='/')}/"} for name in sorted(ids, key=str.casefold)
        ])

    def test_missing_overlay_is_reported_for_discovered_slide(self):
        case_id = "26-490/26-490-145-liver"
        files = self.make_slide(*case_id.split("/"))
        files["mask"].unlink()
        # The H&E preview must not silently replace the segmentation mask.
        (files["he"].parent / "26-490-145-liver_HE.png").touch()
        self.assertEqual([case["id"] for case in self.registry.list_cases()], [case_id])
        with self.assertRaises(CaseError) as caught:
            self.registry.files(case_id)
        self.assertEqual(caught.exception.status, 422)
        self.assertIn("HE-Recogs/Segformer-mit_b5/26-490-145-liver_HE.png", str(caught.exception))

    def test_unknown_slides_and_invalid_cohort_urls_are_rejected(self):
        self.make_slide("26-490", "known")
        for name in ("26-490/unknown", "unknown/known", "26-490", "26-490/a/b",
                     "../known", "26-490/../known", "26-490//known", "26-490/.hidden"):
            with self.subTest(name=name), self.assertRaises(CaseError) as caught:
                self.registry.directory(name)
            self.assertEqual(caught.exception.status, 404)

    def test_cohort_paths_cannot_read_assets_from_another_cohort(self):
        a = self.make_slide("cohort-A", "same")
        b = self.make_slide("cohort-B", "same")
        a["mask"].unlink()
        a["mask"].symlink_to(b["mask"])
        with self.assertRaisesRegex(CaseError, "inside their cohort folder"):
            self.registry.files("cohort-A/same")
        a["he"].unlink()
        a["he"].symlink_to(b["he"])
        (self.root / "alias").symlink_to(self.root / "cohort-B", target_is_directory=True)
        outside = self.root.parent / "outside"
        outside.mkdir()
        (self.root / "escape").symlink_to(outside, target_is_directory=True)
        self.assertEqual([case["id"] for case in self.registry.list_cases()], ["cohort-B/same"])
        with self.assertRaises(CaseError):
            self.registry.directory("escape/same")

    def test_cohort_layout_requires_slide_specific_paths_and_fixed_he_directory(self):
        for options, message in (
            ({"layout": "unknown"}, "DATA_LAYOUT"),
            ({"layout": "cohort"}, "HE_SLIDE_PATH"),
            ({"layout": "cohort", "file_paths": {**COHORT_PATHS, "annotations": "shared.geojson"}}, "IHC_ANNOTATIONS_PATH"),
            ({"layout": "cohort", "file_paths": {**COHORT_PATHS, "he": "HE-Stains/{slide}/{slide}_HE.tiff"}}, "fixed parent directory"),
        ):
            with self.subTest(options=options), self.assertRaisesRegex(ValueError, message):
                CaseRegistry(self.root, self.root.parent / "invalid-cache", **options)


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

    def test_nested_cases_with_same_leaf_name_keep_assets_and_caches_separate(self):
        paths = ("project A/batch α/test link", "project B/batch α/test link")
        for old, new in zip(("case-A", "case-B"), paths):
            destination = self.root / new
            destination.parent.mkdir(parents=True)
            (self.root / old).rename(destination)
        cases = json.loads(self.request("/api/cases"))["cases"]
        self.assertEqual({case["id"] for case in cases}, set(paths))
        for case in cases:
            self.assertEqual(case["url"], f"/{quote(case['id'], safe='/')}/")
            if (ROOT / "dist" / "index.html").exists():
                for url in (case["url"].removesuffix("/"), case["url"]):
                    with urlopen(self.base + url, timeout=5) as response:
                        self.assertEqual(response.url, self.base + case["url"])
                        self.assertIn(b"Pathology Viewer", response.read())
        a, b = map(self.manifest, paths)
        for manifest in (a, b):
            for key in ("he", "ihc"):
                self.assertIn(b"<Image", self.request(manifest["slides"][key]["dzi"]))
        self.assertNotEqual(
            self.request(a["slides"]["ihc"]["dzi"].replace(".dzi", "_files/10/0_0.jpeg")),
            self.request(b["slides"]["ihc"]["dzi"].replace(".dzi", "_files/10/0_0.jpeg")),
        )
        self.assertNotEqual(self.request(a["slides"]["he"]["mask"]["url"]), self.request(b["slides"]["he"]["mask"]["url"]))
        self.assertEqual(struct.unpack("<fff", self.request(a["annotations"]["url"])), (101, 300, 0))
        self.assertEqual(struct.unpack("<fff", self.request(b["annotations"]["url"])), (202, 300, 0))
        self.assertNotEqual(self.registry.cases[paths[0]].cache, self.registry.cases[paths[1]].cache)

    def test_configured_asset_subdirectories_work_inside_nested_cases(self):
        layout = {"he": "slides", "ihc": "slides",
                  "mask": "results/masks", "annotations": "results/annotations"}
        self.registry.close()
        self.registry = CaseRegistry(self.root, Path(self.temporary.name) / "cache", file_subdirs=layout)
        self.server.registry = self.registry
        case_id = "project/renamed case"
        destination = self.root / case_id
        destination.parent.mkdir()
        (self.root / "case-A").rename(destination)
        names = {"he": "case-A_HE.tiff", "ihc": "case-A_IHC.tiff",
                 "mask": "case-A_HE.png", "annotations": "case-A_IHC.geojson"}
        for key, name in names.items():
            folder = destination / layout[key]
            folder.mkdir(parents=True, exist_ok=True)
            (destination / name).rename(folder / name)
        manifest = self.manifest(case_id)
        cases = json.loads(self.request("/api/cases"))["cases"]
        self.assertEqual(cases, [{"id": case_id, "url": "/project/renamed%20case/"}])
        self.assertEqual(manifest["slides"]["he"]["filename"], names["he"])
        tile = self.request(manifest["slides"]["he"]["dzi"].replace(".dzi", "_files/10/0_0.jpeg"))
        self.assertGreater(Image.open(BytesIO(tile)).width, 0)
        mask = self.request(manifest["slides"]["he"]["mask"]["url"])
        self.assertEqual(Image.open(BytesIO(mask)).size, (717, 942))
        self.assertEqual(struct.unpack("<fff", self.request(manifest["annotations"]["url"])), (101, 300, 0))

    def test_cohort_slide_layout_serves_registered_files_using_templates(self):
        self.registry.close()
        self.registry = CaseRegistry(self.root, Path(self.temporary.name) / "cache", file_paths=COHORT_PATHS)
        self.server.registry = self.registry
        names = ("26-490/26-490-145-liver", "26-490/26-490-146-liver")
        for old, name in zip(("case-A", "case-B"), names):
            folder = self.root / name
            sources = {"he": f"{old}_HE.tiff", "ihc": f"{old}_IHC.tiff",
                       "mask": f"{old}_HE.png", "annotations": f"{old}_IHC.geojson"}
            for key, template in COHORT_PATHS.items():
                target = folder / template.replace("{slide}", folder.name)
                target.parent.mkdir(parents=True, exist_ok=True)
                (self.root / old / sources[key]).rename(target)
        self.assertEqual(json.loads(self.request("/api/cases"))["cases"], [
            {"id": name, "url": f"/{name}/"} for name in names
        ])
        for name, x in zip(names, (101, 202)):
            manifest = self.manifest(name)
            self.assertEqual(manifest["slides"]["ihc"]["filename"], f"{Path(name).name}_IHC_Reg.tiff")
            for key in ("he", "ihc"):
                self.assertIn(b"<Image", self.request(manifest["slides"][key]["dzi"]))
                tile = self.request(manifest["slides"][key]["dzi"].replace(".dzi", "_files/10/0_0.jpeg"))
                self.assertGreater(Image.open(BytesIO(tile)).width, 0)
            mask = self.request(manifest["slides"]["he"]["mask"]["url"])
            self.assertEqual(Image.open(BytesIO(mask)).size, (717, 942))
            self.assertEqual(struct.unpack("<fff", self.request(manifest["annotations"]["url"])), (x, 300, 0))
            if (ROOT / "dist" / "index.html").exists():
                self.assertIn(b"Pathology Viewer", self.request(f"/{name}/"))

    def test_shared_cohort_folders_serve_virtual_case_urls_and_isolate_slides(self):
        self.registry.close()
        self.registry = CaseRegistry(self.root, Path(self.temporary.name) / "cache",
                                     file_paths=COHORT_PATHS, layout="cohort")
        self.server.registry = self.registry
        names = ("26-490/26-490-145-liver", "26-490/26-490-146-liver", "cohort α/26-490-145-liver")
        for old, name in zip(("case-A", "case-B", "case-B"), names):
            cohort, slide = name.split("/")
            sources = {"he": f"{old}_HE.tiff", "ihc": f"{old}_IHC.tiff",
                       "mask": f"{old}_HE.png", "annotations": f"{old}_IHC.geojson"}
            for key, template in COHORT_PATHS.items():
                target = self.root / cohort / template.replace("{slide}", slide)
                target.parent.mkdir(parents=True, exist_ok=True)
                os.link(self.root / old / sources[key], target)
            self.assertFalse((self.root / name).exists())
        cases = json.loads(self.request("/api/cases"))["cases"]
        self.assertEqual({case["id"] for case in cases}, set(names))
        manifests = []
        for name, x in zip(names, (101, 202, 202)):
            manifest = self.manifest(name)
            manifests.append(manifest)
            for key in ("he", "ihc"):
                self.assertIn(b"<Image", self.request(manifest["slides"][key]["dzi"]))
                tile = self.request(manifest["slides"][key]["dzi"].replace(".dzi", "_files/10/0_0.jpeg"))
                self.assertGreater(Image.open(BytesIO(tile)).width, 0)
            self.assertEqual(struct.unpack("<fff", self.request(manifest["annotations"]["url"])), (x, 300, 0))
            if (ROOT / "dist" / "index.html").exists():
                for url in (f"/{quote(name, safe='/')}", f"/{quote(name, safe='/')}/"):
                    with urlopen(self.base + url, timeout=5) as response:
                        self.assertTrue(response.url.endswith("/"))
                        self.assertIn(b"Pathology Viewer", response.read())
        a, b, other_cohort = manifests
        self.assertNotEqual(self.request(a["slides"]["he"]["mask"]["url"]), self.request(b["slides"]["he"]["mask"]["url"]))
        self.assertNotEqual(a["annotations"]["url"], other_cohort["annotations"]["url"])
        for name in names:
            self.assertTrue((self.registry.cache / name).is_dir())
        with self.assertRaises(HTTPError) as caught:
            self.request("/26-490/unknown/")
        self.assertEqual(caught.exception.code, 404)

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
            ("/api/cases/project%2F..%2Fcase-A/manifest", 404),
            ("/project/%2e%2e/case-A/", 404),
            ("/project//case-A/", 404),
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
