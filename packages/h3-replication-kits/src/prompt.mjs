// Labels follow the same ordered references as the real h3:Reference edges.
// This is prompt guidance, never a claim that reference conditioning locks identity.
export function buildPrompt(task, segment, references, script) {
    const labels = { image: 'Picture', video: 'Video', audio: 'Audio' };
    const counts = { image: 0, video: 0, audio: 0 };
    const named = references.map(a => ({ ...a, label: `<${labels[a.kind]} ${++counts[a.kind]}>` }));
    const byId = new Map(named.map(a => [a.id, a]));
    const selected = task.requirements.filter(r => segment.requirementIds.includes(r.id));
    const subjects = [...new Set(selected.map(r => r.subject))];
    const subjectLabel = subject => `<Subject ${subjects.indexOf(subject) + 1}>`;
    const roles = named.map(a => `${a.label} supplies ${a.purposes.join(', ')} for ${a.subject}: ${a.description}. Use only the stated properties.${a.frameRole ? ` This is the actual ${a.frameRole} input.` : ''}`);
    const definitions = subjects.map(subject => {
        const bindings = selected.filter(r => r.subject === subject).flatMap(r => (r.referenceIds ?? []).map(id => `${byId.get(id).label} for ${r.kind}${r.attribute ? '/' + r.attribute : ''} (${r.operation})`));
        return `${subjectLabel(subject)} is ${subject}. ${[...new Set(bindings)].join('; ') || 'Follow the requirements and passage direction below.'}`;
    });
    const requirements = selected.map(r => `${r.operation.toUpperCase()} ${r.kind}${r.attribute ? ` attribute ${r.attribute}` : ''} of ${r.subject}: ${r.description}. [${subjectLabel(r.subject)}]`);
    const identityChanges = selected.filter(r => r.kind === 'person' && r.operation === 'replace' && (!r.attribute || ['face', 'identity', 'full', 'all'].includes(r.attribute)))
        .map(r => `For subject ${r.subject} only, replace the original ${r.attribute ?? 'person identity'} as requested. Do not preserve that original identity; retain the other explicitly preserved attributes and subjects. ${subjectLabel(r.subject)} gets the replacement identity from ${(r.referenceIds ?? []).filter(id => byId.get(id)?.purposes.includes('identity')).map(id => byId.get(id).label).join(', ')} throughout every applicable shot. Motion references supply the requested action and camera behavior, not this replaced identity.`);
    const shots = (segment.shots ?? []).map((shot, i) => `[Shot ${i + 1}] ${shot.start}s–${shot.end}s. Subjects: ${shot.subjects.map(subjectLabel).join(', ')}. References: ${shot.referenceIds.map(id => byId.get(id).label).join(', ')}. ${shot.direction}`);
    const audio = {
        generated: `Generate the picture and the new speech together in this one video. Voice direction: ${task.audio.description ?? 'natural clear speech'}.`,
        voice_reference: 'Generate picture and speech together. Use the designated audio only for voice identity; do not repeat its sample words.',
        preserve: 'Picture generation only; the specified original recording will be retained by local composition. Do not invent new speech.',
        recording: 'Picture generation only; the supplied recording is the authoritative final sound. Do not invent a second narration.',
        silent: 'The final scene is silent B-roll. No speech or narration is requested.',
    }[task.audio.mode];
    const caption = task.captions?.mode === 'local'
        ? 'Overlay captions are composed locally; generate no subtitle overlays. Keep required in-scene product and brand text.'
        : task.captions?.mode === 'none'
        ? 'No subtitle overlays. Keep required in-scene product and brand text.'
        : task.captions?.mode === 'model'
        ? `Generate the required on-screen captions in this video: ${task.captions.description}`
        : 'Follow only the explicitly requested on-screen text and caption directions.';
    return [
        'subject_definitions:', ...definitions, ...roles,
        'summary:', segment.strategy === 'direct_edit' ? 'Edit only the subjects and attributes named in the following requirements. Preserve other stated properties; follow the specified action and camera requirements.' : 'Create a new continuous performance for local composition, with the stated identity, scene and action.',
        'retention_analysis:', ...requirements, ...identityChanges,
        'detailed_description:', segment.direction, ...shots, caption,
        script ? `Authoritative dialogue (verbatim, do not shorten or borrow reference words):\n${script}` : '',
        'Natural continuous motion, consistent subject identity. No pasted still portraits.',
        'overall_soundscape:', audio, task.audio.soundscape ?? 'Follow only the stated ambience and sound-effect requirements.',
        'non_diegetic_music:', task.audio.music ?? 'Follow only the stated music requirements.'
    ].filter(Boolean).join('\n\n');
}
