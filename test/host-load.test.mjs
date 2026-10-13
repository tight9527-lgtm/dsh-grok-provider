import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { Context } from "@deepseek-ai/cordis"
import LlmRuntime, { LlmError } from "@deepseek-ai/dsh-llm"

import * as grokPlugin from "../src/host/index.mjs"
import { mapLlmError } from "../src/internal/llm-error.mjs"
import {
  InvalidRequestImageProjectionError,
  UnsupportedImageInputError,
  UnsupportedSearchCapabilityError,
} from "../src/internal/responses-request-compiler.mjs"
import { UnsupportedResponsesRequestError } from "../src/internal/responses-request.mjs"

const hostApplySupported = process.platform === "darwin" || process.platform === "win32"

test("the Host loads against dsh-settings 0.2.0-rc.2 without the removed section installer", async () => {
  const settings = await import("@deepseek-ai/dsh-settings")
  assert.equal(settings.installSettingsSection, undefined)
  assert.equal(settings.settingsNamespace, undefined)
  assert.equal(settings.default.prototype.installSection, undefined)
  assert.equal(typeof settings.default.prototype.configure, "function")
  assert.equal(typeof settings.default.prototype.describe, "function")
  assert.equal(grokPlugin.name, "llm-grok")
  assert.equal(typeof grokPlugin.apply, "function")
})

test("the Host plugin registers and cleanly removes the Grok provider in the real LLM runtime", {
  skip: hostApplySupported ? false : "Host apply is macOS/Windows only",
}, async () => {
  const ctx = new Context()
  const llmFiber = ctx.plugin(LlmRuntime)
  await llmFiber
  const grokFiber = ctx.plugin(grokPlugin, { proxyEnabled: false })
  await grokFiber

  assert.deepEqual(ctx.llm.listProviders(), [{ id: "grok", name: "Grok Build" }])

  await grokFiber.dispose()
  assert.deepEqual(ctx.llm.listProviders(), [])
  await llmFiber.dispose()
})

test("the Host claims its own settings presentation instead of registering a section", {
  skip: hostApplySupported ? false : "Host apply is macOS/Windows only",
}, async () => {
  const ctx = new Context()
  const settings = createSettingsStub()
  const settingsFiber = ctx.plugin(settings.plugin)
  await settingsFiber
  const llmFiber = ctx.plugin(LlmRuntime)
  await llmFiber
  const grokFiber = ctx.plugin(grokPlugin, { proxyEnabled: false })
  await grokFiber

  // Harness 0.2.0 projects the settings form from this Config, and only
  // volatile fields are editable at runtime.
  assert.equal(grokPlugin.Config.dict.webSearch.meta.volatile, true)
  assert.equal(grokPlugin.Config.dict.xSearch.meta.volatile, true)
  assert.equal(grokPlugin.Config.dict.proxyEnabled.meta.volatile, true)
  assert.equal(grokPlugin.Config.dict.proxyUrl.meta.volatile, true)
  // The namespace is the Loader entry id, so the plugin registers no section
  // and no namespace of its own with the settings service, and it declines the
  // auto-generated page because this package ships its own.
  assert.equal(settings.calls.length, 1)
  assert.deepEqual(settings.calls[0].presentation, { auto: false })
  const owner = settings.calls[0].owner
  // One instance may hold one presentation policy at a time.
  assert.throws(
    () => settings.service.configure({ auto: false }, owner),
    /already configured/u,
  )

  // The presentation is effect-owned: unloading the plugin releases it.
  await grokFiber.dispose()
  const release = settings.service.configure({ auto: false }, owner)
  assert.equal(typeof release, "function")
  release()

  await llmFiber.dispose()
  await settingsFiber.dispose()
})

