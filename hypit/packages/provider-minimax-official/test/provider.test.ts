import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EndpointRegistry, MemoryResourceStore } from "@hypit/driver-node";
import { minimaxH3Endpoints, sealMinimaxH3Request } from "@hypit/minimax-h3";
import type { BlobRef, CanonicalValue, Need } from "@hypit/protocol";
import { createOfficialMiniMaxProvider } from "../src/provider.js";
import { officialH3Body, officialH3Route } from "../src/route.js";

function need(request = sealMinimaxH3Request({ prompt: ["A blue toy robot waves."], duration: [4], resolution: ["768P"], aspectRatio: ["1:1"] })): Need {
  return { id: "need:minimax-official", capability: minimaxH3Endpoints.video!.capability, returns: minimaxH3Endpoints.video!.returns, constraints: request as unknown as CanonicalValue, result: "record:minimax-official" };
}
async function setup(fetch: typeof globalThis.fetch, n = need()) {
  const registry = new EndpointRegistry();
  await createOfficialMiniMaxProvider({ fetch, baseUrl: "http://localhost:4010" }).install(registry);
  const found = registry.resolve(n); assert.equal(found.status, "resolved"); assert.equal(found.registration.kind, "asynchronous");
  return { endpoint: found.registration.endpoint, context: { command: { kind: "fulfill-need" as const, id: "command:minimax-official" as const, need: n }, need: n, resources: new MemoryResourceStore(), credentials: { apiKey: { secret: "test-key" } }, operation: "operation:minimax-official" as const } };
}

test("official MiniMax receives V2 content, not relay fields", async () => {
  let path = ""; let body: Record<string, unknown> = {}; let checkpointed = false;
  const { endpoint, context } = await setup(async (url, init) => { path = String(url); body = JSON.parse(String(init?.body)); return Response.json({ task_id: "official-task-1" }); });
  const result = await endpoint.start({ ...context, checkpoint: async () => { checkpointed = true; } });
  assert.equal(result.status, "pending"); assert.equal(result.receipt?.id, "official-task-1"); assert.equal(checkpointed, true);
  assert.equal(path, "http://localhost:4010/v2/video_generation");
  assert.deepEqual(body, { model: "MiniMax-H3", content: [{ type: "text", text: "A blue toy robot waves." }], resolution: "768P", duration: 4, ratio: "1:1" });
  assert.equal("generate_audio" in body, false);
});

test("reference image, video and audio map to official role-tagged content", async () => {
  const image: BlobRef = { kind: "blob", resource: "res_official_image", size: 3, mediaType: "image/png" };
  const video: BlobRef = { kind: "blob", resource: "res_official_video", size: 3, mediaType: "video/mp4" };
  const audio: BlobRef = { kind: "blob", resource: "res_official_audio", size: 3, mediaType: "audio/wav" };
  const request = sealMinimaxH3Request({ prompt: ["Replace the actor"], duration: [5], referenceImage: [{ role: "image", artifact: image }], referenceVideo: [{ role: "video", artifact: video }], referenceAudio: [{ role: "audio", artifact: audio }] });
  const body = await officialH3Route.prepare(request as unknown as CanonicalValue).compile(async artifact => `https://assets.example/${artifact.resource}`);
  assert.deepEqual(body, { model: "MiniMax-H3", content: [
    { type: "text", text: "Replace the actor" },
    { type: "image_url", image_url: { url: "https://assets.example/res_official_image" }, role: "reference_image" },
    { type: "video_url", video_url: { url: "https://assets.example/res_official_video" }, role: "reference_video" },
    { type: "audio_url", audio_url: { url: "https://assets.example/res_official_audio" }, role: "reference_audio" },
  ], resolution: "768P", duration: 5, ratio: "adaptive" });
  assert.equal("messages" in officialH3Body({ text: "hi", duration: 4, messages: ["wrong"] }), false);
});

