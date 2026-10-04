import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, copyFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, policyInput, mockAcceptedModel } from './helpers.mjs';
import { validateTask, assertUnchanged, projectRoot, prepare } from '../src/plan.mjs';
import { createSubmissionPolicy } from '../src/policy.mjs';
import { readLedger, transaction } from '../src/ledger.mjs';
import { atomicJson, hashFile, run } from '../src/common.mjs';
import { registerOutput, recordReview, reviewStatus, criteria, adoptReuse, recordCompletedBuild, completeBuild } from '../src/review.mjs';
import { splitRanges, splitVideo } from '../src/media.mjs';
import { compose } from '../../replication-scenes/src/scene.mjs';
import { checkPlan, hypit } from '../src/cli.mjs';
test('same task record compiles requirements, exact dialogue, ordered references and official Hypit plan', async () => {
    const f = await fixture();
    const p = await f.prepare();
    await assertUnchanged(p);
    assert.equal(p.requestCount, 1);
    assert.equal(p.totalCostCents, 500);
    assert.match(p.segments[0].prompt, /This is our new product/);
    assert.deepEqual(p.segments[0].references.map(a => a.id), ['person', 'product', 'source', 'voice']);
    assert.deepEqual(p.segments[0].summary.content.slice(1).map(a => a.role), ['reference_image', 'reference_image', 'reference_video', 'reference_audio']);
    assert.equal((await checkPlan(p)).paidRequestsCreated, 0);
});
const invalid = [
    ['missing voice', t => t.assets = t.assets.filter(a => a.id !== 'voice')],
    ['missing identity', t => t.assets = t.assets.filter(a => a.id !== 'person')],
    ['omitted product connection', t => t.segments[0].referenceIds = t.segments[0].referenceIds.filter(x => x !== 'product')],
    ['omitted voice connection', t => t.segments[0].referenceIds = t.segments[0].referenceIds.filter(x => x !== 'voice')],
    ['conflicting replacement and preservation', t => t.requirements.push({ ...t.requirements[0], id: 'other', operation: 'preserve' })],
    ['exact action lost by performance scheme', t => t.segments[0].strategy = 'performance'],
    ['old actor in inset', t => t.occurrences[1].source = 'original'],
    ['only local editing', t => t.segments[0].strategy = 'local_edit'],
    ['frame/audio incompatible', t => t.segments[0].frames = { first: 'person' }],
    ['long reference plan', t => t.segments[0].duration = 30],
    ['missing script', t => delete t.segments[0].script],
    ['unknown service switch', t => t.authorization.service = 'cangyuan.default'],
    ['unknown model switch', t => t.authorization.model = 'MiniMax-H3-Max'],
];
for (const [name, change] of invalid)
    test(name + ' stops before payment', async () => { const f = await fixture(change); assert.throws(() => validateTask(f.task)); });
