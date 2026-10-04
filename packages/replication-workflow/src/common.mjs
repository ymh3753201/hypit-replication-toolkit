import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
export const run = promisify(execFile);
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function stable(value) {
    if (Array.isArray(value))
        return value.map(stable);
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
    return value;
}
export const digest = value => sha(JSON.stringify(stable(value)));
export const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
export const hashFile = async (file) => sha(await readFile(file));
export function requireThat(condition, message) { if (!condition)
    throw new Error(message); }
export function id(value) { requireThat(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value), '编号须为 1–80 位字母、数字、下划线或短横线'); return value; }
export const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
export async function atomicJson(file, value) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
        const handle = await open(temp, 'wx', 0o600);
        try {
            await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await rename(temp, file);
        const directory = await open(dirname(file), 'r');
        try {
            await directory.sync();
        }
        finally {
            await directory.close();
        }
    }
    finally {
        await rm(temp, { force: true });
    }
}
export async function probe(file) {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', resolve(file)], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    const p = JSON.parse(stdout);
    const video = p.streams?.find(s => s.codec_type === 'video');
    const audio = p.streams?.find(s => s.codec_type === 'audio');
    const [a, b] = String(video?.avg_frame_rate ?? '0/1').split('/').map(Number);
    return { duration: Number(p.format?.duration ?? 0), width: Number(video?.width ?? 0), height: Number(video?.height ?? 0), fps: a / (b || 1), videoCodec: video?.codec_name ?? '', audioCodec: audio?.codec_name ?? '', hasAudio: !!audio };
}
export function requestSummary(body, assets) {
    requireThat(body.model === 'MiniMax-H3' && Array.isArray(body.content), '只允许官方 MiniMax-H3 内容请求');
    const content = body.content.map(item => {
        if (item.type === 'text') {
            requireThat(Object.keys(item).every(k => ['type', 'text'].includes(k)), '文字请求含未知参数');
            return { type: 'text', text: item.text };
        }
        requireThat(['image_url', 'video_url', 'audio_url'].includes(item.type), '未知官方请求字段');
        requireThat(Object.keys(item).every(k => ['type', 'role', item.type].includes(k)) && Object.keys(item[item.type] ?? {}).every(k => k === 'url'), '素材请求含计划外参数');
        const asset = assets.find(a => a.url === item[item.type]?.url);
        requireThat(asset, '最终请求含未核对的素材地址');
        return { type: item.type, role: item.role, sha256: asset.sha256, size: asset.size, mediaType: asset.mediaType };
    });
    requireThat(Object.keys(body).every(k => ['model', 'content', 'duration', 'resolution', 'ratio'].includes(k)), '最终请求含计划之外的收费参数');
    return { model: body.model, content, duration: body.duration, resolution: body.resolution, ...(body.ratio === undefined ? {} : { ratio: body.ratio }) };
}
