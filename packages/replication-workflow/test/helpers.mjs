import { transaction } from '../src/ledger.mjs';
import { recordCompletedBuild, registerOutput, criteria, recordReview } from '../src/review.mjs';
import { mkdtemp, writeFile, copyFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, atomicJson, readJson, digest, hashFile } from '../src/common.mjs';
import { prepare, projectRoot } from '../src/plan.mjs';
let mediaPromise;
export function mediaFixtures() {
    return mediaPromise ??= (async () => {
        const dir = await mkdtemp(join(tmpdir(), 'replication-media-'));
        for (const [name, color] of [['person', 'blue'], ['product', 'red']])
            await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=${color}:s=320x320`, '-frames:v', '1', join(dir, name + '.png')]);
        for (const [name, size] of [['source', '320x320'], ['generated', '768x768']])
            await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${size}:r=30:d=5`, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', join(dir, name + '.mp4')]);
        await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=5', join(dir, 'voice.wav')]);
        return dir;
    })();
}
export async function fixture(mutate = () => { }, root) {
    const testsRoot = join(projectRoot, '.hypit', 'offline-replication-tests');
    await mkdir(testsRoot, { recursive: true });
    const dir = await mkdtemp(join(testsRoot, 'task-'));
    const media = await mediaFixtures();
    for (const name of ['person.png', 'product.png', 'source.mp4', 'generated.mp4', 'voice.wav'])
        await copyFile(join(media, name), join(dir, name));
    await writeFile(join(dir, 'Brief.md'), 'OFFLINE FIXTURE: replace actor and product; keep camera and motion; specified new voice; exact dialogue. No real model quality evidence.');
    await writeFile(join(dir, 'analysis.md'), 'OFFLINE FIXTURE: full frame and inset; original actor must be removed in both.');
    await writeFile(join(dir, 'script.txt'), 'This is our new product.');
    const task = { format: 'replication.task@1', id: 'fixture-task', revision: 1, brief: 'Brief.md', analysis: { file: 'analysis.md', reviewer: 'offline-fixture', regionsComplete: true, requirementsReviewed: true }, ratio: '1:1', resolution: '768P',
        audio: { mode: 'voice_reference', assetId: 'voice', description: 'reference voice', lipsyncRequired: true },
        assets: [{ id: 'person', kind: 'image', file: 'person.png', subject: 'host', purposes: ['identity'], description: 'new face only' }, { id: 'product', kind: 'image', file: 'product.png', subject: 'item', purposes: ['product'], description: 'exact product shape' }, { id: 'source', kind: 'video', file: 'source.mp4', subject: 'old-host', purposes: ['motion'], description: 'camera and motion only; replace old actor' }, { id: 'voice', kind: 'audio', file: 'voice.wav', subject: 'host', purposes: ['voice'], description: 'voice timbre only, not words' }],
        requirements: [{ id: 'person', kind: 'person', operation: 'replace', subject: 'host', attribute: 'face', description: 'new face in all regions', basis: 'offline fixture', referenceIds: ['person'] }, { id: 'product', kind: 'product', operation: 'replace', subject: 'item', description: 'preserve exact supplied product', basis: 'offline fixture', referenceIds: ['product'] }, { id: 'motion', kind: 'action', operation: 'preserve', subject: 'host', description: 'same motion', exact: true, basis: 'offline fixture', referenceIds: ['source'] }, { id: 'voice', kind: 'voice', operation: 'replace', subject: 'host', description: 'specified voice', basis: 'offline fixture', referenceIds: ['voice'] }, { id: 'words', kind: 'dialogue', operation: 'change', subject: 'host', description: 'exact script', basis: 'offline fixture' }],
        segments: [{ id: 's1', strategy: 'direct_edit', duration: 5, direction: 'Natural delivery with the preserved gesture.', referenceIds: ['person', 'product', 'source', 'voice'], requirementIds: ['person', 'product', 'motion', 'voice', 'words'], script: 'script.txt' }],
        occurrences: [{ id: 'main-host', subject: 'host', segmentId: 's1', slot: 'full', start: 0, end: 5, source: 'generated' }, { id: 'pip-host', subject: 'host', segmentId: 's1', slot: 'pip', start: 1, end: 4, source: 'generated' }, { id: 'product-area', subject: 'item', segmentId: 's1', slot: 'product', start: 0, end: 5, source: 'generated' }],
        authorization: { id: 'fixture-grant', service: 'minimax.official', model: 'MiniMax-H3', maxRequests: 3, maxCostCny: 50, approvedBy: 'OFFLINE MOCK ONLY', basis: 'Mocked HTTP only; not permission for any live request', approvedAt: '2026-09-30' },
        pricing: { model: 'MiniMax-H3', resolution: '768P', outputCnyPerSecond: .5, videoCnyPerSecond: .5, extraImageCny: .2, checkedAt: '2026-09-30', source: 'https://platform.minimax.cn/docs/guides/pricing-paygo' } };
    mutate(task);
    await atomicJson(join(dir, 'task.json'), task);
    const ledgerRoot = root ?? join(dir, 'ledger');
    return { dir, task, taskPath: join(dir, 'task.json'), ledgerRoot, prepare: async () => prepare(join(dir, 'task.json'), { ledgerRoot, ...(process.env.HYPIT_TEST_RUNTIME ? { runtimeTemplate: JSON.parse(await readFile(process.env.HYPIT_TEST_RUNTIME, 'utf8')) } : {}) }) };
}
export function policyInput(plan, segment = plan.segments[0]) {
    const assets = segment.references.map((a, i) => ({ url: `https://assets.example/${i}`, sha256: a.sha256, size: a.size, mediaType: a.mediaType }));
    const body = { model: 'MiniMax-H3', content: [{ type: 'text', text: segment.prompt }, ...segment.references.map((a, i) => ({ type: a.kind + '_url', role: a.frameRole ?? 'reference_' + a.kind, [a.kind + '_url']: { url: assets[i].url } }))], duration: segment.duration, resolution: plan.task.resolution, ratio: segment.summary.ratio };
    return { body, assets, operation: 'op_OFFLINE_FIXTURE', needId: 'need:' + encodeURIComponent('author:' + segment.source + '::component::replacement') + ':generate', uploadedKeys: [] };
}