test('legal image and voice only performance has no forced original-video input', async () => {
    const f = await fixture(t => { t.segments[0].strategy = 'performance'; t.requirements = t.requirements.filter(r => r.id !== 'motion'); t.segments[0].requirementIds = t.requirements.map(r => r.id); t.segments[0].referenceIds = ['person', 'product', 'voice']; });
    const p = await f.prepare();
    assert.equal(p.totalCostCents, 250);
    assert.equal((await checkPlan(p)).plannedRequests, 1);
});
test('silent B-roll and retained original audio are valid alternatives', async () => {
    for (const mode of ['silent', 'preserve', 'recording']) {
        const f = await fixture(t => { t.audio = { mode, ...(mode === 'silent' ? {} : { assetId: 'source' }) }; t.requirements = t.requirements.filter(r => !['voice', 'dialogue'].includes(r.kind)); t.segments[0].requirementIds = t.requirements.map(r => r.id); t.segments[0].referenceIds = ['person', 'product', 'source']; delete t.segments[0].script; });
        const p = await f.prepare();
        await checkPlan(p);
    }
});
test('budget and count overflow stop preparation', async () => {
    for (const change of [t => t.authorization.maxRequests = 0, t => t.authorization.maxCostCny = 1]) {
        const f = await fixture(change);
        await assert.rejects(f.prepare(), /授权/);
    }
});
test('changed script, reference bytes or source after prepare are rejected', async () => {
    for (const file of ['script.txt', 'person.png']) {
        const f = await fixture();
        const p = await f.prepare();
        await writeFile(join(f.dir, file), 'changed');
        await assert.rejects(assertUnchanged(p), /变化/);
    }
    const f = await fixture();
    const p = await f.prepare();
    await writeFile(p.segments[0].source, 'changed');
    await assert.rejects(assertUnchanged(p), /变化/);
});
test('final prompt, image order, duration, new fields and asset changes cannot pass POST policy', async () => {
    const f = await fixture();
    const p = await f.prepare();
    const policy = createSubmissionPolicy({ planPath: p.manifest, ledgerRoot: p.ledgerRoot });
    for (const mutate of [i => i.body.content[0].text += 'changed', i => [i.body.content[1], i.body.content[2]] = [i.body.content[2], i.body.content[1]], i => i.body.duration = 6, i => i.body.extra_paid_voice = true, i => i.assets[0].sha256 = 'changed']) {
        const input = policyInput(p);
        mutate(input);
        await assert.rejects(policy.authorize(input));
    }
    assert.equal(Object.keys((await readLedger(p.ledgerRoot)).intents).length, 0);
});
test('lost receipt occupies budget and prohibits another POST', async () => {
    const f = await fixture();
    const p = await f.prepare();
    const policy = createSubmissionPolicy({ planPath: p.manifest, ledgerRoot: p.ledgerRoot });
    const reserved = await policy.authorize(policyInput(p));
    await policy.unknown(reserved.intentId);
    await assert.rejects(policy.authorize(policyInput(p)), /unknown/);
    assert.equal((await readLedger(p.ledgerRoot)).intents[reserved.intentId].costCents, 500);
});
test('known receipt recovers original task, even when old polling window expired', async () => {
    const f = await fixture();
    const p = await f.prepare();
    const policy = createSubmissionPolicy({ planPath: p.manifest, ledgerRoot: p.ledgerRoot });
    const reserved = await policy.authorize(policyInput(p));
    await policy.submitted(reserved.intentId, { contract: 'hypit.minimax-official-h3@1', taskId: 'MOCK-ONLY', startedAt: 0, uploadedKeys: [], intentId: reserved.intentId });
    const resumed = await policy.authorize(policyInput(p));
    assert.equal(resumed.kind, 'resume');
    assert.equal(resumed.handle.taskId, 'MOCK-ONLY');
    assert.ok(resumed.handle.startedAt > 0);
});
test('shared authorization cannot be escaped by changing task name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'replication-shared-ledger-'));
    for (const name of ['first', 'second']) {
        const f = await fixture(t => { t.id = name; t.authorization.maxRequests = 1; t.authorization.taskIds = ['first', 'second']; }, root);
        const p = await f.prepare();
        const policy = createSubmissionPolicy({ planPath: p.manifest, ledgerRoot: root });
        if (name === 'first')
            await policy.authorize(policyInput(p));
        else
            await assert.rejects(policy.authorize(policyInput(p)), /上限/);
    }
});
test('changing budget under the same grant ID is rejected', async () => {
    const f = await fixture();
    await f.prepare();
    f.task.authorization.maxRequests++;
    await atomicJson(f.taskPath, f.task);
    await assert.rejects(f.prepare(), /授权编号/);
});
test('different processes racing reserve one intent at most', async () => {
    const f = await fixture();
    const p = await f.prepare();
    const file = join(f.dir, 'input.json');
    await atomicJson(file, policyInput(p));
    const script = `import {createSubmissionPolicy} from ${JSON.stringify(new URL('../src/policy.mjs', import.meta.url).href)}; import {readJson} from ${JSON.stringify(new URL('../src/common.mjs', import.meta.url).href)}; const p=createSubmissionPolicy({planPath:${JSON.stringify(p.manifest)},ledgerRoot:${JSON.stringify(p.ledgerRoot)}}); try { console.log((await p.authorize(await readJson(${JSON.stringify(file)}))).kind); }catch{console.log('blocked');}`;
    const results = await Promise.all([1, 2, 3].map(() => run(process.execPath, ['--input-type=module', '-e', script])));
    assert.equal(results.filter(r => r.stdout.trim() === 'reserved').length, 1);
    assert.equal(Object.keys((await readLedger(p.ledgerRoot)).intents).length, 1);
});
test('no region and no sound evidence means no whole-film acceptance; stale bytes invalidate it', async () => {
    const f = await fixture();
    const p = await f.prepare();
    const model = await mockAcceptedModel(f, p);
    assert.equal((await reviewStatus(p, 'model', 's1')).state, 'accepted');
    const c = await compose(p, { width: 768, height: 768, regions: { 'pip-host': [65, 60, 95, 95] } });
    const source = await readFile(join(dirnamePortable(c.run), 'review.svml'), 'utf8');
    assert.equal((source.match(/<audio:Item/g) || []).length, 1);
    assert.match(source, /pip-pip-host.*media=\{norm-s1.media\}/);
    await recordCompletedBuild(p, 'final', undefined, mockBuild('OFFLINE-MOCK-COMPOSITION'));
    const result = await registerOutput(p, { kind: 'final', file: model.file, buildId: 'OFFLINE-MOCK-COMPOSITION' });
    assert.equal((await reviewStatus(p)).state, 'awaiting_review');
    await assert.rejects(recordReview(p, { kind: 'final', observedHash: result.sha256, checks: [{ key: 'voice', verdict: 'pass', reviewer: 'test', method: 'technical', note: 'has track', evidence: [{ file: model.file, sha256: model.sha256 }] }] }), /听音/);
    await recordReview(p, { kind: 'final', observedHash: result.sha256, checks: [{ key: 'region:pip-host', verdict: 'fail', reviewer: 'test', method: 'visual', coverage: { start: 0, end: 5 }, note: 'old actor remained', evidence: [{ file: model.file, sha256: model.sha256 }] }] });
    assert.equal((await reviewStatus(p)).state, 'quality_failed');
    await writeFile(join(dirnamePortable(c.run), 'review.svs'), 'changed layout');
    assert.equal((await reviewStatus(p)).state, 'awaiting_review');
});
function dirnamePortable(file) { return file.slice(0, file.lastIndexOf('/')); }
function mockBuild(id) { return { format: 'hypit.cli-build@1', build: { id, work: { outcome: 'complete' }, result: { state: 'complete' } } }; }
test('partial visual coverage cannot mark a whole region passed', async () => {
    const f = await fixture();
    const p = await f.prepare();
    const model = await mockAcceptedModel(f, p);
    await assert.rejects(recordReview(p, { kind: 'model', segmentId: 's1', observedHash: model.sha256, checks: [{ key: 'requirement:person', verdict: 'pass', reviewer: 'test', method: 'visual', coverage: { start: 0, end: 1 }, note: 'opening only', evidence: [{ file: model.file, sha256: model.sha256 }] }] }), /局部/);
});
test('editing generated output or evidence invalidates model acceptance', async () => {
    const f = await fixture();
    const p = await f.prepare();
    const model = await mockAcceptedModel(f, p);
    await writeFile(model.file, 'changed');
    assert.equal((await reviewStatus(p, 'model', 's1')).state, 'awaiting_review');
});
test('segmentation includes the complete tail within H3 limits', async () => {
    const spans = splitRanges(31.2);
    assert.equal(spans[0].start, 0);
    assert.equal(spans.at(-1).end, 31.2);
    assert.ok(spans.every(s => s.outputDuration >= 4 && s.outputDuration <= 15));
    const f = await fixture();
    const actual = await splitVideo(join(f.dir, 'source.mp4'), join(f.dir, 'split'));
    assert.equal(actual.clips.length, 1);
    assert.ok(Math.abs(actual.clips[0].info.duration - 5) < .1);
});
test('pending and failed Hypit Builds cannot advance to next paid segment', () => {
    for (const state of ['open', 'missing', 'failed', 'cancelled', 'unavailable'])
        assert.throws(() => completeBuild({ format: 'hypit.cli-build@1', build: { id: 'MOCK', work: { outcome: state }, result: { state } } }));
});
test('multiple identities remain connected, while incomplete extra regions stop before paying', async () => {
    const f = await fixture(t => { t.assets.push({ ...t.assets[0], id: 'second-person', subject: 'guest' }); t.requirements.push({ ...t.requirements[0], id: 'second-face', subject: 'guest', referenceIds: ['second-person'] }); t.segments[0].referenceIds.push('second-person'); t.segments[0].requirementIds.push('second-face'); t.occurrences.push({ id: 'guest-region', subject: 'guest', segmentId: 's1', slot: 'full', start: 0, end: 5, source: 'generated' }); });
    const p = await f.prepare();
    assert.deepEqual(p.segments[0].references.map(a => a.id), ['person', 'product', 'second-person', 'source', 'voice']);
    await checkPlan(p);
    f.task.occurrences = f.task.occurrences.filter(o => o.subject !== 'guest');
    assert.throws(() => validateTask(f.task), /出现区域/);
});
test('reference count and total audio/video duration limits are enforced', async () => {
    const f = await fixture(t => { for (let i = 0; i < 8; i++) {
        t.assets.push({ ...t.assets[0], id: 'extra-' + i });
        t.segments[0].referenceIds.push('extra-' + i);
    } });
    assert.throws(() => validateTask(f.task), /数量超限/);
    const long = await fixture(t => { for (let i = 0; i < 2; i++) {
        t.assets.push({ ...t.assets[2], id: 'video-' + i });
        t.segments[0].referenceIds.push('video-' + i);
    } });
    const p = await long.prepare();
    assert.equal(p.segments[0].references.filter(r => r.kind === 'video').length, 3);
    // Three separate valid audio files can still exceed their joint 15-second quota.
    const tooLong = await fixture(t => { for (let i = 0; i < 2; i++) {
        t.assets.push({ ...t.assets[3], id: 'audio-' + i });
        t.segments[0].referenceIds.push('audio-' + i);
    } });
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=6', '-y', join(tooLong.dir, 'voice.wav')]);
    await assert.rejects(tooLong.prepare(), /总时长/);
});
test('valid first-frame generation uses adaptive ratio and no incompatible audio reference', async () => {
    const f = await fixture(t => { t.audio = { mode: 'silent' }; t.requirements = t.requirements.filter(r => r.id === 'person'); t.segments[0] = { id: 's1', strategy: 'performance', duration: 5, direction: 'New visual performance', referenceIds: [], frames: { first: 'person' }, requirementIds: ['person'] }; t.occurrences = t.occurrences.filter(o => o.subject === 'host'); });
    const p = await f.prepare();
    assert.equal(p.segments[0].summary.ratio, 'adaptive');
    await checkPlan(p);
});
test('accepted cross-task performance reuses original task without new requests and clears target acceptance', async () => {
    const first = await fixture();
    const source = await first.prepare();
    await mockAcceptedModel(first, source);
    const second = await fixture(t => { t.id = 'target-task'; t.segments[0].strategy = 'reuse'; t.segments[0].reuse = { manifest: source.manifest, segmentId: 's1', applicabilityReviewedBy: 'offline fixture', basis: 'OFFLINE: same content for aggregation test' }; t.authorization.maxRequests = 0; t.authorization.maxCostCny = 0; });
    const target = await second.prepare();
    assert.equal(target.requestCount, 0);
    const reused = await adoptReuse(target, 's1');
    assert.equal(reused.officialTaskId, 'OFFLINE-MOCK-NOT-OFFICIAL');
    assert.deepEqual(reused.checks, {});
    assert.equal((await reviewStatus(target, 'model', 's1')).state, 'awaiting_review');
    assert.equal(Object.keys((await readLedger(target.ledgerRoot)).intents).length, 0);
});
test('native full/inset/card/caption composition renders locally with one sound source and no paid endpoint', async () => {
    const f = await fixture();
    const p = await f.prepare();
    await mockAcceptedModel(f, p);
    const font = process.env.HYPIT_TEST_FONT_PATH ?? (process.platform === 'darwin' ? '/System/Library/Fonts/Supplemental/Arial.ttf' : '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf');
    await copyFile(font, join(f.dir, 'font.ttf'));
    const c = await compose(p, { width: 768, height: 768, regions: { 'pip-host': [65, 60, 95, 95] }, cards: [{ assetId: 'product', width: 320, height: 320, start: 0, end: 5, box: [3, 3, 30, 30], reviewedNoOldSubjectBy: 'OFFLINE fixture' }], fontFile: 'font.ttf', captions: [{ text: 'OFFLINE TEST - NO MODEL QUALITY CLAIM', start: 0, end: 5 }] });
    try {
        await hypit(['check', c.run]);
        const localPlan = await hypit(['plan', c.run, '--runtime', c.runtime]);
        assert.ok(localPlan.providers.every(x => ['media.local', 'hyperframes.local'].includes(x.endpoint)));
        const rendered = await hypit(['build', c.run, '--runtime', c.runtime, '--follow', '--max-wait-ms', '120000']);
        const buildId = await recordCompletedBuild(p, 'final', undefined, rendered);
        const file = join(f.dir, 'final.mp4');
        await hypit(['get', buildId, '--output', 'final.video', '--to', file]);
        const final = await registerOutput(p, { kind: 'final', file, buildId });
        assert.equal(final.info.hasAudio, true);
        assert.ok(Math.abs(final.info.duration - 5) < .1);
        await assert.rejects(registerOutput(p, { kind: 'final', file, buildId: 'UNRELATED-BUILD' }), /Build/);
        assert.equal((await reviewStatus(p)).state, 'awaiting_review');
        await atomicJson(join(projectRoot, '.hypit', 'replication-offline-demo.json'), { task: f.taskPath, run: c.run, runtime: c.runtime, file, buildId, notice: 'Synthetic fixtures only. Not a real H3 result, nor human audiovisual acceptance.' });
    }
    finally {
        await hypit(['runtime', 'down', c.runtime]);
    }
});
test('real Hypit worker passes actual operation identity to guarded Provider and never duplicates localhost POST', async () => {
    const { createServer } = await import('node:http');
    const { readJson } = await import('../src/common.mjs');
    let posts = 0;
    const server = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); if (req.method === 'POST') {
        posts++;
        res.end(JSON.stringify({ task_id: 'OFFLINE-LOCALHOST-TASK' }));
    }
    else
        res.end(JSON.stringify({ task: { id: 'OFFLINE-LOCALHOST-TASK', status: 'queued' } })); });
    await new Promise(yes => server.listen(0, '127.0.0.1', yes));
    const f = await fixture(t => { t.assets = []; t.audio = { mode: 'silent' }; t.requirements = [{ id: 'scene', kind: 'scene', operation: 'change', subject: 'background', description: 'Plain blue backdrop.', basis: 'OFFLINE HTTP fixture only' }]; t.segments = [{ id: 's1', strategy: 'performance', duration: 5, direction: 'Empty blue stage.', referenceIds: [], requirementIds: ['scene'] }]; t.occurrences = []; });
    const template = await readJson(join(projectRoot, 'hypit', 'hypit.runtime.cangyuan.json'));
    template.credentials = { env: { use: '@hypit/credential-store-env' } };
    Object.assign(template.endpoints['minimax.official'].config, { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: { store: 'env', key: 'HYPIT_OFFLINE_TEST_CREDENTIAL' }, pollIntervalMs: 1000 });
    process.env.HYPIT_OFFLINE_TEST_CREDENTIAL = 'OFFLINE-MOCK-NOT-A-SECRET';
    const p = await prepare(f.taskPath, { ledgerRoot: f.ledgerRoot, runtimeTemplate: template });
    const s = p.segments[0];
    try {
        await checkPlan(p);
        const first = await hypit(['build', s.run, '--runtime', s.runtime, '--follow', '--max-wait-ms', '3000']);
        assert.ok(first.build.id);
        const ledger = await readLedger(p.ledgerRoot);
        assert.equal(ledger.intents[s.intentId]?.handle?.taskId, 'OFFLINE-LOCALHOST-TASK');
        assert.equal(posts, 1);
        await hypit(['build', s.run, '--runtime', s.runtime, '--follow', '--max-wait-ms', '3000']);
        assert.equal(posts, 1);
    }
    finally {
        await hypit(['runtime', 'down', s.runtime]);
        server.close();
        delete process.env.HYPIT_OFFLINE_TEST_CREDENTIAL;
    }
});
test('authorization scope and expiry block new payment, but expiry cannot block known-task recovery', async () => {
    const outside = await fixture(t => t.authorization.taskIds = ['different-task']);
    assert.throws(() => validateTask(outside.task), /范围/);
    const expired = await fixture(t => t.authorization.expiresAt = '2000-01-01T00:00:00Z');
    assert.throws(() => validateTask(expired.task), /过期/);
    const f = await fixture(t => t.authorization.expiresAt = new Date(Date.now() + 60000).toISOString());
    const p = await f.prepare();
    const policy = createSubmissionPolicy({ planPath: p.manifest, ledgerRoot: p.ledgerRoot });
    const a = await policy.authorize(policyInput(p));
    await policy.submitted(a.intentId, { taskId: 'OFFLINE-EXPIRED-GRANT-TASK', startedAt: 0, uploadedKeys: [], intentId: a.intentId });
    const now = Date.now;
    try {
        Date.now = () => Date.parse(p.task.authorization.expiresAt) + 1;
        assert.equal((await policy.authorize(policyInput(p))).kind, 'resume');
    }
    finally {
        Date.now = now;
    }
});
test('changing a submitted plan cannot silently reuse the same task revision', async () => {
    const f = await fixture();
    const p = await f.prepare();
    await createSubmissionPolicy({ planPath: p.manifest, ledgerRoot: p.ledgerRoot }).authorize(policyInput(p));
    await writeFile(join(f.dir, 'script.txt'), 'Different speech');
    await assert.rejects(f.prepare(), /revision/);
    f.task.revision++;
    await atomicJson(f.taskPath, f.task);
    const next = await f.prepare();
    assert.notEqual(next.planHash, p.planHash);
});
test('actual long-video splitting covers all frames and tail without exceeding reference limit', async () => {
    const f = await fixture();
    const long = join(f.dir, 'long.mp4');
    await run('ffmpeg', ['-v', 'error', '-stream_loop', '6', '-i', join(f.dir, 'source.mp4'), '-t', '31.2', '-c', 'copy', long]);
    const split = await splitVideo(long, join(f.dir, 'long-segments'));
    assert.equal(split.clips.length, 3);
    assert.equal(split.clips[0].start, 0);
    assert.equal(split.clips.at(-1).end, split.source.info.duration);
    assert.ok(split.clips.every(s => s.info.duration <= 15.05 && s.info.hasAudio));
});
test('partial listening and old final Build cannot masquerade as full-film acceptance', async () => {
    const f = await fixture();
    const p = await f.prepare();
    const model = await mockAcceptedModel(f, p);
    await assert.rejects(recordReview(p, { kind: 'model', segmentId: 's1', observedHash: model.sha256, checks: [{ key: 'voice', verdict: 'pass', reviewer: 'test', method: 'listening', coverage: { start: 0, end: 1 }, note: 'Only opening', evidence: [{ file: model.file, sha256: model.sha256 }] }] }), /完整/);
    const c = await compose(p, { width: 768, height: 768, regions: { 'pip-host': [65, 60, 95, 95] } });
    await recordCompletedBuild(p, 'final', undefined, mockBuild('OLD-FINAL'));
    await assert.rejects(registerOutput(p, { kind: 'final', file: model.file, buildId: 'UNRELATED-FINAL' }), /Build/);
    const original = await readFile(join(dirnamePortable(c.run), 'review.svs'), 'utf8');
    await writeFile(join(dirnamePortable(c.run), 'review.svs'), original + '\n');
    await assert.rejects(registerOutput(p, { kind: 'final', file: model.file, buildId: 'OLD-FINAL' }), /改变/);
});

test('each generated segment must explicitly account for its own person and product occurrences',async()=>{
  const f=await fixture(t=>t.segments.push({...t.segments[0],id:'s2'}));assert.throws(()=>validateTask(f.task),/s2.*出现区域/);
});

test('retained recording lip-sync is reviewed on final mix rather than silent generated picture', async () => {
    const f = await fixture(t => {
        t.audio = { mode: 'recording', assetId: 'source', lipsyncRequired: true };
        t.segments[0].referenceIds = ['person', 'product', 'source'];
        t.requirements = t.requirements.filter(r => r.id !== 'voice');
        t.segments[0].requirementIds = t.requirements.map(r => r.id);
    });
    const p = await f.prepare();
    assert.equal(criteria(p, 'model', 's1').includes('lipsync'), false);
    assert.equal(criteria(p, 'final').includes('lipsync'), true);
    assert.equal(criteria(p, 'final').includes('dialogue'), true);
});
