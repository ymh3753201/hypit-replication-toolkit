import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, stat, copyFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir, hostname } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fixture, policyInput, mockAcceptedModel } from './helpers.mjs';
import { assertUnchanged, projectRoot } from '../src/plan.mjs';
import { atomicJson, readJson, hashFile, digest, requestSummary, run } from '../src/common.mjs';
import { transaction, registerGrant, readLedger, recoverLock, occupiedCents } from '../src/ledger.mjs';
import { createSubmissionPolicy } from '../src/policy.mjs';
import { reviewStatus, recordReview, adoptReuse, recordCompletedBuild, registerOutput, outputs } from '../src/review.mjs';
import { compose } from '../../replication-scenes/src/scene.mjs';
import { checkPlan } from '../src/cli.mjs';
const moduleUrl = new URL('../src/ledger.mjs', import.meta.url).href;
const newPolicy = p => createSubmissionPolicy({ planPath: p.manifest, ledgerRoot: p.ledgerRoot });
const canonical = p => ({ task: p.task, inputs: p.inputs, segments: p.segments.map(({ intentId, source, run, runtime, ...s }) => s), ...(p.implementation ? { implementation: p.implementation } : {}) });

for (const variant of ['product', 'scene', 'voice', 'clothes', 'whole-person', 'one-of-two']) {
    test(`SPEC-1 full planned/authorized request respects ${variant} identity scope`, async () => {
        const f = await fixture(t => {
            t.audio = { mode: variant === 'voice' ? 'voice_reference' : 'preserve', assetId: variant === 'voice' ? 'voice' : 'source' };
            t.assets.find(a => a.id === 'source').purposes = ['motion', 'identity'];
            t.assets.find(a => a.id === 'source').description = 'original presenter and second presenter, motion and camera';
            t.requirements = [{ id: 'keep', kind: 'person', operation: 'preserve', subject: 'old-host', attribute: 'face', description: 'keep this presenter face unchanged', referenceIds: ['source'], basis: 'OFFLINE' }];
            if (variant === 'whole-person') {
                t.requirements = [{ id: 'replace', kind: 'person', operation: 'replace', subject: 'host', description: 'replace this entire presenter', referenceIds: ['person'], basis: 'OFFLINE' }];
            } else if (variant === 'one-of-two') {
                t.requirements.push({ id: 'replace', kind: 'person', operation: 'replace', subject: 'host', attribute: 'face', description: 'replace only this other presenter', referenceIds: ['person'], basis: 'OFFLINE' });
            } else {
                const kind = variant === 'clothes' ? 'person' : variant;
                const assetId = variant === 'voice' ? 'voice' : variant === 'clothes' ? 'person' : 'product';
                if (variant === 'scene') t.assets.find(a => a.id === assetId).purposes = ['scene'];
                if (variant === 'clothes') t.assets.find(a => a.id === assetId).purposes = ['clothes'];
                t.requirements.push({ id: 'change', kind, operation: 'replace', subject: kind === 'person' || kind === 'voice' ? 'old-host' : 'item', ...(variant === 'clothes' ? { attribute: 'clothes' } : {}), description: `change only ${variant}`, referenceIds: [assetId], basis: 'OFFLINE' });
            }
            t.segments[0].requirementIds = t.requirements.map(r => r.id);
            t.segments[0].referenceIds = [...new Set(['source', ...t.requirements.flatMap(r => r.referenceIds ?? []), ...(variant === 'voice' ? ['voice'] : [])])];
            t.occurrences = [...new Set(t.requirements.filter(r => ['person', 'product'].includes(r.kind)).map(r => r.subject))].map((subject, i) => ({ id: 'area-' + i, subject, segmentId: 's1', slot: 'full', start: 0, end: 5, source: 'generated' }));
        });
        const p = await f.prepare();
        const input = policyInput(p);
        assert.equal(digest(requestSummary(input.body, input.assets)), p.segments[0].requestHash);
        assert.equal(input.body.content.length, 1 + p.segments[0].references.length);
        const prompt = input.body.content[0].text;
        assert.doesNotMatch(prompt, /old actor identity is not a preservation target/);
        if (['whole-person', 'one-of-two'].includes(variant)) assert.match(prompt, /For subject host only, replace/);
        else assert.doesNotMatch(prompt, /Do not preserve that original identity/);
        if (variant !== 'whole-person') assert.match(prompt, /PRESERVE person attribute face of old-host/);
        if (variant === 'clothes') {
            assert.match(prompt, /REPLACE person attribute clothes of old-host/);
            assert.match(prompt, /supplies clothes/);
        }
        const source = await readFile(p.segments[0].source, 'utf8');
        assert.equal((source.match(/<h3:Reference /g) ?? []).length, input.assets.length);
        for (let i = 0; i < input.assets.length; i++) assert.match(source, new RegExp(`<h3:Reference ${p.segments[0].references[i].kind}=\\{ref-${i}\\}`));
        assert.equal((await checkPlan(p)).paidRequestsCreated, 0);
        assert.equal((await newPolicy(p).authorize(input)).kind, 'reserved'); // no HTTP transport
    });
}

