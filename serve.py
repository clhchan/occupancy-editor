#!/usr/bin/env python3
"""Serve the built Occupancy Editor and a restricted local file API."""

from __future__ import annotations

import argparse
import base64
import binascii
import ipaddress
import json
import mimetypes
import os
import socket
import struct
import sys
import tempfile
import threading
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit


COLORS = {
    'reset': '\033[0m',
    'bold': '\033[1m',
    'blue': '\033[34m',
    'green': '\033[32m',
    'yellow': '\033[33m',
    'red': '\033[31m',
    'dim': '\033[2m',
}
STATUS_COLORS = {'2': 'green', '3': 'blue', '4': 'yellow'}


def _paint(text: str, color: str, stream) -> str:
    if not color or 'NO_COLOR' in os.environ or not stream.isatty():
        return text
    return f'{COLORS[color]}{text}{COLORS["reset"]}'


class ReusableServer(ThreadingHTTPServer):
    allow_reuse_address = True


class OccupancyHandler(SimpleHTTPRequestHandler):
    data_root: Path
    save_lock = threading.Lock()

    def log_message(self, format: str, *args: object) -> None:
        """Render concise, color-coded HTTP access logs for interactive use."""
        stream = sys.stderr
        message = format % args
        client = str(self.client_address[0]) if self.client_address else '-'
        request = str(args[0]) if args else message
        status = str(args[1]) if len(args) > 1 else '-'
        size = str(args[2]) if len(args) > 2 else '-'
        status_color = STATUS_COLORS.get(status[:1], 'red')
        print(
            f'{_paint(self.log_date_time_string(), "dim", stream)} '
            f'{client} '
            f'{_paint(status, status_color, stream)} '
            f'{request} {_paint(f"{size} B", "dim", stream)}',
            file=stream,
            flush=True,
        )

    def _json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _error(self, message: str, status: int = 400) -> None:
        self._json({'error': message}, status)

    def _safe_path(self, raw_path: str) -> Path:
        relative = unquote(raw_path or '.').replace('\\', '/')
        candidate = (self.data_root / relative).resolve()
        try:
            candidate.relative_to(self.data_root)
        except ValueError as exc:
            raise ValueError('路径超出用户 home 目录') from exc
        return candidate

    def _relative_path(self, path: Path) -> str:
        relative = path.relative_to(self.data_root).as_posix()
        return relative or '.'

    def _query_path(self) -> str:
        return parse_qs(urlsplit(self.path).query).get('path', ['.'])[0]

    def _send_file(self, path: Path) -> None:
        if not path.is_file():
            self._error('文件不存在', 404)
            return
        content = path.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', mimetypes.guess_type(path.name)[0] or 'application/octet-stream')
        self.send_header('Content-Length', str(len(content)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(content)

    def _read_json_body(self) -> dict:
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError as exc:
            raise ValueError('保存内容大小无效') from exc
        if length <= 0 or length > 128 * 1024 * 1024:
            raise ValueError('保存内容大小无效')
        payload = json.loads(self.rfile.read(length).decode('utf-8'))
        if not isinstance(payload, dict):
            raise ValueError('请求内容必须是 JSON 对象')
        return payload

    def _decode_target(self, payload: object) -> tuple[Path, bytes]:
        if not isinstance(payload, dict):
            raise ValueError('保存目标格式无效')
        path = self._safe_path(str(payload.get('path', '')))
        if path.suffix.lower() not in {'.pgm', '.yaml', '.yml'}:
            raise ValueError('仅允许保存 PGM/YAML 文件')
        encoded = payload.get('contentBase64')
        if not isinstance(encoded, str) or not encoded:
            raise ValueError('保存内容为空')
        content = base64.b64decode(encoded, validate=True)
        if not path.parent.is_dir():
            raise ValueError('目标目录不存在')
        return path, content

    def _decode_delete_target(self, payload: object) -> Path:
        if not isinstance(payload, dict):
            raise ValueError('删除目标格式无效')
        path = self._safe_path(str(payload.get('path', '')))
        if path.suffix.lower() not in {'.pgm', '.yaml', '.yml'}:
            raise ValueError('仅允许删除 PGM/YAML 文件')
        if not path.is_file():
            raise ValueError('文件不存在')
        return path

    @staticmethod
    def _atomic_write(path: Path, content: bytes) -> None:
        descriptor, temporary_name = tempfile.mkstemp(prefix=f'.{path.name}.', suffix='.tmp', dir=path.parent)
        try:
            with os.fdopen(descriptor, 'wb') as temporary:
                temporary.write(content)
                temporary.flush()
                os.fsync(temporary.fileno())
            os.replace(temporary_name, path)
        except Exception:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass
            raise

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == '/api/files':
            try:
                directory = self._safe_path(self._query_path())
            except ValueError as exc:
                self._error(str(exc), 403)
                return
            if not directory.is_dir():
                self._error('目录不存在', 404)
                return
            entries = []
            for entry in sorted(directory.iterdir(), key=lambda item: (not item.is_dir(), item.name.lower())):
                if entry.name.startswith('.') and not (entry.is_dir() and entry.name == '.ros'):
                    continue
                if entry.is_dir():
                    entries.append({'name': entry.name, 'path': self._relative_path(entry), 'type': 'directory'})
                elif entry.suffix.lower() in {'.pgm', '.yaml', '.yml'}:
                    entries.append({'name': entry.name, 'path': self._relative_path(entry), 'type': 'file', 'size': entry.stat().st_size})
            parent = None if directory == self.data_root else self._relative_path(directory.parent)
            self._json({'root': str(self.data_root), 'path': self._relative_path(directory), 'parent': parent, 'entries': entries})
            return

        if parsed.path == '/api/file':
            try:
                path = self._safe_path(self._query_path())
            except ValueError as exc:
                self._error(str(exc), 403)
                return
            if path.suffix.lower() not in {'.pgm', '.yaml', '.yml'}:
                self._error('仅允许读取 PGM/YAML 文件', 403)
                return
            self._send_file(path)
            return
        super().do_GET()

    def do_POST(self) -> None:
        endpoint = urlsplit(self.path).path
        if endpoint not in {'/api/delete', '/api/save', '/api/save-pair'}:
            self._error('不支持的接口', 404)
            return
        try:
            payload = self._read_json_body()
            if endpoint == '/api/delete':
                path = self._decode_delete_target(payload)
                with self.save_lock:
                    try:
                        path.unlink()
                    except FileNotFoundError as exc:
                        raise ValueError('文件不存在') from exc
                self._json({'path': self._relative_path(path)})
                return
            if endpoint == '/api/save':
                path, content = self._decode_target(payload)
                with self.save_lock:
                    self._atomic_write(path, content)
                self._json({'path': self._relative_path(path), 'bytes': len(content)})
                return

            pgm_path, pgm_content = self._decode_target(payload.get('pgm'))
            yaml_path, yaml_content = self._decode_target(payload.get('yaml'))
            if pgm_path.parent != yaml_path.parent:
                raise ValueError('PGM 和 YAML 必须保存到同一目录')
            if pgm_path == yaml_path:
                raise ValueError('PGM 和 YAML 目标不能相同')
            with self.save_lock:
                previous_pgm = pgm_path.read_bytes() if pgm_path.exists() else None
                self._atomic_write(pgm_path, pgm_content)
                try:
                    self._atomic_write(yaml_path, yaml_content)
                except Exception:
                    try:
                        if previous_pgm is None:
                            pgm_path.unlink(missing_ok=True)
                        else:
                            self._atomic_write(pgm_path, previous_pgm)
                    except OSError:
                        pass
                    raise
            self._json({
                'pgm': {'path': self._relative_path(pgm_path), 'bytes': len(pgm_content)},
                'yaml': {'path': self._relative_path(yaml_path), 'bytes': len(yaml_content)},
            })
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError, binascii.Error) as exc:
            self._error(str(exc), 400)
            return
        except OSError as exc:
            self._error(f'文件写入失败: {exc}', 500)
            return


def _network_addresses() -> list[tuple[str, str, str]]:
    """Return usable IPv4 addresses grouped by physical interface type."""
    try:
        import fcntl
    except ImportError:
        return []

    ignored_prefixes = (
        'br-', 'docker', 'dummy', 'veth', 'virbr', 'tun', 'tap', 'wg',
        'tailscale',
    )
    addresses = []
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as interface_socket:
        for _, interface in socket.if_nameindex():
            interface_name = interface.lower()
            if interface_name == 'lo' or interface_name.startswith(ignored_prefixes):
                continue
            try:
                request = struct.pack('256s', interface.encode('utf-8')[:15])
                result = fcntl.ioctl(interface_socket.fileno(), 0x8915, request)
                address = socket.inet_ntoa(result[20:24])
                parsed = ipaddress.ip_address(address)
            except (OSError, ValueError):
                continue
            if parsed.is_loopback or parsed.is_link_local or parsed.is_unspecified:
                continue
            wireless = (
                Path('/sys/class/net', interface, 'wireless').exists()
                or interface_name.startswith(('wl', 'w1', 'wifi', 'wwan'))
            )
            addresses.append(('Wireless' if wireless else 'Ethernet', interface, address))
    return addresses


def main() -> None:
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description='Occupancy Editor local file server')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8080)
    parser.add_argument('--data-root', default=str(Path.home()), help='文件根目录，默认是当前用户 home')
    args = parser.parse_args()

    data_root = Path(args.data_root).expanduser().resolve()
    if not data_root.is_dir():
        parser.error(f'数据目录不存在: {data_root}')
    OccupancyHandler.data_root = data_root
    os.chdir(root / 'dist' if (root / 'dist').is_dir() else root)
    server = ReusableServer((args.host, args.port), OccupancyHandler)
    output = sys.stdout
    print(
        f'{_paint("Occupancy Editor", "bold", output)}: '
        f'{_paint(f"http://{args.host}:{args.port}", "green", output)}',
        flush=True,
    )
    if args.host in {'', '0.0.0.0', '::'}:
        for interface_type, interface, address in _network_addresses():
            print(
                f'  {interface_type} ({interface}): '
                f'{_paint(f"http://{address}:{args.port}", "green", output)}',
                flush=True,
            )
    print(
        f'Data root: {_paint(str(data_root), "dim", output)}',
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print(f'\n{_paint("Occupancy Editor stopped", "dim", output)}')
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
