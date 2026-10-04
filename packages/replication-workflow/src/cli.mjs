import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { prepare, currentPlan, assertUnchanged, projectRoot, ledgerRoot } from './plan.mjs';
import { readJson, atomicJson, run, hashFile, requireThat as check, probe } from './common.mjs';
import { readLedger, recoverLock, transaction, occupiedCents } from './ledger.mjs';
import { registerOutput, recordReview, reviewStatus, outputs, adoptReuse, criteria, recordCompletedBuild } from './review.mjs';
import { splitVideo } from './media.mjs';
import { compose } from '../../replication-scenes/src/scene.mjs';
export async function hypit(args) {
    let stdout;
    try {
        ({ stdout } = await run(join(projectRoot, '.toolchain/node-v24.14.1/bin/node'), [join(projectRoot, 'hypit/bin/hypit.mjs'), ...args, '--json'], { cwd: projectRoot, timeout: 3600000, maxBuffer: 16 * 1024 * 1024 }));
    }
    catch (error) {
        if (error.stdout?.trim().startsWith('{'))
            stdout = error.stdout;
        else
            throw error;
    }
    const result = JSON.parse(stdout);
    check(result.ok !== false, result.error?.message ?? 'Hypit 检查/执行未通过');
    return result;
}
export async function checkPlan(plan, options = {}) {
    await assertUnchanged(plan, options);
    const results = [];
    for (const s of plan.segments.filter(s => s.strategy !== 'reuse')) {
        await hypit(['check', s.run]);
        const result = await hypit(['plan', s.run, '--runtime', s.runtime]);
        check(result.format === 'hypit.cli-plan@1' && result.ok && result.providerRequestCount === 1 && result.unresolvedRequestCount === 0 && result.unsupportedRequestCount === 0, 'Hypit 计划格式或生成任务数不符合契约');
        check(result.providers?.length === 1 && result.providers[0].endpoint === 'minimax.official' && result.providers[0].capability === '@hypit/minimax-h3@1#minimax-h3', '生成请求没有绑定唯一官方 H3');
        check(result.needs?.[0]?.summary?.fields?.duration === s.duration, 'Hypit 片段时长与任务不一致');
        results.push({ segmentId: s.id, requestCount: 1, endpoint: 'minimax.official', ok: true });
    }
    return { ok: true, paidRequestsCreated: 0, plannedRequests: plan.requestCount, estimatedMaxCny: plan.totalCostCents / 100, warnings: plan.warnings, segments: results };
}
async function main(args) {
    const [command, file, ...extra] = args;
    if (!command || command === 'help') {
        console.log('replicate: prepare/check/build/bind-build/task-status/export-model/export-final/review/review-template/adopt-reuse/compose/render/studio/fetch/split/reconcile/record-cost/recover-lock\n详见 docs/复刻优化使用说明.md；prepare/check 不创建付费任务。');
        return;
    }
    if (command === 'recover-lock') {
        await recoverLock(ledgerRoot, { legacyWorkersStopped: args.includes('--legacy-workers-stopped') });
        console.log('锁已恢复；未知提交仍占用授权，未重投');
        return;
    }
    check(file, '缺少 task.json 或媒体文件');
    if (command === 'split') {
        check(extra[0], '缺少新的分段目录');
        console.log(JSON.stringify(await splitVideo(file, extra[0]), null, 2));
        return;
    }
    if (command === 'fetch') {
        check(extra[0], '缺少媒体保存路径');
        await hypit(['media', 'fetch', file, '--to', resolve(extra[0])]);
        const info = await probe(resolve(extra[0]));
        check(info.videoCodec, '下载结果不是实际视频');
        console.log(JSON.stringify({ file: resolve(extra[0]), info, sha256: await hashFile(resolve(extra[0])) }));
        return;
    }
    if (command === 'prepare') {
        const p = await prepare(file);
        console.log(JSON.stringify({ manifest: p.manifest, planHash: p.planHash, requests: p.requestCount, estimatedMaxCny: p.totalCostCents / 100, warnings: p.warnings }, null, 2));
        return;
    }
    const plan = await currentPlan(file);
    if (command === 'check') {
        console.log(JSON.stringify(await checkPlan(plan), null, 2));
        return;
    }
    if (command === 'build') {
        check(extra.includes('--submit'), 'build 会收费，必须明确使用 --submit，并已有 task.json 中的授权');
        await checkPlan(plan, { purpose: 'artifact' });
        const selection = extra.find(x => x !== '--submit');
        const segments = plan.segments.filter(s => !selection || s.id === selection);
        check(segments.length, '未知片段');
        const result = [];
        console.log(`官方 MiniMax-H3；计划 ${plan.requestCount} 次；保守估计 ${plan.totalCostCents / 100} 元；按已有授权执行。未自动追加配音或重试。`);
        for (const s of segments) {
            if (s.strategy === 'reuse') {
                await adoptReuse(plan, s.id);
                continue;
            }
            const built = await hypit(['build', s.run, '--runtime', s.runtime, '--follow']);
            await atomicJson(join(dirname(plan.manifest), s.id + '.last-build.json'), { planHash: plan.planHash, result: built });
            await recordCompletedBuild(plan, 'model', s.id, built);
            result.push({ segmentId: s.id, result: built });
        }
        console.log(JSON.stringify(result, null, 2));
        return;
    }
    if (['export-model', 'export-final'].includes(command)) {
        const model = command === 'export-model';
        const segmentId = model ? extra[0] : undefined;
        const buildId = model ? extra[1] : extra[0];
        check(buildId, '缺少准确 Build 编号');
        const dir = join(dirname(plan.manifest), 'exports');
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const destination = join(dir, `${model ? segmentId : 'final'}-${Date.now()}.mp4`);
        await hypit(['get', buildId, '--output', model ? 'replacement.video' : 'final.video', '--to', destination]);
        console.log(JSON.stringify(await registerOutput(plan, { kind: model ? 'model' : 'final', segmentId, file: destination, buildId }), null, 2));
        return;
    }
    if (command === 'bind-build') {
        await assertUnchanged(plan, { purpose: 'artifact' });
        const s = plan.segments.find(s => s.id === extra[0]);
        const buildId = extra[1];
        check(s && buildId, '缺少片段及原 Build 编号');
        const inspected = await hypit(['inspect', buildId, '--verbose']);
        const b = inspected.build;
        const item = (await readLedger(plan.ledgerRoot)).intents[s.intentId];
        check(b?.id === buildId && b.outcome === 'complete' && resolve(projectRoot, b.source) === s.source && b.targets?.includes('replacement.video') && b.operations?.some(o => o.endpoint === 'minimax.official' && o.receipt?.id === item?.handle?.taskId), '原 Build 未完成，或其来源/官方回执不对应当前计划');
        await recordCompletedBuild(plan, 'model', s.id, { format: 'hypit.cli-build@1', build: { id: b.id, work: { state: 'done', outcome: 'complete' }, result: { state: 'complete', outputCount: b.outputCount } } });
        console.log('已核对并登记原模型 Build；没有新增请求。');
        return;
    }
    if (command === 'adopt-reuse') {
        console.log(JSON.stringify(await adoptReuse(plan, extra[0]), null, 2));
        return;
    }
    if (command === 'review') {
        check(extra[0], '缺少审阅 JSON');
        console.log(JSON.stringify(await recordReview(plan, await readJson(resolve(extra[0]))), null, 2));
        return;
    }
    if (command === 'review-template') {
        const kind = extra[0] ?? 'final';
        const segmentId = extra[1];
        const registry = await outputs(plan);
        const a = kind === 'model' ? registry.model[segmentId] : registry.final;
        check(a, '先导出并登记对应结果');
        console.log(JSON.stringify({ kind, segmentId, observedHash: a.sha256, checks: criteria(plan, kind, segmentId, a).map(key => ({ key, verdict: 'unverified', reviewer: '', method: '', note: '', coverage: { start: 0, end: a.info.duration }, evidence: [{ file: a.file, sha256: a.sha256 }] })) }, null, 2));
        return;
    }
    if (command === 'compose') {
        check(extra[0], '缺少布局 JSON');
        console.log(JSON.stringify(await compose(plan, await readJson(resolve(extra[0]))), null, 2));
        return;
    }
    if (['render', 'studio'].includes(command)) {
        await assertUnchanged(plan, { purpose: 'artifact' });
        const compositionPath = join(dirname(plan.manifest), 'composition.json');
        const c = await readJson(compositionPath);
        for (const i of c.inputs) {
            const hash = await hashFile(i.file);
            if (hash !== i.sha256) {
                check(i.file.startsWith(dirname(c.run) + '/') && /review\.(svml|svs|svrun)$/.test(i.file), '模型/录音/字体/Runtime 等剪辑输入变化，请重新核对 compose');
                i.sha256 = hash;
            }
        }
        const p = await hypit(['plan', c.run, '--runtime', c.runtime]);
        check(p.providers?.every(r => ['media.local', 'hyperframes.local'].includes(r.endpoint)), '审阅/剪辑出现收费 Provider，停止');
        await atomicJson(compositionPath, c);
        if (command === 'render') {
            const result = await hypit(['build', c.run, '--runtime', c.runtime, '--follow']);
            await recordCompletedBuild(plan, 'final', undefined, result);
            console.log(JSON.stringify(result, null, 2));
        }
        else {
            const port = extra[0] ?? '5185';
            check(/^\d+$/.test(port), 'Studio 端口无效');
            const { spawn } = await import('node:child_process');
            const processChild = spawn(join(projectRoot, 'bin/hypit'), ['studio', '--run', c.run, '--runtime', c.runtime, '--port', port], { cwd: projectRoot, stdio: 'inherit' });
            await new Promise((yes, no) => { processChild.on('error', no); processChild.on('exit', code => code === 0 ? yes() : no(new Error('Studio 退出'))); });
        }
        return;
    }
    if (command === 'reconcile') {
        await assertUnchanged(plan, { purpose: 'artifact' });
        check(extra[0], '缺少已人工核对的官方回执文件');
        const receiptPath = resolve(extra[0]);
        const receipt = await readJson(receiptPath);
        check(receipt.officialTaskId && receipt.segmentId && receipt.verifiedBy && receipt.basis, '回执须明确官方任务号、片段、核对人及依据');
        const s = plan.segments.find(s => s.id === receipt.segmentId);
        check(s, '未知片段');
        const evidenceHash = await hashFile(receiptPath);
        await transaction(plan.ledgerRoot, l => {
            const item = l.intents[s.intentId];
            check(item && ['submission_in_progress', 'submission_unknown'].includes(item.state) && !item.handle?.taskId, '只允许恢复无回执的已有预留，不覆盖已知官方任务');
            item.handle = { contract: 'hypit.minimax-official-h3@1', taskId: String(receipt.officialTaskId), startedAt: Date.now(), uploadedKeys: item.uploadedKeys, intentId: s.intentId };
            item.state = 'submitted';
            item.reconciliation = { file: receiptPath, sha256: evidenceHash, verifiedBy: receipt.verifiedBy, basis: receipt.basis };
        });
        console.log('已关联人工核对的原任务；下次 build 只恢复查询，不新增 POST');
        return;
    }
    if (command === 'record-cost') {
        check(extra[0], '缺少已核对的费用记录');
        const costPath = resolve(extra[0]);
        const cost = await readJson(costPath);
        check(cost.officialTaskId && Number.isFinite(cost.actualCny) && cost.actualCny >= 0 && cost.verifiedBy && cost.basis && cost.evidence?.file && cost.evidence.sha256, '费用记录须有官方任务号、实际金额、核对人、依据和账单证据指纹');
        const evidence = resolve(dirname(costPath), cost.evidence.file);
        check(await hashFile(evidence) === cost.evidence.sha256, '账单证据文件已改变');
        const recordSha256 = await hashFile(costPath);
        await transaction(plan.ledgerRoot, l => { const item = Object.values(l.intents).find(i => i.planHash === plan.planHash && i.handle?.taskId === cost.officialTaskId); check(item, '账单未对应本计划官方任务'); item.actualCost = cost.actualCny; item.actualCostSource = { ...cost.evidence, file: evidence, verifiedBy: cost.verifiedBy, basis: cost.basis, recordSha256 }; });
        console.log('已关联人工核对的实际费用；额度按原预留和已核实实付中的较大值占用。');
        return;
    }
    if (command === 'task-status') {
        const ledger = await readLedger(plan.ledgerRoot);
        const items = Object.values(ledger.intents).filter(i => i.grantId === plan.task.authorization.id);
        console.log(JSON.stringify({ planHash: plan.planHash, final: await reviewStatus(plan), segments: await Promise.all(plan.segments.map(async (s) => ({ id: s.id, execution: ledger.intents[s.intentId]?.state ?? 'ready', officialTaskId: ledger.intents[s.intentId]?.handle?.taskId ?? null, actualCost: ledger.intents[s.intentId]?.actualCost ?? null, review: await reviewStatus(plan, 'model', s.id) }))), reservedRequests: items.length, reservedCny: items.reduce((n, i) => n + i.costCents, 0) / 100, occupiedCny: items.reduce((n, i) => n + occupiedCents(i), 0) / 100, billedCny: items.some(i => i.actualCost == null) ? null : items.reduce((n, i) => n + i.actualCost, 0), unlinkedBills: items.filter(i => i.actualCost == null).length }, null, 2));
        return;
    }
    throw new Error('未知命令，请使用 help');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
