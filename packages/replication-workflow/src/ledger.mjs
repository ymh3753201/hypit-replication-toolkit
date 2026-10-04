import { mkdir, rm, chmod, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { atomicJson, readJson, requireThat, digest } from './common.mjs';

// Permanent OS guard. Never unlink this database: different inodes would split
// contenders into separate locks. The operating system releases it after death.
async function guarded(root, action) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const file = join(root, 'ledger.guard.sqlite');
    const db = new DatabaseSync(file);
    try {
        await chmod(file, 0o600);
        try { db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); }
        catch (e) {
            if (e.errcode === 5 || e.errcode === 6)
                throw new Error('执行记录正在被其他进程使用；不能恢复活锁或重复提交');
            throw e;
        }
        return await action();
    }
    finally { db.close(); }
}
async function writeLedger(root, action) {
    const ledger = await readLedger(root);
    const result = await action(ledger);
    await atomicJson(join(root, 'ledger.json'), ledger);
    return result;
}
// One root covers all tasks and workers; never remove uncertain spending.
export async function transaction(root, action) {
    return guarded(root, async () => {
        const lock = join(root, 'ledger.lock');
        try { await mkdir(lock); }
        catch (e) {
            if (e.code === 'EEXIST')
                throw new Error('执行记录正在被其他进程使用，或锁未恢复；禁止重复提交');
            throw e;
        }
        try {
            await atomicJson(join(lock, 'owner.json'), { pid: process.pid, host: hostname(), protocol: 'sqlite-guard@1', createdAt: new Date().toISOString() });
            return await writeLedger(root, action);
        }
        finally { await rm(lock, { recursive: true, force: true }); }
    });
}
export async function registerGrant(root, grant) {
    return transaction(root, l => {
        const old = l.grants[grant.id];
        requireThat(!old || digest(old) === digest(grant), '同一授权编号的预算或依据已改变；请明确取得新授权，不可覆盖旧额度');
        l.grants[grant.id] = grant;
    });
}
export async function readLedger(root) {
    try { return await readJson(join(root, 'ledger.json')); }
    catch (e) {
        if (e.code === 'ENOENT') return { format: 'replication.ledger@1', grants: {}, intents: {} };
        throw e;
    }
}
export async function recoverLock(root, { legacyWorkersStopped = false } = {}) {
    return guarded(root, async () => {
        const lock = join(root, 'ledger.lock');
        await stat(lock); // No lock means no recovery; do not disturb active POSTs.
        let owner;
        try { owner = await readJson(join(lock, 'owner.json')); }
        catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
        const validOwner = owner && typeof owner.host === 'string' && Number.isInteger(owner.pid) && owner.pid > 0;
        if (validOwner) {
            requireThat(owner.host === hostname(), '锁来自其他主机，须核对该主机上的进程');
            let alive = true;
            try { process.kill(owner.pid, 0); }
            catch (e) { if (e.code === 'ESRCH') alive = false; else throw e; }
            requireThat(!alive, '持锁进程仍在运行，不能移除锁');
        }
        else {
            // Old workers did not hold this OS guard. Missing metadata cannot
            // establish their absence; the migration requires explicit confirmation.
            requireThat(legacyWorkersStopped, '锁缺少有效 owner；先停止所有旧版复刻进程，再使用 --legacy-workers-stopped 确认恢复，不能强删');
        }
        await writeLedger(root, l => {
            for (const item of Object.values(l.intents))
                if (item.state === 'submission_in_progress') item.state = 'submission_unknown';
            l.lastLockRecovery = { at: new Date().toISOString(), host: hostname(), pid: process.pid, legacyWorkersStopped, owner: validOwner ? owner : null };
        });
        await rm(lock, { recursive: true, force: true });
    });
}
// Higher verified bills occupy more; lower/unknown bills never free reservations.
export function occupiedCents(item) {
    requireThat(Number.isSafeInteger(item.costCents) && item.costCents >= 0, '预留费用记录无效，停止新增提交');
    if (item.actualCost == null) return item.costCents;
    requireThat(Number.isFinite(item.actualCost) && item.actualCost >= 0 && item.actualCostSource?.verifiedBy && item.actualCostSource?.sha256, '实际费用缺少有效核对记录，停止新增提交');
    const actual = Math.ceil(item.actualCost * 100);
    requireThat(Number.isSafeInteger(actual), '实际费用超出可计算范围，停止新增提交');
    return Math.max(item.costCents, actual);
}
