import { resolve } from 'node:path';
import { readJson, requireThat as check, requestSummary, digest } from './common.mjs';
import { assertUnchanged } from './plan.mjs';
import { transaction, occupiedCents } from './ledger.mjs';
export function createSubmissionPolicy({ planPath, ledgerRoot }) {
    check(planPath && ledgerRoot, '提交保护缺少计划或共享账本');
    const root = resolve(ledgerRoot);
    return {
        async authorize({ body, assets, operation, needId, uploadedKeys }) {
            const plan = await readJson(planPath);
            await assertUnchanged(plan, { purpose: 'artifact' });
            check(plan.ledgerRoot === root, '提交保护使用的账本与计划不一致');
            const requestHash = digest(requestSummary(body, assets));
            const decoded = decodeURIComponent(String(needId));
            const segment = plan.segments.find(s => s.strategy !== 'reuse' && decoded === 'need:author:' + s.source + '::component::replacement:generate');
            check(segment && segment.requestHash === requestHash, '最终模型、提示词、素材顺序/字节、时长或来源与计划不一致');
            return transaction(root, async ledger => {
                const grant = ledger.grants[plan.task.authorization.id];
                check(grant && digest(grant) === digest(plan.task.authorization), '授权记录与计划不一致');
                check(grant.taskIds.includes(plan.task.id), '当前任务不在授权范围');
                const old = ledger.intents[segment.intentId];
                if (old) {
                    check(old.requestHash === requestHash, '同一执行意图的请求指纹已变化');
                    if (old.handle?.taskId)
                        return { kind: 'resume', intentId: segment.intentId, handle: { ...old.handle, startedAt: Date.now() } };
                    throw new Error('该片段可能已经提交但没有可靠回执；submission_unknown，须核对官方任务/账单，禁止重投');
                }
                await assertUnchanged(plan);
                check(!grant.expiresAt || Date.parse(grant.expiresAt) > Date.now(), '授权已过期，不能新增提交；已有回执仍可恢复查询');
                const spent = Object.values(ledger.intents).filter(i => i.grantId === grant.id);
                check(spent.length < grant.maxRequests && spent.reduce((n, i) => n + occupiedCents(i), 0) + segment.costCents <= Math.floor(grant.maxCostCny * 100), '本授权已占用的次数/费用达到上限，禁止追加调用');
                const startedAt = Date.now();
                ledger.intents[segment.intentId] = { intentId: segment.intentId, grantId: grant.id, taskId: plan.task.id, segmentId: segment.id, planHash: plan.planHash, requestHash, summary: requestSummary(body, assets), compatibility: plan.compatibility, costCents: segment.costCents, actualCost: null, actualCostSource: null, state: 'submission_in_progress', operation, needId, startedAt, uploadedKeys };
                return { kind: 'reserved', intentId: segment.intentId, startedAt };
            });
        },
        async submitted(intentId, handle) { return transaction(root, l => { check(l.intents[intentId], '执行额度未预留'); l.intents[intentId].handle = handle; l.intents[intentId].state = 'submitted'; }); },
        async unknown(intentId, handle) { return transaction(root, l => { const item = l.intents[intentId]; check(item, '执行额度未预留'); if (handle?.taskId) {
            item.handle = handle;
            item.state = 'submitted';
        }
        else
            item.state = 'submission_unknown'; }); },
        async outcome(intentId, state, details = {}) { return transaction(root, l => { check(l.intents[intentId], '执行记录缺失'); Object.assign(l.intents[intentId], details, { state }); }); },
    };
}
