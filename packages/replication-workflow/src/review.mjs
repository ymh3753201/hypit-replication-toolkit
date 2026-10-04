import { dirname, join, resolve } from 'node:path';
import { readJson, atomicJson, hashFile, probe, digest, requireThat as check } from './common.mjs';
import { assertUnchanged } from './plan.mjs';
import { readLedger, transaction } from './ledger.mjs';
const registryPath = plan => join(dirname(plan.manifest), 'outputs.json');
export async function outputs(plan) { try {
    return await readJson(registryPath(plan));
}
catch (e) {
    if (e.code === 'ENOENT')
        return { format: 'replication.outputs@1', model: {}, final: null };
    throw e;
} }
export function criteria(plan, kind, segmentId, artifact) {
    let requirements = kind === 'model' ? plan.task.requirements.filter(r => plan.segments.find(s => s.id === segmentId).requirementIds.includes(r.id)) : plan.task.requirements;
    if (kind === 'model' && ['preserve', 'recording'].includes(plan.task.audio.mode))
        requirements = requirements.filter(r => !['voice', 'dialogue'].includes(r.kind));
    const keys = requirements.map(r => 'requirement:' + r.id);
    if (kind === 'model' && artifact && Math.abs(artifact.info.duration - plan.segments.find(s => s.id === segmentId).duration) > .3) keys.push('timing');
    if (['generated', 'voice_reference'].includes(plan.task.audio.mode) || kind === 'final' && requirements.some(r => r.kind === 'voice'))
        keys.push('voice');
    if (requirements.some(r => r.kind === 'dialogue'))
        keys.push('dialogue', 'lipsync');
    // Retained/provided recordings are heard only in the final composition, so
    // their lip-sync evidence must be recorded against that exact final file.
    if (plan.task.audio.lipsyncRequired && (kind === 'final' || ['generated', 'voice_reference'].includes(plan.task.audio.mode)))
        keys.push('lipsync');
    if (kind === 'final') {
        keys.push(...plan.task.occurrences.map(o => 'region:' + o.id));
        if (plan.task.audio.mode !== 'silent')
            keys.push('final_mix');
    }
    return [...new Set(keys)];
}
export function completeBuild(result) {
    check(result.format === 'hypit.cli-build@1' && result.build?.id && result.build.result?.state === 'complete' && result.build.work?.outcome === 'complete', 'Build 尚未完成或已失败；保留编号，停止后续片段，不自动重试');
    return result.build.id;
}
export async function recordCompletedBuild(plan, kind, segmentId, result) {
    await assertUnchanged(plan, { purpose: 'artifact' });
    const buildId = completeBuild(result);
    if (kind === 'model') {
        check(plan.segments.some(s => s.id === segmentId), '未知片段');
        await atomicJson(join(dirname(plan.manifest), segmentId + '.build.json'), { planHash: plan.planHash, result });
    }
    else {
        const path = join(dirname(plan.manifest), 'composition.json');
        const c = await readJson(path);
        for (const input of c.inputs)
            check(await hashFile(input.file) === input.sha256, '渲染期间剪辑输入改变，不能绑定成片');
        c.render = { buildId, inputHash: digest(c.inputs), result };
        await atomicJson(path, c);
    }
    return buildId;
}
export async function registerOutput(plan, { kind, segmentId, file, buildId }) {
    await assertUnchanged(plan, { purpose: 'artifact' });
    check(['model', 'final'].includes(kind) && buildId, '须记录 model/final 及准确 Build 编号');
    file = resolve(file);
    const sha256 = await hashFile(file);
    const info = await probe(file);
    const registry = await outputs(plan);
    if (kind === 'model') {
        const s = plan.segments.find(s => s.id === segmentId);
        check(s, '未知片段');
        const item = (await readLedger(plan.ledgerRoot)).intents[s.intentId];
        const receipt = await readJson(join(dirname(plan.manifest), segmentId + '.build.json'));
        check(receipt.planHash === plan.planHash && completeBuild(receipt.result) === buildId, '模型 Build 编号未绑定当前计划');
        check(item?.handle?.taskId && item.output?.sha256 === sha256 && item.state === 'generated_unreviewed', '模型文件未匹配本次官方任务的真实下载指纹，不能用原片/截图顶替');
        check(info.videoCodec && Math.abs(info.duration - s.duration) <= .5, '模型文件时长/画面不符合计划');
        if (['generated', 'voice_reference'].includes(plan.task.audio.mode))
            check(info.hasAudio, '原始模型文件确实无音轨；停止验收，不默认追加付费配音');
        registry.model[segmentId] = { kind, file, sha256, info, buildId, officialTaskId: item.handle.taskId, planHash: plan.planHash, checks: {}, technical: true, timing: { requested: s.duration, actual: info.duration, delta: info.duration - s.duration, requiresReview: Math.abs(info.duration - s.duration) > .3 } };
    }
    else {
        const composition = await readJson(join(dirname(plan.manifest), 'composition.json'));
        check(composition.render?.buildId === buildId && composition.render.inputHash === digest(composition.inputs), '成片 Build 编号未绑定这次剪辑版本；先 render 再导出其准确编号');
        check(completeBuild(composition.render.result) === buildId, '成片 Build 未完成');
        for (const input of composition.inputs)
            check(await hashFile(input.file) === input.sha256, '剪辑来源/布局已改变，应重新生成并注册准确成片');
        check(info.videoCodec && Math.abs(info.duration - plan.segments.reduce((n, s) => n + s.duration, 0)) <= .3, '成片时长或画面不符合计划');
        const shouldHaveAudio = plan.task.audio.mode !== 'silent';
        check(info.hasAudio === shouldHaveAudio, '成片音轨与声音目标不一致；先核对本地剪辑，不能推断模型无声');
        registry.final = { kind, file, sha256, info, buildId, planHash: plan.planHash, checks: {}, technical: true, compositionInputs: composition.inputs };
    }
    await atomicJson(registryPath(plan), registry);
    return kind === 'model' ? registry.model[segmentId] : registry.final;
}
async function artifactFresh(plan, artifact) {
    try {
        if (!artifact || artifact.planHash !== plan.planHash || await hashFile(artifact.file) !== artifact.sha256)
            return false;
        for (const input of artifact.compositionInputs ?? [])
            if (await hashFile(input.file) !== input.sha256)
                return false;
        return true;
    }
    catch {
        return false;
    }
}
function checkCoverage(entry, expectedStart, expectedEnd, duration, passMessage) {
    const c = entry.coverage;
    check(c && Number.isFinite(c.start) && Number.isFinite(c.end) && c.start >= 0 && c.end > c.start && c.end <= duration + .05, '审阅须记录结果内真实、非空的时间范围');
    if (entry.verdict === 'pass')
        check(c.start <= expectedStart && c.end >= expectedEnd, passMessage);
    else
        check(c.start < expectedEnd && c.end > expectedStart, '失败观察必须与该要求的必需区域重叠');
}
export async function recordReview(plan, review) {
    await assertUnchanged(plan, { purpose: 'artifact' });
    const registry = await outputs(plan);
    const target = review.kind === 'model' ? registry.model[review.segmentId] : registry.final;
    check(await artifactFresh(plan, target) && review.observedHash === target.sha256, '审阅对应的成片版本已改变，旧证据不能验收新文件');
    const needed = criteria(plan, review.kind, review.segmentId, target);
    for (const entry of review.checks ?? []) {
        check(needed.includes(entry.key) && ['pass', 'fail', 'unverified'].includes(entry.verdict) && entry.reviewer && entry.note, '审阅项须明确 pass/fail/unverified、审阅人和观察结论');
        if (entry.verdict !== 'unverified') {
            check(Array.isArray(entry.evidence) && entry.evidence.length > 0, '通过/失败结论必须附实际证据文件');
            if (['voice', 'dialogue', 'final_mix'].includes(entry.key))
                check(entry.method === 'listening', '声音、台词和混音需要真实听音记录，不能以音轨存在或转写代替');
            if (entry.key === 'timing') {
                const method = plan.task.audio.mode === 'silent' ? 'visual' : 'audiovisual';
                check(entry.method === method, method === 'audiovisual' ? '时长偏差必须同时看画面并听声音' : '时长偏差需要真实画面审阅');
                checkCoverage(entry, 0, target.info.duration, target.info.duration, '时长偏差须覆盖完整结果和将被裁掉的尾部');
                if (entry.verdict === 'pass') check(target.info.duration >= plan.segments.find(s => s.id === review.segmentId).duration, '模型原件偏短，不能以审阅通过授权补帧；须调整剪辑计划');
            }
            if (entry.key === 'lipsync')
                check(entry.method === 'audiovisual', '口型必须同时看画面并听声音');
            const requirement = plan.task.requirements.find(r => 'requirement:' + r.id === entry.key);
            if (['voice', 'dialogue'].includes(requirement?.kind))
                check(entry.method === 'listening', '声音和台词要求需要真实听音记录');
            if (['voice', 'dialogue', 'final_mix', 'lipsync'].includes(entry.key) || ['voice', 'dialogue'].includes(requirement?.kind))
                checkCoverage(entry, 0, target.info.duration, target.info.duration, '声音、台词和口型须覆盖完整结果，不能只听开头');
            if (['person', 'product', 'action', 'camera', 'scene', 'style'].includes(requirement?.kind) || entry.key.startsWith('region:')) {
                check(['visual', 'audiovisual'].includes(entry.method), '人物、商品、画面区域需要真实画面审阅');
                const region = plan.task.occurrences.find(o => 'region:' + o.id === entry.key);
                const segmentOffset = region ? plan.segments.slice(0, plan.segments.findIndex(s => s.id === region.segmentId)).reduce((n, s) => n + s.duration, 0) : 0;
                const expectedStart = region ? segmentOffset + region.start : 0;
                const expectedEnd = region ? segmentOffset + region.end : target.info.duration;
                checkCoverage(entry, expectedStart, expectedEnd, target.info.duration, '局部观察不能替代整个必需区域的验收');
            }
            entry.evidence = await Promise.all(entry.evidence.map(async (e) => { check(e.file && e.sha256, '证据须显式记录审阅时的文件指纹'); const file = resolve(e.file); check(await hashFile(file) === e.sha256, '证据文件发生变化'); return { ...e, file }; }));
        }
        target.checks[entry.key] = { ...entry, artifactHash: target.sha256, recordedAt: new Date().toISOString() };
    }
    await atomicJson(registryPath(plan), registry);
    return reviewStatus(plan, review.kind, review.segmentId);
}
export async function reviewStatus(plan, kind = 'final', segmentId) {
    try {
        await assertUnchanged(plan, { purpose: 'artifact' });
    }
    catch {
        return { state: 'blocked', reason: '需求/素材/计划版本变化' };
    }
    const registry = await outputs(plan);
    const artifact = kind === 'model' ? registry.model[segmentId] : registry.final;
    if (!artifact)
        return { state: kind === 'model' ? 'generated_unreviewed' : 'awaiting_review', missing: criteria(plan, kind, segmentId) };
    if (!await artifactFresh(plan, artifact))
        return { state: 'awaiting_review', reason: '输出或剪辑来源变化，证据已过期' };
    if (kind === 'final')
        for (const s of plan.segments) {
            const source = await reviewStatus(plan, 'model', s.id);
            if (source.state !== 'accepted')
                return { state: source.state === 'quality_failed' ? 'quality_failed' : 'awaiting_review', reason: `源片段 ${s.id} 的验收未通过或已过期` };
        }
    const required = criteria(plan, kind, segmentId, artifact);
    const missing = [];
    let failed = false;
    for (const key of required) {
        const result = artifact.checks[key];
        let fresh = result?.artifactHash === artifact.sha256;
        for (const e of result?.evidence ?? []) {
            try {
                fresh = fresh && await hashFile(e.file) === e.sha256;
            }
            catch {
                fresh = false;
            }
        }
        if (!fresh || !result || result.verdict === 'unverified')
            missing.push(key);
        else if (result.verdict === 'fail')
            failed = true;
    }
    return { state: failed ? 'quality_failed' : missing.length ? 'awaiting_review' : 'accepted', missing, sha256: artifact.sha256, info: artifact.info };
}
export async function adoptReuse(plan, segmentId) {
    await assertUnchanged(plan, { purpose: 'artifact' });
    const s = plan.segments.find(s => s.id === segmentId);
    check(s?.strategy === 'reuse', '片段未声明复用');
    const source = await readJson(resolve(dirname(plan.taskPath), s.reuse.manifest));
    check((await reviewStatus(source, 'model', s.reuse.segmentId)).state === 'accepted', '复用源表演未通过或其证据已失效');
    const model = (await outputs(source)).model[s.reuse.segmentId];
    check(Math.abs(model.info.duration - s.duration) <= .3, '复用素材时长不匹配');
    const registry = await outputs(plan);
    registry.model[s.id] = { ...model, planHash: plan.planHash, checks: {}, reusedFrom: { manifest: source.manifest, segmentId: s.reuse.segmentId, taskId: model.officialTaskId, applicabilityReviewedBy: s.reuse.applicabilityReviewedBy, basis: s.reuse.basis } };
    // Source acceptance does not automatically accept different target requirements.
    await atomicJson(registryPath(plan), registry);
    return registry.model[s.id];
}
