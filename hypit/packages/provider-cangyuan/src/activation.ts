import { createRuntimeEndpointAdapterFacet, runtimeConfigActionLimits, runtimeConfigCredentialRef, runtimeConfigExact, runtimeConfigObject, runtimeConfigPositiveInteger, runtimeConfigString } from "@hypit/runtime-kit";
import { checkCangyuanAssetStore, createCangyuanProvider } from "./provider.js";

const adapter = createRuntimeEndpointAdapterFacet({
  use: "@hypit/provider-cangyuan",
  activate(context) {
    if (context.pool === undefined) throw new Error("Cangyuan Provider Pool is required");
    const config = runtimeConfigObject(context.config, "Cangyuan");
    runtimeConfigExact(config, ["baseUrl", "apiKey", "defaultConcurrency", "actionLimits", "pollIntervalMs", "requestTimeoutMs", "operationTimeoutMs", "ossPython", "ossStorageModule", "primaryModel", "fallbackModel", "fallbackModels", "disabledModels"], "Cangyuan");
    const baseUrl = runtimeConfigString(config.baseUrl, "Cangyuan baseUrl");
    if (baseUrl !== undefined) {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") throw new Error("Cangyuan baseUrl must use HTTPS or loopback");
    }
    const apiKey = runtimeConfigCredentialRef(config.apiKey, "Cangyuan apiKey");
    if (apiKey === undefined) throw new Error("Cangyuan apiKey CredentialRef is required");
    const defaultConcurrency = runtimeConfigPositiveInteger(config.defaultConcurrency, "Cangyuan defaultConcurrency");
    const pollIntervalMs = runtimeConfigPositiveInteger(config.pollIntervalMs, "Cangyuan pollIntervalMs");
    const requestTimeoutMs = runtimeConfigPositiveInteger(config.requestTimeoutMs, "Cangyuan requestTimeoutMs");
    const operationTimeoutMs = runtimeConfigPositiveInteger(config.operationTimeoutMs, "Cangyuan operationTimeoutMs");
    const actionLimits = runtimeConfigActionLimits(config.actionLimits);
    const ossPython = runtimeConfigString(config.ossPython, "Cangyuan ossPython");
    const ossStorageModule = runtimeConfigString(config.ossStorageModule, "Cangyuan ossStorageModule");
    const primaryModel = runtimeConfigString(config.primaryModel, "Cangyuan primaryModel");
    const fallbackModel = runtimeConfigString(config.fallbackModel, "Cangyuan fallbackModel");
    const fallbackModels = config.fallbackModels === undefined ? undefined : (() => {
      if (!Array.isArray(config.fallbackModels)) throw new Error("Cangyuan fallbackModels must be an array of non-empty strings");
      return config.fallbackModels.map((value, index) => runtimeConfigString(value, `Cangyuan fallbackModels[${index}]`)!);
    })();
    const disabledModels = config.disabledModels === undefined ? undefined : (() => {
      if (!Array.isArray(config.disabledModels) || config.disabledModels.some(v => typeof v !== "string" || !v.trim())) throw new Error("disabledModels must be non-empty model IDs");
      return config.disabledModels as string[];
    })();
    return { endpoint: createCangyuanProvider({ instance: context.instance, pool: context.pool, ...(baseUrl === undefined ? {} : { baseUrl }), apiKey, ...(defaultConcurrency === undefined ? {} : { defaultConcurrency }), ...(actionLimits === undefined ? {} : { actionLimits }), ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }), ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }), ...(operationTimeoutMs === undefined ? {} : { operationTimeoutMs }), ...(ossPython === undefined ? {} : { ossPython }), ...(ossStorageModule === undefined ? {} : { ossStorageModule }), ...(primaryModel === undefined ? {} : { primaryModel }), ...(fallbackModel === undefined ? {} : { fallbackModel }), ...(fallbackModels === undefined ? {} : { fallbackModels }), ...(disabledModels === undefined ? {} : { disabledModels }) }), diagnose: async () => {
      try { await checkCangyuanAssetStore({ ...(ossPython === undefined ? {} : { ossPython }), ...(ossStorageModule === undefined ? {} : { ossStorageModule }) }); return []; }
      catch (error) { return [{ severity: "error" as const, code: "CANGYUAN_ASSET_STORE_UNAVAILABLE", message: error instanceof Error ? error.message : String(error), subject: context.instance }]; }
    } };
  },
});

export const hypitPackage = { format: "hypit.node-package@1" as const, hostFacets: [adapter] };
export default hypitPackage;
