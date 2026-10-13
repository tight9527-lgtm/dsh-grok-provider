import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import packageJson from "../../package.json" with { type: "json" }

import { attributionHeaders } from "@deepseek-ai/dsh-llm"
import Schema from "@deepseek-ai/schemastery"
import { clientRequestSchema } from "@deepseek-ai/dsh-client-connection"

import {
  GROK_PRODUCTION_OIDC_AUTH_CONTRACT,
  UnsupportedCredentialError,
  createCredentialSource,
} from "../internal/credential-source.mjs"
import { createAccountDashboard } from "../internal/account-dashboard.mjs"
import { createAuthController } from "../internal/auth-controller.mjs"
import { createAuthRpcHandler } from "../internal/auth-rpc.mjs"
import { createAuthFetchRoutes } from "../internal/auth-fetch.mjs"
import { createGrokAdapter } from "../internal/grok-adapter.mjs"
import { createGrokCommandHandler } from "../internal/grok-command-handler.mjs"
import { createGrokTransport } from "../internal/grok-transport.mjs"
import { mapLlmError } from "../internal/llm-error.mjs"
import { createOfficialCredentialLoader } from "../internal/official-credential-loader.mjs"
import { createOfficialCliAuth } from "../internal/official-cli-auth.mjs"
import { createOfficialAuthDriver } from "../internal/official-auth-driver.mjs"
import { verifyOfficialCliExecutable } from "../internal/official-cli-verifier.mjs"
import { installProviderRuntime } from "../internal/provider-runtime.mjs"
import { createRuntimeDiagnostics } from "../internal/runtime-diagnostics.mjs"
import { createNetworkRoute } from "../internal/network-proxy.mjs"

export const name = "llm-grok"
export const inject = ["llm"]
/** cosmokit's shared live-config reference protocol, read without importing the package. */
const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write")

export const Config = Schema.object({
  webSearch: Schema.boolean().default(false).description("Allow xAI Web Search for regular Grok requests").volatile(),
  xSearch: Schema.boolean().default(false).description("Allow xAI X Search for regular Grok requests").volatile(),
  proxyEnabled: Schema.boolean().default(true)
    .description("Route Grok requests through the HTTP proxy below").volatile(),
  proxyUrl: Schema.string().default("http://127.0.0.1:7897")
    .description("HTTP proxy address used for Grok requests").volatile(),
})