test("first and last frame use the official frame roles and adaptive ratio", async () => {
  const first: BlobRef = { kind: "blob", resource: "res_first", size: 3, mediaType: "image/png" };
  const last: BlobRef = { kind: "blob", resource: "res_last", size: 3, mediaType: "image/png" };
  const request = sealMinimaxH3Request({ prompt: ["The person turns toward the camera."], duration: [6], resolution: ["2K"], firstFrame: [{ role: "image", artifact: first }], lastFrame: [{ role: "image", artifact: last }] });
  const body = await officialH3Route.prepare(request as unknown as CanonicalValue).compile(async artifact => `https://assets.example/${artifact.resource}`);
  assert.deepEqual(body, { model: "MiniMax-H3", content: [
    { type: "text", text: "The person turns toward the camera." },
    { type: "image_url", image_url: { url: "https://assets.example/res_first" }, role: "first_frame" },
    { type: "image_url", image_url: { url: "https://assets.example/res_last" }, role: "last_frame" },
  ], resolution: "2K", duration: 6, ratio: "adaptive" });
});

test("multiple identity images and voice references keep their order without a source video", async () => {
  const image = (n: number): BlobRef => ({ kind: "blob", resource: `res_identity_${n}`, size: 3, mediaType: "image/png" });
  const audio: BlobRef = { kind: "blob", resource: "res_voice", size: 3, mediaType: "audio/mpeg" };
  const request = sealMinimaxH3Request({
    prompt: ["The person in the first two pictures speaks with the supplied voice."],
    duration: [8], resolution: ["768P"], aspectRatio: ["9:16"],
    referenceImage: [1, 2].map(n => ({ role: "image" as const, artifact: image(n) })),
    referenceAudio: [{ role: "audio", artifact: audio }],
  });
  const body = await officialH3Route.prepare(request as unknown as CanonicalValue).compile(async artifact => {
    // Completion order must not change reference numbering in content.
    if (artifact.resource === "res_identity_1") await new Promise(resolve => setTimeout(resolve, 10));
    return `https://assets.example/${artifact.resource}`;
  });
  const content = body.content as Array<Record<string, unknown>>;
  assert.deepEqual(content.slice(1), [
    { type: "image_url", image_url: { url: "https://assets.example/res_identity_1" }, role: "reference_image" },
    { type: "image_url", image_url: { url: "https://assets.example/res_identity_2" }, role: "reference_image" },
    { type: "audio_url", audio_url: { url: "https://assets.example/res_voice" }, role: "reference_audio" },
  ]);
});

test("text video without ratio is rejected before a paid request", async () => {
  const request = sealMinimaxH3Request({ prompt: ["A blue toy robot waves."], duration: [4] });
  const n = need(request);
  const registry = new EndpointRegistry();
  await createOfficialMiniMaxProvider({ baseUrl: "http://localhost:4010", fetch: async () => { throw new Error("must not call API"); } }).install(registry);
  const found = registry.resolve(n);
  assert.equal(found.status, "unsupported");
  const support = officialH3Route.supports(n);
  assert.equal(support.status, "unsupported");
  if (support.status === "unsupported") assert.match(support.reason, /画幅/u);
});

test("real reference video and character image pass preflight into one official request", async () => {
  const resources = new MemoryResourceStore();
  const fixture = await transferFixture();
  const video = await resources.put(new Uint8Array(fixture.bytes[1]!), "video/mp4");
  const image = await resources.put(new Uint8Array(fixture.bytes[0]!), "image/png");
  await rm(fixture.dir, { recursive: true, force: true });
  const request = sealMinimaxH3Request({ prompt: ["Replace the subject while keeping the reference motion."], duration: [4], resolution: ["768P"], aspectRatio: ["1:1"], referenceVideo: [{ role: "video", artifact: video }], referenceImage: [{ role: "image", artifact: image }] });
  const n = need(request);
  let calls = 0; let body: Record<string, unknown> = {};
  const registry = new EndpointRegistry();
  await createOfficialMiniMaxProvider({ baseUrl: "http://localhost:4010", publicAssetUrl: async ref => `https://assets.example/${ref.resource}`, fetch: async (_url, init) => { calls++; body = JSON.parse(String(init?.body)); return Response.json({ task_id: "reference-task" }); } }).install(registry);
  const found = registry.resolve(n); assert.equal(found.status, "resolved"); assert.equal(found.registration.kind, "asynchronous");
  const result = await found.registration.endpoint.start({ command: { kind: "fulfill-need", id: "command:reference", need: n }, need: n, resources, credentials: { apiKey: { secret: "test-key" } }, operation: "operation:reference" });
  assert.equal(result.status, "pending"); assert.equal(result.receipt?.id, "reference-task"); assert.equal(calls, 1);
  const content = body.content as Array<Record<string, unknown>>;
  assert.deepEqual(content.map(item => item.role).filter(Boolean), ["reference_image", "reference_video"]);
});

