/** Explicit paid smoke test; never loaded by the ordinary test runner.
 * Each model is submitted once. Existing checkpoint means resume, never resubmit.
 * node --import tsx packages/provider-cangyuan/scripts/smoke.ts --live OUTPUT_DIRECTORY
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import sharp from "sharp";
import { EndpointRegistry, MemoryResourceStore } from "@hypit/driver-node";
import { sealSeedanceRequest, seedanceEndpoints } from "@hypit/seedance";
import type { CanonicalValue, Need } from "@hypit/protocol";
import type { EndpointOutcome } from "@hypit/endpoint-kit";
import { createCangyuanProvider } from "../src/provider.js";
assert(process.argv[2] === "--live" && process.argv[3], "Explicit --live OUTPUT_DIRECTORY required; this creates paid requests");
const dir = resolve(process.argv[3]); await mkdir(dir, { recursive: true });
const exists = async (path: string) => access(path).then(() => true, () => false);
const svg = (color: string, antenna: string) => `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg"><rect width="512" height="512" fill="#f4ecd9"/><ellipse cx="256" cy="422" rx="135" ry="20" fill="#c7bba4"/><g stroke="#222" stroke-width="7" stroke-linejoin="round"><rect x="181" y="160" width="150" height="110" rx="22" fill="${color}"/><path d="M256 160v-35"/><circle cx="256" cy="114" r="16" fill="${antenna}"/><rect x="195" y="280" width="122" height="90" rx="15" fill="${color}"/><path d="M207 370v42m96-42v42M195 299l-40 50M317 299l40-50" fill="none"/><circle cx="221" cy="208" r="14" fill="white"/><circle cx="291" cy="208" r="14" fill="white"/><path d="M231 241h50"/></g></svg>`;
if (!await exists(join(dir, "reference.mp4"))) {
 await sharp(Buffer.from(svg("#dc513e", "#dc513e"))).png().toFile(join(dir, "original.png"));
 await sharp(Buffer.from(svg("#357cce", "#ffe25c"))).png().toFile(join(dir, "replacement.png"));
 execFileSync("ffmpeg", ["-v", "error", "-y", "-loop", "1", "-i", join(dir, "original.png"), "-vf", "zoompan=z='1+0.08*sin(on/120*PI)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=120:s=512x512:fps=30", "-t", "4", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(dir, "reference.mp4")], { timeout: 30_000 });
}
const key = execFileSync("security", ["find-generic-password", "-s", "ai-dsp-cangyuan", "-a", "ai-dsp", "-w"], { encoding: "utf8" }).trim();
for (const [model, resolution] of [["sd12-seedance-2.0", "480p"], ["sd14-seedance-2.0", "720p"]] as const) {
 if (process.argv[4] && process.argv[4] !== model) continue;
 const statePath = join(dir, `${model}.private.json`); const reportPath = join(dir, `${model}.json`);
 if (await exists(reportPath) && ["completed", "failed"].includes(JSON.parse(await readFile(reportPath, "utf8")).status)) { console.log(`${model}: already terminal; no new submission`); continue; }
 const resources = new MemoryResourceStore();
 const video = await resources.put(new Uint8Array(await readFile(join(dir, "reference.mp4"))), "video/mp4");
 const image = await resources.put(new Uint8Array(await readFile(join(dir, "replacement.png"))), "image/png");
 const constraints = sealSeedanceRequest("seedance-2", { prompt: ["参考视频1的构图、镜头缓慢推进和节奏，使用参考图1中的蓝色原创玩具机器人替换红色机器人。保持蓝色机身与黄色天线，机器人自然挥动右手。温暖浅色背景，连续真实运动，不要把静态图片贴在画面上，不要文字。"], resolution: [resolution], aspectRatio: ["1:1"], duration: [4], generateAudio: [false], webSearch: [false], referenceVideo: [{ role: "video", artifact: video, fields: { personReference: false } }], referenceImage: [{ role: "image", artifact: image, fields: { personReference: false } }] });
 const need: Need = { id: "need:smoke", capability: seedanceEndpoints.standard!.capability, returns: seedanceEndpoints.standard!.returns, constraints: constraints as unknown as CanonicalValue, result: "record:smoke" };
 const registry = new EndpointRegistry(); await createCangyuanProvider({ primaryModel: model, fallbackModels: [], pollIntervalMs: 10_000 }).install(registry);
 const found = registry.resolve(need); assert(found.status === "resolved" && found.registration.kind === "asynchronous"); const endpoint = found.registration.endpoint;
 const context = { need, command: { kind: "fulfill-need" as const, id: "command:smoke" as const, need }, operation: `operation:smoke-${model}` as const, resources, credentials: { apiKey: { secret: key } }, reportProgress: async (p: { phase?: string }) => { console.log(`${model}: ${p.phase}`); }, checkpoint: async (c: { handle: CanonicalValue }) => { await writeFile(statePath, JSON.stringify(c.handle), { mode: 0o600 }); } };
 let state: EndpointOutcome;
 if (await exists(statePath)) state = { status: "pending", handle: JSON.parse(await readFile(statePath, "utf8")), wake: { kind: "timer", at: new Date().toISOString() } } as unknown as EndpointOutcome;
 else {
  assert(!await exists(reportPath), "Earlier submission has no checkpoint; inspect the service task history before retrying");
  // Durable submission marker: a lost HTTP response must not create another paid job on rerun.
  await writeFile(reportPath, JSON.stringify({ model, status: "submitting", started: new Date().toISOString() }));
  state = await endpoint.start(context);
 }
 while (state.status === "pending") {
  const handle = state.handle; await writeFile(statePath, JSON.stringify(handle), { mode: 0o600 });
  await writeFile(reportPath, JSON.stringify({ model, resolution, status: "pending", receipt: state.receipt, checked: new Date().toISOString() }, null, 2));
  await new Promise(resolve => setTimeout(resolve, 10_000));
  state = await endpoint.poll({ ...context, handle });
 }
 if (state.status === "ready") { await writeFile(statePath, JSON.stringify(state.handle), { mode: 0o600 }); state = await endpoint.collect!({ ...context, handle: state.handle }); }
 if (state.status === "completed") {
  const stored = state.result.value;
  assert(stored.kind === "inline");
  const value = stored.value as unknown as { videos: { resource: `res_${string}` }[] };
  const artifact = value.videos[0]!; const bytes = await resources.get(artifact.resource); assert(bytes);
  await writeFile(join(dir, `${model}.mp4`), bytes);
 }
 const report = { model, resolution, status: state.status, receipt: state.receipt, ...(state.status === "failed" ? { failure: state.failure } : {}), checked: new Date().toISOString() };
 await writeFile(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
}