for (const legacy of [false, true]) for (const fileKind of ['prompt', 'plan', 'provider']) {
    test(`SPEC-2 ${legacy ? 'legacy' : 'new'} plan: ${fileKind} upgrade allows historical reuse/resume but blocks new POST`, async () => {
        const f = await fixture();
        const p = await f.prepare();
        let verification = { assertUnchanged, reviewStatus, adoptReuse, createSubmissionPolicy };
        if (legacy) {
            // A real isolated code tree keeps the fixed historical path allowlist
            // meaningful without modifying the user's working implementation.
            const isolated = join(f.dir, 'isolated-workspace');
            for (const i of p.implementation) {
                const dest = join(isolated, relative(projectRoot, i.file));
                await mkdir(dirname(dest), { recursive: true });
                await copyFile(i.file, dest); i.file = dest;
            }
            verification = {
                ...await import(pathToFileURL(join(isolated, 'packages/replication-workflow/src/plan.mjs')).href),
                ...await import(pathToFileURL(join(isolated, 'packages/replication-workflow/src/review.mjs')).href),
                ...await import(pathToFileURL(join(isolated, 'packages/replication-workflow/src/policy.mjs')).href),
            };
        }
        const item = p.implementation.find(i => i.file.endsWith(fileKind === 'provider' ? '/provider.ts' : `/${fileKind}.mjs`));
        if (!legacy) {
            item.file = join(f.dir, `temporary-${fileKind}.txt`);
            await writeFile(item.file, 'OFFLINE implementation version 1');
        }
        item.sha256 = await hashFile(item.file);
        if (legacy) { p.inputs.push(...p.implementation); delete p.implementation; }
        p.planHash = digest(canonical(p));
        await atomicJson(p.manifest, p);
        await mockAcceptedModel(f, p);
        await verification.assertUnchanged(p);
        await writeFile(item.file, '\n// OFFLINE implementation version 2\n', { flag: 'a' });
        assert.equal((await verification.reviewStatus(p, 'model', 's1')).state, 'accepted');
        await assert.rejects(verification.assertUnchanged(p), /实现代码已变化/);
        const l = await readLedger(p.ledgerRoot);
        const saved = l.intents[p.segments[0].intentId];
        const policy = verification.createSubmissionPolicy({ planPath: p.manifest, ledgerRoot: p.ledgerRoot });
        assert.equal((await policy.authorize(policyInput(p))).kind, 'resume');
        await transaction(p.ledgerRoot, l => { delete l.intents[p.segments[0].intentId]; });
        await assert.rejects(policy.authorize(policyInput(p)), /实现代码已变化/);
        await transaction(p.ledgerRoot, l => { l.intents[p.segments[0].intentId] = saved; });
        const target = await fixture(t => {
            t.id = 'reuse-target'; t.authorization.id = 'reuse-only-grant'; t.authorization.maxRequests = 0; t.authorization.maxCostCny = 0;
            t.segments[0].strategy = 'reuse';
            t.segments[0].reuse = { manifest: p.manifest, segmentId: 's1', applicabilityReviewedBy: 'OFFLINE', basis: 'Synthetic reuse, requires new target review' };
        });
        const tp = await target.prepare();
        const reused = await verification.adoptReuse(tp, 's1');
        assert.equal(tp.requestCount, 0);
        assert.deepEqual(reused.checks, {});
        assert.equal(reused.officialTaskId, saved.handle.taskId);
        assert.equal((await reviewStatus(tp, 'model', 's1')).state, 'awaiting_review');
        assert.equal(Object.keys((await readLedger(tp.ledgerRoot)).intents).length, 0);
        await writeFile(target.taskPath, 'changed target requirements');
        assert.equal((await reviewStatus(tp, 'model', 's1')).state, 'blocked');
        await writeFile(join(f.dir, 'script.txt'), 'changed original dialogue');
        assert.equal((await verification.reviewStatus(p, 'model', 's1')).state, 'blocked');
    });
}

