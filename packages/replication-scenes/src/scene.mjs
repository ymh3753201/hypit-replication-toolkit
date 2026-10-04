import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join, relative } from 'node:path';
import { xml, hashFile, probe, atomicJson, requireThat as check } from '../../replication-workflow/src/common.mjs';
import { assertUnchanged } from '../../replication-workflow/src/plan.mjs';
import { outputs, reviewStatus } from '../../replication-workflow/src/review.mjs';
// Emit ordinary native Tracks rather than flattening the source into one opaque movie.
export async function compose(plan, layout) {
    await assertUnchanged(plan, { purpose: 'artifact' });
    check(!layout.captions?.length || !['model', 'none'].includes(plan.task.captions?.mode), '字幕责任冲突：已选择模型字幕或无字幕，不能再次添加本地字幕');
    check(plan.task.captions?.mode !== 'local' || layout.captions?.length > 0, '已选择本地字幕，剪辑布局必须提供字幕内容和时间');
    const registry = await outputs(plan);
    const base = dirname(plan.manifest);
    const out = join(base, 'review');
    await mkdir(out, { recursive: true, mode: 0o700 });
    check(Number.isInteger(layout.width) && layout.width > 0 && Number.isInteger(layout.height) && layout.height > 0, '剪辑画布尺寸无效');
    const declarations = [];
    const picture = [];
    const audio = [];
    const captions = [];
    const recipes = ['media.full { stack-order: 0; fit: contain; clip: frame; }', 'film.main { background: #000000; }'];
    const inputs = [];
    const asset = file => xml(relative(out, file));
    const track = async (file) => { inputs.push({ file, sha256: await hashFile(file) }); };
    const duration = plan.segments.reduce((n, s) => n + s.duration, 0);
    let offset = 0;
    declarations.push(`<time:Clock id="clock" frame-rate="30"/><time:Timeline id="program" clock={clock} end="${duration}s"/>`, `<space:Canvas id="canvas" width="${layout.width}" height="${layout.height}"/>`, '<space:Frame id="full" within={canvas} left="0%" top="0%" right="100%" bottom="100%"/>');
    for (const s of plan.segments) {
        check((await reviewStatus(plan, 'model', s.id)).state === 'accepted', `片段 ${s.id} 的人物/商品/声音等必需项尚未通过，停止剪辑交付`);
        const model = registry.model[s.id];
        await track(model.file);
        declarations.push(`<media:Video id="clip-${s.id}" src="${asset(model.file)}"/>`, `<pipeline:Normalize id="norm-${s.id}" source={clip-${s.id}} video="primary-moving" audio="default" span-authority="video" clock={clock}/>`);
        picture.push(`<media-track:Item id="main-${s.id}" media={norm-${s.id}.media} frame={full} at="${offset}s" for="${s.duration}s" appearance={look.media.full}/>`);
        for (const region of plan.task.occurrences.filter(o => o.segmentId === s.id && o.slot === 'pip')) {
            const box = layout.regions?.[region.id];
            check(box && box.every(Number.isFinite) && box.length === 4, '小窗须提供 [left,top,right,bottom] 百分比布局');
            check(box[0] >= 0 && box[1] >= 0 && box[2] <= 100 && box[3] <= 100 && box[2] > box[0] && box[3] > box[1], '小窗范围无效');
            declarations.push(`<space:Frame id="frame-${region.id}" within={canvas} left="${box[0]}%" top="${box[1]}%" right="${box[2]}%" bottom="${box[3]}%"/>`);
            recipes.push(`media.${region.id} { stack-order: 20; fit: contain; clip: frame; trim-start: ${Math.round(region.start * 30)}; trim-end: ${Math.round(region.end * 30)}; }`);
            picture.push(`<media-track:Item id="pip-${region.id}" media={norm-${s.id}.media} frame={frame-${region.id}} at="${offset + region.start}s" for="${region.end - region.start}s" appearance={look.media.${region.id}}/>`);
        }
        if (['generated', 'voice_reference'].includes(plan.task.audio.mode))
            audio.push(`<audio:Item id="sound-${s.id}" source={norm-${s.id}.media} at="${offset}s" for="${s.duration}s" playback="once"/>`);
        offset += s.duration;
    }
    if (['preserve', 'recording'].includes(plan.task.audio.mode)) {
        const a = plan.task.assets.find(a => a.id === plan.task.audio.assetId);
        const file = resolve(dirname(plan.taskPath), a.file);
        await track(file);
        declarations.push(`<media:${a.kind === 'video' ? 'Video' : 'Audio'} id="retained-audio" src="${asset(file)}"/>`, `<pipeline:Normalize id="retained" source={retained-audio} video="none" audio="default" span-authority="audio" clock={clock}/>`);
        audio.push(`<audio:Item id="retained-sound" source={retained.media} during="program" playback="once"/>`);
    }
    for (const [i, card] of (layout.cards ?? []).entries()) {
        check(card.assetId && card.reviewedNoOldSubjectBy, '卡片须确认不会带入旧人物');
        const a = plan.task.assets.find(a => a.id === card.assetId);
        check(a?.kind === 'image', '卡片必须使用已登记图片');
        const file = resolve(dirname(plan.taskPath), a.file);
        await track(file);
        const box = card.box ?? [0, 0, 100, 100];
        check(box.length === 4 && box.every(Number.isFinite) && box[0] >= 0 && box[1] >= 0 && box[2] <= 100 && box[3] <= 100 && box[2] > box[0] && box[3] > box[1], '卡片区域无效');
        check(card.start >= 0 && card.end > card.start && card.end <= duration, '卡片时间范围无效');
        check(Number.isFinite(card.width) && card.width > 0 && Number.isFinite(card.height) && card.height > 0, '卡片需登记真实图片尺寸');
        const dimensions = await probe(file);
        check(dimensions.width === card.width && dimensions.height === card.height, '卡片声明尺寸与真实图片不同');
        declarations.push(`<media:Image id="card-${i}" src="${asset(file)}"/>`, `<space:Extent id="extent-${i}" width="${card.width}" height="${card.height}"/>`, `<space:Frame id="card-frame-${i}" within={canvas} left="${box[0]}%" top="${box[1]}%" right="${box[2]}%" bottom="${box[3]}%"/>`);
        recipes.push(`media.card${i} { stack-order: 10; fit: contain; clip: frame; }`);
        picture.push(`<media-track:Item id="card-item-${i}" image={card-${i}} extent={extent-${i}} frame={card-frame-${i}} at="${card.start}s" for="${card.end - card.start}s" appearance={look.media.card${i}}/>`);
    }
    if (layout.captions?.length) {
        check(layout.fontFile, '字幕需要已准备好的精确字体文件');
        const fontFile = resolve(dirname(plan.taskPath), layout.fontFile);
        await track(fontFile);
        declarations.push(`<media:Font id="font" src="${asset(fontFile)}" weight="400" style="normal"/>`, '<space:Frame id="caption-frame" within={canvas} left="5%" top="80%" right="95%" bottom="98%"/>', '<typo:Style id="caption-style" font={font} recipe={look.text.caption}><typo:Fill color="#ffffff"/><typo:Stroke color="#000000" width="2" placement="outside"/></typo:Style>');
        recipes.push('text.caption { stack-order: 50; size: 40; weight: 400; }');
        for (const [i, c] of layout.captions.entries()) {
            check(c.text && c.start >= 0 && c.end > c.start && c.end <= duration, '字幕内容或时间无效');
            captions.push(`<typo:Area id="caption-${i}" placement={caption-frame} style={caption-style} at="${c.start}s" for="${c.end - c.start}s">${xml(c.text)}</typo:Area>`);
        }
    }
    const imports = [['media', 'media'], ['pipeline', 'media-pipeline'], ['media-track', 'media-track'], ['audio', 'audio-track'], ['time', 'timeline-author'], ['space', 'spatial'], ['typo', 'typography-track'], ['film', 'film'], ['render', 'render-hyperframes']].map(([as, p]) => `<import as="${as}" from="@hypit/${p}@1"/>`).join('\n');
    const source = `<?svml using="@hypit/markup@1"?>\n<svml>\n${imports}\n<import as="look" source="./review.svs"/>\n${declarations.join('\n')}\n<media-track:Track id="picture" timeline={program.timeline} canvas={canvas}>${picture.join('\n')}</media-track:Track>\n${audio.length ? `<audio:Track id="sound" timeline={program.timeline}>${audio.join('\n')}</audio:Track>` : ''}\n${captions.length ? `<typo:Track id="captions" timeline={program.timeline}>${captions.join('\n')}</typo:Track>` : ''}\n<film:Film id="main" canvas={canvas} timeline={program.timeline} appearance={look.film.main}><film:Track source={picture.visual}/>${audio.length ? '<film:Track source={sound.audio}/>' : ''}${captions.length ? '<film:Track source={captions.track}/>' : ''}</film:Film>\n<render:Video id="final" composition={main.composition} timeline={program.timeline}/>\n</svml>\n`;
    const file = join(out, 'review.svml');
    const run = join(out, 'review.svrun');
    const style = join(out, 'review.svs');
    await writeFile(file, source, { mode: 0o600 });
    await writeFile(style, `<?svml using="@hypit/svs@1"?>\n<sheet version="1">${recipes.join('\n')}</sheet>\n`, { mode: 0o600 });
    await writeFile(run, '<?svml using="@hypit/run-markup@1"?>\n<svrun version="1"><author source="./review.svml"/><target output="final.video"/></svrun>\n', { mode: 0o600 });
    for (const f of [file, style, run])
        await track(f);
    const localRuntime = join(out, 'local.runtime.json');
    const generationRuntime = await import('node:fs/promises').then(fs => fs.readFile(plan.segments.find(s => s.strategy !== 'reuse')?.runtime ?? join(base, 'local.runtime-template.json'), 'utf8')).catch(() => null);
    // Keep only local endpoints: no video/voice generation is possible from this review Run.
    const template = generationRuntime ? JSON.parse(generationRuntime) : JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(new URL('../../../hypit/hypit.runtime.cangyuan.json', import.meta.url), 'utf8')));
    await atomicJson(localRuntime, { format: template.format, dataRoot: join(out, 'runtime-data'), endpoints: { 'media.local': template.endpoints['media.local'], 'hyperframes.local': template.endpoints['hyperframes.local'] }, bindings: {} });
    await track(localRuntime);
    const composition = { format: 'replication.composition@1', planHash: plan.planHash, run, runtime: localRuntime, inputs, layout, status: 'composed', audioSource: plan.task.audio.mode };
    await atomicJson(join(base, 'composition.json'), composition);
    return composition;
}