export function apply(ctx, config) {
  const platform = process.platform
  if (platform !== "darwin" && platform !== "win32") {
    throw new TypeError("dsh-grok-provider supports macOS and Windows")
  }

  // Harness 0.2.0 owns settings by Loader entry: the profile entry id
  // (`llm-grok`) IS the namespace, the form derives from this Config, and a
  // configuration write reaches this plugin through the normal Loader path.
  // `configure({ auto: false })` states that the browser page lives in this
  // package instead of an auto-generated form.
  const currentConfig = () => ({
    webSearch: readLiveValue(config?.webSearch),
    xSearch: readLiveValue(config?.xSearch),
  })
  // Harness 0.2.0 routes outbound HTTP through a process-wide dispatcher the
  // launcher installs from the launch environment, which covers hosts that carry
  // HTTP_PROXY/HTTPS_PROXY. A machine whose only proxy is application-local (the
  // desktop app started from a plain shortcut, for example) has nothing to read,
  // so this plugin offers its own operator-set route for its own requests only.
  const networkRoute = createNetworkRoute({
    baseFetch: globalThis.fetch,
    readProxyConfig: () => ({
      enabled: readLiveValue(config?.proxyEnabled) !== false,
      url: readLiveValue(config?.proxyUrl),
    }),
    env: process.env,
  })
  ctx.effect(() => () => networkRoute.dispose(), "llm-grok network route")

  const homeDir = os.homedir()
  let refreshOfficialCredential
  let inspectOfficialCli
  const officialSource = createCredentialSource({
    contract: GROK_PRODUCTION_OIDC_AUTH_CONTRACT,
    load: createOfficialCredentialLoader({
      authPath: path.join(homeDir, ".grok", "auth.json"),
      platform,
    }),
    now: () => new Date(),
    refresh: async () => {
      if (refreshOfficialCredential === undefined) throw new UnsupportedCredentialError()
      await refreshOfficialCredential()
    },
  })
  const runtime = installProviderRuntime({
    llm: ctx.llm,
    officialSource,
    createTransport: (credentialSource) => createGrokTransport({
      credentialSource,
      fetch: networkRoute.fetch,
      attributionHeaders,
      clientIdentifier: "dsh-grok-provider",
      clientVersion: "1.0.5",
    }),
    createAdapter: ({ getGeneration }) => createGrokAdapter({
      getGeneration,
      getAttachmentStore: () => ctx.get("attachments"),
      getSearchPolicy: () => {
        const current = currentConfig()
        return {
          webSearch: current.webSearch,
          xSearch: current.xSearch,
        }
      },
      mapError: mapLlmError,
    }),
  })
  ctx.inject(["settings"], (settingsCtx) => {
    settingsCtx.effect(
      () => settingsCtx.settings.configure({ auto: false }, ctx.fiber),
      "llm-grok settings presentation",
    )
  })
  const authController = createAuthController({
    registry: runtime.auth,
    randomUUID,
  })
  const commandHandler = createGrokCommandHandler({ controller: authController })
  const dashboard = createAccountDashboard({
    listModels: () => runtime.adapter.listModels("grok"),
    getBilling: ({ signal } = {}) => runtime.auth.getGeneration().transport.getBilling({ signal }),
    now: () => new Date(),
  })
  const runtimeDiagnostics = createRuntimeDiagnostics({
    pluginVersion: packageJson.version,
    getCliInspector: () => inspectOfficialCli,
    getNetworkState: () => networkRoute.state(),
  })
  const authRpcHandler = createAuthRpcHandler({
    controller: authController,
    dashboard,
    diagnostics: runtimeDiagnostics.read,
  })

  ctx.inject(["subprocess"], (subprocessCtx) => {
    let removeDriver
    let refresh
    let inspectCli
    let isolated = false
    const isolate = () => {
      if (isolated) return
      isolated = true
      if (inspectOfficialCli === inspectCli) inspectOfficialCli = undefined
      if (refreshOfficialCredential === refresh) refreshOfficialCredential = undefined
      removeDriver?.()
    }
    const officialAuth = createOfficialCliAuth({
      subprocess: subprocessCtx.subprocess,
      platform,
      homeDir,
      verifyExecutable: verifyOfficialCliExecutable,
      onCleanupFailure: isolate,
    })
    inspectCli = ({ signal } = {}) => officialAuth.inspect({ signal })
    inspectOfficialCli = inspectCli
    removeDriver = authController.installDriver(createOfficialAuthDriver({
      officialAuth,
      credentialSource: officialSource,
    }))
    refresh = async () => {
      const outcome = await authController.refresh()
      if (outcome.kind !== "succeeded") throw new UnsupportedCredentialError()
    }
    refreshOfficialCredential = refresh
    return async () => {
      isolate()
      const results = await Promise.allSettled([
        runtimeDiagnostics.disposeInspector(inspectCli),
        authController.shutdown(),
      ])
      const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason)
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, "Failed to dispose Grok CLI capability")
    }
  })

  ctx.inject(["commands"], (commandsCtx) => commandsCtx.commands.register({
    name: "grok",
    description: "Manage Grok Build authentication",
    input: { hint: "status|login|cancel|logout" },
    recordInput: false,
    handler: commandHandler,
  }))
  ctx.inject(["connection"], (connectionCtx) => {
    for (const route of createAuthFetchRoutes(authRpcHandler, clientRequestSchema)) {
      connectionCtx.connection.fetch.register(route)
    }
  })

  ctx.effect(() => () => runtime.dispose(), "llm-grok runtime")
}

/**
 * Read one live Config field. A `.volatile()` field is projected as a cosmokit
 * live reference whose current value is read at call time, so a settings write
 * reaches later calls without re-reading the profile; a plain value is accepted
 * unchanged for compositions that validate without the volatile projection.
 * @param value - validated Config field.
 * @returns the current field value.
 */
function readLiveValue(value) {
  if (
    typeof value === "object" && value !== null &&
    VOLATILE_WRITE in value && typeof value.get === "function"
  ) {
    return value.get()
  }
  return value
}
