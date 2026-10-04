import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EndpointRegistry, MemoryResourceStore } from '@hypit/driver-node';
import { sealMinimaxH3Request, minimaxH3Endpoints } from '@hypit/minimax-h3';
import { createOfficialMiniMaxProvider } from '../src/provider.ts';
import { fixture, policyInput } from '../../../../packages/replication-workflow/test/helpers.mjs';
import { readLedger } from '../../../../packages/replication-workflow/src/ledger.mjs';
async function setup(fetcher, { mutate = () => { }, requestMutate = () => { }, policyModule } = {}) {
    const f = await fixture(mutate);
    const plan = await f.prepare();
    const s = plan.segments[0];
    const resources = new MemoryResourceStore();
    const ports = { prompt: [s.prompt], duration: [s.duration], resolution: [plan.task.resolution], aspectRatio: [plan.task.ratio] };
    for (const kind of ['image', 'video', 'audio']) {
        const refs = s.references.filter(a => a.kind === kind);
        if (!refs.length)
            continue;
        ports[{ image: 'referenceImage', video: 'referenceVideo', audio: 'referenceAudio' }[kind]] = await Promise.all(refs.map(async (a) => ({ role: kind, artifact: await resources.put(new Uint8Array(await readFile(a.file)), a.mediaType) })));
    }
    requestMutate(ports);
    const constraints = sealMinimaxH3Request(ports);
    const need = { id: policyInput(plan).needId, capability: minimaxH3Endpoints.video.capability, returns: minimaxH3Endpoints.video.returns, constraints, result: 'record:fixture' };
    const registry = new EndpointRegistry();
    await createOfficialMiniMaxProvider({ fetch: fetcher, baseUrl: 'http://localhost:4010', submissionPolicyModule: policyModule ?? fileURLToPath(new URL('../../../../packages/replication-workflow/src/policy.mjs', import.meta.url)), submissionPlan: plan.manifest, submissionLedgerRoot: plan.ledgerRoot }).install(registry);
    const found = registry.resolve(need);
    assert.equal(found.status, 'resolved');
    const context = { command: { kind: 'fulfill-need', id: 'command:fixture', need }, need, resources, credentials: { apiKey: { secret: 'OFFLINE-FAKE-KEY' } }, operation: policyInput(plan).operation };
    return { f, plan, endpoint: found.registration.endpoint, context };
}
test('guarded Provider submits exactly once and resumes same official receipt on second Build', async () => {
    let posts = 0;
    const x = await setup(async (_url, init) => { assert.equal(init.method, 'POST'); posts++; const body = JSON.parse(init.body); assert.equal(body.model, 'MiniMax-H3'); assert.equal('submissionPlan' in body, false); return Response.json({ task_id: 'MOCK-TASK-1' }); });
    const a = await x.endpoint.start(x.context);
    const b = await x.endpoint.start(x.context);
    assert.equal(a.status, 'pending');
    assert.equal(b.status, 'pending');
    assert.equal(b.receipt.id, 'MOCK-TASK-1');
    assert.equal(posts, 1);
    assert.ok(!JSON.stringify(await readLedger(x.plan.ledgerRoot)).includes('data:'));
});
test('guarded Provider catches changed prompt and image ordering before any POST', async () => {
    for (const requestMutate of [p => p.prompt[0] += 'changed', p => p.referenceImage.reverse()]) {
        let posts = 0;
        const x = await setup(async () => { posts++; throw Error('never'); }, { requestMutate });
        const result = await x.endpoint.start(x.context);
        assert.equal(result.status, 'failed');
        assert.match(result.failure.message, /计划不一致/);
        assert.equal(posts, 0);
    }
});
test('POST response loss is persisted as unknown and never auto-resubmitted', async () => {
    let posts = 0;
    const x = await setup(async () => { posts++; throw Error('connection lost after POST'); });
    const a = await x.endpoint.start(x.context);
    const b = await x.endpoint.start(x.context);
    assert.equal(a.status, 'failed');
    assert.equal(b.status, 'failed');
    assert.equal(posts, 1);
    assert.equal(Object.values((await readLedger(x.plan.ledgerRoot)).intents)[0].state, 'submission_unknown');
});
test('checkpoint failure preserves task ID independently and restores polling without a POST', async () => {
    let posts = 0;
    const x = await setup(async () => { posts++; return Response.json({ task_id: 'MOCK-CHECKPOINT' }); });
    const a = await x.endpoint.start({ ...x.context, checkpoint: async () => { throw Error('checkpoint disk failure'); } });
    assert.equal(a.status, 'failed');
    assert.equal(a.receipt.id, 'MOCK-CHECKPOINT');
    const b = await x.endpoint.start(x.context);
    assert.equal(b.status, 'pending');
    assert.equal(b.receipt.id, 'MOCK-CHECKPOINT');
    assert.equal(posts, 1);
});
test('task ID persistence failure retains known receipt and closes duplicate submission path', async () => {
    // Simulate an independent ledger write failing after the remote accepted the request.
    let posts = 0;
    const x = await setup(async () => { posts++; return Response.json({ task_id: 'MOCK-LEDGER-WRITE' }); });
    const wrapper = join(x.f.dir, 'failing-policy.mjs');
    const real = new URL('../../../../packages/replication-workflow/src/policy.mjs', import.meta.url).href;
    await writeFile(wrapper, `import {createSubmissionPolicy as real} from ${JSON.stringify(real)}; export function createSubmissionPolicy(options) { const p=real(options); return {...p,submitted:async()=>{throw Error('simulated disk write failure')}}; }`);
    const registry = new EndpointRegistry();
    await createOfficialMiniMaxProvider({ fetch: async () => { posts++; return Response.json({ task_id: 'MOCK-LEDGER-WRITE' }); }, baseUrl: 'http://localhost:4010', submissionPolicyModule: wrapper, submissionPlan: x.plan.manifest, submissionLedgerRoot: x.plan.ledgerRoot }).install(registry);
    const endpoint = registry.resolve(x.context.need).registration.endpoint;
    const a = await endpoint.start(x.context);
    assert.equal(a.status, 'failed');
    assert.equal(a.receipt.id, 'MOCK-LEDGER-WRITE');
    const b = await endpoint.start(x.context);
    assert.equal(b.receipt.id, 'MOCK-LEDGER-WRITE');
    assert.equal(posts, 1);
});
test('query and download faults keep original receipt and collect original audible video', async () => {
    let posts = 0, queries = 0, downloads = 0, cdnCredential = '';
    let bytes;
    const x = await setup(async (url, init) => {
        if (init.method === 'POST') {
            posts++;
            return Response.json({ task_id: 'MOCK-RESULT' });
        }
        if (String(url).includes('/v2/query/')) {
            queries++;
            if (queries === 1)
                return new Response('transient', { status: 503 });
            return Response.json({ task: { id: 'MOCK-RESULT', status: 'succeeded', content: { url: 'https://cdn.example/mock.mp4' } } });
        }
        downloads++;
        cdnCredential = new Headers(init.headers).get('authorization');
        if (downloads === 1)
            return new Response('transient', { status: 503 });
        return new Response(bytes, { headers: { 'content-type': 'video/mp4' } });
    });
    bytes = await readFile(join(x.f.dir, 'generated.mp4'));
    const submitted = await x.endpoint.start(x.context);
    assert.equal((await x.endpoint.poll({ ...x.context, handle: submitted.handle })).status, 'pending');
    const ready = await x.endpoint.poll({ ...x.context, handle: submitted.handle });
    assert.equal(ready.status, 'ready');
    assert.equal((await x.endpoint.collect({ ...x.context, handle: ready.handle })).status, 'pending');
    const done = await x.endpoint.collect({ ...x.context, handle: ready.handle });
    assert.equal(done.status, 'completed');
    assert.equal(posts, 1);
    assert.equal(cdnCredential, null);
    const item = Object.values((await readLedger(x.plan.ledgerRoot)).intents)[0];
    assert.equal(item.state, 'generated_unreviewed');
    assert.equal(item.output.hasAudio, true);
    assert.equal('url' in item.output, false);
    assert.equal('accepted' in item, false);
});
test('ordinary build with a guarded Runtime but no matching execution source cannot pay', async () => {
    let posts = 0;
    const x = await setup(async () => { posts++; throw Error('never'); });
    const result = await x.endpoint.start({ ...x.context, need: { ...x.context.need, id: 'need:another-run' } });
    assert.equal(result.status, 'failed');
    assert.equal(posts, 0);
});
test('partial policy configuration is rejected instead of silently disabling protection', () => {
    assert.throws(() => createOfficialMiniMaxProvider({ submissionPlan: '/tmp/plan.json' }), /同时配置/);
    assert.throws(() => createOfficialMiniMaxProvider({ submissionPlan: '', submissionLedgerRoot: '', submissionPolicyModule: '' }), /同时配置/);
});

test('invalid collected media stays a technical failure and cannot reopen a paid intent', async () => {
    let posts = 0;
    const x = await setup(async (_url, init) => {
        if (init.method === 'POST') { posts++; return Response.json({ task_id: 'MOCK-BAD-MEDIA' }); }
        return new Response('not an mp4', { headers: { 'content-type': 'video/mp4' } });
    });
    const submitted = await x.endpoint.start(x.context);
    const invalid = await x.endpoint.collect({ ...x.context, handle: { ...submitted.handle, url: 'https://cdn.example/bad.mp4' } });
    assert.equal(invalid.status, 'failed');
    assert.equal((await readLedger(x.plan.ledgerRoot)).intents[x.plan.segments[0].intentId].state, 'technical_failed');
    const resumed = await x.endpoint.start(x.context);
    assert.equal(resumed.receipt.id, 'MOCK-BAD-MEDIA');
    assert.equal(posts, 1);
});
