import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture, mockAcceptedModel } from './helpers.mjs';
import { validateTask } from '../src/plan.mjs';
import { atomicJson, hashFile, run } from '../src/common.mjs';
import { transaction } from '../src/ledger.mjs';
import { registerOutput, recordCompletedBuild, recordReview, reviewStatus, criteria } from '../src/review.mjs';
import { compose } from '../../replication-scenes/src/scene.mjs';

test('subject bindings, shots and caption responsibility reach the actual planned request', async () => {
  const f = await fixture(t => {
    t.captions = { mode: 'model', description: 'Display 一佳, matching the source caption style.' };
    t.segments[0].shots = [{ id: 'reveal', start: 0, end: 5, subjects: ['host', 'item'], referenceIds: ['person', 'product', 'source'], direction: 'The host raises the bottle with the same hand and framing.' }];
  });
  const p = await f.prepare(); const prompt = p.segments[0].summary.content[0].text;
  assert.match(prompt, /subject_definitions:/);
  assert.match(prompt, /<Subject 1>.*host/);
  assert.match(prompt, /<Picture 1>.*identity/);
  assert.match(prompt, /\[Shot 1\].*0.*5/);
  assert.match(prompt, /Display 一佳/);
  assert.doesNotMatch(prompt, /Precise captions and information cards are composed locally/);
  assert.ok(p.warnings.some(w => /身份硬锁/.test(w)));
});

test('shot scope and source-frame provenance reject incomplete or disconnected bindings', async () => {
  const f = await fixture();
  for (const shots of [
    [{ id: 'one', start: 0, end: 4, subjects: ['host'], referenceIds: ['person'], direction: 'pose' }],
    [{ id: 'one', start: 0, end: 5, subjects: ['unknown'], referenceIds: ['person'], direction: 'pose' }],
    [{ id: 'one', start: 0, end: 5, subjects: ['host'], referenceIds: ['missing'], direction: 'pose' }],
  ]) { f.task.segments[0].shots = shots; assert.throws(() => validateTask(f.task), /镜头/); }
  delete f.task.segments[0].shots;
  f.task.assets[0].sourceFrame = { assetId: 'source', time: 6, reviewedBy: 'offline', compositionMatched: true };
  await atomicJson(f.taskPath, f.task);
  await assert.rejects(f.prepare(), /关键帧/);
});

test('9-to-9.417-style duration drift is reviewable but cannot silently reach composition', async () => {
  const f = await fixture(); const p = await f.prepare(); const s = p.segments[0];
  const file = join(f.dir, 'drift.mp4');
  await run('ffmpeg', ['-v','error','-f','lavfi','-i','color=blue:s=768x768:r=24:d=5.416667','-f','lavfi','-i','sine=duration=5.416667','-shortest','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',file]);
  const sha256 = await hashFile(file);
  await transaction(p.ledgerRoot, l => { l.intents[s.intentId] = { state:'generated_unreviewed', handle:{taskId:'OFFLINE-DRIFT'}, output:{sha256} }; });
  await recordCompletedBuild(p,'model','s1',{format:'hypit.cli-build@1',build:{id:'DRIFT-BUILD',work:{outcome:'complete'},result:{state:'complete'}}});
  const a = await registerOutput(p,{kind:'model',segmentId:'s1',file,buildId:'DRIFT-BUILD'});
  assert.ok(a.timing.requiresReview);
  assert.ok((await reviewStatus(p,'model','s1')).missing.includes('timing'));
  await assert.rejects(compose(p,{width:768,height:768}), /尚未通过/);
  const entry = {key:'timing',verdict:'pass',reviewer:'OFFLINE',method:'visual',coverage:{start:0,end:a.info.duration},note:'synthetic tail only',evidence:[{file,sha256}]};
  await assert.rejects(recordReview(p,{kind:'model',segmentId:'s1',observedHash:sha256,checks:[entry]}), /同时看画面并听声音/);
  entry.method='audiovisual';
  await recordReview(p,{kind:'model',segmentId:'s1',observedHash:sha256,checks:[entry]});
  assert.equal((await reviewStatus(p,'model','s1')).missing.includes('timing'),false);
  assert.equal((await reviewStatus(p,'model','s1')).state,'awaiting_review');
});


test('caption ownership prevents duplicate model/local overlays and omitted local captions', async () => {
  for (const mode of ['model','local','none']) {
    const f = await fixture(t => { t.captions={mode,description:'target captions'}; });
    const p = await f.prepare();
    await mockAcceptedModel(f,p);
    const layout = {width:768,height:768,...(mode==='local'?{}:{captions:[{text:'duplicate',start:0,end:5}]})};
    await assert.rejects(compose(p,layout), /字幕/);
  }
});
