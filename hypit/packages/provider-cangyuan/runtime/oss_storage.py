#!/usr/bin/env python3
"""Private Alibaba Cloud OSS transport for temporary ai-dsp references."""

from __future__ import annotations

import os
import re
import subprocess
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import PurePosixPath
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, build_opener


OSS_ACCESS_KEY_ID_ENV = "AI_DSP_OSS_ACCESS_KEY_ID"
OSS_ACCESS_KEY_SECRET_ENV = "AI_DSP_OSS_ACCESS_KEY_SECRET"
OSS_REGION_ENV = "AI_DSP_OSS_REGION"
OSS_ENDPOINT_ENV = "AI_DSP_OSS_ENDPOINT"
OSS_BUCKET_ENV = "AI_DSP_OSS_BUCKET"
OSS_PREFIX_ENV = "AI_DSP_OSS_PREFIX"
OSS_URL_TTL_ENV = "AI_DSP_OSS_URL_TTL_SECONDS"
OSS_LIFECYCLE_MAX_DAYS_ENV = "AI_DSP_OSS_LIFECYCLE_MAX_DAYS"

DEFAULT_OSS_REGION = "cn-shenzhen"
DEFAULT_OSS_ENDPOINT = "https://oss-cn-shenzhen.aliyuncs.com"
DEFAULT_OSS_BUCKET = ""  # Distribution: require the recipient's own bucket.
DEFAULT_OSS_PREFIX = "ai-dsp-temp"
DEFAULT_OSS_URL_TTL_SECONDS = 6 * 60 * 60
MAX_OSS_URL_TTL_SECONDS = 7 * 24 * 60 * 60
DEFAULT_OSS_LIFECYCLE_MAX_DAYS = 7
MAX_OSS_LIFECYCLE_MAX_DAYS = 30

DEFAULT_OSS_ACCESS_KEY_ID_SERVICE = "ai-dsp-aliyun-oss-access-key-id"
DEFAULT_OSS_ACCESS_KEY_SECRET_SERVICE = "ai-dsp-aliyun-oss-access-key-secret"
DEFAULT_OSS_KEYCHAIN_ACCOUNT = "ai-dsp"

SAFE_BUCKET = re.compile(r"^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$")
SAFE_SEGMENT = re.compile(r"[^A-Za-z0-9._-]+")


class OssAssetError(Exception):
    """Safe OSS configuration or transfer failure."""


