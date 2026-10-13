import net from "node:net"

/**
 * Outbound route selection for every Grok request.
 *
 * Node's `fetch` reads neither the Windows system proxy nor any application
 * setting, so a machine that reaches the internet through a local proxy needs
 * one of two answers: the Harness launcher's process-wide dispatcher (installed
 * from `HTTP_PROXY`/`HTTPS_PROXY` in the launch environment), or a route this
 * plugin owns. This module owns the second one: an operator-set HTTP proxy that
 * applies to this plugin's requests only, never to the process.
 *
 * Precedence is deliberate. A process that already carries a proxy in its
 * environment is left completely alone — the Harness launcher has already
 * installed an equivalent policy, and a settings field must not silently
 * override the deployment's own transport decision.
 */

/** Proxy address this plugin offers by default; the value is only a default, never a requirement. */
export const DEFAULT_PROXY_URL = "http://127.0.0.1:7897"

/** Environment names the Harness launcher resolves its own proxy policy from. */
const PROXY_ENV_NAMES = Object.freeze([
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
])

/** Loopback hosts whose absence is safe to fall back from: they can only ever serve this machine. */
const LOOPBACK_HOSTS = Object.freeze(["localhost", "127.0.0.1", "::1", "[::1]"])

const PROXY_SCHEMES = Object.freeze(["http:", "https:"])
const PROBE_TIMEOUT_MS = 400
const POSITIVE_PROBE_TTL_MS = 30_000
const CONNECT_FAILURE_CODES = Object.freeze([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
])

/**
 * Closed set of routes a Grok request can take. Reported without any address, so
 * the diagnostics outcome keeps its promise never to leak a proxy URL.
 */
export const NETWORK_STATES = Object.freeze([
  "environment",
  "disabled",
  "proxy",
  "proxy-unavailable",
  "proxy-invalid",
])

/**
 * Build the request route for this plugin.
 *
 * @param options - route dependencies.
 * @param options.baseFetch - the process fetch, used for every direct request.
 * @param options.readProxyConfig - current operator settings: `{ enabled, url }`.
 * @param options.loadUndici - lazily resolves the proxy transport implementation.
 * @param options.probe - reachability probe for a loopback proxy.
 * @param options.now - clock, injectable for tests.
 * @param options.env - environment carrying any launcher-resolved proxy.
 * @param options.positiveTtlMs - how long a successful loopback probe is trusted.
 * @returns a frozen route: `fetch`, current `state()`, and `dispose()`.
 */
export function createNetworkRoute({
  baseFetch,
  readProxyConfig,
  loadUndici = () => import("undici"),
  probe = probeTcp,
  now = () => Date.now(),
  env = process.env,
  positiveTtlMs = POSITIVE_PROBE_TTL_MS,
} = {}) {
  if (typeof baseFetch !== "function") throw new TypeError("Invalid Grok network fetch")
  if (typeof readProxyConfig !== "function") throw new TypeError("Invalid Grok proxy configuration source")
  if (typeof loadUndici !== "function" || typeof probe !== "function" || typeof now !== "function") {
    throw new TypeError("Invalid Grok network route dependencies")
  }
  if (env === null || typeof env !== "object") throw new TypeError("Invalid Grok proxy environment")
  if (!Number.isSafeInteger(positiveTtlMs) || positiveTtlMs <= 0) {
    throw new TypeError("Invalid Grok proxy probe lifetime")
  }

  const environmentProxy = readEnvironmentProxy(env)
  let state = environmentProxy === undefined ? "disabled" : "environment"
  let agent
  let agentUrl
  let undici
  let reachableUrl
  let reachableAt
  let probeInFlight
  let disposed = false

  const resolveRoute = async () => {
    if (environmentProxy !== undefined) {
      state = "environment"
      return { mode: "base" }
    }
    const configured = readProxyConfiguration(readProxyConfig)
    if (configured.kind === "disabled") {
      state = "disabled"
      return { mode: "base" }
    }
    if (configured.kind === "invalid") {
      state = "proxy-invalid"
      return { mode: "base" }
    }
    if (configured.loopback && !await isLoopbackProxyReachable(configured, probe, now, positiveTtlMs, {
      read: () => ({ url: reachableUrl, at: reachableAt }),
      write: (url, at) => {
        reachableUrl = url
        reachableAt = at
      },
      readInFlight: () => probeInFlight,
      writeInFlight: (promise) => {
        probeInFlight = promise
      },
    })) {
      state = "proxy-unavailable"
      return { mode: "base" }
    }
    let transport
    try {
      transport = await resolveTransport(configured)
    } catch {
      state = "proxy-unavailable"
      return { mode: "base" }
    }
    state = "proxy"
    return { mode: "proxy", ...transport }
  }

  const resolveTransport = async (configured) => {
    if (undici === undefined) undici = await loadUndici()
    if (agent === undefined || agentUrl !== configured.url) {
      const previous = agent
      agent = new undici.ProxyAgent(configured.url)
      agentUrl = configured.url
      if (previous !== undefined) await previous.close().catch(() => {})
    }
    return Object.freeze({
      url: configured.url,
      request: (input, init) => undici.fetch(input, { ...init, dispatcher: agent }),
    })
  }

  const networkFetch = async (input, init) => {
    if (disposed) throw new TypeError("The Grok network route is disposed")
    const route = await resolveRoute()
    if (route.mode === "base") return baseFetch(input, init)
    try {
      return await route.request(input, init)
    } catch (error) {
      // A loopback proxy that just refused a connection must not stay trusted
      // for the rest of its positive-probe lifetime.
      if (route.url === reachableUrl && isConnectFailure(error)) {
        reachableUrl = undefined
        reachableAt = undefined
      }
      throw error
    }
  }

  return Object.freeze({
    fetch: networkFetch,
    state: () => state,
    async dispose() {
      if (disposed) return
      disposed = true
      const current = agent
      agent = undefined
      agentUrl = undefined
      if (current !== undefined) await current.close().catch(() => {})
    },
  })
}