test("the Host exposes opt-in Search policy and an opt-out proxy without a selectable authentication mode", () => {
  assert.deepEqual(readLiveConfig({}), {
    webSearch: false,
    xSearch: false,
    proxyEnabled: true,
    proxyUrl: "http://127.0.0.1:7897",
  })
  assert.deepEqual(readLiveConfig({ webSearch: true, xSearch: false }), {
    webSearch: true,
    xSearch: false,
    proxyEnabled: true,
    proxyUrl: "http://127.0.0.1:7897",
  })
  assert.deepEqual(readLiveConfig({ proxyEnabled: false, proxyUrl: "http://10.0.0.5:3128" }), {
    webSearch: false,
    xSearch: false,
    proxyEnabled: false,
    proxyUrl: "http://10.0.0.5:3128",
  })
  assert.throws(() => grokPlugin.Config({ webSearch: "true" }), TypeError)
  assert.throws(() => grokPlugin.Config({ proxyEnabled: "true" }), TypeError)
  assert.throws(() => grokPlugin.Config({ proxyUrl: 7897 }), TypeError)
  assert.doesNotMatch(String(grokPlugin.Config), /authMode/u)
  assert.deepEqual(Object.keys(grokPlugin).sort(), ["Config", "apply", "inject", "name"])
})

/** Read the validated Config the way the Host does: a volatile field is a live reference. */
function readLiveConfig(raw) {
  const parsed = grokPlugin.Config(raw)
  return {
    webSearch: parsed.webSearch.get(),
    xSearch: parsed.xSearch.get(),
    proxyEnabled: parsed.proxyEnabled.get(),
    proxyUrl: parsed.proxyUrl.get(),
  }
}

test("the Host applies Search configuration to later calls across a plugin reload", {
  skip: hostApplySupported ? false : "Host apply is macOS/Windows only",
}, async () => {
  const originalFetch = globalThis.fetch
  const originalHome = process.env.HOME
  const originalUserProfile = process.env.USERPROFILE
  const fixtureHome = await mkdtemp(join(tmpdir(), "dsh-grok-host-config-"))
  const authDir = join(fixtureHome, ".grok")
  let grokFiber
  let llmFiber
  let settingsFiber
  const capturedRequests = []

  try {
    await mkdir(authDir)
    await writeFile(join(authDir, "auth.json"), JSON.stringify(officialCredentialFixture()), {
      mode: 0o600,
    })
    process.env.HOME = fixtureHome
    process.env.USERPROFILE = fixtureHome
    globalThis.fetch = async (url, init = {}) => {
      if (url === "https://cli-chat-proxy.grok.com/v1/models") {
        return new Response(modelCatalogFixture(), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url === "https://cli-chat-proxy.grok.com/v1/responses") {
        capturedRequests.push(JSON.parse(init.body))
        return new Response(completedResponseFixture(), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      }
      throw new Error(`Unexpected fixture URL: ${url}`)
    }

    const ctx = new Context()
    const settings = createSettingsStub()
    settingsFiber = ctx.plugin(settings.plugin)
    await settingsFiber
    llmFiber = ctx.plugin(LlmRuntime)
    await llmFiber
    grokFiber = ctx.plugin(grokPlugin, { webSearch: true, proxyEnabled: false })
    await grokFiber

    const requestOptions = (id) => ({
      provider: "grok",
      model: "grok-4.6",
      messages: [{
        id,
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: "Find the official documentation" }],
      }],
    })

    for await (const _chunk of ctx.llm.stream(requestOptions("configured-before-reload"))) {}

    // Harness 0.2.0 applies a configuration write by reloading the plugin entry
    // with its new config, so later calls use the new policy. That unload also
    // retires the previous generation — the Host contract requires an unload to
    // abort its fetches — while the per-generation snapshot a prepared call
    // takes is covered by the adapter and request-compiler suites.
    await grokFiber.dispose()
    grokFiber = ctx.plugin(grokPlugin, { webSearch: false, xSearch: true, proxyEnabled: false })
    await grokFiber

    for await (const _chunk of ctx.llm.stream(requestOptions("created-after-reload"))) {}

    assert.deepEqual(capturedRequests.map((request) => request.tools), [
      [{ type: "web_search" }],
      [{ type: "x_search" }],
    ])
  } finally {
    globalThis.fetch = originalFetch
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
    try {
      await grokFiber?.dispose()
    } finally {
      try {
        await settingsFiber?.dispose()
      } finally {
        try {
          await llmFiber?.dispose()
        } finally {
          await rm(fixtureHome, { recursive: true, force: true })
        }
      }
    }
  }
})

