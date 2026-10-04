import { requestDeadline } from "@hypit/runtime-kit";
import type { AsyncEndpoint, EndpointCredential, EndpointOutcome } from "@hypit/endpoint-kit";
import { defineEndpointPackage, wakeAfter } from "@hypit/endpoint-kit";
import type { GenerationRequest } from "@hypit/generation";
import { canonicalize } from "@hypit/protocol";
import type { BlobRef } from "@hypit/protocol";
import { credentialRef } from "@hypit/runtime";
import type { CredentialRef, ResourceStore } from "@hypit/runtime";
import { checkAssetStore, deleteAsset, publishAsset } from "./assets.js";
import type { AssetOptions } from "./assets.js";
import { inspectMedia, validateReference } from "./media.js";
import { officialH3Route } from "./route.js";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

type SubmissionPolicy = {
  authorize(input: { body: Record<string, unknown>; assets: Array<{ url: string; sha256: string; size: number; mediaType: string }>; operation: string; needId: string; uploadedKeys: string[] }): Promise<{ kind: "reserved" | "resume"; intentId: string; startedAt?: number; handle?: Handle }>;
  submitted(intentId: string, handle: Handle): Promise<void>;
  unknown(intentId: string, handle?: Handle): Promise<void>;
  outcome(intentId: string, state: string, details?: Record<string, unknown>): Promise<void>;
};
async function submissionPolicy(options: CreateOfficialMiniMaxProviderOptions): Promise<SubmissionPolicy | undefined> {
  if (!options.submissionPolicyModule) return undefined;
  const module = await import(pathToFileURL(resolve(options.submissionPolicyModule)).href);
  return module.createSubmissionPolicy({ planPath: options.submissionPlan, ledgerRoot: options.submissionLedgerRoot }) as SubmissionPolicy;
}

