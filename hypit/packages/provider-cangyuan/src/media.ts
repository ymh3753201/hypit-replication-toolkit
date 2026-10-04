import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const exec = promisify(execFile);
export type MediaInfo = { duration: number; width: number; height: number; codec: string; fps: number };
export async function inspectMedia(path: string): Promise<MediaInfo> {
  const { stdout } = await exec("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  const probe = JSON.parse(stdout);
  const video = probe.streams?.find((s: { codec_type: string }) => s.codec_type === "video");
  const [n, d] = String(video?.avg_frame_rate ?? "0/1").split("/").map(Number);
  return { duration: Number(probe.format?.duration ?? video?.duration ?? 0), width: Number(video?.width ?? 0), height: Number(video?.height ?? 0), codec: String(video?.codec_name ?? ""), fps: n! / (d || 1) };
}
export async function prepareMedia(bytes: Uint8Array, mediaType: string, output = false, mute = false): Promise<{ bytes: Uint8Array; mediaType: string; info: MediaInfo }> {
  const dir = await mkdtemp(join(tmpdir(), "hypit-cangyuan-"));
  try {
    const input = join(dir, "input"); await writeFile(input, bytes);
    const info = await inspectMedia(input);
    if (mediaType.startsWith("image/")) {
      if (Math.min(info.width, info.height) < 300 || Math.max(info.width, info.height) > 6000 || bytes.length > 30 * 1024 ** 2) throw new Error("参考图要求：边长 300–6000 像素，每张不超过 30MB");
    } else if (mediaType.startsWith("audio/")) {
      if (!(info.duration > 0 && info.duration <= 15) || bytes.length > 15 * 1024 ** 2) throw new Error("参考音频要求：每条有效时长不超过 15 秒，大小不超过 15MB");
    } else if (mediaType.startsWith("video/")) {
      if (!(info.duration > 0) || !info.width || !info.height) throw new Error("文件中没有可解码的视频");
      if (!output && (info.duration < 2 || info.duration > 15.05 || Math.min(info.width, info.height) < 480 || Math.max(info.width, info.height) > 1920 || bytes.length > 200 * 1024 ** 2)) throw new Error("参考视频要求：2–15 秒，边长 480–1920 像素，每条不超过 200MB；请先拆分镜头或调整尺寸，不能直接上传整条长视频");
      const target = join(dir, "normalized.mp4");
      const args = ["-v", "error", "-y", "-i", input, "-map", "0:v:0", ...(mute ? ["-an"] : ["-map", "0:a:0?", "-c:a", "aac"]), "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-vf", (!output && info.width * info.height < 407696 ? `scale=${Math.ceil(info.width * Math.sqrt(407696 / (info.width * info.height)) / 2) * 2}:${Math.ceil(info.height * Math.sqrt(407696 / (info.width * info.height)) / 2) * 2}` : "scale=trunc(iw/2)*2:trunc(ih/2)*2"), "-r", String(info.fps >= 24 && info.fps <= 60 ? info.fps : 30), "-movflags", "+faststart", target];
      await exec("ffmpeg", args, { timeout: 180_000, maxBuffer: 1024 * 1024 });
      return { bytes: new Uint8Array(await readFile(target)), mediaType: "video/mp4", info: await inspectMedia(target) };
    } else throw new Error(`不支持的素材类型：${mediaType}`);
    return { bytes, mediaType, info };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
