import assert from "node:assert/strict";
import test from "node:test";
import { EndpointRegistry, MemoryResourceStore } from "@hypit/driver-node";
import { sealSeedanceRequest, seedanceEndpoints } from "@hypit/seedance";
import type { Need, CanonicalValue } from "@hypit/protocol";
import { buildPayload, compatibleModels, createCangyuanProvider } from "../src/provider.js";
import type { CreateCangyuanProviderOptions } from "../src/provider.js";
function request(resolution = "480p", audio = false) { return sealSeedanceRequest("seedance-2", { prompt: ["A blue toy robot waves."], resolution: [resolution], aspectRatio: ["1:1"], duration: [4], generateAudio: [audio], webSearch: [false] }); }
function need(resolution = "720p"): Need { return { id: "need:test", capability: seedanceEndpoints.standard!.capability, returns: seedanceEndpoints.standard!.returns, constraints: request(resolution) as unknown as CanonicalValue, result: "record:test" }; }
async function setup(fetch: typeof globalThis.fetch, options: CreateCangyuanProviderOptions = {}, resolution = "720p") {
 const n = need(resolution); const registry = new EndpointRegistry();
 await createCangyuanProvider({ fetch, ...options }).install(registry);
 const r = registry.resolve(n); assert.equal(r.status, "resolved"); assert.equal(r.registration.kind, "asynchronous");
 return { endpoint: r.registration.endpoint, context: { command: { kind: "fulfill-need" as const, id: "command:test" as const, need: n }, need: n, resources: new MemoryResourceStore(), credentials: { apiKey: { secret: "test-key" } }, operation: "operation:test" as const } };
}
test("only configured standard 2.0 models, including a pinned single model", () => {
 assert.doesNotThrow(() => createCangyuanProvider({ fallbackModels: [] }));
 assert.throws(() => createCangyuanProvider({ fallbackModels: ["sd13-seedance-2.5"] }), /2.5/);
 assert.throws(() => createCangyuanProvider({ primaryModel: "sd99-seedance-2.0" }), /未核对/);
});
test("model-specific resolution and reference duration budgets are enforced", () => {
 const models = ["sd12-seedance-2.0", "sd14-seedance-2.0"] as const;
 assert.deepEqual(compatibleModels(request(), models, 10), [models[0]]);
 assert.deepEqual(compatibleModels(request("720p"), models, 15), [models[1]]);
 assert.throws(() => compatibleModels(request(), models, 15), /没有兼容/);
 assert.throws(() => compatibleModels(request("1080p"), models), /没有兼容/);
 assert.throws(() => compatibleModels(request("720p", true), models), /音频/);
});
test("correct first and last frame names, reference arrays and no unsupported fields", () => {
 const input = { prompt: "go", duration: 4, aspect_ratio: "1:1", first_frame_url: "https://a/first", last_frame_url: "https://a/last", reference_video_urls: ["https://a/video"], generate_audio: false, web_search: false };
 const body = buildPayload(input, "sd14-seedance-2.0");
 assert.equal(body.first_image_url, input.first_frame_url); assert.equal(body.last_image_url, input.last_frame_url);
 assert.deepEqual(body.reference_videos, input.reference_video_urls); assert.equal(body.resolution, "720p");
 assert.equal("web_search" in body, false); assert.equal("generate_audio" in body, false); assert.equal("image_url" in body, false);
 assert.equal(buildPayload(input, "sd12-seedance-2.0").generate_audio, false);
});
test("720p selects SD14 and checkpoints the real receipt", async () => {
 let body: Record<string, unknown> = {}; let saved = false;
 const { endpoint, context } = await setup(async (_url, init) => { body = JSON.parse(String(init?.body)); return Response.json({ id: "real-task" }); }, {}, "720p");
 const result = await endpoint.start({ ...context, checkpoint: async () => { saved = true; } });
 assert.equal(result.status, "pending"); assert.equal(body.model, "sd14-seedance-2.0"); assert.equal(saved, true);
});
test("uncertain POST and parameter errors are never resubmitted", async () => {
 for (const status of [400, 500]) {
  let calls = 0; const { endpoint, context } = await setup(async () => { calls++; return new Response("invalid duration", { status }); });
  const result = await endpoint.start(context); assert.equal(result.status, "failed"); assert.equal(calls, 1);
 }
});
test("temporary polling errors keep the same handle and receipt", async () => {
 let calls = 0;
 const { endpoint, context } = await setup(async () => { calls++; return calls === 1 ? Response.json({ id: "persisted-task" }) : new Response("temporarily unavailable", { status: 503 }); });
 const start = await endpoint.start(context); assert.equal(start.status, "pending");
 const polled = await endpoint.poll({ ...context, handle: start.handle }); assert.equal(polled.status, "pending");
 if (polled.status === "pending") assert.deepEqual(polled.handle, start.handle);
 assert.equal(polled.receipt?.id, "persisted-task"); assert.equal(calls, 2);
});
test("completed top-level URL is collected without unsupported content API", async () => {
 const { endpoint, context } = await setup(async () => Response.json({ status: "completed", url: "https://assets.test/result.mp4" }));
 const handle = { contract: "hypit.cangyuan-operation@1", taskId: "task", model: "sd12-seedance-2.0", startedAt: Date.now(), uploadedKeys: [], mute: true };
 const polled = await endpoint.poll({ ...context, handle: handle as unknown as CanonicalValue });
 assert.equal(polled.status, "ready"); if (polled.status === "ready") assert.equal((polled.handle as Record<string, unknown>).url, "https://assets.test/result.mp4");
});
test("remote failure remains failure with receipt and secrets removed", async () => {
 const { endpoint, context } = await setup(async () => Response.json({ status: "failed", fail_reason: "reference https://private.test/video?sig=secret Bearer sk-secret" }));
 const result = await endpoint.poll({ ...context, handle: { taskId: "task", startedAt: Date.now(), uploadedKeys: [] } });
 assert.equal(result.status, "failed"); if (result.status === "failed") { assert.equal(result.receipt?.id, "task"); assert.doesNotMatch(result.failure.message, /sig=secret|sk-secret/); }
});
test("quarantined model is not submitted even when the request otherwise fits", async () => {
 let calls = 0;
 const registry = new EndpointRegistry();
 await createCangyuanProvider({ fetch: async () => { calls++; return Response.json({ id: "wrong" }); }, primaryModel: "sd14-seedance-2.0", fallbackModels: ["sd12-seedance-2.0"], disabledModels: ["sd12-seedance-2.0"] }).install(registry);
 const result = registry.resolve(need("480p")); assert.equal(result.status, "unsupported"); assert.equal(calls, 0);
});
test("temporary result download failure keeps the same paid task", async () => {
 let calls = 0;
 const { endpoint, context } = await setup(async () => { calls++; return new Response("temporarily unavailable", { status: 503 }); });
 const handle = { contract: "hypit.cangyuan-operation@1", taskId: "paid-task", capability: "seedance-2", model: "sd14-seedance-2.0", startedAt: Date.now(), uploadedKeys: [], mute: true, url: "https://assets.test/result.mp4" };
 assert.ok(endpoint.collect);
 const collected = await endpoint.collect({ ...context, handle: handle as unknown as CanonicalValue });
 assert.equal(collected.status, "pending"); assert.equal(collected.receipt?.id, "paid-task"); assert.equal(calls, 1);
 if (collected.status === "pending") assert.deepEqual(collected.handle, handle);
});
