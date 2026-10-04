import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareMedia } from "../src/media.js";

test("reference normalization preserves duration, supplies H264 and sufficient pixel count", async () => {
 const dir = await mkdtemp(join(tmpdir(), "cangyuan-test-"));
 try {
  const file = join(dir, "reference.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=red:s=512x512:r=12:d=2", "-c:v", "mpeg4", file]);
  const result = await prepareMedia(new Uint8Array(await readFile(file)), "video/mp4");
  assert.equal(result.info.codec, "h264"); assert.equal(result.info.fps, 30);
  assert.ok(result.info.width * result.info.height >= 407696); assert.ok(Math.abs(result.info.duration - 2) < 0.05);
 } finally { await rm(dir, { recursive: true, force: true }); }
});
test("corrupt result data cannot be stored as a successful video", async () => {
 await assert.rejects(() => prepareMedia(new TextEncoder().encode('<html>error</html>'), "video/mp4", true, true));
});
test("long reference videos fail before uploading, rather than being silently trimmed", async () => {
 const dir = await mkdtemp(join(tmpdir(), "cangyuan-test-"));
 try {
  const file = join(dir, "long.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=red:s=480x854:r=24:d=16", "-c:v", "libx264", "-preset", "ultrafast", file]);
  await assert.rejects(() => prepareMedia(new Uint8Array(readFileSync(file)), "video/mp4"), /2–15/);
 } finally { await rm(dir, { recursive: true, force: true }); }
});
import { readFileSync } from "node:fs";