export const officialMiniMaxProviderModuleRef = { name: "@hypit/provider-minimax-official", version: "1" } as const;
export type CreateOfficialMiniMaxProviderOptions = AssetOptions & {
  readonly instance?: string; readonly pool?: string; readonly baseUrl?: string; readonly apiKey?: CredentialRef;
  readonly defaultConcurrency?: number; readonly actionLimits?: import("@hypit/endpoint-kit").EndpointActionLimits;
  readonly pollIntervalMs?: number; readonly requestTimeoutMs?: number; readonly operationTimeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly assetTransport?: "auto" | "inline" | "platform" | "oss";
  readonly publicAssetUrl?: (artifact: BlobRef, resources: ResourceStore) => Promise<string>;
  readonly submissionPolicyModule?: string; readonly submissionPlan?: string; readonly submissionLedgerRoot?: string;
};
type Handle = { contract: "hypit.minimax-official-h3@1"; taskId: string; startedAt: number; uploadedKeys: string[]; url?: string; intentId?: string };
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function object(value: unknown, subject: string): Record<string, unknown> { assert(value && typeof value === "object" && !Array.isArray(value), `${subject} must be an object`); return value as Record<string, unknown>; }
function key(credentials: Readonly<Record<string, EndpointCredential>>): string { const value = credentials.apiKey?.secret; assert(value, "MiniMax 官方 API 密钥不可用"); return value; }
function redact(value: string): string { return value.replace(/data:[^\s"'<>]+/gu, "[inline media redacted]").replace(/https?:\/\/[^\s"'<>]+/gu, "[URL redacted]").replace(/sk-[A-Za-z0-9_-]+/gu, "[credential redacted]").slice(0, 600); }
function failure(error: unknown, taskId?: string): EndpointOutcome { return { status: "failed", ...(taskId ? { receipt: { id: taskId } } : {}), failure: { code: "MINIMAX_OFFICIAL_ERROR", message: redact(error instanceof Error ? error.message : String(error)) } }; }
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
class TransportError extends Error {}
class Client {
  constructor(readonly base: string, readonly timeout: number, readonly fetcher: typeof globalThis.fetch) {}
  async read(url: string, init: RequestInit = {}): Promise<Response> {
    const deadline = requestDeadline(this.timeout);
    try {
      const response = await deadline.wait(this.fetcher(url, { ...init, signal: deadline.signal }));
      const bytes = await deadline.wait(response.arrayBuffer());
      if (!response.ok) throw new HttpError(response.status, `MiniMax HTTP ${response.status}: ${redact(new TextDecoder().decode(bytes))}`);
      return new Response(bytes, { status: response.status, headers: response.headers });
    } catch (error) { if (error instanceof HttpError) throw error; throw new TransportError(redact(error instanceof Error ? error.message : String(error))); }
    finally { deadline.finish(); }
  }
  async json(path: string, apiKey: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const response = await this.read(`${this.base}${path}`, { ...init, headers: { authorization: `Bearer ${apiKey}`, ...init.headers } });
    return object(await response.json(), "MiniMax response");
  }
}
function task(body: Record<string, unknown>): Record<string, unknown> { return object(body.task, "MiniMax task"); }
function state(value: unknown): "waiting" | "succeeded" | "failed" | "unknown" {
  if (value === "queued" || value === "running") return "waiting";
  if (value === "succeeded") return "succeeded";
  if (value === "failed" || value === "cancelled") return "failed";
  return "unknown";
}
function resultUrl(job: Record<string, unknown>): string {
  const content = object(job.content, "MiniMax task content");
  assert(typeof content.url === "string" && content.url.startsWith("https://"), "MiniMax 成功任务缺少 HTTPS 视频地址");
  return content.url;
}
function safeBase(value: string): string {
  const base = value.replace(/\/+$/u, "");
  assert(["https://api.minimax.cn", "https://api.minimax.io"].includes(base) || /^http:\/\/(localhost|127\.0\.0\.1)(?::\d+)?$/u.test(base), "MiniMax 官方接口只允许官方域名或本机测试地址");
  return base;
}

function endpoint(client: Client, options: CreateOfficialMiniMaxProviderOptions): AsyncEndpoint {
  const interval = options.pollIntervalMs ?? 10_000;
  const timeout = options.operationTimeoutMs ?? 30 * 60_000;
  async function cleanup(keys: readonly string[], report?: (value: { phase: string }) => Promise<void>, apiKey?: string) {
    for (const key of keys) try {
      if (key.startsWith("minimax-file:")) {
        assert(apiKey, "MiniMax 文件清理缺少凭据");
        const fileId = Number(key.slice(13));
        assert(Number.isSafeInteger(fileId) && fileId > 0, "MiniMax 文件编号不安全，保留至平台过期");
        const result = await client.json("/v1/files/delete", apiKey, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file_id: fileId, purpose: "video_generation_input" }) });
        assert(!object(result.base_resp, "MiniMax file deletion").status_code, "MiniMax 临时文件清理失败");
      } else await deleteAsset(options, key);
    } catch { await report?.({ phase: "临时素材清理失败；保留记录，平台文件最长7天过期，OSS使用生命周期" }); }
  }
  async function uploadPlatform(bytes: Uint8Array, mediaType: string, apiKey: string): Promise<string> {
    const suffix = mediaType === "video/quicktime" ? "mov" : mediaType === "audio/mpeg" ? "mp3" : mediaType === "audio/x-wav" ? "wav" : mediaType.split("/")[1]!;
    const form = new FormData();
    form.set("purpose", "video_generation_input");
    form.set("file", new Blob([new Uint8Array(bytes)], { type: mediaType }), `reference.${suffix}`);
    const result = await client.json("/v1/files/upload", apiKey, { method: "POST", body: form });
    assert(!object(result.base_resp, "MiniMax file upload").status_code, "MiniMax 平台素材上传失败；不会自动切换 OSS");
    const file = object(result.file, "MiniMax uploaded file");
    assert(typeof file.file_id !== "number" || Number.isSafeInteger(file.file_id), "MiniMax 文件编号精度不安全，停止提交");
    const id = String(file.file_id ?? "");
    assert(/^[0-9]+$/u.test(id), "MiniMax 平台上传未返回有效文件编号");
    return id;
  }
  return {
    async start(context) {
      const uploadedKeys: string[] = []; let submitted = false; let taskId: string | undefined;
      let policy: SubmissionPolicy | undefined; let intentId: string | undefined; let durableHandle: Handle | undefined;
      try {
        policy = await submissionPolicy(options);
        const apiKey = key(context.credentials);
        const request = context.need.constraints as unknown as GenerationRequest;
        const prepared = officialH3Route.prepare(context.need.constraints);
        const assets = new Map<string, { bytes: Uint8Array; mediaType: string }>();
        let videoSeconds = 0; let audioSeconds = 0;
        for (const [port, values] of Object.entries(request.ports)) for (const value of values) {
          if (!value || typeof value !== "object" || !("artifact" in value)) continue;
          const artifact = value.artifact as BlobRef;
          let asset = assets.get(artifact.resource);
          if (!asset) {
            const bytes = await context.resources.get(artifact.resource);
            assert(bytes && bytes.byteLength === artifact.size, "MiniMax 参考素材不存在或大小已改变");
            const info = await inspectMedia(bytes, artifact.mediaType);
            validateReference(info, artifact.mediaType, bytes.byteLength);
            asset = { bytes, mediaType: artifact.mediaType }; assets.set(artifact.resource, asset);
          }
          if (port === "referenceVideo") videoSeconds += (await inspectMedia(asset.bytes, asset.mediaType)).duration;
          if (port === "referenceAudio") audioSeconds += (await inspectMedia(asset.bytes, asset.mediaType)).duration;
        }
        assert(videoSeconds <= 15.02 && audioSeconds <= 15.02, "MiniMax 参考视频或参考音频的总时长不能超过 15 秒");
        const published = new Map<string, string>();
        let body = await prepared.compile(async artifact => {
          const cached = published.get(artifact.resource); if (cached) return cached;
          const asset = assets.get(artifact.resource); assert(asset, "MiniMax 参考素材预检未通过");
          let url: string;
          if (options.publicAssetUrl) url = await options.publicAssetUrl(artifact, context.resources);
          else if (options.assetTransport !== "oss") {
            // Data URIs keep the local file in the request; MOV uses the official file service.
            if (options.assetTransport === "platform" || asset.mediaType === "video/quicktime") {
              const id = await uploadPlatform(asset.bytes, asset.mediaType, apiKey);
              url = `mm_file://${id}`; uploadedKeys.push(`minimax-file:${id}`);
            } else url = `data:${asset.mediaType === "audio/x-wav" ? "audio/wav" : asset.mediaType};base64,${Buffer.from(asset.bytes).toString("base64")}`;
          } else {
            const result = await publishAsset(options, asset.bytes, asset.mediaType, published.size + 1);
            url = result.url; uploadedKeys.push(result.key);
          }
          assert(url.startsWith("https://") || /^mm_file:\/\/[0-9]+$/u.test(url) || url.startsWith("data:"), "MiniMax 参考素材地址无效");
          published.set(artifact.resource, url); return url;
        });
        // The 64MB limit applies to JSON after Base64 expansion, including repeated references.
        let wire = JSON.stringify(body);
        if (Buffer.byteLength(wire) > 64_000_000 && (options.assetTransport ?? "auto") === "auto" && !options.publicAssetUrl) {
          const candidates = [...published].filter(([, url]) => url.startsWith("data:")).sort((a, b) => assets.get(b[0])!.bytes.byteLength - assets.get(a[0])!.bytes.byteLength);
          for (const [resource] of candidates) {
            const asset = assets.get(resource)!;
            const id = await uploadPlatform(asset.bytes, asset.mediaType, apiKey);
            published.set(resource, `mm_file://${id}`); uploadedKeys.push(`minimax-file:${id}`);
            body = await prepared.compile(async artifact => published.get(artifact.resource)!);
            wire = JSON.stringify(body);
            if (Buffer.byteLength(wire) <= 64_000_000) break;
          }
        }
        assert(Buffer.byteLength(wire) <= 64_000_000, "MiniMax 请求超过64MB；请选择平台文件上传方式，不需要OSS或公网配置；禁止删减素材绕过");
        await context.reportProgress?.({ phase: `素材传递：${options.assetTransport ?? "auto"}（默认直接传入，超限使用本模型平台文件）` });
        await context.reportProgress?.({ phase: `调用 MiniMax-H3 官方接口：${String(body.resolution)}，参考视频 ${videoSeconds.toFixed(2)} 秒` });
        if (policy) {
          const reservation = await policy.authorize({ body, assets: [...published].map(([resource, url]) => {
            const asset = assets.get(resource)!;
            return { url, sha256: createHash("sha256").update(asset.bytes).digest("hex"), size: asset.bytes.byteLength, mediaType: asset.mediaType };
          }), operation: String(context.operation), needId: context.need.id, uploadedKeys });
          intentId = reservation.intentId;
          if (reservation.kind === "resume") {
            const handle = reservation.handle!; taskId = handle.taskId;
            await cleanup(uploadedKeys, context.reportProgress, context.credentials.apiKey?.secret);
            return { ...wakeAfter(canonicalize(handle), interval, Date.now(), { phase: "恢复查询原官方任务，未新增提交" }), receipt: { id: handle.taskId } };
          }
        }
        submitted = true;
        const response = await client.json("/v2/video_generation", apiKey, { method: "POST", headers: { "content-type": "application/json" }, body: wire });
        taskId = response.task_id as string | undefined;
        assert(typeof taskId === "string" && taskId.length > 0, "MiniMax 提交结果缺少任务编号；结果未知，禁止自动重新提交");
        const handle: Handle = { contract: "hypit.minimax-official-h3@1", taskId, startedAt: Date.now(), uploadedKeys, ...(intentId ? { intentId } : {}) }; durableHandle = handle;
        const receipt = { id: taskId };
        if (policy && intentId) await policy.submitted(intentId, handle);
        await context.checkpoint?.({ handle: canonicalize(handle), receipt });
        return { ...wakeAfter(canonicalize(handle), interval, Date.now(), { phase: "submitted" }), receipt };
      } catch (error) {
        if (submitted && policy && intentId) {
          try { await policy.unknown(intentId, durableHandle); } catch { /* The reserved intent remains closed to further POSTs. */ }
        }
        if (!submitted) await cleanup(uploadedKeys, context.reportProgress, context.credentials.apiKey?.secret);
        return failure(submitted ? new Error(`${error instanceof Error ? error.message : String(error)}；提交结果可能未知，请核对官方后台，不能自动重投`) : error, taskId);
      }
    },
    async poll(context) {
      const handle = context.handle as unknown as Handle;
      try {
        assert(handle.contract === "hypit.minimax-official-h3@1" && handle.taskId, "MiniMax 任务句柄无效");
        assert(Date.now() - handle.startedAt <= timeout, `MiniMax 任务 ${handle.taskId} 等待超时；远端结果未知，勿重新提交`);
        const job = task(await client.json(`/v2/query/video_generation/${encodeURIComponent(handle.taskId)}`, key(context.credentials)));
        const status = state(job.status); const receipt = { id: handle.taskId };
        if (status === "waiting") return { ...wakeAfter(canonicalize(handle), interval, Date.now(), { phase: String(job.status) }), receipt };
        if (status === "failed") {
          if (handle.intentId) await (await submissionPolicy(options))?.outcome(handle.intentId, "technical_failed");
          await cleanup(handle.uploadedKeys ?? [], context.reportProgress, context.credentials.apiKey?.secret);
          const detail = job.error && typeof job.error === "object" && !Array.isArray(job.error) ? String((job.error as Record<string, unknown>).message ?? "") : "";
          return failure(new Error(`MiniMax 任务 ${handle.taskId} ${String(job.status)}${detail ? `: ${detail}` : ""}`), handle.taskId);
        }
        assert(status === "succeeded", `MiniMax 任务 ${handle.taskId} 状态未知：${String(job.status)}`);
        return { status: "ready", handle: canonicalize({ ...handle, url: resultUrl(job) }), receipt };
      } catch (error) {
        if (Date.now() - handle.startedAt <= timeout && (error instanceof TransportError || error instanceof HttpError && (error.status === 429 || error.status >= 500))) return { ...wakeAfter(canonicalize(handle), interval, Date.now(), { phase: "查询暂时失败，继续查询同一任务" }), receipt: { id: handle.taskId } };
        if (handle.intentId) try { await (await submissionPolicy(options))?.outcome(handle.intentId, "technical_failed", { failure: { phase: "poll", message: redact(error instanceof Error ? error.message : String(error)) } }); } catch { /* Preserve the original receipt even if audit storage fails. */ }
        return failure(error, handle.taskId);
      }
    },
    async collect(context) {
      const handle = context.handle as unknown as Handle;
      let rawArtifact: BlobRef | undefined;
      let rawOutput: Record<string, unknown> | undefined;
      try {
        assert(handle.contract === "hypit.minimax-official-h3@1" && handle.taskId, "MiniMax 任务句柄无效");
        assert(handle.url?.startsWith("https://"), "MiniMax 结果缺少 HTTPS 视频地址");
        // Never send the API credential to the signed result host.
        const response = await client.read(handle.url!);
        const bytes = new Uint8Array(await response.arrayBuffer());
        // Keep the original in the native resource store before validating delivery limits.
        // A downloaded but rejected result must remain recoverable without another paid POST.
        rawArtifact = await context.resources.put(bytes, "video/mp4");
        rawOutput = { artifact: rawArtifact, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength };
        const info = await inspectMedia(bytes, "video/mp4");
        const request = context.need.constraints as unknown as GenerationRequest;
        const requestedDuration = Number(request.ports.duration?.[0]);
        rawOutput = { ...rawOutput, hasAudio: !!info.audioCodec, duration: info.duration, width: info.width, height: info.height,
          timing: { requested: requestedDuration, actual: info.duration, delta: info.duration - requestedDuration, requiresReview: Math.abs(info.duration - requestedDuration) > 0.3 } };
        assert(info.videoCodec && Number.isFinite(info.duration) && info.duration > 0, "MiniMax 返回的视频无有效画面或时长");
        assert(info.width > 0 && info.height > 0 && Math.abs(info.duration - Number(request.ports.duration?.[0])) <= 0.5, `MiniMax 成片时长或画面无效：请求 ${String(request.ports.duration?.[0])} 秒，实际 ${info.duration.toFixed(3)} 秒，${info.width}×${info.height}`);
        const minEdge = request.ports.resolution?.[0] === "2K" ? 1080 : 768;
        assert(Math.min(info.width, info.height) >= minEdge, "MiniMax 成片分辨率低于请求");
        if (request.ports.aspectRatio?.[0] && !request.ports.firstFrame?.length && !request.ports.lastFrame?.length) {
          const [width, height] = String(request.ports.aspectRatio[0]).split(":").map(Number);
          assert(Math.abs(info.width / info.height / (width! / height!) - 1) <= 0.03, "MiniMax 成片画幅与请求不符");
        }
        if (Math.abs(info.duration - requestedDuration) > 0.3) await context.reportProgress?.({ phase: `模型原件已保存；请求 ${requestedDuration} 秒，实际 ${info.duration.toFixed(3)} 秒，剪辑前须审阅尾部画面与声音` });
        if (handle.intentId) await (await submissionPolicy(options))?.outcome(handle.intentId, "generated_unreviewed", { output: rawOutput });
        await cleanup(handle.uploadedKeys ?? [], context.reportProgress, context.credentials.apiKey?.secret);
        return { status: "completed", result: { value: officialH3Route.packageResult([rawArtifact]) }, receipt: { id: handle.taskId } };
      } catch (error) {
        if (Date.now() - handle.startedAt <= timeout && (error instanceof TransportError || error instanceof HttpError && (error.status === 429 || error.status >= 500))) return { ...wakeAfter(canonicalize(handle), interval, Date.now(), { phase: "成片下载暂时失败，继续下载同一任务" }), receipt: { id: handle.taskId } };
        if (handle.intentId) try { await (await submissionPolicy(options))?.outcome(handle.intentId, "technical_failed", { ...(rawOutput ? { output: rawOutput } : {}), failure: { phase: "collect", message: redact(error instanceof Error ? error.message : String(error)) } }); } catch { /* Never reopen a paid intent on an audit-write failure. */ }
        return failure(rawArtifact ? new Error(`原件已保存 resource=${rawArtifact.resource}；${error instanceof Error ? error.message : String(error)}`) : error, handle.taskId);
      }
    },
  };
}

