#!/usr/bin/env python3
"""Small stdin/stdout bridge that reuses the AI Dsp Alibaba OSS store."""
from __future__ import annotations
import base64, hashlib, importlib.util, json, os, sys

module_path = os.environ.get("AI_DSP_OSS_STORAGE_MODULE", "").strip()
if not module_path:
    raise SystemExit("AI_DSP_OSS_STORAGE_MODULE is required")
spec = importlib.util.spec_from_file_location("ai_dsp_storage", module_path)
if spec is None or spec.loader is None:
    raise SystemExit("cannot load AI Dsp OSS storage module")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def main() -> None:
    request = json.load(sys.stdin)
    store = module.AliyunOssAssetStore.from_environment()
    action = request.get("action")
    if action == "check":
        print(json.dumps(store.check_ready(), ensure_ascii=False))
        return
    if action == "upload":
        data = base64.b64decode(request["data"])
        mime = str(request["mime_type"])
        digest = hashlib.sha256(data).hexdigest()
        if digest != request["sha256"]:
            raise RuntimeError("OSS bridge input hash mismatch")
        result = store.upload_asset(
            project_id=str(request["project_id"]), clip_id=str(request["clip_id"]),
            reference_index=int(request["reference_index"]), data=data,
            mime_type=mime, sha256=digest, object_key=request.get("object_key"),
        )
        print(json.dumps({"url": result["url"], "object_key": result["object_key"], "sha256": digest}, ensure_ascii=False))
        return
    if action == "delete":
        store.delete_object(str(request["object_key"]))
        print(json.dumps({"deleted": True}, ensure_ascii=False))
        return
    raise RuntimeError("unsupported OSS bridge action")

try:
    main()
except Exception as exc:
    print(json.dumps({"error": type(exc).__name__, "message": str(exc)}, ensure_ascii=False))
    raise SystemExit(1)
