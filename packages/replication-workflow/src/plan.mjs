import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson, readJson, hashFile, sha, digest, probe, run, requireThat as check, id, xml } from './common.mjs';
import { registerGrant, readLedger } from './ledger.mjs';
import { buildPrompt } from '../../h3-replication-kits/src/prompt.mjs';
export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const ledgerRoot = join(projectRoot, '.hypit', 'replication-ledger');
const kinds = ['person', 'product', 'action', 'camera', 'scene', 'style', 'voice', 'dialogue'];
const modes = ['generated', 'voice_reference', 'preserve', 'recording', 'silent'];
const mediaTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
// The old compatibility list was not hashed. Only these actual old code paths
// may be separated from legacy business inputs; metadata cannot reclassify media.
const legacyImplementationPaths = new Set(['packages/replication-workflow/src/common.mjs', 'packages/replication-workflow/src/plan.mjs', 'packages/replication-workflow/src/policy.mjs', 'packages/replication-workflow/src/ledger.mjs', 'packages/replication-workflow/src/review.mjs', 'packages/replication-scenes/src/scene.mjs', 'packages/h3-replication-kits/src/prompt.mjs', 'hypit/packages/provider-minimax-official/src/provider.ts', 'hypit/packages/provider-minimax-official/src/activation.ts', 'hypit/packages/provider-minimax-official/src/route.ts'].map(f => join(projectRoot, f)));
export function validateTask(t) {
    check(t.format === 'replication.task@1', 'task.json 格式须为 replication.task@1');
    id(t.id);
    check(Number.isInteger(t.revision) && t.revision > 0, '须记录任务修订版本');
    check(t.brief && t.analysis?.reviewer && t.analysis?.file && t.analysis.regionsComplete === true && t.analysis.requirementsReviewed === true, '必须先观察原片、记录 Brief 和分析，再确认人物/商品出现区域及需求');
    check(t.audio && modes.includes(t.audio.mode), '须明确声音目标');
    check(Array.isArray(t.assets) && Array.isArray(t.requirements) && t.requirements.length > 0 && Array.isArray(t.segments) && t.segments.length > 0, '素材、要求和片段列表缺失');
    const assets = new Map();
    for (const a of t.assets) {
        id(a.id);
        check(!assets.has(a.id), '素材编号重复');
        check(['image', 'video', 'audio'].includes(a.kind) && a.file && a.subject && a.description && Array.isArray(a.purposes) && a.purposes.length > 0, '素材必须记录文件、种类、对象、说明和用途');
        assets.set(a.id, a);
    }
    const keys = new Map();
    const reqs = new Map();
    for (const r of t.requirements) {
        id(r.id);
        check(!reqs.has(r.id), '要求编号重复');
        check(kinds.includes(r.kind) && ['replace', 'preserve', 'change'].includes(r.operation) && r.subject && r.description && r.basis, '要求须有替换/保留目标、说明及用户原话依据');
        const key = `${r.kind}:${r.subject}:${r.attribute ?? 'default'}`;
        check(!keys.has(key) || keys.get(key) === r.operation, '同一对象属性同时要求保留与替换');
        keys.set(key, r.operation);
        reqs.set(r.id, r);
        for (const aid of r.referenceIds ?? [])
            check(assets.has(aid), `要求 ${r.id} 缺少必需素材 ${aid}`);
        if (['person', 'product'].includes(r.kind) && r.operation === 'replace') {
            const purpose = r.kind === 'product' ? 'product' : !r.attribute || ['face', 'identity', 'full', 'all'].includes(r.attribute) ? 'identity' : r.attribute;
            check((r.referenceIds ?? []).some(aid => assets.get(aid)?.kind === 'image' && assets.get(aid).purposes.includes(purpose)), `替换 ${r.kind} 缺少对应 ${purpose} 图片用途`);
        }
    }
    if (t.audio.mode === 'voice_reference')
        check(assets.get(t.audio.assetId)?.kind === 'audio' && assets.get(t.audio.assetId).purposes.includes('voice'), '指定音色缺少音色参考');
    if (['preserve', 'recording'].includes(t.audio.mode))
        check(['video', 'audio'].includes(assets.get(t.audio.assetId)?.kind), '保留/指定录音缺少声音源');
    if (t.audio.mode === 'silent')
        check(!t.requirements.some(r => ['voice', 'dialogue'].includes(r.kind)), '最终无声与声音/台词要求冲突');
    if (t.captions !== undefined)
        check(t.captions && ['model', 'local', 'none'].includes(t.captions.mode) && (t.captions.mode !== 'model' || typeof t.captions.description === 'string' && t.captions.description.trim()), '字幕须明确 model/local/none；模型字幕需准确内容和样式');
    for (const a of t.assets) if (a.sourceFrame !== undefined) {
        const frame = a.sourceFrame;
        check(a.kind === 'image' && assets.get(frame?.assetId)?.kind === 'video' && Number.isFinite(frame.time) && frame.time >= 0 && frame.reviewedBy && frame.compositionMatched === true, '分镜关键帧须对应真实视频时间，并确认构图、角度、姿势和持物关系');
    }
    const used = new Set();
    const segIds = new Set();
    for (const s of t.segments) {
        id(s.id);
        check(!segIds.has(s.id), '片段编号重复');
        segIds.add(s.id);
        check(['direct_edit', 'performance', 'reuse'].includes(s.strategy), '制作方案须为 direct_edit、performance 或 reuse');
        check(Number.isInteger(s.duration) && s.duration >= 4 && s.duration <= 15, '生成片段须为 4–15 秒整数；长片请先分段');
        check(s.direction && Array.isArray(s.referenceIds) && new Set(s.referenceIds).size === s.referenceIds.length && Array.isArray(s.requirementIds) && s.requirementIds.length > 0, '片段缺少方向、素材顺序或要求映射');
        const refs = s.referenceIds.map(aid => { check(assets.has(aid), `片段 ${s.id} 缺少素材 ${aid}`); return assets.get(aid); });
        const frames = Object.values(s.frames ?? {});
        check(!frames.length || (!refs.length && frames.every(aid => assets.get(aid)?.kind === 'image')), '首尾帧与参考图/视频/音频不能混用');
        check(!s.frames || Object.keys(s.frames).every(k => ['first', 'last'].includes(k)), '未知首尾帧字段');
        check(refs.filter(a => a.kind === 'image').length <= 9 && refs.filter(a => a.kind === 'video').length <= 3 && refs.filter(a => a.kind === 'audio').length <= 3 && refs.length <= 12, 'H3 参考素材数量超限');
        check(!refs.some(a => a.kind === 'audio') || refs.some(a => a.kind !== 'audio'), '音频参考必须伴随图片或视频');
        for (const rid of s.requirementIds) {
            const r = reqs.get(rid);
            check(r, `未知要求 ${rid}`);
            used.add(rid);
            check((r.referenceIds ?? []).every(aid => s.referenceIds.includes(aid) || frames.includes(aid)), `片段 ${s.id} 实际连接遗漏 ${r.id} 的必需参考`);
            if (r.exact && ['action', 'camera'].includes(r.kind)) {
                check(s.strategy !== 'performance', '新表演方案不能擅自替代要求严格保留的动作/运镜');
                check(s.strategy === 'reuse' || refs.some(a => a.kind === 'video' && a.purposes.includes('motion')), '严格动作/运镜缺少原片视频参考');
            }
        }
        if (s.shots !== undefined) {
            check(Array.isArray(s.shots) && s.shots.length > 0, '镜头表不能为空');
            const subjects = new Set(s.requirementIds.map(rid => reqs.get(rid).subject));
            const shotIds = new Set(); let end = 0;
            for (const shot of s.shots) {
                check(shot && typeof shot.id === 'string' && !shotIds.has(shot.id) && typeof shot.direction === 'string' && shot.direction.trim() && Number.isFinite(shot.start) && Number.isFinite(shot.end) && Math.abs(shot.start - end) < .001 && shot.end > shot.start && shot.end <= s.duration, '镜头表须按时间完整覆盖片段，不能重叠、留空或重复编号');
                check(Array.isArray(shot.subjects) && shot.subjects.every(subject => subjects.has(subject)) && Array.isArray(shot.referenceIds) && shot.referenceIds.every(aid => s.referenceIds.includes(aid) || frames.includes(aid)), '镜头对象或参考素材未连接到本片段');
                shotIds.add(shot.id); end = shot.end;
            }
            check(Math.abs(end - s.duration) < .001, '镜头表须覆盖片段结尾');
        }
        for (const a of refs) if (a.sourceFrame) check(s.referenceIds.includes(a.sourceFrame.assetId), '分镜关键帧对应的原片未实际连接到本片段');
        if (s.strategy === 'direct_edit')
            check(refs.some(a => a.kind === 'video' && a.purposes.includes('motion')), '直接编辑方案必须连接必要的原片动作片段');
        if (t.audio.mode === 'voice_reference' && s.strategy !== 'reuse')
            check(s.referenceIds.includes(t.audio.assetId), '指定音色未实际连接到当前片段');
        if (s.strategy === 'reuse')
            check(s.reuse?.manifest && s.reuse?.segmentId && s.reuse?.applicabilityReviewedBy && s.reuse?.basis, '复用须明确成功结果来源及当前需求的适用性复核');
        if (['generated', 'voice_reference'].includes(t.audio.mode) && t.requirements.some(r => s.requirementIds.includes(r.id) && r.kind === 'dialogue'))
            check(s.script, '台词必须有单一脚本文件');
    }
    check(t.requirements.every(r => used.has(r.id)), '整片仍有未安排处理的必需要求');
    check(Array.isArray(t.occurrences), '须记录所有人物/商品区域，空列表也须明确');
    for (const o of t.occurrences) {
        id(o.id);
        check(segIds.has(o.segmentId) && o.subject && ['full', 'pip', 'product'].includes(o.slot) && Number.isFinite(o.start) && Number.isFinite(o.end) && o.start >= 0 && o.end > o.start && o.end <= t.segments.find(s => s.id === o.segmentId).duration, '区域须明确所属片段和有效时间范围');
        check(o.source === 'generated', '复刻区域须使用本片段的新动态结果，不能沿用旧人物画面');
    }
    check(new Set(t.occurrences.map(o => o.id)).size === t.occurrences.length, '出现区域编号重复');
    for (const s of t.segments)
        for (const r of t.requirements.filter(r => s.requirementIds.includes(r.id) && ['person', 'product'].includes(r.kind)))
            check(t.occurrences.some(o => o.segmentId === s.id && o.subject === r.subject), `片段 ${s.id} 的人物/商品要求缺少出现区域记录`);
    const a = t.authorization;
    check(a && a.id && Number.isInteger(a.maxRequests) && a.maxRequests >= 0 && Number.isFinite(a.maxCostCny) && a.maxCostCny >= 0 && a.approvedBy && a.basis && a.approvedAt, '缺少次数、金额及授权依据');
    id(a.id);
    a.taskIds ??= [t.id];
    check(Array.isArray(a.taskIds) && a.taskIds.includes(t.id), '本授权范围没有包含当前任务');
    a.taskIds.forEach(id);
    if (a.expiresAt)
        check(Number.isFinite(Date.parse(a.expiresAt)) && Date.parse(a.expiresAt) > Date.now(), '授权已过期或日期无效');
    check(a.service === 'minimax.official' && a.model === 'MiniMax-H3', '授权仅可用于官方 MiniMax-H3；禁止自动切换收费服务');
    check(t.resolution === undefined || ['768P', '2K'].includes(t.resolution), '分辨率必须为 768P 或 2K');
    check(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'].includes(t.ratio), '须明确出片画幅');
    return t;
}
export async function inspectAsset(a, base) {
    const file = resolve(base, a.file);
    const bytes = await readFile(file);
    const extension = file.slice(file.lastIndexOf('.')).toLowerCase();
    const mediaType = mediaTypes[extension];
    check(mediaType?.startsWith(a.kind + '/'), '素材扩展名与声明种类不一致');
    const info = await probe(file);
    return { ...a, file, sha256: sha(bytes), size: bytes.length, mediaType, info };
}
function validateMedia(a) {
    const p = a.info;
    const ratio = p.width / p.height;
    if (a.kind === 'image')
        check(a.size <= 30000000 && Math.min(p.width, p.height) >= 256 && Math.max(p.width, p.height) <= 5760 && ratio >= .4 && ratio <= 2.5, '参考图片不符合 H3 尺寸或大小限制');
    if (a.kind === 'video')
        check(a.size <= 50000000 && p.duration >= 2 && p.duration <= 15.05 && Math.min(p.width, p.height) >= 256 && Math.max(p.width, p.height) <= 5760 && ratio >= .4 && ratio <= 2.5 && p.fps >= 23.9 && p.fps <= 60.1 && ['h264', 'hevc'].includes(p.videoCodec) && (!p.audioCodec || ['aac', 'mp3'].includes(p.audioCodec)), '参考视频不兼容或超过 15 秒；请先分段/转换');
    if (a.kind === 'audio')
        check(a.size <= 15000000 && p.hasAudio && p.duration >= 2 && p.duration <= 15.05, '音频参考须为 2–15 秒、≤15MB 的 WAV/MP3');
}
function cost(task, segment, refs) {
    const p = task.pricing;
    check(p?.checkedAt && p.source && p.model === 'MiniMax-H3' && p.resolution === (task.resolution ?? '768P') && Number.isFinite(p.outputCnyPerSecond) && p.outputCnyPerSecond >= 0 && Number.isFinite(p.videoCnyPerSecond) && p.videoCnyPerSecond >= 0 && Number.isFinite(p.extraImageCny) && p.extraImageCny >= 0, '缺少与本模型/分辨率匹配的已核对价格表');
    const videoSeconds = refs.filter(a => a.kind === 'video').reduce((n, a) => n + Math.ceil(a.info.duration), 0);
    const extra = Math.max(0, refs.filter(a => a.kind === 'image').length - 5);
    return Math.ceil((segment.duration * p.outputCnyPerSecond + videoSeconds * p.videoCnyPerSecond + extra * p.extraImageCny) * 100);
}
export function generationSource(task, seg, refs, prompt, base = dirname(seg.source)) {
    const imports = '<import as="media" from="@hypit/media@1"/><import as="text" from="@hypit/text@1"/><import as="h3" from="@hypit/minimax-h3@1"/>';
    const definitions = refs.map((a, i) => `<media:${a.kind[0].toUpperCase() + a.kind.slice(1)} id="ref-${i}" src="${xml(relative(base, a.file))}"/>`).join('\n');
    const frame = Object.keys(seg.frames ?? {}).length > 0;
    const tag = frame ? 'FrameVideo' : refs.length ? 'ReferenceVideo' : 'TextVideo';
    const children = frame ? '' : refs.map((a, i) => `<h3:Reference ${a.kind}={ref-${i}}/>`).join('\n');
    const frameAttrs = frame ? refs.map((a, i) => `${a.frameRole === 'first_frame' ? 'first' : 'last'}-frame={ref-${i}}`).join(' ') : `aspect-ratio="${task.ratio}"`;
    return `<?svml using="@hypit/markup@1"?>\n<svml>\n${imports}\n${definitions}\n<text:Value id="prompt">${xml(prompt)}</text:Value>\n<h3:${tag} id="replacement" prompt={prompt} duration="${seg.duration}" resolution="${task.resolution ?? '768P'}" ${frameAttrs}>${children}</h3:${tag}>\n</svml>\n`;
}
export async function prepare(taskPath, options = {}) {
    taskPath = resolve(taskPath);
    const base = dirname(taskPath);
    const t = validateTask(await readJson(taskPath));
    const inputs = [];
    const track = async (file) => { file = resolve(base, file); const sha256 = await hashFile(file); if (!inputs.some(i => i.file === file))
        inputs.push({ file, sha256 }); return file; };
    await track(taskPath);
    await track(t.brief);
    await track(t.analysis.file);
    const implementationFiles = ['packages/replication-workflow/src/common.mjs', 'packages/replication-workflow/src/plan.mjs', 'packages/replication-workflow/src/policy.mjs', 'packages/replication-workflow/src/ledger.mjs', 'packages/replication-workflow/src/review.mjs', 'packages/replication-workflow/src/cli.mjs', 'packages/replication-workflow/src/media.mjs', 'packages/replication-scenes/src/scene.mjs', 'packages/h3-replication-kits/src/prompt.mjs', 'hypit/packages/provider-minimax-official/src/provider.ts', 'hypit/packages/provider-minimax-official/src/activation.ts', 'hypit/packages/provider-minimax-official/src/route.ts', 'hypit/packages/provider-minimax-official/src/assets.ts', 'hypit/packages/provider-minimax-official/src/media.ts'];
    const implementation = await Promise.all(implementationFiles.map(async f => ({ file: join(projectRoot, f), sha256: await hashFile(join(projectRoot, f)) })));
    const assets = [];
    for (const a of t.assets) {
        const inspected = await inspectAsset(a, base);
        assets.push(inspected);
        await track(inspected.file);
    }
    const byId = new Map(assets.map(a => [a.id, a]));
    for (const a of assets) if (a.sourceFrame) check(a.sourceFrame.time < byId.get(a.sourceFrame.assetId).info.duration, '分镜关键帧时间超出真实原片');
    const segments = [];
    const warnings = [];
    for (const s of t.segments) {
        const refs = Object.keys(s.frames ?? {}).length ? ['first', 'last'].filter(k => s.frames[k]).map(k => ({ ...byId.get(s.frames[k]), frameRole: k + '_frame' })) : ['image', 'video', 'audio'].flatMap(kind => s.referenceIds.map(aid => byId.get(aid)).filter(a => a.kind === kind));
        refs.forEach(validateMedia);
        for (const kind of ['video', 'audio'])
            check(refs.filter(a => a.kind === kind).reduce((n, a) => n + a.info.duration, 0) <= 15.02, `${kind} 参考总时长超过 15 秒`);
        if (['preserve', 'recording'].includes(t.audio.mode))
            check(byId.get(t.audio.assetId).info.hasAudio, '选择的原录音实际没有音轨');
        let script = '';
        if (s.script) {
            script = (await readFile(await track(s.script), 'utf8')).trim();
            check(script, '台词脚本为空');
        }
        if (script.replace(/\s/g, '').length / s.duration > 5)
            warnings.push(`${s.id}: 台词语速偏高，须复核；代码不会删词，也不保证口型`);
        if (s.strategy === 'direct_edit' && t.requirements.some(r => s.requirementIds.includes(r.id) && r.kind === 'person' && r.operation === 'replace' && (!r.attribute || ['face','identity','full','all'].includes(r.attribute)))) {
            warnings.push(`${s.id}: 参考视频生成不提供身份硬锁；必须验收动态人脸，原人物可能继续影响生成`);
            if (!s.shots) warnings.push(`${s.id}: 未提供 shots 镜头表，请明确每个镜头的主体、动作和参考对应关系`);
            if (!refs.some(a => a.sourceFrame)) warnings.push(`${s.id}: 未提供已核对的 sourceFrame 分镜图；需要时以原片关键帧编辑目标人物/物品，核对构图和持物关系`);
        }
        const prompt = buildPrompt(t, s, refs, script);
        check(prompt.length <= 7000, '提示词超过 7000 字，请重写要求表达，不得删掉用户要求');
        const summary = { model: 'MiniMax-H3', content: [{ type: 'text', text: prompt }, ...refs.map(a => ({ type: a.kind + '_url', role: a.frameRole ?? 'reference_' + a.kind, sha256: a.sha256, size: a.size, mediaType: a.mediaType }))], duration: s.duration, resolution: t.resolution ?? '768P', ratio: Object.keys(s.frames ?? {}).length ? 'adaptive' : t.ratio };
        segments.push({ ...s, references: refs, prompt, script, summary, requestHash: digest(summary), costCents: s.strategy === 'reuse' ? 0 : cost(t, s, refs) });
    }
    const totalCostCents = segments.reduce((n, s) => n + s.costCents, 0);
    const requestCount = segments.filter(s => s.strategy !== 'reuse').length;
    if (['preserve', 'recording'].includes(t.audio.mode))
        check(byId.get(t.audio.assetId).info.duration + .1 >= segments.reduce((n, s) => n + s.duration, 0), '原声/指定录音不够覆盖整片，须明确每段声音和时间安排');
    check(requestCount <= t.authorization.maxRequests && totalCostCents <= Math.floor(t.authorization.maxCostCny * 100), '计划总次数或保守费用超出授权');
    const planHash = digest({ task: t, inputs, segments, implementation });
    const out = join(base, '.replication', planHash);
    await mkdir(out, { recursive: true, mode: 0o700 });
    const root = resolve(options.ledgerRoot ?? ledgerRoot);
    await registerGrant(root, t.authorization);
    let previous;
    try {
        previous = await currentPlan(taskPath);
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw e;
    }
    if (previous && previous.planHash !== planHash) {
        const ledger = await readLedger(root);
        check(!previous.segments.some(s => ledger.intents[s.intentId]) || t.revision > previous.task.revision, '已提交的任务版本发生变化；须明确增加 revision 并核对新调用授权，不能无声重投');
    }
    const plan = { format: 'replication.plan@1', taskPath, task: t, planHash, inputs, implementation, segments, requestCount, totalCostCents, warnings, ledgerRoot: root, preparedAt: new Date().toISOString(), status: 'ready' };
    // Source distributions keep provenance in a manifest; do not require private Git history.
    const distribution = await readJson(join(projectRoot, 'DISTRIBUTION.json'));
    for (const field of ['workspaceCommit', 'hypitCommit', 'upstreamCommit'])
        check(/^[a-f0-9]{40}$/u.test(distribution[field]), '安装包版本来源记录无效');
    plan.compatibility = { workflowVersion: distribution.workflowVersion ?? '0.1.1', workspaceCommit: distribution.workspaceCommit, hypitCommit: distribution.hypitCommit, upstreamCommit: distribution.upstreamCommit, sourceDistribution: true, implementationFiles: implementation };
    const template = options.runtimeTemplate ?? await readJson(join(projectRoot, 'hypit', 'hypit.runtime.cangyuan.json'));
    plan.files = [];
    for (const s of segments) {
        s.intentId = digest({ taskId: t.id, revision: t.revision, segmentId: s.id, planHash });
        s.source = join(out, s.id + '.svml');
        s.run = join(out, s.id + '.svrun');
        s.runtime = join(out, s.id + '.runtime.json');
        if (s.strategy === 'reuse')
            continue;
        await writeFile(s.source, generationSource(t, s, s.references, s.prompt), { mode: 0o600 });
        await writeFile(s.run, `<?svml using="@hypit/run-markup@1"?>\n<svrun version="1"><author source="./${s.id}.svml"/><target output="replacement.video"/></svrun>\n`, { mode: 0o600 });
        const official = structuredClone(template.endpoints['minimax.official']);
        Object.assign(official.config, { submissionPolicyModule: join(projectRoot, 'packages/replication-workflow/src/policy.mjs'), submissionPlan: join(out, 'plan.json'), submissionLedgerRoot: root });
        const profile = { format: template.format, dataRoot: join(projectRoot, '.hypit', 'runtimes', 'replication', planHash, s.id), credentials: template.credentials, endpoints: { 'minimax.official': official, 'media.local': template.endpoints['media.local'], 'hyperframes.local': template.endpoints['hyperframes.local'] }, bindings: { '@hypit/minimax-h3@1#minimax-h3': 'minimax.official' } };
        await atomicJson(s.runtime, profile);
        for (const file of [s.source, s.run, s.runtime])
            plan.files.push({ file, sha256: await hashFile(file) });
    }
    plan.manifest = join(out, 'plan.json');
    await atomicJson(plan.manifest, plan);
    await atomicJson(join(base, '.replication', 'current.json'), { manifest: plan.manifest, planHash });
    return plan;
}
export async function currentPlan(taskPath) { return readJson((await readJson(join(dirname(resolve(taskPath)), '.replication', 'current.json'))).manifest); }
export async function assertUnchanged(plan, { purpose = 'execution' } = {}) {
    check(['execution', 'artifact'].includes(purpose), '未知计划核对用途');
    const implementation = plan.implementation ?? plan.inputs.filter(i => legacyImplementationPaths.has(i.file));
    const hashContent = { task: plan.task, inputs: plan.inputs, segments: plan.segments.map(({ intentId, source, run, runtime, ...s }) => s), ...(plan.implementation ? { implementation: plan.implementation } : {}) };
    check(plan.planHash === digest(hashContent), '执行计划内容已变化');
    if (plan.implementation)
        check(digest(plan.implementation) === digest(plan.compatibility?.implementationFiles), '实现版本记录已变化');
    // Legacy plan@1 mixed code fingerprints into inputs; do not rewrite its history.
    const businessInputs = plan.inputs.filter(i => !implementation.some(c => c.file === i.file && c.sha256 === i.sha256));
    for (const item of [...businessInputs, ...plan.files])
        check(await hashFile(item.file) === item.sha256, '计划后任务、脚本、素材、Run 或配置已变化；须重新 prepare 并复核');
    if (purpose === 'execution')
        for (const item of implementation)
            check(await hashFile(item.file) === item.sha256, '执行实现代码已变化；新增付费请求须重新 prepare/check 并复核授权');
}
