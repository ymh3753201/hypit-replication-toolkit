import { mkdir, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { run, probe, hashFile, atomicJson, requireThat as check } from './common.mjs';
export function splitRanges(duration) {
    check(Number.isFinite(duration) && duration >= 4, '原片不足 4 秒，需明确适配方式');
    const count = Math.ceil(duration / 15);
    const step = duration / count;
    return Array.from({ length: count }, (_, i) => ({ start: i * step, end: i === count - 1 ? duration : (i + 1) * step, outputDuration: Math.ceil(step) }));
}
export async function splitVideo(file, out) {
    file = resolve(file);
    out = resolve(out);
    const info = await probe(file);
    check(info.videoCodec, '输入不是实际视频文件');
    try {
        await access(out);
        throw new Error('分段输出目录已存在，请使用新目录保留原件');
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw e;
    }
    await mkdir(out, { recursive: true, mode: 0o700 });
    const ranges = splitRanges(info.duration);
    const clips = [];
    for (const [i, r] of ranges.entries()) {
        const clip = join(out, `segment-${i + 1}.mp4`);
        await run('ffmpeg', ['-v', 'error', '-i', file, '-ss', String(r.start), '-t', String(r.end - r.start), '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-movflags', '+faststart', clip], { timeout: 300000 });
        const clipInfo = await probe(clip);
        check(Math.abs(clipInfo.duration - (r.end - r.start)) <= .15, '分段时长偏差超限');
        clips.push({ ...r, file: clip, sha256: await hashFile(clip), info: clipInfo });
    }
    const record = { format: 'replication.split@1', source: { file, sha256: await hashFile(file), info }, clips, note: '完整覆盖原片；按语义复核镜头/台词边界。outputDuration 为 H3 整数输出时长，未裁掉尾段。' };
    await atomicJson(join(out, 'segments.json'), record);
    return record;
}