export async function mockAcceptedModel(f, p) {
    const s = p.segments[0];
    const hash = await hashFile(join(f.dir, 'generated.mp4'));
    await transaction(p.ledgerRoot, l => { l.intents[s.intentId] = { intentId: s.intentId, grantId: p.task.authorization.id, requestHash: s.requestHash, costCents: s.costCents, state: 'generated_unreviewed', handle: { taskId: 'OFFLINE-MOCK-NOT-OFFICIAL' }, output: { sha256: hash } }; });
    await recordCompletedBuild(p, 'model', s.id, { format: 'hypit.cli-build@1', build: { id: 'OFFLINE-MOCK-BUILD', work: { outcome: 'complete' }, result: { state: 'complete' } } });
    const model = await registerOutput(p, { kind: 'model', segmentId: s.id, file: join(f.dir, 'generated.mp4'), buildId: 'OFFLINE-MOCK-BUILD' });
    const checks = criteria(p, 'model', s.id).map(key => ({ key, verdict: 'pass', reviewer: 'offline assertion, not human quality acceptance', method: ['voice', 'dialogue', 'requirement:voice', 'requirement:words'].includes(key) ? 'listening' : key === 'lipsync' ? 'audiovisual' : 'visual', coverage: { start: 0, end: 5 }, note: 'Synthetic fixture used only to test state aggregation.', evidence: [{ file: model.file, sha256: model.sha256 }] }));
    await recordReview(p, { kind: 'model', segmentId: s.id, observedHash: hash, checks });
    return model;
}