/**
 * The Host's settings service is a Loader/profile-owned service, so a unit test
 * supplies the smallest faithful stand-in: entry-independent `configure`
 * bookkeeping for the presentation policy this plugin claims.
 */
function createSettingsStub() {
  const live = new Map()
  const calls = []
  const service = {
    configure(presentation, owner) {
      if (live.has(owner)) {
        throw new Error("Settings presentation is already configured for this plugin instance")
      }
      live.set(owner, presentation)
      calls.push({ presentation, owner })
      return () => live.delete(owner)
    },
    describe() {
      return []
    },
  }
  return {
    calls,
    service,
    plugin: {
      name: "test/settings-stub",
      apply(pluginCtx) {
        pluginCtx.provide("settings", service)
      },
    },
    get live() {
      return [...live.values()]
    },
  }
}

test("the Host distinguishes image and Search policy failures from invalid generic requests", () => {
  assert.equal(mapLlmError(new UnsupportedImageInputError()).code, "UNSUPPORTED_CONTENT")
  assert.equal(mapLlmError(new UnsupportedSearchCapabilityError()).code, "UNSUPPORTED_CONTENT")
  assert.equal(mapLlmError(Object.assign(new Error("unsupported projection"), {
    code: "ATTACHMENT_PROJECTION_UNSUPPORTED",
  })).code, "UNSUPPORTED_CONTENT")
  assert.equal(mapLlmError(new InvalidRequestImageProjectionError()).code, "INVALID_RESPONSE")
  assert.equal(mapLlmError(new UnsupportedResponsesRequestError()).code, "INVALID_RESPONSE")
})

test("an aborted request maps an existing LLM error to ABORTED", () => {
  const controller = new AbortController()
  const reason = new LlmError("fixture", "AUTH")
  controller.abort(reason)

  const mapped = mapLlmError(reason, controller.signal)

  assert.equal(mapped.code, "ABORTED")
  assert.notEqual(mapped, reason)
  assert.equal(mapped.cause, reason)
})

function officialCredentialFixture() {
  const clientId = "b1a00492-073a-47ea-816f-4c329264a828"
  return {
    [`https://auth.x.ai::${clientId}`]: {
      auth_mode: "oidc",
      oidc_issuer: "https://auth.x.ai",
      oidc_client_id: clientId,
      key: "fixture-access-token",
      expires_at: "2999-01-01T00:00:00.000Z",
    },
  }
}

function modelCatalogFixture() {
  return JSON.stringify({
    object: "list",
    data: [{
      id: "grok-4.6",
      name: "Grok 4.6",
      context_window: 500000,
      api_backend: "responses",
      supports_reasoning_effort: false,
    }],
  })
}

function completedResponseFixture() {
  const events = [
    { type: "response.created", sequence_number: 0, response: { status: "in_progress" } },
    { type: "response.in_progress", sequence_number: 1, response: { status: "in_progress" } },
    { type: "response.output_item.added", sequence_number: 2, output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", status: "in_progress", content: [] } },
    { type: "response.content_part.added", sequence_number: 3, output_index: 0, item_id: "msg_1", part: { type: "output_text", text: "" } },
    { type: "response.output_text.delta", sequence_number: 4, output_index: 0, item_id: "msg_1", delta: "OK" },
    { type: "response.output_text.done", sequence_number: 5, output_index: 0, item_id: "msg_1", text: "OK" },
    { type: "response.content_part.done", sequence_number: 6, output_index: 0, item_id: "msg_1", part: { type: "output_text", text: "OK" } },
    { type: "response.output_item.done", sequence_number: 7, output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", status: "completed" } },
    { type: "response.completed", sequence_number: 8, response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } },
  ]
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")
}
