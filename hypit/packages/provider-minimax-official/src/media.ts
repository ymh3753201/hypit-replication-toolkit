import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);
export type MediaInfo = { duration: number; width: number; height: number; fps: number; videoCodec: string; audioCodec: string };

export async function inspectMedia(bytes: Uint8Array, mediaType: string): Promise<MediaInfo> {
  const dir = await mkdtemp(join(tmpdir(), "hypit-minimax-probe-"));
  try {
    const path = join(dir, `asset.${mediaType.startsWith("image/") ? "png" : mediaType.startsWith("audio/") ? "wav" : "mp4"}`);
    await writeFile(path, bytes);
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const probe = JSON.parse(stdout) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
    const video = probe.streams?.find(s => s.codec_type === "video");
    const audio = probe.streams?.find(s => s.codec_type === "audio");
    const [numerator, denominator] = String(video?.avg_frame_rate ?? "0/1").split("/").map(Number);
    return { duration: Number(probe.format?.duration ?? video?.duration ?? audio?.duration ?? 0), width: Number(video?.width ?? 0), height: Number(video?.height ?? 0), fps: numerator! / (denominator || 1), videoCodec: String(video?.codec_name ?? ""), audioCodec: String(audio?.codec_name ?? "") };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export function validateReference(info: MediaInfo, mediaType: string, size: number): void {
  const ratio = info.width / info.height;
  if (mediaType.startsWith("image/")) {
    if (!["image/png", "image/jpeg", "image/webp"].includes(mediaType)) throw new Error("MiniMax 参考图当前支持 PNG/JPEG/WebP；请先转换其他格式");
    if (size > 30_000_000 || Math.min(info.width, info.height) < 256 || Math.max(info.width, info.height) > 5760 || ratio < 0.4 || ratio > 2.5) throw new Error("MiniMax 参考图超出官方大小、尺寸或画幅范围");
  } else if (mediaType.startsWith("video/")) {
    if (mediaType !== "video/mp4" && mediaType !== "video/quicktime") throw new Error("MiniMax 参考视频需要 MP4 或 MOV");
    if (size > 50_000_000 || info.duration < 2 || info.duration > 15.05 || Math.min(info.width, info.height) < 256 || Math.max(info.width, info.height) > 5760 || ratio < 0.4 || ratio > 2.5 || info.fps < 23.9 || info.fps > 60.1 || !["h264", "hevc"].includes(info.videoCodec) || (info.audioCodec && !["aac", "mp3"].includes(info.audioCodec))) throw new Error("MiniMax 参考视频不符合官方限制：2–15 秒、≤50MB、H.264/H.265、23.976–60fps；请只做兼容性转换，不裁剪内容");
  } else if (mediaType.startsWith("audio/")) {
    if (!["audio/wav", "audio/x-wav", "audio/mpeg"].includes(mediaType) || size > 15_000_000 || info.duration < 2 || info.duration > 15.05) throw new Error("MiniMax 参考音频需要 2–15 秒的 WAV/MP3，且不超过 15MB");
  } else throw new Error(`MiniMax 不支持的参考素材：${mediaType}`);
}