test("ambiguous paid POST is never repeated", async () => {
  let calls = 0;
  const { endpoint, context } = await setup(async () => { calls++; return new Response("temporary failure", { status: 503 }); });
  const result = await endpoint.start(context);
  assert.equal(result.status, "failed"); assert.equal(calls, 1);
});

test("official task query uses its task ID and preserves receipt on transient failure", async () => {
  let calls = 0;
  const { endpoint, context } = await setup(async url => { calls++; assert.match(String(url), /\/v2\/query\/video_generation\/official-task-1$/u); return new Response("temporary failure", { status: 503 }); });
  const handle = { contract: "hypit.minimax-official-h3@1", taskId: "official-task-1", startedAt: Date.now(), uploadedKeys: [] };
  const result = await endpoint.poll({ ...context, handle: handle as unknown as CanonicalValue });
  assert.equal(result.status, "pending"); assert.equal(result.receipt?.id, "official-task-1"); assert.equal(calls, 1);
});

test("succeeded task downloads original video without passing API key to CDN", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hypit-minimax-test-"));
  try {
    const videoPath = join(dir, "result.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=blue:s=768x768:r=24:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", videoPath]);
    const bytes = await readFile(videoPath);
    let cdnAuth = "not-requested";
    const { endpoint, context } = await setup(async (url, init) => {
      if (String(url).includes("/v2/query/")) return Response.json({ task: { id: "official-task-1", status: "succeeded", content: { url: "https://cdn.example/result.mp4" } } });
      cdnAuth = new Headers(init?.headers).get("authorization") ?? "none";
      return new Response(bytes, { headers: { "content-type": "video/mp4" } });
    });
    const handle = { contract: "hypit.minimax-official-h3@1", taskId: "official-task-1", startedAt: Date.now(), uploadedKeys: [] };
    const polled = await endpoint.poll({ ...context, handle: handle as unknown as CanonicalValue });
    assert.equal(polled.status, "ready"); if (polled.status !== "ready") return;
    assert.ok(endpoint.collect);
    const collected = await endpoint.collect({ ...context, handle: polled.handle });
    assert.equal(collected.status, "completed"); assert.equal(cdnAuth, "none"); assert.equal(collected.receipt?.id, "official-task-1");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Self-contained fixtures: the distribution must not depend on personal productions.
async function transferFixture() {
  const dir = await mkdtemp(join(tmpdir(), "h3-transfer-"));
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=blue:s=320x320", "-frames:v", "1", join(dir, "image.png")]);
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x320:r=24:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(dir, "video.mp4")]);
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", join(dir, "audio.wav")]);
  const resources = new MemoryResourceStore();
  const bytes = await Promise.all(["image.png", "video.mp4", "audio.wav"].map(f => readFile(join(dir, f))));
  const refs = await Promise.all(bytes.map((b, i) => resources.put(new Uint8Array(b), ["image/png", "video/mp4", "audio/wav"][i]!)));
  const n = need(sealMinimaxH3Request({prompt:["Abstract animation"], duration:[4], resolution:["768P"], aspectRatio:["1:1"], referenceImage:[{role:"image",artifact:refs[0]!}], referenceVideo:[{role:"video",artifact:refs[1]!}], referenceAudio:[{role:"audio",artifact:refs[2]!}]}));
  return { dir, bytes, refs, resources, n };
}
async function transferEndpoint(f: Awaited<ReturnType<typeof transferFixture>>, fetcher: typeof fetch, options: Parameters<typeof createOfficialMiniMaxProvider>[0] = {}) {
  const registry = new EndpointRegistry();
  await createOfficialMiniMaxProvider({baseUrl:"http://localhost:4010", fetch:fetcher, ...options}).install(registry);
  const found = registry.resolve(f.n); assert.equal(found.status,"resolved"); assert.equal(found.registration.kind,"asynchronous");
  return {endpoint:found.registration.endpoint,context:{command:{kind:"fulfill-need" as const,id:"command:transfer" as const,need:f.n},need:f.n,resources:f.resources,credentials:{apiKey:{secret:"test-key"}},operation:"operation:transfer" as const}};
}
test("default local image/video/audio preserve exact bytes with no OSS or file upload", async () => {
  const f = await transferFixture();
  try {
    let calls=0;
    const x = await transferEndpoint(f, async (url,init) => {
      calls++; assert.match(String(url), /\/v2\/video_generation$/);
      const content=JSON.parse(String(init?.body)).content.slice(1);
      assert.deepEqual(content.map((c:any)=>c.role),["reference_image","reference_video","reference_audio"]);
      content.forEach((c:any,i:number)=>{const uri=c[c.type].url;assert.match(uri,/^data:/);assert.deepEqual(Buffer.from(uri.split(",")[1],"base64"),f.bytes[i]);});
      return Response.json({task_id:"inline-test"});
    });
    assert.equal((await x.endpoint.start(x.context)).status,"pending");assert.equal(calls,1);
  } finally {await rm(f.dir,{recursive:true,force:true});}
});
test("platform transport uses the same model account and cleans up registered file IDs", async () => {
  const f=await transferFixture();
  try {
    let uploads=0,posts=0,deletes=0;
    const x=await transferEndpoint(f,async(url,init)=>{
      const path=String(url);
      if(path.endsWith("/files/upload")) {
        const form=init?.body as FormData; assert.equal(form.get("purpose"),"video_generation_input");
        assert.deepEqual(Buffer.from(await (form.get("file") as Blob).arrayBuffer()),f.bytes[uploads]); uploads++;
        return Response.json({file:{file_id:String(100+uploads)},base_resp:{status_code:0}});
      }
      if(path.endsWith("/files/delete")){deletes++;assert.equal(JSON.parse(String(init?.body)).purpose,"video_generation_input");assert.equal(typeof JSON.parse(String(init?.body)).file_id,"number");return Response.json({base_resp:{status_code:0}});}
      if(path.includes("/v2/query/"))return Response.json({task:{status:"failed"}});
      posts++; const content=JSON.parse(String(init?.body)).content.slice(1);
      assert.deepEqual(content.map((c:any)=>c[c.type].url),["mm_file://101","mm_file://102","mm_file://103"]);
      return Response.json({task_id:"platform-test"});
    },{assetTransport:"platform"});
    const result=await x.endpoint.start(x.context);assert.equal(result.status,"pending");if(result.status!=="pending")return;
    await x.endpoint.poll({...x.context,handle:result.handle});
    assert.equal(uploads,3);assert.equal(posts,1);assert.equal(deletes,3);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});
test("oversized repeated references auto-upload once; explicit inline fails before generation",async()=>{
  const f=await transferFixture();
  try{
    const padded=Buffer.concat([f.bytes[0]!,Buffer.alloc(7_000_000)]);
    const image=await f.resources.put(new Uint8Array(padded),"image/png");
    f.n=need(sealMinimaxH3Request({prompt:["Abstract animation"],duration:[4],aspectRatio:["1:1"],referenceImage:Array.from({length:9},()=>({role:"image" as const,artifact:image}))}));
    let uploads=0,posts=0;
    const fetcher:typeof fetch=async(url,init)=>{
      if(String(url).endsWith("/files/upload")){uploads++;return Response.json({file:{file_id:"222"},base_resp:{status_code:0}});}
      posts++;const body=JSON.parse(String(init?.body));assert.equal(body.content.length,10);assert.ok(body.content.slice(1).every((c:any)=>c.image_url.url==="mm_file://222"));return Response.json({task_id:"large"});
    };
    const inline=await transferEndpoint(f,fetcher,{assetTransport:"inline"});
    const fail=await inline.endpoint.start(inline.context);assert.equal(fail.status,"failed");assert.equal(posts+uploads,0);
    const auto=await transferEndpoint(f,fetcher);assert.equal((await auto.endpoint.start(auto.context)).status,"pending");assert.equal(uploads,1);assert.equal(posts,1);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});
test("unsafe file ID and platform failure never switch to OSS or create a video",async()=>{
  const f=await transferFixture();
  try{
    for(const response of [{file:{file_id:9007199254740992},base_resp:{status_code:0}},{base_resp:{status_code:1004}}]){
      let calls=0;const x=await transferEndpoint(f,async(url)=>{calls++;assert.match(String(url),/\/files\/upload$/);return Response.json(response);},{assetTransport:"platform"});
      assert.equal((await x.endpoint.start(x.context)).status,"failed");assert.equal(calls,1);
    }
  }finally{await rm(f.dir,{recursive:true,force:true});}
});
test("inline media echoed by an API error is redacted",async()=>{
  const {endpoint,context}=await setup(async()=>new Response('bad data:image/png;base64,SECRET_MEDIA_BYTES',{status:400}));
  const result=await endpoint.start(context);assert.equal(result.status,"failed");if(result.status!=="failed")return;assert.ok(!result.failure.message.includes("SECRET_MEDIA_BYTES"));
});

test("small H3 duration drift is accepted without trimming; excessive drift still fails",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"h3-duration-"));
  try{
    for(const [frames,expected] of [[107,"completed"],[120,"failed"]] as const){
      const file=join(dir,`${frames}.mp4`);
      execFileSync("ffmpeg",["-v","error","-f","lavfi","-i","color=blue:s=768x768:r=24","-frames:v",String(frames),"-c:v","libx264","-pix_fmt","yuv420p",file]);
      const bytes=await readFile(file);
      const {endpoint,context}=await setup(async()=>new Response(bytes));
      assert.ok(endpoint.collect);
      const result=await endpoint.collect({...context,handle:{contract:"hypit.minimax-official-h3@1",taskId:"existing-task",startedAt:Date.now(),uploadedKeys:[],url:"https://cdn.example/original.mp4"} as unknown as CanonicalValue});
      assert.equal(result.status,expected);
      // Collection succeeds without clipping the original video.
      if(result.status==="completed")assert.ok(result.result.value);
    }
  }finally{await rm(dir,{recursive:true,force:true});}
});