test('SPEC-2 legacy compatibility metadata cannot hide changed business media or dialogue', async () => {
    for (const businessName of ['source.mp4', 'script.txt']) {
        const f = await fixture(); const p = await f.prepare();
        p.inputs.push(...p.implementation); delete p.implementation;
        p.planHash = digest(canonical(p)); await atomicJson(p.manifest, p);
        await mockAcceptedModel(f, p);
        p.compatibility.implementationFiles.push(p.inputs.find(i => i.file === join(f.dir, businessName)));
        await atomicJson(p.manifest, p); // compatibility is not in legacy planHash
        await writeFile(join(f.dir, businessName), 'changed business bytes');
        assert.equal((await reviewStatus(p, 'model', 's1')).state, 'blocked');
    }
});

test('SPEC-2 independent review evidence changes invalidate historical acceptance', async () => {
    const f = await fixture(); const p = await f.prepare(); const m = await mockAcceptedModel(f, p);
    const evidence = join(f.dir, 'observation.txt'); await writeFile(evidence, 'OFFLINE observation');
    await recordReview(p, { kind: 'model', segmentId: 's1', observedHash: m.sha256, checks: [{ key: 'requirement:person', verdict: 'pass', reviewer: 'OFFLINE', note: 'synthetic', method: 'visual', coverage: { start: 0, end: 5 }, evidence: [{ file: evidence, sha256: await hashFile(evidence) }] }] });
    await writeFile(evidence, 'changed observation');
    assert.equal((await reviewStatus(p, 'model', 's1')).state, 'awaiting_review');
});

for (const [key, method] of [['requirement:person', 'visual'], ['voice', 'listening'], ['dialogue', 'listening'], ['lipsync', 'audiovisual']]) {
    test(`SPEC-3 partial ${key} pass rejected; decisive partial failure overwrites acceptance`, async () => {
        const f = await fixture(); const p = await f.prepare(); const m = await mockAcceptedModel(f, p);
        const entry = { key, method, verdict: 'pass', reviewer: 'OFFLINE', note: 'first second only', coverage: { start: 0, end: 1 }, evidence: [{ file: m.file, sha256: m.sha256 }] };
        const review = { kind: 'model', segmentId: 's1', observedHash: m.sha256, checks: [entry] };
        await assert.rejects(recordReview(p, review), /覆盖完整|局部/);
        entry.verdict = 'fail';
        assert.equal((await recordReview(p, review)).state, 'quality_failed');
        for (const coverage of [{ start: 0, end: 0 }, { start: -1, end: 1 }, { start: 4, end: 6 }, { start: 0, end: NaN }]) {
            entry.coverage = coverage;
            await assert.rejects(recordReview(p, review), /时间范围/);
        }
    });
}
test('SPEC-3 inset failure must overlap its own time window; whole-film status fails', async () => {
    const f = await fixture(); const p = await f.prepare(); const m = await mockAcceptedModel(f, p);
    await compose(p, { width: 768, height: 768, regions: { 'pip-host': [65, 60, 95, 95] } });
    const built = { format: 'hypit.cli-build@1', build: { id: 'OFFLINE-FINAL', work: { outcome: 'complete' }, result: { state: 'complete' } } };
    await recordCompletedBuild(p, 'final', undefined, built);
    const final = await registerOutput(p, { kind: 'final', file: m.file, buildId: 'OFFLINE-FINAL' });
    const entry = { key: 'region:pip-host', method: 'visual', verdict: 'fail', reviewer: 'OFFLINE', note: 'wrong face in inset', coverage: { start: 0, end: .5 }, evidence: [{ file: final.file, sha256: final.sha256 }] };
    const review = { kind: 'final', observedHash: final.sha256, checks: [entry] };
    await assert.rejects(recordReview(p, review), /重叠/);
    entry.coverage = { start: 1.2, end: 1.5 };
    assert.equal((await recordReview(p, review)).state, 'quality_failed');
});