def _load_keychain_secret(service: str, account: str) -> str:
    if sys.platform != "darwin":
        return ""
    try:
        completed = subprocess.run(
            [
                "/usr/bin/security",
                "find-generic-password",
                "-a",
                account,
                "-s",
                service,
                "-w",
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    if completed.returncode != 0:
        return ""
    return completed.stdout.strip()


def load_oss_credentials() -> tuple[str, str]:
    access_key_id = os.environ.get(OSS_ACCESS_KEY_ID_ENV, "").strip()
    access_key_secret = os.environ.get(OSS_ACCESS_KEY_SECRET_ENV, "").strip()
    if not access_key_id:
        access_key_id = _load_keychain_secret(
            DEFAULT_OSS_ACCESS_KEY_ID_SERVICE, DEFAULT_OSS_KEYCHAIN_ACCOUNT
        )
    if not access_key_secret:
        access_key_secret = _load_keychain_secret(
            DEFAULT_OSS_ACCESS_KEY_SECRET_SERVICE, DEFAULT_OSS_KEYCHAIN_ACCOUNT
        )
    return access_key_id, access_key_secret


def _https_endpoint(value: str) -> str:
    endpoint = value.strip()
    if not endpoint:
        raise OssAssetError("OSS endpoint is missing")
    if "://" not in endpoint:
        endpoint = "https://" + endpoint
    parsed = urlparse(endpoint)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        raise OssAssetError("OSS endpoint must be a credential-free HTTPS origin")
    return endpoint.rstrip("/")


def _safe_segment(value: str, fallback: str) -> str:
    cleaned = SAFE_SEGMENT.sub("-", value).strip(".-_")
    return cleaned[:64] or fallback


def _extension_for_mime(mime_type: str) -> str:
    mapping = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
        "audio/mpeg": ".mp3",
        # Seedance reference-to-video needs the source clip itself uploaded.
        # Keep the existing allowlist and give MP4 references a safe suffix.
        "video/mp4": ".mp4",
        "video/quicktime": ".mov",
    }
    try:
        return mapping[mime_type]
    except KeyError as exc:
        raise OssAssetError(
            "unsupported temporary media MIME type"
        ) from exc


class AliyunOssAssetStore:
    """Upload private temporary objects and expose short-lived V4 signed GET URLs."""

    def __init__(
        self,
        access_key_id: str,
        access_key_secret: str,
        region: str = DEFAULT_OSS_REGION,
        endpoint: str = DEFAULT_OSS_ENDPOINT,
        bucket: str = DEFAULT_OSS_BUCKET,
        prefix: str = DEFAULT_OSS_PREFIX,
        url_ttl_seconds: int = DEFAULT_OSS_URL_TTL_SECONDS,
        lifecycle_max_days: int = DEFAULT_OSS_LIFECYCLE_MAX_DAYS,
        client: Any | None = None,
        sdk: Any | None = None,
        signed_url_opener: Any | None = None,
    ) -> None:
        if not access_key_id or not access_key_secret:
            raise OssAssetError(
                "missing OSS credentials: configure the ai-dsp macOS Keychain items "
                "or AI_DSP_OSS_ACCESS_KEY_ID/AI_DSP_OSS_ACCESS_KEY_SECRET"
            )
        if not isinstance(region, str) or not re.fullmatch(r"cn-[a-z0-9-]+", region):
            raise OssAssetError("OSS region must look like cn-shenzhen")
        if not isinstance(bucket, str) or not SAFE_BUCKET.fullmatch(bucket):
            raise OssAssetError("OSS bucket name is invalid")
        if isinstance(url_ttl_seconds, bool) or not isinstance(url_ttl_seconds, int):
            raise OssAssetError("OSS signed URL TTL must be an integer")
        if not 300 <= url_ttl_seconds <= MAX_OSS_URL_TTL_SECONDS:
            raise OssAssetError("OSS signed URL TTL must be 300-604800 seconds")
        if isinstance(lifecycle_max_days, bool) or not isinstance(
            lifecycle_max_days, int
        ):
            raise OssAssetError("OSS lifecycle maximum days must be an integer")
        if not 1 <= lifecycle_max_days <= MAX_OSS_LIFECYCLE_MAX_DAYS:
            raise OssAssetError("OSS lifecycle maximum days must be between 1 and 30")
        prefix_path = PurePosixPath(prefix.strip("/"))
        if not prefix_path.parts or ".." in prefix_path.parts:
            raise OssAssetError("OSS prefix must be a safe relative object prefix")

        self.region = region
        self.endpoint = _https_endpoint(endpoint)
        self.bucket = bucket
        self.prefix = prefix_path.as_posix()
        self.url_ttl_seconds = url_ttl_seconds
        self.lifecycle_max_days = lifecycle_max_days
        self.sdk = sdk or self._import_sdk()
        if client is None:
            provider = self.sdk.credentials.StaticCredentialsProvider(
                access_key_id, access_key_secret
            )
            config = self.sdk.config.load_default()
            config.credentials_provider = provider
            config.region = self.region
            config.endpoint = self.endpoint
            client = self.sdk.Client(config)
        self.client = client
        self.signed_url_opener = signed_url_opener or build_opener()

    @staticmethod
    def _import_sdk() -> Any:
        try:
            import alibabacloud_oss_v2 as oss  # type: ignore[import-not-found]
        except ImportError as exc:
            raise OssAssetError(
                "Alibaba Cloud OSS SDK is missing; run the project .venv setup from "
                ".agents/skills/ai-dsp/requirements.txt"
            ) from exc
        return oss

    @classmethod
    def from_environment(cls) -> "AliyunOssAssetStore":
        access_key_id, access_key_secret = load_oss_credentials()
        raw_ttl = os.environ.get(
            OSS_URL_TTL_ENV, str(DEFAULT_OSS_URL_TTL_SECONDS)
        ).strip()
        try:
            ttl = int(raw_ttl)
        except ValueError as exc:
            raise OssAssetError(f"{OSS_URL_TTL_ENV} must be an integer") from exc
        raw_lifecycle_days = os.environ.get(
            OSS_LIFECYCLE_MAX_DAYS_ENV,
            str(DEFAULT_OSS_LIFECYCLE_MAX_DAYS),
        ).strip()
        try:
            lifecycle_max_days = int(raw_lifecycle_days)
        except ValueError as exc:
            raise OssAssetError(
                f"{OSS_LIFECYCLE_MAX_DAYS_ENV} must be an integer"
            ) from exc
        return cls(
            access_key_id=access_key_id,
            access_key_secret=access_key_secret,
            region=os.environ.get(OSS_REGION_ENV, DEFAULT_OSS_REGION).strip(),
            endpoint=os.environ.get(OSS_ENDPOINT_ENV, DEFAULT_OSS_ENDPOINT).strip(),
            bucket=os.environ.get(OSS_BUCKET_ENV, DEFAULT_OSS_BUCKET).strip(),
            prefix=os.environ.get(OSS_PREFIX_ENV, DEFAULT_OSS_PREFIX).strip(),
            url_ttl_seconds=ttl,
            lifecycle_max_days=lifecycle_max_days,
        )

    def check_ready(self) -> dict[str, Any]:
        try:
            exists = bool(self.client.is_bucket_exist(self.bucket))
        except Exception as exc:
            raise OssAssetError(
                f"OSS read-only bucket check failed: {type(exc).__name__}"
            ) from exc
        if not exists:
            raise OssAssetError("configured OSS bucket does not exist or is not accessible")
        try:
            acl_result = self.client.get_bucket_acl(
                self.sdk.GetBucketAclRequest(bucket=self.bucket)
            )
            bucket_acl = str(getattr(acl_result, "acl", "") or "").strip().lower()
        except Exception as exc:
            raise OssAssetError(
                f"OSS bucket ACL could not be verified: {type(exc).__name__}"
            ) from exc
        if bucket_acl != "private":
            raise OssAssetError(
                "OSS bucket ACL must be private before production uploads"
            )
        try:
            lifecycle_result = self.client.get_bucket_lifecycle(
                self.sdk.GetBucketLifecycleRequest(bucket=self.bucket)
            )
            lifecycle_configuration = getattr(
                lifecycle_result, "lifecycle_configuration", None
            )
            lifecycle_rules = list(
                getattr(lifecycle_configuration, "rules", None)
                or getattr(lifecycle_result, "rules", None)
                or []
            )
        except Exception as exc:
            raise OssAssetError(
                f"OSS lifecycle rule could not be verified: {type(exc).__name__}"
            ) from exc
        if not lifecycle_rules:
            raise OssAssetError(
                "OSS bucket requires a verified lifecycle rule for temporary objects"
            )
        expected_prefix = self.prefix.rstrip("/") + "/"
        matching_rule: dict[str, Any] | None = None
        for rule in lifecycle_rules:
            rule_prefix = str(getattr(rule, "prefix", "") or "")
            status = str(getattr(rule, "status", "") or "").strip().lower()
            expiration = getattr(rule, "expiration", None)
            expiration_days = getattr(expiration, "days", None)
            if (
                rule_prefix in {self.prefix, expected_prefix}
                and status == "enabled"
                and isinstance(expiration_days, int)
                and not isinstance(expiration_days, bool)
                and 1 <= expiration_days <= self.lifecycle_max_days
            ):
                matching_rule = {
                    "id": str(getattr(rule, "id", "") or "")[:255],
                    "prefix": expected_prefix,
                    "expiration_days": expiration_days,
                }
                break
        if matching_rule is None:
            raise OssAssetError(
                "OSS requires an enabled expiration rule for the configured temporary "
                f"prefix within {self.lifecycle_max_days} days"
            )
        return {
            "ready": True,
            "region": self.region,
            "endpoint": self.endpoint,
            "bucket": self.bucket,
            "prefix": self.prefix,
            "url_ttl_seconds": self.url_ttl_seconds,
            "bucket_acl": bucket_acl,
            "object_acl": "private",
            "lifecycle_rule_count": len(lifecycle_rules),
            "lifecycle_rule": matching_rule,
            "lifecycle_max_days": self.lifecycle_max_days,
            "signed_url_version": "OSS4-HMAC-SHA256",
        }

    def identity(self) -> dict[str, str]:
        return {
            "provider": "aliyun-oss",
            "region": self.region,
            "endpoint": self.endpoint,
            "bucket": self.bucket,
            "prefix": self.prefix,
        }

    def build_object_key(
        self,
        *,
        project_id: str,
        clip_id: str,
        reference_index: int,
        mime_type: str,
        sha256: str,
    ) -> str:
        extension = _extension_for_mime(mime_type)
        date_prefix = datetime.now(timezone.utc).strftime("%Y%m%d")
        return "/".join(
            (
                self.prefix,
                date_prefix,
                _safe_segment(project_id, "project"),
                _safe_segment(clip_id, "clip"),
                f"ref-{reference_index:02d}-{sha256[:12]}-{uuid.uuid4().hex}{extension}",
            )
        )

    def upload_asset(
        self,
        *,
        project_id: str,
        clip_id: str,
        reference_index: int,
        data: bytes,
        mime_type: str,
        sha256: str,
        object_key: str | None = None,
    ) -> dict[str, Any]:
        expected_prefix = self.prefix + "/"
        key = object_key or self.build_object_key(
            project_id=project_id,
            clip_id=clip_id,
            reference_index=reference_index,
            mime_type=mime_type,
            sha256=sha256,
        )
        if not isinstance(key, str) or not key.startswith(expected_prefix):
            raise OssAssetError("OSS object key must stay inside the configured prefix")
        uploaded = False
        try:
            result = self.client.put_object(
                self.sdk.PutObjectRequest(
                    bucket=self.bucket,
                    key=key,
                    body=data,
                    content_length=len(data),
                    content_type=mime_type,
                    cache_control="private, no-store",
                    object_acl="private",
                    metadata={
                        "ai-dsp-sha256": sha256,
                        "ai-dsp-clip": _safe_segment(clip_id, "clip"),
                    },
                )
            )
            status_code = int(getattr(result, "status_code", 0) or 0)
            if status_code not in {200, 201}:
                raise OssAssetError(f"OSS upload returned HTTP {status_code or 'unknown'}")
            uploaded = True
            signed = self.client.presign(
                self.sdk.GetObjectRequest(bucket=self.bucket, key=key),
                expires=timedelta(seconds=self.url_ttl_seconds),
            )
            signed_url = str(getattr(signed, "url", "") or "")
            parsed = urlparse(signed_url)
            if parsed.scheme != "https" or not parsed.hostname or not parsed.query:
                raise OssAssetError("OSS did not return a valid HTTPS signed URL")
            self._verify_signed_asset_url(signed_url, mime_type)
        except OssAssetError:
            if uploaded:
                self._delete_after_failed_upload(key)
            raise
        except Exception as exc:
            if uploaded:
                self._delete_after_failed_upload(key)
            raise OssAssetError(f"OSS upload failed: {type(exc).__name__}") from exc
        return {
            "object_key": key,
            "url": signed_url,
            "url_expires_at": (
                datetime.now(timezone.utc) + timedelta(seconds=self.url_ttl_seconds)
            ).replace(microsecond=0).isoformat(),
            "origin": f"https://{parsed.hostname}",
            "mime_type": mime_type,
            "size_bytes": len(data),
            "sha256": sha256,
            "storage": self.identity(),
        }

    def upload_image(self, **kwargs: Any) -> dict[str, Any]:
        """Backward-compatible image-only entry point."""
        if not str(kwargs.get("mime_type") or "").startswith("image/"):
            raise OssAssetError("upload_image accepts image MIME types only")
        return self.upload_asset(**kwargs)

    def _verify_signed_asset_url(self, signed_url: str, mime_type: str) -> None:
        """Byte-check the exact public URL without logging its signature."""
        request = Request(
            signed_url,
            headers={"Range": "bytes=0-31", "Accept": mime_type},
            method="GET",
        )
        try:
            with self.signed_url_opener.open(request, timeout=20) as response:
                header = response.read(32)
        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            raise OssAssetError(
                f"OSS signed URL verification failed: {type(exc).__name__}"
            ) from exc
        wave = len(header) >= 12 and header.startswith(b"RIFF") and header[8:12] == b"WAVE"
        # MP3 may start with ID3 metadata or directly with a Layer III frame.
        mp3 = header.startswith(b"ID3") or (
            len(header) >= 4
            and header[0] == 0xFF
            and header[1] & 0xE0 == 0xE0
            and header[1] & 0x18 != 0x08  # reserved MPEG version
            and header[1] & 0x06 == 0x02  # Layer III
            and header[2] & 0xF0 != 0xF0  # invalid bitrate index
            and header[2] & 0x0C != 0x0C  # invalid sample-rate index
        )
        # QuickTime MOV can start with a wide/mdat/moov atom instead of ftyp.
        # This is a URL/header check; the provider probes the full media first.
        mov = len(header) >= 8 and header[4:8] in {
            b"ftyp", b"wide", b"mdat", b"moov", b"free", b"skip"
        }
        valid = {
            "image/png": header.startswith(b"\x89PNG\r\n\x1a\n"),
            "image/jpeg": header.startswith(b"\xff\xd8\xff"),
            "image/webp": len(header) >= 12
            and header.startswith(b"RIFF")
            and header[8:12] == b"WEBP",
            "audio/wav": wave,
            "audio/x-wav": wave,
            "audio/mpeg": mp3,
            # MP4/ISO-BMFF files begin with a four-byte box length followed by
            # the `ftyp` box type.  This checks the container without decoding.
            "video/mp4": len(header) >= 8 and header[4:8] == b"ftyp",
            "video/quicktime": mov,
        }.get(mime_type, False)
        if not valid:
            raise OssAssetError("OSS signed URL did not return the expected asset bytes")

    def _delete_after_failed_upload(self, object_key: str) -> None:
        try:
            self.client.delete_object(
                self.sdk.DeleteObjectRequest(bucket=self.bucket, key=object_key)
            )
        except Exception as exc:
            raise OssAssetError(
                "OSS upload failed and the uploaded object could not be removed; "
                f"manual cleanup is required ({type(exc).__name__})"
            ) from exc

    def delete_object(self, object_key: str) -> None:
        if not object_key.startswith(self.prefix + "/"):
            raise OssAssetError("refusing to delete an object outside the ai-dsp prefix")
        try:
            self.client.delete_object(
                self.sdk.DeleteObjectRequest(bucket=self.bucket, key=object_key)
            )
        except Exception as exc:
            raise OssAssetError(f"OSS cleanup failed: {type(exc).__name__}") from exc
