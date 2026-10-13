import assert from "node:assert/strict"
import test from "node:test"

import { createRuntimeDiagnostics } from "../../../src/internal/runtime-diagnostics.mjs"

test("runtime diagnostics report plugin version while the subprocess capability is unavailable", async () => {
  const diagnostics = createRuntimeDiagnostics({
    pluginVersion: "0.1.6",
    getCliInspector: () => undefined,
    getNetworkState: () => "proxy",
  })

  assert.deepEqual(await diagnostics.read(), {
    pluginVersion: "0.1.6",
    cli: { state: "unavailable" },
    network: "proxy",
  })
})

test("runtime diagnostics project only a safe installed CLI version", async () => {
  const signal = new AbortController().signal
  const diagnostics = createRuntimeDiagnostics({
    pluginVersion: "0.1.6",
    getCliInspector: () => async (options) => {
      assert.equal(options.signal instanceof AbortSignal, true)
      assert.notEqual(options.signal, signal)
      return { state: "ready", version: "1.0.5" }
    },
    getNetworkState: () => "environment",
  })

  assert.deepEqual(await diagnostics.read({ signal }), {
    pluginVersion: "0.1.6",
    cli: { state: "ready", version: "1.0.5" },
    network: "environment",
  })
})

test("runtime diagnostics reject extra CLI fields at the Host boundary", async () => {
  const diagnostics = createRuntimeDiagnostics({
    pluginVersion: "0.1.6",
    getCliInspector: () => async () => ({
      state: "missing",
      path: "C:\\Users\\fixture\\.grok\\bin\\grok.exe",
    }),
    getNetworkState: () => "proxy",
  })

  await assert.rejects(diagnostics.read(), { name: "TypeError" })
})

test("runtime diagnostics refuse an unknown network state", async () => {
  const diagnostics = createRuntimeDiagnostics({
    pluginVersion: "0.1.6",
    getCliInspector: () => async () => ({ state: "unavailable" }),
    getNetworkState: () => "socks5://127.0.0.1:1080",
  })

  await assert.rejects(diagnostics.read(), { name: "TypeError" })
})

test("runtime diagnostics share one in-flight CLI inspection", async () => {
  const result = deferred()
  let calls = 0
  let inspectedSignal
  const inspector = async ({ signal }) => {
    calls += 1
    inspectedSignal = signal
    return result.promise
  }
  const diagnostics = createRuntimeDiagnostics({
    pluginVersion: "0.1.6",
    getCliInspector: () => inspector,
    getNetworkState: () => "proxy",
  })

  const first = diagnostics.read()
  const second = diagnostics.read()
  await Promise.resolve()
  assert.equal(calls, 1)
  assert.equal(inspectedSignal instanceof AbortSignal, true)

  result.resolve({ state: "ready", version: "1.0.5" })
  assert.deepEqual(await Promise.all([first, second]), [
    { pluginVersion: "0.1.6", cli: { state: "ready", version: "1.0.5" }, network: "proxy" },
    { pluginVersion: "0.1.6", cli: { state: "ready", version: "1.0.5" }, network: "proxy" },
  ])
})

test("disposing an inspector aborts and waits for its in-flight inspection", async () => {
  const started = deferred()
  const releaseCleanup = deferred()
  let calls = 0
  const inspector = async ({ signal }) => {
    calls += 1
    started.resolve(signal)
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
    await releaseCleanup.promise
    signal.throwIfAborted()
  }
  const diagnostics = createRuntimeDiagnostics({
    pluginVersion: "0.1.6",
    getCliInspector: () => inspector,
    getNetworkState: () => "proxy",
  })

  const reading = diagnostics.read()
  const signal = await started.promise
  let disposed = false
  const disposing = diagnostics.disposeInspector(inspector).then((value) => {
    disposed = true
    return value
  })
  await Promise.resolve()
  assert.equal(signal.aborted, true)
  assert.equal(disposed, false)
  assert.equal(calls, 1)

  releaseCleanup.resolve()
  await assert.rejects(reading, { name: "AbortError" })
  assert.equal(await disposing, true)
  assert.equal(disposed, true)
  assert.equal(await diagnostics.disposeInspector(inspector), false)
})

test("cancelling the final diagnostics caller cancels the shared inspection", async () => {
  const started = deferred()
  const inspector = async ({ signal }) => {
    started.resolve(signal)
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
    signal.throwIfAborted()
  }
  const diagnostics = createRuntimeDiagnostics({
    pluginVersion: "0.1.6",
    getCliInspector: () => inspector,
    getNetworkState: () => "proxy",
  })
  const caller = new AbortController()
  const reading = diagnostics.read({ signal: caller.signal })
  const inspectionSignal = await started.promise

  caller.abort(new DOMException("RPC cancelled", "AbortError"))
  await assert.rejects(reading, { name: "AbortError" })
  await Promise.resolve()
  assert.equal(inspectionSignal.aborted, true)
})

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
