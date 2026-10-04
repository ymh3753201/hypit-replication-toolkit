import { requestDeadline } from "@hypit/runtime-kit";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AsyncEndpoint, EndpointCredential, EndpointOutcome } from "@hypit/endpoint-kit";
import { defineEndpointPackage, wakeAfter } from "@hypit/endpoint-kit";
import type { GenerationRequest } from "@hypit/generation";
import { canonicalize } from "@hypit/protocol";
import type { BlobRef, CapabilityRef } from "@hypit/protocol";
import { credentialRef } from "@hypit/runtime";
import type { CredentialRef, ResourceStore } from "@hypit/runtime";
import { hiApiRoutes } from "@hypit/provider-hiapi";
import { prepareMedia } from "./media.js";
export const cangyuanProviderModuleRef = { name: "@hypit/provider-cangyuan", version: "1" } as const;
export type CreateCangyuanProviderOptions = {
 readonly instance?: string; readonly pool?: string; readonly baseUrl?: string; readonly apiKey?: CredentialRef;
 readonly defaultConcurrency?: number; readonly actionLimits?: import("@hypit/endpoint-kit").EndpointActionLimits;
 readonly pollIntervalMs?: number; readonly requestTimeoutMs?: number; readonly operationTimeoutMs?: number;
 readonly fetch?: typeof globalThis.fetch;
 readonly publicAssetUrl?: (artifact: BlobRef, resources: ResourceStore, fields?: Readonly<Record<string, string | number | boolean>>) => Promise<string>;
 readonly ossPython?: string; readonly ossStorageModule?: string;
 readonly primaryModel?: string; readonly fallbackModel?: string; readonly fallbackModels?: readonly string[]; readonly disabledModels?: readonly string[];
};
type Handle = { contract: "hypit.cangyuan-operation@1"; taskId: string; capability: string; startedAt: number; model: string; mute: boolean; url?: string; uploadedKeys: string[] };
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function object(value: unknown, subject: string): Record<string, unknown> { assert(value && typeof value === "object" && !Array.isArray(value), `${subject} must be an object`); return value as Record<string, unknown>; }
function capabilityKey(cap: CapabilityRef): string { return `${cap.module.name}@${cap.module.version}#${cap.name}`; }
function routeFor(cap: CapabilityRef) { return hiApiRoutes.find(r => capabilityKey(r.capability) === capabilityKey(cap)); }
function apiKey(credentials: Readonly<Record<string, EndpointCredential>>): string { const key = credentials.apiKey?.secret; assert(key, "Cangyuan API key is unavailable"); return key; }
function redact(value: string): string { return value.replace(/https?:\/\/[^\s"'<>]+/gu, "[URL redacted]").replace(/(?:sk-|Bearer\s+)[A-Za-z0-9._-]+/gu, "[credential redacted]"); }
function fail(error: unknown, taskId?: string): EndpointOutcome { return { status: "failed", ...(taskId ? { receipt: { id: taskId } } : {}), failure: { code: "CANGYUAN_ERROR", message: redact(error instanceof Error ? error.message : String(error)) } }; }
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
class TransportError extends Error {}
class Client {
 constructor(readonly base: string, readonly timeout: number, readonly fetcher: typeof globalThis.fetch) {}
 async read(url: string, init: RequestInit = {}): Promise<Response> {
   const deadline = requestDeadline(this.timeout);
   try {
     const response = await deadline.wait(this.fetcher(url, { ...init, signal: deadline.signal }));
     const bytes = await deadline.wait(response.arrayBuffer());
     if (!response.ok) throw new HttpError(response.status, `Cangyuan HTTP ${response.status}: ${redact(new TextDecoder().decode(bytes)).slice(0, 800)}`);
     return new Response(bytes, { status: response.status, headers: response.headers });
   } catch (error) { if (error instanceof HttpError) throw error; throw new TransportError(redact(error instanceof Error ? error.message : String(error))); }
   finally { deadline.finish(); }
 }
 async json(path: string, key: string, init: RequestInit = {}) { const response = await this.read(`${this.base}${path}`, { ...init, headers: { authorization: `Bearer ${key}`, ...init.headers } }); return object(await response.json(), "Cangyuan response"); }
}
// Model contracts verified against the service documentation on 2026-09-27.
export const modelContracts = {
 "sd12-seedance-2.0": { resolution: "480p", ratios: ["16:9", "4:3", "1:1", "3:4", "9:16"], totalSeconds: 18, audio: true },
 "sd14-seedance-2.0": { resolution: "720p", ratios: ["16:9", "1:1", "9:16"], totalSeconds: 25, audio: false },
} as const;
type Model = keyof typeof modelContracts;
export function compatibleModels(request: GenerationRequest, models: readonly Model[], referenceSeconds = 0): Model[] {
 const p = request.ports; const duration = Number(p.duration?.[0]);
 assert(p.webSearch?.[0] !== true, "中转站没有 webSearch 参数，请关闭联网搜索");
 assert(typeof p.prompt?.[0] === "string" && p.prompt[0].length <= 5000, "提示词不能为空且不得超过 5000 字");
 const candidates = models.filter(model => {
   const c = modelContracts[model];
   return c.resolution === p.resolution?.[0] && (c.ratios as readonly unknown[]).includes(p.aspectRatio?.[0]) && duration >= 4 && duration <= 15 && Number.isInteger(duration) && duration + referenceSeconds <= c.totalSeconds + 0.02 && (p.generateAudio?.[0] !== true || c.audio);
 });
 assert(candidates.length, `没有兼容的已配置 2.0 通道（当前启用 ${models.join(", ")}）：sd12 为 480p、出片+参考≤18秒；sd14 为 720p、合计≤25秒且未提供音频开关（请设 generate-audio=false 后本地配音）。请求分辨率=${p.resolution?.[0]}，出片=${duration}秒，参考=${referenceSeconds.toFixed(2)}秒。请调整分镜/参数，不要重复付费提交。`);
 return candidates;
}
export function buildPayload(input: Record<string, unknown>, model: Model): Record<string, unknown> {
 const body: Record<string, unknown> = { model, prompt: input.prompt, duration: input.duration, aspect_ratio: input.aspect_ratio, resolution: modelContracts[model].resolution };
 for (const [from, to] of Object.entries({ first_frame_url: "first_image_url", last_frame_url: "last_image_url", reference_image_urls: "reference_image_urls", reference_video_urls: "reference_videos", reference_audio_urls: "reference_audios" })) if (input[from] !== undefined) body[to] = input[from];
 if (modelContracts[model].audio) body.generate_audio = input.generate_audio;
 return body;
}
function resultUrl(body: Record<string, unknown>): string | undefined {
  if (typeof body.url === "string") return body.url;
  if (typeof body.result_url === "string") return body.result_url;
  if (typeof body.video_url === "string") return body.video_url;
  const metadata = body.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata) && typeof (metadata as Record<string, unknown>).video_url === "string") return (metadata as Record<string, unknown>).video_url as string;
  const data = body.data;
  if (Array.isArray(data) && data[0] && typeof data[0] === "object" && typeof (data[0] as Record<string, unknown>).url === "string") return (data[0] as Record<string, unknown>).url as string;
  return undefined;
}
function normalizedStatus(value: unknown): "queued" | "running" | "ready" | "failed" | "unknown" { const v = String(value ?? "").toLowerCase(); if (["queued", "pending", "waiting", "created", "in_queue"].includes(v)) return "queued"; if (["running", "processing", "in_progress"].includes(v)) return "running"; if (["completed", "succeeded", "success", "done", "finished"].includes(v)) return "ready"; if (["failed", "error", "cancelled", "canceled"].includes(v)) return "failed"; return "unknown"; }
function taskFailureMessage(body: Record<string, unknown>, taskId: string): string {
  if (typeof body.fail_reason === "string" && body.fail_reason.trim()) return `Cangyuan task ${taskId} failed: ${body.fail_reason.trim()}`;
  const error = body.error;
  if (typeof error === "string" && error.trim()) return `Cangyuan task ${taskId} failed: ${error.trim()}`;
  if (error && typeof error === "object" && !Array.isArray(error) && typeof (error as Record<string, unknown>).message === "string" && String((error as Record<string, unknown>).message).trim()) return `Cangyuan task ${taskId} failed: ${String((error as Record<string, unknown>).message).trim()}`;
  return `Cangyuan task ${taskId} failed`;
}
async function ossBridge(python: string, module: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(python, ["-u", requireOssBridgePath()], { env: { ...process.env, AI_DSP_OSS_STORAGE_MODULE: module } });
    let out = ""; let err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("OSS bridge timed out")); }, 120_000);
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); if (out.length > 2 * 1024 * 1024) child.kill(); });
    child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`OSS bridge exited ${code}: ${redact(err || out).slice(0, 500)}`)); });
    child.stdin.on("error", () => { /* the child error/close handler reports bridge failure */ });
    child.stdin.end(JSON.stringify(request));
  });
  const result = object(JSON.parse(stdout), "OSS bridge response");
  if (typeof result.error === "string") throw new Error(`AI Dsp OSS: ${result.message ?? result.error}`);
  return result;
}
function requireOssBridgePath(): string { return fileURLToPath(new URL("../runtime/oss_bridge.py", import.meta.url)); }
function defaultOssPython(): string { return fileURLToPath(new URL("../runtime/.venv/bin/python", import.meta.url)); }
function defaultOssModule(): string { return fileURLToPath(new URL("../runtime/oss_storage.py", import.meta.url)); }
export async function checkCangyuanAssetStore(options: Pick<CreateCangyuanProviderOptions, "ossPython" | "ossStorageModule"> = {}): Promise<void> {
 await ossBridge(options.ossPython ?? defaultOssPython(), options.ossStorageModule ?? defaultOssModule(), { action: "check" });
}