/**
 * Read the operator's proxy settings into one closed decision.
 * @param readProxyConfig - current settings source.
 * @returns `{ kind: "disabled" }`, `{ kind: "invalid" }`, or a usable proxy target.
 */
function readProxyConfiguration(readProxyConfig) {
  const configured = readProxyConfig()
  if (configured === null || typeof configured !== "object") return { kind: "disabled" }
  if (configured.enabled !== true) return { kind: "disabled" }
  if (typeof configured.url !== "string" || configured.url.trim() === "") return { kind: "invalid" }
  const parsed = parseProxyUrl(configured.url)
  if (parsed === undefined) return { kind: "invalid" }
  return parsed
}

/**
 * Parse one proxy address. Credentials are refused rather than stored in a
 * profile settings document, and anything that is not an HTTP(S) proxy URL is
 * refused so a typo cannot silently become a different route.
 * @param text - raw operator input.
 * @returns the parsed target, or undefined when unusable.
 */
function parseProxyUrl(text) {
  let url
  try {
    url = new URL(text.trim())
  } catch {
    return undefined
  }
  if (!PROXY_SCHEMES.includes(url.protocol)) return undefined
  if (url.username !== "" || url.password !== "") return undefined
  if (url.hostname === "") return undefined
  return Object.freeze({
    url: url.origin,
    host: url.hostname,
    port: url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port),
    loopback: LOOPBACK_HOSTS.includes(url.hostname.toLowerCase()),
  })
}

/**
 * A proxy already present in the launch environment wins: the Harness launcher
 * installed its dispatcher from exactly those names at boot.
 * @param env - process environment.
 * @returns the first usable configured name's value, or undefined.
 */
function readEnvironmentProxy(env) {
  for (const name of PROXY_ENV_NAMES) {
    const value = env[name]
    if (typeof value === "string" && value.trim() !== "") return value.trim()
  }
  return undefined
}

async function isLoopbackProxyReachable(configured, probe, now, positiveTtlMs, cache) {
  const cached = cache.read()
  if (cached.url === configured.url && cached.at !== undefined && now() - cached.at < positiveTtlMs) {
    return true
  }
  const inFlight = cache.readInFlight()
  if (inFlight !== undefined) return inFlight
  const attempt = Promise.resolve()
    .then(() => probe(configured))
    .then(
      (reached) => {
        if (reached) cache.write(configured.url, now())
        return reached
      },
      () => false,
    )
    .finally(() => {
      cache.writeInFlight(undefined)
    })
  cache.writeInFlight(attempt)
  return attempt
}

/**
 * One bounded TCP reachability probe against a local proxy.
 * @param target - parsed proxy target.
 * @returns whether something accepted the connection.
 */
function probeTcp(target) {
  return new Promise((resolve) => {
    let settled = false
    const socket = net.connect({ host: target.host, port: target.port })
    const finish = (reached) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(reached)
    }
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(false))
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
  })
}

function isConnectFailure(error) {
  const code = error?.cause?.code ?? error?.code
  return typeof code === "string" && CONNECT_FAILURE_CODES.includes(code)
}
