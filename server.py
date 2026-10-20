"""Folder-based slide viewer: one case per data-root directory, one URL per case."""
import argparse
from collections import OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import contextmanager
import hashlib
from html import escape
from http.server import BaseHTTPRequestHandler, HTTPServer
from io import BytesIO
import json
import mimetypes
import os
from pathlib import Path
import re
import signal
import threading
import traceback
from urllib.parse import quote, unquote, urlsplit

import openslide
from openslide.deepzoom import DeepZoomGenerator
from PIL import Image, ImageChops

from prepare import prepare_points

ROOT = Path(__file__).resolve().parent


class CaseError(Exception):
    def __init__(self, message, status=404):
        super().__init__(message)
        self.status = status


def valid_case_id(name):
    return (0 < len(name) <= 200 and not name.startswith(".")
            and name not in {"api", "assets", "favicon.svg"}
            and not any(char in "/\\" or ord(char) < 32 for char in name))


def mask_rgba(source):
    """Keep every label color exactly; only RGB(0,0,0) is background."""
    image = Image.open(source).convert("RGB")
    red, green, blue = image.split()
    alpha = ImageChops.lighter(ImageChops.lighter(red, green), blue).point(lambda v: 255 if v else 0)
    image.putalpha(alpha)
    return image


class TileCache:
    def __init__(self, budget=64 * 1024 * 1024):
        self.budget, self.size = budget, 0
        self.items, self.pending = OrderedDict(), {}
        self.lock = threading.Lock()
        self.render_slots = threading.BoundedSemaphore(4)

    def get(self, key, render):
        with self.lock:
            if key in self.items:
                self.items.move_to_end(key)
                return self.items[key]
            owner = key not in self.pending
            future = self.pending.setdefault(key, Future())
        if not owner:
            return future.result()
        try:
            with self.render_slots:
                value = render()
            with self.lock:
                self.items[key] = value
                self.size += len(value)
                while self.size > self.budget and self.items:
                    self.size -= len(self.items.popitem(last=False)[1])
            future.set_result(value)
            return value
        except Exception as error:
            future.set_exception(error)
            raise
        finally:
            with self.lock:
                self.pending.pop(key, None)


class ViewerData:
    def __init__(self, case_id, files, cache, tiles=None, decoded_cache=None):
        self.case_id, self.files, self.cache = case_id, files, cache
        self.slides, self.generators, self.metadata = {}, {}, {}
        signature = [(key, str(source), source.stat().st_size, source.stat().st_mtime_ns)
                     for key, source in sorted(files.items())]
        self.version = hashlib.sha256(json.dumps(signature).encode()).hexdigest()[:16]
        self.api = f"/api/cases/{quote(case_id, safe='')}/{self.version}"
        self.tiles = tiles if tiles is not None else TileCache()
        self.decoded_cache = decoded_cache or openslide.OpenSlideCache(64 * 1024 * 1024)
        self.state = {"state": "preparing", "phase": "Opening slides", "progress": 0}
        self.points_path = None
        self.users = 0
        self.preparing = False
        try:
            self.open()
        except Exception:
            self.close()
            raise

    def open(self):
        for key in ("he", "ihc"):
            source = self.files[key]
            slide = openslide.OpenSlide(source)
            slide.set_cache(self.decoded_cache)
            self.slides[key] = slide
            self.generators[key] = DeepZoomGenerator(slide, tile_size=256, overlap=1, limit_bounds=False)
            width, height = slide.dimensions
            self.metadata[key] = {
                "width": width, "height": height, "filename": source.name,
                "levels": slide.level_count, "dzi": f"{self.api}/slides/{key}.dzi",
            }
        mask = mask_rgba(self.files["mask"])
        buffer = BytesIO()
        mask.save(buffer, format="PNG")
        self.mask = buffer.getvalue()
        # The supplied PNG exactly matches pyramid level 5. Full extent mapping
        # uses separate x/y scales, avoiding drift from rounded pyramid sizes.
        if mask.size not in self.slides["he"].level_dimensions:
            raise CaseError("Mask dimensions do not match an H&E pyramid level; verify its registration.", 422)
        self.metadata["he"]["mask"] = {
            "width": mask.width, "height": mask.height, "url": f"{self.api}/mask.png",
            "scaleX": self.slides["he"].dimensions[0] / mask.width,
            "scaleY": self.slides["he"].dimensions[1] / mask.height,
        }

    def prepare(self):
        try:
            def progress(phase, fraction):
                offset = 0 if phase == "Reading classes" else 50
                self.state = {"state": "preparing", "phase": phase, "progress": round(offset + fraction * 50)}
            result, self.points_path = prepare_points(
                self.files["annotations"], self.cache,
                self.slides["ihc"].dimensions, progress,
            )
            self.state = {"state": "ready", "progress": 100, **result,
                          "url": f"{self.api}/points/{result['version']}.bin"}
            print(f"{self.case_id}: {result['count']:,} points ready, {result['outside']} outside image bounds.", flush=True)
        except Exception as error:
            self.state = {"state": "error", "error": str(error)}
            traceback.print_exc()

    def tile(self, key, level, x, y):
        generator = self.generators[key]
        if not 0 <= level < generator.level_count:
            raise ValueError("Invalid tile level")
        columns, rows = generator.level_tiles[level]
        if not (0 <= x < columns and 0 <= y < rows):
            raise ValueError("Invalid tile coordinates")

        def render():
            image = generator.get_tile(level, (x, y))
            buffer = BytesIO()
            image.save(buffer, "JPEG", quality=88, icc_profile=image.info.get("icc_profile"))
            return buffer.getvalue()
        return self.tiles.get((self.case_id, self.version, key, level, x, y), render)

    def close(self):
        for slide in self.slides.values():
            slide.close()
        self.slides.clear()


