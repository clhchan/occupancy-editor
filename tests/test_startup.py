import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from html.parser import HTMLParser
from pathlib import Path
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[1]


class PageLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attrs):
        key = {'script': 'src', 'link': 'href'}.get(tag)
        if key and key in dict(attrs):
            self.urls.append(dict(attrs)[key])


class OfflineStartup(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / 'tools' / 'occupancy-editor'
        self.root.mkdir(parents=True)
        for name in ('start.sh', 'serve.py'):
            shutil.copy2(ROOT / name, self.root / name)
        shutil.copytree(ROOT / 'dist', self.root / 'dist')
        binaries = Path(temporary.name) / 'bin'
        binaries.mkdir()
        for name in ('bash', 'python3', 'dirname'):
            (binaries / name).symlink_to(shutil.which(name))
        self.env = {'PATH': str(binaries), 'HOME': temporary.name, 'OCCUPANCY_EDITOR_HOST': '127.0.0.1'}

    def run_once(self):
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        origin = f'http://127.0.0.1:{port}'
        env = dict(self.env, OCCUPANCY_EDITOR_PORT=str(port))
        with subprocess.Popen(['./start.sh'], cwd=self.root, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT) as server:
            try:
                deadline = time.monotonic() + 5
                while True:
                    if server.poll() is not None:
                        self.fail(server.stdout.read().decode())
                    try:
                        with urlopen(origin, timeout=1) as response:
                            self.assertEqual(response.status, 200)
                            page = PageLinks()
                            page.feed(response.read().decode())
                        break
                    except OSError:
                        if time.monotonic() >= deadline:
                            raise
                        time.sleep(0.05)
                self.assertTrue({'.js', '.css'}.issubset(Path(url).suffix for url in page.urls))
                for url in page.urls:
                    with urlopen(origin + url, timeout=2) as response:
                        self.assertEqual(response.status, 200)
                        self.assertEqual(response.read(), (self.root / 'dist' / url.lstrip('/')).read_bytes())
            finally:
                server.terminate()
                server.wait(timeout=5)

    def test_first_and_second_start_without_node(self):
        assets = {path: path.stat().st_mtime_ns for path in (self.root / 'dist').rglob('*') if path.is_file()}
        for _ in range(2):
            self.run_once()
            self.assertFalse((self.root / 'node_modules').exists())
            self.assertEqual(assets, {path: path.stat().st_mtime_ns for path in assets})

    def test_missing_referenced_asset_is_not_served(self):
        stylesheet = next((self.root / 'dist' / 'assets').glob('*.css'))
        stylesheet.unlink()
        result = subprocess.run(['./start.sh', '--offline'], cwd=self.root, env=self.env, capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(stylesheet.name, result.stderr)
        self.assertIn('Node.js', result.stderr)
