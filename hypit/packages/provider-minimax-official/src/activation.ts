import { createRuntimeEndpointAdapterFacet, runtimeConfigActionLimits, runtimeConfigCredentialRef, runtimeConfigExact, runtimeConfigObject, runtimeConfigPositiveInteger, runtimeConfigString } from "@hypit/runtime-kit";
import { checkAssetStore, createOfficialMiniMaxProvider } from "./provider.js";

const adapter = createRuntimeEndpointAdapterFacet({
  use: "@hypit/provider-minimax-official",
  activate(context) {
    if (context.pool === undefined) throw new Error("MiniMax official Provider Pool is required");
    const config = runtimeConfigObject(context.config, "MiniMax official");
    runtimeConfigExact(config, ["baseUrl", "apiKey", "defaultConcurrency", "actionLimits", "pollIntervalMs", "requestTimeoutMs", "operationTimeoutMs", "ossPython", "ossStorageModule", "assetTransport", "submissionPolicyModule", "submissionPlan", "submissionLedgerRoot"], "MiniMax official");
    const baseUrl = runtimeConfigString(config.baseUrl, "MiniMax official baseUrl");
    const apiKey = runtimeConfigCredentialRef(config.apiKey, "MiniMax official apiKey");
    if (apiKey === undefined) throw new Error("MiniMax official apiKey CredentialRef is required");
    const defaultConcurrency = runtimeConfigPositiveInteger(config.defaultConcurrency, "MiniMax official defaultConcurrency");
    const pollIntervalMs = runtimeConfigPositiveInteger(config.pollIntervalMs, "MiniMax official pollIntervalMs");
    const requestTimeoutMs = runtimeConfigPositiveInteger(config.requestTimeoutMs, "MiniMax official requestTimeoutMs");
    const operationTimeoutMs = runtimeConfigPositiveInteger(config.operationTimeoutMs, "MiniMax official operationTimeoutMs");
    const actionLimits = runtimeConfigActionLimits(config.actionLimits);
    const assetTransport = runtimeConfigString(config.assetTransport, "MiniMax official assetTransport") ?? "auto";
    if (!["auto", "inline", "platform", "oss"].includes(assetTransport)) throw new Error("MiniMax assetTransport 须为 auto/inline/platform/oss");
    const ossPython = runtimeConfigString(config.ossPython, "MiniMax official ossPython");
    const ossStorageModule = runtimeConfigString(config.ossStorageModule, "MiniMax official ossStorageModule");
    const submissionPolicyModule = runtimeConfigString(config.submissionPolicyModule, "MiniMax official submissionPolicyModule");
    const submissionPlan = runtimeConfigString(config.submissionPlan, "MiniMax official submissionPlan");
    const submissionLedgerRoot = runtimeConfigString(config.submissionLedgerRoot, "MiniMax official submissionLedgerRoot");
    const policy = { ...(submissionPolicyModule ? { submissionPolicyModule } : {}), ...(submissionPlan ? { submissionPlan } : {}), ...(submissionLedgerRoot ? { submissionLedgerRoot } : {}) };
    const assets = { ...(ossPython ? { ossPython } : {}), ...(ossStorageModule ? { ossStorageModule } : {}) };
    return { endpoint: createOfficialMiniMaxProvider({ instance: context.instance, pool: context.pool, ...(baseUrl ? { baseUrl } : {}), apiKey, ...(defaultConcurrency ? { defaultConcurrency } : {}), ...(pollIntervalMs ? { pollIntervalMs } : {}), ...(requestTimeoutMs ? { requestTimeoutMs } : {}), ...(operationTimeoutMs ? { operationTimeoutMs } : {}), ...(actionLimits ? { actionLimits } : {}), ...assets, ...policy, assetTransport: assetTransport as "auto" | "inline" | "platform" | "oss" }), diagnose: async () => {
      if (assetTransport !== "oss") return [];
      try { await checkAssetStore(assets); return []; }
      catch (error) { return [{ severity: "error" as const, code: "MINIMAX_ASSET_STORE_UNAVAILABLE", message: error instanceof Error ? error.message : String(error), subject: context.instance }]; }
    } };
  },
});

export const hypitPackage = { format: "hypit.node-package@1" as const, hostFacets: [adapter] };
export default hypitPackage;