class CaseRegistry:
    """A small LRU of open cases. Requests and preprocessing pin their handles."""
    def __init__(self, root, cache, max_open=4):
        self.root, self.cache = Path(root).resolve(), Path(cache).resolve()
        if not self.root.is_dir():
            raise ValueError(f"Data root does not exist: {self.root}. Set DATA_DIR to your case-folder parent.")
        if max_open < 1:
            raise ValueError("MAX_OPEN_CASES must be at least 1.")
        self.cache.mkdir(parents=True, exist_ok=True)
        self.max_open = max_open
        self.cases = OrderedDict()
        self.lock = threading.RLock()
        self.tiles = TileCache()
        self.decoded_cache = openslide.OpenSlideCache(64 * 1024 * 1024)
        self.preparation = ThreadPoolExecutor(max_workers=2, thread_name_prefix="prepare")

    def directory(self, case_id):
        if not valid_case_id(case_id):
            raise CaseError("Invalid case name.")
        folder = (self.root / case_id).resolve()
        if folder.parent != self.root or not folder.is_dir():
            raise CaseError(f"Case '{case_id}' was not found.")
        return folder

    def list_cases(self):
        result = []
        for folder in self.root.iterdir():
            if valid_case_id(folder.name) and folder.is_dir() and folder.resolve().parent == self.root:
                result.append({"id": folder.name, "url": f"/{quote(folder.name, safe='')}/"})
        return sorted(result, key=lambda case: case["id"].casefold())

    def files(self, case_id):
        folder = self.directory(case_id)
        # The folder identifies the URL only. A copied case keeps its original
        # filenames; suffixes identify each asset without depending on a prefix.
        entries = [source for source in folder.iterdir()
                   if source.is_file() and not source.name.startswith(".")]
        files = {}
        for key, (label, suffixes) in {
            "he": ("H&E slide", ("_HE.tiff", "_HE.tif")),
            "ihc": ("IHC slide", ("_IHC.tiff", "_IHC.tif")),
            "mask": ("H&E mask", ("_HE.png",)),
            "annotations": ("IHC annotations", ("_IHC.geojson",)),
        }.items():
            matches = sorted(
                (source for source in entries
                 if source.name.lower().endswith(tuple(suffix.lower() for suffix in suffixes))),
                key=lambda source: source.name,
            )
            if not matches:
                raise CaseError(
                    f"Missing {label} in '{case_id}'. Expected one file ending in {' or '.join(suffixes)}.", 422)
            if len(matches) > 1:
                names = ", ".join(source.name for source in matches)
                raise CaseError(
                    f"Multiple files match {label} in '{case_id}': {names}. "
                    "Keep one matching file per case folder.", 422)
            source = matches[0]
            if not source.resolve().is_relative_to(self.root):
                raise CaseError("Case files must remain inside the configured data root.", 422)
            files[key] = source
        return files

    def prepare(self, data):
        try:
            data.prepare()
        finally:
            with self.lock:
                data.preparing = False

    @contextmanager
    def acquire(self, case_id):
        self.directory(case_id)
        with self.lock:
            data = self.cases.get(case_id)
            if data is None:
                files = self.files(case_id)
                if len(self.cases) >= self.max_open:
                    victim = next((key for key, value in self.cases.items()
                                   if not value.users and not value.preparing), None)
                    if victim is None:
                        raise CaseError("Other cases are busy. Please retry shortly.", 503)
                    self.cases.pop(victim).close()
                data = ViewerData(case_id, files, self.cache / case_id, self.tiles, self.decoded_cache)
                data.preparing = True
                self.cases[case_id] = data
                self.preparation.submit(self.prepare, data)
            self.cases.move_to_end(case_id)
            data.users += 1
        try:
            yield data
        finally:
            with self.lock:
                data.users -= 1

    def close(self):
        self.preparation.shutdown(wait=True)
        for data in self.cases.values():
            data.close()
        self.cases.clear()