for (const [actual, allowNext] of [[8, false], [3, true], [5.001, false], [null, true]]) {
    test(`SPEC-4 actual=${actual}: shared grant uses conservative occupied fees and permits original resume`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'replication-budget-fix-'));
        const setup = id => fixture(t => { t.id = id; Object.assign(t.authorization, { id: 'shared', taskIds: ['first', 'next'], maxRequests: 2, maxCostCny: 10 }); }, root);
        const f = await setup('first'); const p = await f.prepare(); const policy = newPolicy(p);
        const first = await policy.authorize(policyInput(p)); await policy.submitted(first.intentId, { taskId: 'OFFLINE-BILL-FIRST' });
        if (actual !== null) {
            const evidence = join(f.dir, 'bill.txt'); await writeFile(evidence, 'OFFLINE synthetic bill, no real fee');
            const cost = join(f.dir, 'cost.json');
            await atomicJson(cost, { officialTaskId: 'OFFLINE-BILL-FIRST', actualCny: actual, verifiedBy: 'OFFLINE', basis: 'synthetic bill', evidence: { file: evidence, sha256: await hashFile(evidence) } });
            await run(process.execPath, [join(projectRoot, 'packages/replication-workflow/src/cli.mjs'), 'record-cost', f.taskPath, cost]);
        }
        const item = (await readLedger(root)).intents[first.intentId];
        assert.equal(occupiedCents(item), actual === null ? 500 : Math.max(500, Math.ceil(actual * 100)));
        const next = await setup('next'); const np = await next.prepare();
        if (allowNext) assert.equal((await newPolicy(np).authorize(policyInput(np))).kind, 'reserved');
        else await assert.rejects(newPolicy(np).authorize(policyInput(np)), /上限/);
        assert.equal((await policy.authorize(policyInput(p))).kind, 'resume');
        const { stdout } = await run(process.execPath, [join(projectRoot, 'packages/replication-workflow/src/cli.mjs'), 'task-status', f.taskPath]);
        const status = JSON.parse(stdout);
        assert.equal(status.occupiedCny, (Math.max(500, actual === null ? 500 : Math.ceil(actual * 100)) + (allowNext ? 500 : 0)) / 100);
        assert.equal(status.billedCny, !allowNext ? actual : null);
    });
}
test('SPEC-4 malformed recorded amounts stop new submissions', () => {
    assert.throws(() => occupiedCents({ costCents: 500, actualCost: 8 }), /核对记录/);
    assert.throws(() => occupiedCents({ costCents: NaN }), /预留/);
});

