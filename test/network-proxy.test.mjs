import assert from "node:assert/strict"
import test from "node:test"

import { createNetworkRoute, DEFAULT_PROXY_URL } from "../src/internal/network-proxy.mjs"

const LOOPBACK_URL = "http://127.0.0.1:7897"

test("a proxy already present in the launch environment is left to the host", async () => {
  const undici = createUndiciStub()
  let undiciLoads = 0
  let probes = 0
  const route = createNetworkRoute({
    baseFetch: async () => new Response("direct", { status: 200 }),
    readProxyConfig: () => ({ enabled: true, url: LOOPBACK_URL }),
    loadUndici: () => {
      undiciLoads += 1
      return undici.module
    },
    probe: () => {
      probes += 1
      return true
    },
    env: { HTTPS_PROXY: "http://10.0.0.5:3128" },
  })

  const response = await route.fetch("https://cli-chat-proxy.grok.com/v1/models")
  assert.equal(await response.text(), "direct")
  assert.equal(route.state(), "environment")
  assert.equal(undiciLoads, 0)
  assert.equal(probes, 0)
  await route.dispose()
})

test("a disabled proxy setting routes directly and never loads the proxy transport", async () => {
  const route = createNetworkRoute({
    baseFetch: async () => new Response("direct", { status: 200 }),
    readProxyConfig: () => ({ enabled: false, url: LOOPBACK_URL }),
    loadUndici: () => { throw new Error("must not load undici") },
    probe: () => { throw new Error("must not probe") },
    env: {},
  })

  assert.equal(route.state(), "disabled")
  assert.equal(await (await route.fetch("https://cli-chat-proxy.grok.com/v1/models")).text(), "direct")
  assert.equal(route.state(), "disabled")
  await route.dispose()
})

test("an unusable proxy address routes directly instead of failing every request", async () => {
  for (const url of ["127.0.0.1:7897", "socks5://127.0.0.1:1080", "http://user:pass@127.0.0.1:7897", ""]) {
    const route = createNetworkRoute({
      baseFetch: async () => new Response("direct", { status: 200 }),
      readProxyConfig: () => ({ enabled: true, url }),
      loadUndici: () => { throw new Error("must not load undici") },
      probe: () => { throw new Error("must not probe") },
      env: {},
    })

    assert.equal(await (await route.fetch("https://cli-chat-proxy.grok.com/v1/models")).text(), "direct")
    assert.equal(route.state(), "proxy-invalid", `url ${JSON.stringify(url)}`)
    await route.dispose()
  }
})

test("a local proxy that is not listening falls back to a direct connection", async () => {
  const probes = []
  const route = createNetworkRoute({
    baseFetch: async () => new Response("direct", { status: 200 }),
    readProxyConfig: () => ({ enabled: true, url: LOOPBACK_URL }),
    loadUndici: () => { throw new Error("must not load undici while the proxy is down") },
    probe: (target) => {
      probes.push(`${target.host}:${target.port}`)
      return false
    },
    env: {},
  })

  assert.equal(await (await route.fetch("https://cli-chat-proxy.grok.com/v1/models")).text(), "direct")
  assert.equal(route.state(), "proxy-unavailable")
  assert.deepEqual(probes, ["127.0.0.1:7897"])
  // A negative probe is never cached: starting the proxy is picked up at once.
  await route.fetch("https://cli-chat-proxy.grok.com/v1/models")
  assert.deepEqual(probes, ["127.0.0.1:7897", "127.0.0.1:7897"])
  await route.dispose()
})

test("a reachable local proxy carries the request with its own dispatcher", async () => {
  const undici = createUndiciStub()
  const route = createNetworkRoute({
    baseFetch: async () => new Response("direct", { status: 200 }),
    readProxyConfig: () => ({ enabled: true, url: LOOPBACK_URL }),
    loadUndici: () => undici.module,
    probe: () => true,
    env: {},
  })

  const response = await route.fetch("https://cli-chat-proxy.grok.com/v1/models", { headers: { accept: "application/json" } })
  assert.equal(await response.text(), "proxied")
  assert.equal(route.state(), "proxy")
  assert.deepEqual(undici.agents, [LOOPBACK_URL])
  assert.equal(undici.requests.length, 1)
  assert.equal(undici.requests[0].init.dispatcher, undici.dispatchers[0])
  assert.deepEqual(undici.requests[0].init.headers, { accept: "application/json" })
  await route.dispose()
  assert.deepEqual(undici.closes, [LOOPBACK_URL])
})