class LocalServer(HTTPServer):
    """Bound request concurrency, including during rapid viewport changes."""
    def __init__(self, address, handler, registry):
        self.registry = registry
        self.pool = ThreadPoolExecutor(max_workers=12, thread_name_prefix="http")
        super().__init__(address, handler)

    def process_request(self, request, client_address):
        self.pool.submit(self.process_request_thread, request, client_address)

    def process_request_thread(self, request, client_address):
        try:
            self.finish_request(request, client_address)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            self.handle_error(request, client_address)
        finally:
            self.shutdown_request(request)

    def server_close(self):
        super().server_close()
        self.pool.shutdown(wait=True)
        self.registry.close()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.route(head=False)

    def do_HEAD(self):
        self.route(head=True)

    def route(self, head):
        path = unquote(urlsplit(self.path).path)
        registry = self.server.registry
        try:
            if path == "/api/health":
                self.send_json({"status": "ok"}, head)
            elif path == "/api/cases":
                self.send_json({"cases": registry.list_cases()}, head)
            elif match := re.fullmatch(r"/api/cases/([^/]+)/(.+)", path):
                with registry.acquire(match[1]) as data:
                    self.case_resource(data, match[2], head)
            elif path == "/api" or path.startswith("/api/"):
                raise CaseError("Unknown API resource.")
            elif path == "/":
                cases = registry.list_cases()
                if len(cases) == 1:
                    self.redirect(cases[0]["url"])
                else:
                    self.send_catalog(cases, head)
            elif path == "/favicon.svg" or path.startswith("/assets/"):
                self.static_file(path.lstrip("/"), head)
            elif match := re.fullmatch(r"/([^/]+)(/?)", path):
                registry.directory(match[1])
                if not match[2]:
                    self.redirect(f"/{quote(match[1], safe='')}/")
                else:
                    self.static_file("index.html", head)
            else:
                raise CaseError("Unknown page.")
        except CaseError as error:
            self.send_json({"error": str(error)}, head, status=error.status)
        except (ValueError, KeyError):
            self.send_json({"error": "Invalid tile or resource."}, head, status=404)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            traceback.print_exc()
            self.send_json({"error": "Could not read case data; check the files and server output."}, head, status=500)

    def case_resource(self, data, resource, head):
        if resource == "manifest":
            self.send_json({"case": {"id": data.case_id}, "slides": data.metadata, "annotations": data.state}, head)
            return
        version, _, resource = resource.partition("/")
        if version != data.version:
            raise CaseError("This case has changed. Reload the viewer.")
        if resource == "mask.png":
            self.send_bytes(data.mask, "image/png", head, "private, max-age=31536000, immutable")
        elif match := re.fullmatch(r"slides/(he|ihc)\.dzi", resource):
            self.send_bytes(data.generators[match[1]].get_dzi("jpeg").encode(), "application/xml", head)
        elif match := re.fullmatch(r"slides/(he|ihc)_files/(\d+)/(\d+)_(\d+)\.jpeg", resource):
            self.send_bytes(data.tile(match[1], *map(int, match.groups()[1:])), "image/jpeg", head, "private, max-age=31536000, immutable")
        elif match := re.fullmatch(r"points/([a-f0-9]{16})\.bin", resource):
            if data.state["state"] != "ready" or match[1] != data.state["version"]:
                raise CaseError("Annotation cache is not available.")
            self.send_file(data.points_path, "application/octet-stream", head, "private, max-age=31536000, immutable")
        else:
            raise CaseError("Unknown case resource.")

    def static_file(self, name, head):
        asset = (ROOT / "dist" / name).resolve()
        if not asset.is_relative_to((ROOT / "dist").resolve()) or not asset.is_file():
            raise CaseError("Frontend file not found. Run npm run build.")
        self.send_file(asset, mimetypes.guess_type(asset)[0] or "application/octet-stream", head)

    def redirect(self, location):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

    def send_catalog(self, cases, head):
        links = "".join(f'<li><a href="{escape(case["url"], quote=True)}">{escape(case["id"])}</a></li>' for case in cases)
        content = f'<ul>{links}</ul>' if cases else (
            '<p>No case folders found. Add a folder named after your slide to the configured data root.</p>'
            '<pre>data/CASE_ID/\n  CASE_ID_HE.tiff\n  CASE_ID_HE.png\n  CASE_ID_IHC.tiff\n  CASE_ID_IHC.geojson</pre>')
        page = ('<!doctype html><html lang="en"><meta charset="utf-8">'
                '<meta name="viewport" content="width=device-width,initial-scale=1">'
                '<title>Pathology Viewer · Slides</title><style>'
                'body{font:16px system-ui;color:#263b43;background:#f2f5f6;margin:0;padding:8vh 24px}'
                'main{max-width:720px;margin:auto;background:white;padding:32px;border-radius:12px}'
                'h1{font-size:24px}p{color:#64767e}ul{padding:0;list-style:none}'
                'a{display:block;padding:14px 0;color:#167866;overflow-wrap:anywhere}'
                'li+li{border-top:1px solid #e2e8ea}pre{font-size:13px;overflow:auto}'
                '</style><main><h1>Pathology Viewer</h1><p>Choose a slide</p>'
                f'{content}</main></html>')
        self.send_bytes(page.encode(), "text/html; charset=utf-8", head)

    def send_json(self, payload, head, status=200):
        self.send_bytes(json.dumps(payload).encode(), "application/json", head, status=status)

    def send_content_headers(self, length, content_type, cache, status=200):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()

    def send_bytes(self, payload, content_type, head, cache="no-cache", status=200):
        self.send_content_headers(len(payload), content_type, cache, status)
        if not head:
            self.wfile.write(payload)

    def send_file(self, source, content_type, head, cache="no-cache"):
        self.send_content_headers(source.stat().st_size, content_type, cache)
        if not head:
            with source.open("rb") as stream:
                while chunk := stream.read(256 * 1024):
                    self.wfile.write(chunk)

    def log_message(self, format, *args):
        if len(args) > 1 and str(args[1]) not in ("200", "304"):
            super().log_message(format, *args)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=os.environ.get("VIEWER_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("VIEWER_PORT", "8000")))
    parser.add_argument("--data-dir", type=Path, default=Path(os.environ.get("DATA_DIR", ROOT / "data")))
    parser.add_argument("--cache-dir", type=Path, default=Path(os.environ.get("CACHE_DIR", ROOT / ".cache" / "cases")))
    parser.add_argument("--max-open-cases", type=int, default=int(os.environ.get("MAX_OPEN_CASES", "4")))
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--case", help="Prepare only this case with --prepare-only; defaults to all cases.")
    args = parser.parse_args()
    registry = CaseRegistry(args.data_dir, args.cache_dir, args.max_open_cases)
    if args.prepare_only:
        failed = False
        try:
            for case_id in ([args.case] if args.case else [case["id"] for case in registry.list_cases()]):
                data = ViewerData(case_id, registry.files(case_id), registry.cache / case_id, registry.tiles, registry.decoded_cache)
                try:
                    data.prepare()
                    print(json.dumps({"case": case_id, "slides": data.metadata, "annotations": data.state}, indent=2))
                    failed |= data.state["state"] == "error"
                finally:
                    data.close()
        finally:
            registry.close()
        raise SystemExit(1 if failed else 0)
    server = LocalServer((args.host, args.port), Handler, registry)
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    print(f"Pathology Viewer: http://{args.host}:{args.port}\nData root: {registry.root}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