export function createOfficialMiniMaxProvider(options: CreateOfficialMiniMaxProviderOptions = {}) {
  if (!["auto", "inline", "platform", "oss"].includes(options.assetTransport ?? "auto")) throw new Error("MiniMax assetTransport 无效");
  const policyFields = [options.submissionPolicyModule, options.submissionPlan, options.submissionLedgerRoot];
  if (policyFields.some(value => value !== undefined) && !policyFields.every(value => typeof value === "string" && value.length > 0)) throw new Error("MiniMax 提交保护需要同时配置 module、plan 和共享 ledger");
  const base = safeBase(options.baseUrl ?? "https://api.minimax.cn");
  const client = new Client(base, options.requestTimeoutMs ?? 300_000, options.fetch ?? globalThis.fetch);
  return defineEndpointPackage({ module: officialMiniMaxProviderModuleRef, facet: "gateway", instance: options.instance ?? "minimax.official", pool: options.pool ?? options.instance ?? "minimax.official", pricing: { kind: "page", url: "https://platform.minimax.cn/docs/api-reference/video-generation-v2-create" }, credentials: { apiKey: options.apiKey ?? credentialRef("os", "minimax-official-h3") }, credentialInputs: { apiKey: { label: "MiniMax official API key" } }, defaultConcurrency: options.defaultConcurrency ?? 1, ...(options.actionLimits ? { actionLimits: options.actionLimits } : {}), capabilities: [{ capability: officialH3Route.capability, returns: officialH3Route.returns, lifecycle: "asynchronous", endpoint: endpoint(client, options), capacity: "minimax-h3", supports: officialH3Route.supports }] });
}

export { checkAssetStore };