test("a non-local proxy is used without probing it and never falls back", async () => {
  const undici = createUndiciStub()
  let probes = 0
  const route = createNetworkRoute({
    baseFetch: async () => new Response("direct", { status: 200 }),
    readProxyConfig: () => ({ enabled: true, url: "http://10.0.0.5:3128" }),
    loadUndici: () => undici.module,
    probe: () => {
      probes += 1
      return false
    },
    env: {},
  })

  assert.equal(await (await route.fetch("https://cli-chat-proxy.grok.com/v1/models")).text(), "proxied")
  assert.equal(route.state(), "proxy")
  assert.equal(probes, 0)
  await route.dispose()
})

test("a successful local probe is cached until its lifetime expires", async () => {
  const undici = createUndiciStub()
  let probes = 0
  let clock = 1_000
  const route = createNetworkRoute({
    baseFetch: async () => new Response("direct", { status: 200 }),
    readProxyConfig: () => ({ enabled: true, url: LOOPBACK_URL }),
    loadUndici: () => undici.module,
    probe: () => {
      probes += 1
      return true
    },
    now: () => clock,
    positiveTtlMs: 5_000,
    env: {},
  })

  await route.fetch("https://cli-chat-proxy.grok.com/v1/models")
  clock += 4_000
  await route.fetch("https://cli-chat-proxy.grok.com/v1/models")
  assert.equal(probes, 1)
  clock += 2_000
  await route.fetch("https://cli-chat-proxy.grok.com/v1/models")
  assert.equal(probes, 2)
  await route.dispose()
})

test("a refused connection invalidates the cached probe and falls back next time", async () => {
  const undici = createUndiciStub()
  let probes = 0
  let reachable = true
  undici.module.fetch = async () => {
    const error = new TypeError("fetch failed")
    error.cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })
    throw error
  }
  const route = createNetworkRoute({
    baseFetch: async () => new Response("direct", { status: 200 }),
    readProxyConfig: () => ({ enabled: true, url: LOOPBACK_URL }),
    loadUndici: () => undici.module,
    probe: () => {
      probes += 1
      return reachable
    },
    env: {},
  })

  await assert.rejects(route.fetch("https://cli-chat-proxy.grok.com/v1/models"))
  reachable = false
  assert.equal(await (await route.fetch("https://cli-chat-proxy.grok.com/v1/models")).text(), "direct")
  assert.equal(route.state(), "proxy-unavailable")
  assert.equal(probes, 2)
  await route.dispose()
})

test("the route follows live settings and refuses use after disposal", async () => {
  const undici = createUndiciStub()
  const settings = { enabled: true, url: LOOPBACK_URL }
  const route = createNetworkRoute({
    baseFetch: async () => new Response("direct", { status: 200 }),
    readProxyConfig: () => ({ ...settings }),
    loadUndici: () => undici.module,
    probe: () => true,
    env: {},
  })

  assert.equal(await (await route.fetch("https://cli-chat-proxy.grok.com/v1/models")).text(), "proxied")
  settings.enabled = false
  assert.equal(await (await route.fetch("https://cli-chat-proxy.grok.com/v1/models")).text(), "direct")
  assert.equal(route.state(), "disabled")
  settings.enabled = true
  settings.url = "http://10.0.0.5:3128"
  await route.fetch("https://cli-chat-proxy.grok.com/v1/models")
  assert.deepEqual(undici.agents, [LOOPBACK_URL, "http://10.0.0.5:3128"])
  assert.deepEqual(undici.closes, [LOOPBACK_URL])

  await route.dispose()
  await assert.rejects(route.fetch("https://cli-chat-proxy.grok.com/v1/models"), { name: "TypeError" })
})

test("the default proxy address is the local Clash port this plugin offers", () => {
  assert.equal(DEFAULT_PROXY_URL, "http://127.0.0.1:7897")
})

function createUndiciStub() {
  const agents = []
  const closes = []
  const dispatchers = []
  const requests = []
  class ProxyAgent {
    constructor(url) {
      this.url = url
      agents.push(url)
      dispatchers.push(this)
    }

    async close() {
      closes.push(this.url)
    }
  }
  const module = {
    ProxyAgent,
    async fetch(input, init) {
      requests.push({ input, init })
      return new Response("proxied", { status: 200 })
    },
  }
  return { agents, closes, dispatchers, module, requests }
}
