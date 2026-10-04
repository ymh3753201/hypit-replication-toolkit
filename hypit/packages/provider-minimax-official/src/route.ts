import { compileWireRequest, generationTypes, sealGeneratedVideoSet } from "@hypit/generation";
import type { GenerationRequest, GenerationWireMapping } from "@hypit/generation";
import { canonicalize } from "@hypit/protocol";
import type { BlobRef, CanonicalValue } from "@hypit/protocol";
import type { EndpointRequest, EndpointSupport } from "@hypit/endpoint-kit";

const mapping: GenerationWireMapping = {
  capability: { module: { name: "@hypit/minimax-h3", version: "1" }, name: "minimax-h3" },
  result: "video", routes: [{ model: "MiniMax-H3" }],
  fields: {
    prompt: { as: "value", field: "text" },
    duration: { as: "value", field: "duration" },
    resolution: { as: "value", field: "resolution", whenAbsent: "768P" },
    aspectRatio: { as: "value", field: "ratio" },
    firstFrame: { as: "url", field: "first_frame" },
    lastFrame: { as: "url", field: "last_frame" },
    referenceImage: { as: "urlArray", field: "reference_image" },
    referenceVideo: { as: "urlArray", field: "reference_video" },
    referenceAudio: { as: "urlArray", field: "reference_audio" },
  },
};

function list(value: unknown): string[] { return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []; }
function item(type: "image_url" | "video_url" | "audio_url", url: string, role: string) { return { type, [type]: { url }, role }; }

export function validateOfficialH3(request: GenerationRequest): void {
  const ports = request.ports;
  if (typeof ports.prompt?.[0] !== "string" || !ports.prompt[0].trim() || ports.prompt[0].length > 7_000) throw new Error("MiniMax H3 提示词不能为空且不得超过 7000 字");
  const duration = ports.duration?.[0];
  if (typeof duration !== "number" || !Number.isInteger(duration) || duration < 4 || duration > 15) throw new Error("MiniMax H3 时长须为 4–15 秒的整数");
  const resolution = ports.resolution?.[0];
  if (resolution !== undefined && resolution !== "768P" && resolution !== "2K") throw new Error("MiniMax H3 仅支持 768P 或 2K");
  const ratio = ports.aspectRatio?.[0];
  if (ratio !== undefined && !["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].includes(String(ratio))) throw new Error("MiniMax H3 不支持所选画幅");
  const hasRefs = ["referenceImage", "referenceVideo", "referenceAudio"].some(port => (ports[port]?.length ?? 0) > 0);
  const hasFrames = (ports.firstFrame?.length ?? 0) > 0 || (ports.lastFrame?.length ?? 0) > 0;
  if (hasRefs && hasFrames) throw new Error("MiniMax H3 参考素材与首尾帧不能混用");
  if (!hasRefs && !hasFrames && !ports.aspectRatio?.[0]) throw new Error("MiniMax H3 文生视频必须指定画幅");
  if ((ports.referenceImage?.length ?? 0) > 9 || (ports.referenceVideo?.length ?? 0) > 3 || (ports.referenceAudio?.length ?? 0) > 3) throw new Error("MiniMax H3 参考素材数量超过官方限制");
  if (["referenceImage", "referenceVideo", "referenceAudio"].reduce((n, port) => n + (ports[port]?.length ?? 0), 0) > 12) throw new Error("MiniMax H3 参考素材总数不能超过 12");
  if ((ports.referenceAudio?.length ?? 0) > 0 && !ports.referenceImage?.length && !ports.referenceVideo?.length) throw new Error("MiniMax H3 音频参考须伴随图片或视频");
  if ((ports.firstFrame?.length ?? 0) > 1 || (ports.lastFrame?.length ?? 0) > 1) throw new Error("MiniMax H3 首帧与尾帧各只允许一张图片");
}

export function officialH3Body(input: Record<string, unknown>): Record<string, unknown> {
  const first = typeof input.first_frame === "string" ? [item("image_url", input.first_frame, "first_frame")] : [];
  const last = typeof input.last_frame === "string" ? [item("image_url", input.last_frame, "last_frame")] : [];
  const references = [
    ...list(input.reference_image).map(url => item("image_url", url, "reference_image")),
    ...list(input.reference_video).map(url => item("video_url", url, "reference_video")),
    ...list(input.reference_audio).map(url => item("audio_url", url, "reference_audio")),
  ];
  const ratio = first.length || last.length ? "adaptive" : input.ratio ?? (references.length ? "adaptive" : undefined);
  return {
    model: "MiniMax-H3",
    content: [{ type: "text", text: input.text }, ...first, ...last, ...references],
    resolution: input.resolution ?? "768P",
    duration: input.duration,
    ...(ratio === undefined ? {} : { ratio }),
  };
}

export const officialH3Route = {
  capability: mapping.capability,
  returns: generationTypes.videoSet,
  supports: (need: EndpointRequest): EndpointSupport => {
    try { validateOfficialH3(need.constraints as unknown as GenerationRequest); return { status: "supported" }; }
    catch (error) { return { status: "unsupported", reason: error instanceof Error ? error.message : String(error) }; }
  },
  prepare: (constraints: CanonicalValue) => {
    const request = constraints as unknown as GenerationRequest;
    validateOfficialH3(request);
    return { compile: async (resolve: Parameters<typeof compileWireRequest>[2]) => officialH3Body((await compileWireRequest(mapping, request, resolve)).input as Record<string, unknown>) };
  },
  packageResult: (videos: readonly BlobRef[]) => ({ kind: "inline" as const, value: canonicalize(sealGeneratedVideoSet({ videos })) }),
};
