import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const bridgePath = fileURLToPath(new URL("../../provider-cangyuan/runtime/oss_bridge.py", import.meta.url));
const defaultPython = fileURLToPath(new URL("../../provider-cangyuan/runtime/.venv/bin/python", import.meta.url));
const defaultStorage = fileURLToPath(new URL("../../provider-cangyuan/runtime/oss_storage.py", import.meta.url));
export type AssetOptions = { readonly ossPython?: string; readonly ossStorageModule?: string };

function safeError(value: string): string { return value.replace(/https?:\/\/[^\s"'<>]+/gu, "[URL redacted]").slice(0, 400); }
async function bridge(options: AssetOptions, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await new Promise<string>((resolve, reject) => {
    const child = spawn(options.ossPython ?? defaultPython, ["-u", bridgePath], { env: { ...process.env, AI_DSP_OSS_STORAGE_MODULE: options.ossStorageModule ?? defaultStorage } });
    let out = ""; let err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("MiniMax asset store timed out")); }, 120_000);
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); if (out.length > 2_000_000) child.kill("SIGKILL"); });
    child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`MiniMax asset store failed: ${safeError(err || out)}`)); });
    child.stdin.on("error", () => { /* child close reports this failure */ });
    child.stdin.end(JSON.stringify(payload));
  });
  const value = JSON.parse(result) as Record<string, unknown>;
  if (value.error) throw new Error(`MiniMax asset store: ${safeError(String(value.message ?? value.error))}`);
  return value;
}

export async function checkAssetStore(options: AssetOptions): Promise<void> { await bridge(options, { action: "check" }); }

export async function publishAsset(options: AssetOptions, bytes: Uint8Array, mimeType: string, index: number): Promise<{ url: string; key: string }> {
  const extension: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "video/quicktime": "mov", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3" };
  const suffix = extension[mimeType]; if (!suffix) throw new Error(`MiniMax OSS 不支持 ${mimeType}`);
  const value = await bridge(options, { action: "upload", project_id: "hypit", clip_id: "minimax-h3", reference_index: index, object_key: `ai-dsp-temp/hypit/minimax/${randomUUID()}.${suffix}`, data: Buffer.from(bytes).toString("base64"), mime_type: mimeType, sha256: createHash("sha256").update(bytes).digest("hex") });
  if (typeof value.url !== "string" || !value.url.startsWith("https://") || typeof value.object_key !== "string") throw new Error("MiniMax OSS 没有返回有效的临时素材地址");
  return { url: value.url, key: value.object_key };
}

export async function deleteAsset(options: AssetOptions, key: string): Promise<void> { await bridge(options, { action: "delete", object_key: key }); }