function endpoint(client: Client, options: CreateCangyuanProviderOptions, models: readonly Model[]): AsyncEndpoint {
 const interval = options.pollIntervalMs ?? 10_000;
 const timeout = options.operationTimeoutMs ?? 30 * 60_000;
 const python = options.ossPython ?? defaultOssPython(); const module = options.ossStorageModule ?? defaultOssModule();
 async function cleanup(keys: readonly string[], progress?: (value: { phase: string }) => Promise<void>) {
   for (const key of keys) try { await ossBridge(python, module, { action: "delete", object_key: key }); }
   catch { await progress?.({ phase: "临时素材清理失败；由已有 OSS 生命周期到期删除，不影响生成结果" }); }
 }
 return {
  async start(context) {
   const keys: string[] = []; let submitted = false;
   try {
    assert(context.need.capability.name === "seedance-2", "此项目只启用 Seedance 2.0");
    const route = routeFor(context.need.capability)!;
    const prepared = route.prepare(context.need.constraints);
    const request = context.need.constraints as unknown as GenerationRequest;
    compatibleModels(request, models);
    // Inspect all inputs before publishing or making any billable API request.
    const media = new Map<string, Awaited<ReturnType<typeof prepareMedia>>>();
    let referenceSeconds = 0; let audioSeconds = 0;
    for (const [port, values] of Object.entries(request.ports)) for (const value of values) {
      if (!value || typeof value !== "object" || !("artifact" in value)) continue;
      const artifact = value.artifact as BlobRef;
      let item = media.get(artifact.resource);
      if (!item) {
       const bytes = await context.resources.get(artifact.resource);
       assert(bytes && bytes.byteLength === artifact.size, "参考素材不存在或大小已改变");
       item = await prepareMedia(bytes, artifact.mediaType); media.set(artifact.resource, item);
      }
      if (port === "referenceVideo") referenceSeconds += item.info.duration;
      if (port === "referenceAudio") audioSeconds += item.info.duration;
    }
    assert(audioSeconds <= 15.02, "参考音频合计不能超过 15 秒");
    const candidates = compatibleModels(request, models, referenceSeconds);
    const published = new Map<string, string>();
    const compiled = await prepared.compile(async (artifact, fields) => {
      const cached = published.get(artifact.resource); if (cached) return cached;
      const item = media.get(artifact.resource)!;
      const normalized = await context.resources.put(item.bytes, item.mediaType);
      let url: string;
      if (options.publicAssetUrl) url = await options.publicAssetUrl(normalized, context.resources, fields);
      else {
       const digest = createHash("sha256").update(item.bytes).digest("hex");
       const extension = item.mediaType === "video/mp4" ? "mp4" : item.mediaType.split("/")[1]!.replace(/[^a-z0-9]/giu, "");
       // Short random keys prevent unnecessarily long signed URLs and do not reveal project paths.
       const result = await ossBridge(python, module, { action: "upload", project_id: "hypit", clip_id: "reference", reference_index: published.size + 1, object_key: `ai-dsp-temp/hypit/${randomUUID()}.${extension}`, data: Buffer.from(item.bytes).toString("base64"), mime_type: item.mediaType, sha256: digest });
       const key = result.object_key; assert(typeof key === "string" && key.startsWith("ai-dsp-temp/"), "OSS returned an invalid temporary key"); keys.push(key);
       assert(typeof result.url === "string", "OSS returned no URL"); url = result.url;
      }
      assert(url.startsWith("https://"), "参考素材必须使用 HTTPS 地址");
      published.set(artifact.resource, url); return url;
    });
    let response: Record<string, unknown> | undefined; let selected = candidates[0]!;
    for (const model of candidates) {
      selected = model;
      await context.reportProgress?.({ phase: `调用 ${model}：${modelContracts[model].resolution}，参考视频 ${referenceSeconds.toFixed(2)} 秒` });
      submitted = true;
      try { response = await client.json("/v1/videos", apiKey(context.credentials), { method: "POST", headers: { "content-type": "application/json", "idempotency-key": `${context.operation}-${model}` }, body: JSON.stringify(buildPayload(compiled.input as Record<string, unknown>, model)) }); break; }
      catch (error) {
       // Only an explicit model-identity rejection proves no task was created. Never retry uncertain POSTs.
       if (error instanceof HttpError && [400, 404].includes(error.status) && /model.*(?:unknown|not found|unavailable|unsupported)|模型.*(?:不存在|不可用|不支持)/iu.test(error.message)) { submitted = false; if (model !== candidates.at(-1)) continue; }
       throw error;
      }
    }
    assert(response, "中转站没有返回任务");
    const taskId = response.id ?? response.task_id; assert(typeof taskId === "string" && taskId, "中转站未返回任务编号；提交结果未知，请核对后台后再重试");
    const handle: Handle = { contract: "hypit.cangyuan-operation@1", taskId, capability: capabilityKey(context.need.capability), startedAt: Date.now(), model: selected, mute: request.ports.generateAudio?.[0] === false, uploadedKeys: keys };
    const receipt = { id: taskId }; await context.checkpoint?.({ handle: canonicalize(handle), receipt });
    return { ...wakeAfter(canonicalize(handle), interval, Date.now(), { phase: "submitted" }), receipt };
   } catch (error) {
    if (!submitted) await cleanup(keys, context.reportProgress);
    return fail(submitted ? new Error(`${error instanceof Error ? error.message : String(error)}；提交结果可能未知，禁止自动重投。临时素材保留至生命周期到期，请核对中转站任务记录。`) : error);
   }
  },
  async poll(context) {
   const handle = context.handle as unknown as Handle;
   try {
    assert(Date.now() - handle.startedAt <= timeout, `任务 ${handle.taskId} 等待超时；远端结果未知，保留任务编号，勿重新提交`);
    const body = await client.json(`/v1/videos/${encodeURIComponent(handle.taskId)}`, apiKey(context.credentials));
    const state = normalizedStatus(body.status); const receipt = { id: handle.taskId };
    if (state === "queued" || state === "running") return { ...wakeAfter(canonicalize(handle), interval, Date.now(), { phase: state }), receipt };
    if (state === "failed") { await cleanup(handle.uploadedKeys ?? [], context.reportProgress); return fail(new Error(taskFailureMessage(body, handle.taskId)), handle.taskId); }
    assert(state === "ready", `任务 ${handle.taskId} 返回未知状态 ${String(body.status)}，不要重新提交`);
    const url = resultUrl(body); assert(url && url.startsWith("https://"), "已完成任务没有 HTTPS 视频地址，请凭任务编号核查中转站");
    return { status: "ready", handle: canonicalize({ ...handle, url }), receipt };
   } catch (error) {
    if (Date.now() - handle.startedAt <= timeout && (error instanceof TransportError || error instanceof HttpError && (error.status === 429 || error.status >= 500))) return { ...wakeAfter(canonicalize(handle), interval, Date.now(), { phase: "查询临时失败，继续查询同一任务，不重新扣费提交" }), receipt: { id: handle.taskId } };
    return fail(error, handle.taskId);
   }
  },
  async collect(context) {
   const handle = context.handle as unknown as Handle;
   try {
    assert(handle.url?.startsWith("https://"), "结果缺少 HTTPS 下载地址");
    // Signed result hosts never receive the Cangyuan API credential.
    const response = await client.read(handle.url!);
    const video = await prepareMedia(new Uint8Array(await response.arrayBuffer()), "video/mp4", true, handle.mute);
    const requested = context.need.constraints as unknown as GenerationRequest;
    assert(Math.abs(video.info.duration - Number(requested.ports.duration?.[0])) <= 0.25, "模型返回视频时长不符合请求，请人工检查任务结果");
    if (requested.ports.aspectRatio?.[0]) {
      const [rw, rh] = String(requested.ports.aspectRatio[0]).split(":").map(Number);
      assert(Math.abs(video.info.width / video.info.height / (rw! / rh!) - 1) <= 0.03, "模型返回的画幅不符合请求，请检查参考素材的画幅并调整分镜");
    }
    const minEdge = Number(String(requested.ports.resolution?.[0]).replace("p", ""));
    assert(Math.min(video.info.width, video.info.height) >= minEdge, "模型返回的实际分辨率低于请求，请人工检查，不能标记成功");
    const artifact = await context.resources.put(video.bytes, video.mediaType);
    const route = routeFor(context.need.capability)!;
    await cleanup(handle.uploadedKeys ?? [], context.reportProgress);
    return { status: "completed", result: { value: route.packageResult([artifact]) }, receipt: { id: handle.taskId } };
   } catch (error) {
    if (Date.now() - handle.startedAt <= timeout && (error instanceof TransportError || error instanceof HttpError && (error.status === 429 || error.status >= 500))) {
      return { ...wakeAfter(canonicalize(handle), interval, Date.now(), { phase: "成片下载临时失败，继续下载同一任务，不重新生成" }), receipt: { id: handle.taskId } };
    }
    return fail(error, handle.taskId);
   }
  },
 };
}
export function createCangyuanProvider(options: CreateCangyuanProviderOptions = {}) {
 const base = (options.baseUrl ?? "https://ai.cangyuansuanli.cn").replace(/\/+$/u, "");
 assert(/^https:\/\//u.test(base) || /^http:\/\/(localhost|127\.0\.0\.1)(?::\d+)?$/u.test(base), "Cangyuan requires HTTPS or loopback");
 const ids = [...new Set([options.primaryModel ?? "sd14-seedance-2.0", ...(options.fallbackModels ?? (options.fallbackModel ? [options.fallbackModel] : []))])];
 for (const id of ids) assert(typeof id === "string" && Object.hasOwn(modelContracts, id), `未核对的中转站模型 ID：${String(id)}。只启用已验证规则的 Seedance 2.0，禁止 2.5 或跨服务降级。`);
 const activeModels = ids.filter(id => !(options.disabledModels ?? []).includes(id));
 assert(activeModels.length > 0, "没有启用的模型：请检查 disabledModels");
 const route = hiApiRoutes.find(r => r.capability.name === "seedance-2")!;
 return defineEndpointPackage({ module: cangyuanProviderModuleRef, facet: "gateway", instance: options.instance ?? "cangyuan.default", pool: options.pool ?? options.instance ?? "cangyuan.default", pricing: { kind: "page", url: "https://ai.cangyuansuanli.cn/docs/seedance" }, credentials: { apiKey: options.apiKey ?? credentialRef("os", "ai-dsp") }, credentialInputs: { apiKey: { label: "Cangyuan API key" } }, defaultConcurrency: options.defaultConcurrency ?? 1, ...(options.actionLimits ? { actionLimits: options.actionLimits } : {}), capabilities: [{ capability: route.capability, returns: route.returns, lifecycle: "asynchronous", endpoint: endpoint(new Client(base, options.requestTimeoutMs ?? 300_000, options.fetch ?? globalThis.fetch), options, activeModels as Model[]), capacity: "seedance-2", supports: need => {
   const upstream = route.supports(need);
   if (upstream.status !== "supported") return upstream;
   try { compatibleModels(need.constraints as unknown as GenerationRequest, activeModels as Model[]); return upstream; }
   catch (error) { return { status: "unsupported", reason: error instanceof Error ? error.message : String(error) }; }
 } }] });
}