test("duration rejection retains raw artifact and receipt for recovery without another POST", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hypit-duration-recovery-"));
  try {
    const videoPath = join(dir, "result.mp4");
    execFileSync("ffmpeg", ["-v","error","-f","lavfi","-i","color=blue:s=768x768:r=24:d=5","-c:v","libx264","-pix_fmt","yuv420p",videoPath]);
    const bytes = await readFile(videoPath);
    const { endpoint, context } = await setup(async (_url, init) => {
      assert.notEqual(init?.method, "POST"); return new Response(bytes);
    });
    const stored: BlobRef[] = [];
    const put = context.resources.put.bind(context.resources);
    context.resources.put = async (...args) => { const a = await put(...args); stored.push(a); return a; };
    const handle = { contract:"hypit.minimax-official-h3@1",taskId:"OFFLINE-RAW-RECOVERY",startedAt:Date.now(),uploadedKeys:[],url:"https://cdn.example/result.mp4" };
    const result = await endpoint.collect!({...context,handle:handle as unknown as CanonicalValue});
    assert.equal(result.status,"failed"); assert.equal(result.receipt?.id,handle.taskId);
    assert.equal(stored.length,1);
    assert.deepEqual(Buffer.from((await context.resources.get(stored[0]!.resource))!), bytes);
    if (result.status === "failed") assert.ok(result.failure.message.includes(stored[0]!.resource));
  } finally { await rm(dir,{recursive:true,force:true}); }
});