async function lockFixture(owner) {
    const root = await mkdtemp(join(tmpdir(), 'replication-lock-fix-'));
    await atomicJson(join(root, 'ledger.json'), { format: 'replication.ledger@1', grants: { original: { id: 'original' } }, intents: { pending: { state: 'submission_in_progress', costCents: 500 }, unknown: { state: 'submission_unknown', costCents: 600 } } });
    await mkdir(join(root, 'ledger.lock'));
    if (owner !== undefined) await writeFile(join(root, 'ledger.lock', 'owner.json'), typeof owner === 'string' ? owner : JSON.stringify(owner));
    return root;
}
for (const owner of [undefined, '{corrupt', { pid: 0, host: hostname() }]) {
    test(`STANDARDS-1 missing/corrupt owner ${JSON.stringify(owner)} has explicit safe migration`, async () => {
        const root = await lockFixture(owner);
        await assert.rejects(recoverLock(root), /停止所有旧版/);
        await recoverLock(root, { legacyWorkersStopped: true });
        const l = await readLedger(root);
        assert.equal(l.intents.pending.state, 'submission_unknown'); assert.equal(l.intents.pending.costCents, 500);
        assert.equal(l.intents.unknown.costCents, 600); assert.deepEqual(l.grants, { original: { id: 'original' } });
        await registerGrant(root, { id: 'new' });
        await stat(join(root, 'ledger.guard.sqlite'));
    });
}
test('STANDARDS-1 live or foreign legacy lock is never removed, even with migration flag', async () => {
    for (const owner of [{ pid: process.pid, host: hostname() }, { pid: process.pid, host: 'other-host' }]) {
        const root = await lockFixture(owner);
        await assert.rejects(recoverLock(root, { legacyWorkersStopped: true }), /仍在运行|其他主机/);
        await stat(join(root, 'ledger.lock'));
    }
});
async function liveWorker(t, script) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('worker exited before ready'); })]);
    return child;
}
test('STANDARDS-1 OS guard blocks recovery of active ownerless writer, then releases after crash', { timeout: 15000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'replication-live-lock-'));
    const child = await liveWorker(t, `import {DatabaseSync} from 'node:sqlite'; import {mkdir} from 'node:fs/promises'; const db=new DatabaseSync(${JSON.stringify(join(root, 'ledger.guard.sqlite'))}); db.exec('BEGIN IMMEDIATE'); await mkdir(${JSON.stringify(join(root, 'ledger.lock'))}); console.log('ready'); setInterval(()=>{},1000);`);
    await assert.rejects(recoverLock(root, { legacyWorkersStopped: true }), /正在被其他进程/);
    await stat(join(root, 'ledger.lock'));
    child.kill('SIGKILL'); await once(child, 'exit');
    await recoverLock(root, { legacyWorkersStopped: true });
    await registerGrant(root, { id: 'after-crash' });
});
test('STANDARDS-1 dead owner recovery and simultaneous recoverers/new transaction preserve reservations', async () => {
    const dead = Number((await run(process.execPath, ['-e', 'console.log(process.pid)'])).stdout.trim());
    const deadRoot = await lockFixture({ pid: dead, host: hostname() });
    await recoverLock(deadRoot);
    assert.equal((await readLedger(deadRoot)).intents.pending.state, 'submission_unknown');
    const root = await lockFixture({ pid: dead, host: hostname() });
    const recovery = `import {recoverLock} from ${JSON.stringify(moduleUrl)}; try{await recoverLock(${JSON.stringify(root)});console.log('recovered')}catch{console.log('blocked')}`;
    const writer = `import {transaction} from ${JSON.stringify(moduleUrl)}; try{await transaction(${JSON.stringify(root)},async l=>{l.grants.racer={id:'racer'};await new Promise(r=>setTimeout(r,100));});console.log('written')}catch{console.log('blocked')}`;
    const results = await Promise.all([recovery, recovery, writer].map(s => run(process.execPath, ['--input-type=module', '-e', s])));
    const recovered = results.slice(0, 2).filter(r => r.stdout.trim() === 'recovered').length;
    assert.ok(recovered <= 1, 'two recoverers must never both remove a lock');
    // Fail-fast contenders may all be rejected while the writer holds the OS
    // guard and discovers the old directory. No fairness/auto-retry is promised.
    // After all contenders finish, an explicit local recovery must still work.
    if (recovered === 0) await recoverLock(root);
    const l = await readLedger(root);
    assert.equal(l.intents.pending.state, 'submission_unknown'); assert.equal(l.intents.pending.costCents, 500); assert.equal(l.intents.unknown.costCents, 600);
    if (results[2].stdout.trim() === 'written') assert.deepEqual(l.grants.racer, { id: 'racer' });
    await registerGrant(root, { id: 'after-race' });
    await assert.rejects(recoverLock(root), { code: 'ENOENT' });
});
