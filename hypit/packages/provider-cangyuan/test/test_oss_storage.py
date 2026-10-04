"""Offline checks for the media formats accepted by the shared OSS bridge."""
import importlib.util
import io
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    "oss_storage", Path(__file__).resolve().parents[1] / "runtime" / "oss_storage.py"
)
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)


class HeaderOpener:
    def __init__(self, data):
        self.data = data

    def open(self, request, timeout):
        return io.BytesIO(self.data)


class SignedMediaTests(unittest.TestCase):
    def verify(self, mime, data):
        store = storage.AliyunOssAssetStore.__new__(storage.AliyunOssAssetStore)
        store.signed_url_opener = HeaderOpener(data)
        store._verify_signed_asset_url("https://assets.example/test?signature=fake", mime)

    def test_real_audio_and_mov_headers(self):
        # Exercise both common MP3 headers and MOV without an ISO ftyp box.
        with tempfile.TemporaryDirectory() as directory:
            for filename, mime, args in [
                ("id3.mp3", "audio/mpeg", ["-f", "lavfi", "-i", "sine=duration=0.1"]),
                ("frames.mp3", "audio/mpeg", ["-f", "lavfi", "-i", "sine=duration=0.1", "-id3v2_version", "0", "-write_xing", "0"]),
                ("voice.wav", "audio/wav", ["-f", "lavfi", "-i", "sine=duration=0.1"]),
                ("alias.wav", "audio/x-wav", ["-f", "lavfi", "-i", "sine=duration=0.1"]),
                ("video.mov", "video/quicktime", ["-f", "lavfi", "-i", "color=s=256x256:r=24:d=0.1", "-c:v", "libx264"]),
            ]:
                with self.subTest(mime=mime, filename=filename):
                    path = Path(directory) / filename
                    subprocess.run(["ffmpeg", "-v", "error", *args, str(path)], check=True, capture_output=True)
                    self.verify(mime, path.read_bytes()[:32])

    def test_existing_formats_and_iso_mov(self):
        for mime, header in [
            ("image/png", b"\x89PNG\r\n\x1a\n"),
            ("image/jpeg", b"\xff\xd8\xff"),
            ("image/webp", b"RIFF\x00\x00\x00\x00WEBP"),
            ("video/mp4", b"\x00\x00\x00\x18ftypisom"),
            ("video/quicktime", b"\x00\x00\x00\x14ftypqt  "),
        ]:
            with self.subTest(mime=mime):
                self.verify(mime, header)

    def test_error_pages_and_wrong_media_still_fail(self):
        for mime in ["image/png", "image/jpeg", "image/webp", "audio/wav", "audio/x-wav", "audio/mpeg", "video/mp4", "video/quicktime"]:
            with self.subTest(mime=mime):
                with self.assertRaises(storage.OssAssetError):
                    self.verify(mime, b"<html>AccessDenied</html>")
        for header in [b"", b"\xff", b"\xff\xff\xff\xff", b"RIFF\x00\x00\x00\x00WAVE"]:
            with self.subTest(header=header):
                with self.assertRaises(storage.OssAssetError):
                    self.verify("audio/mpeg", header)


if __name__ == "__main__":
    unittest.main()
