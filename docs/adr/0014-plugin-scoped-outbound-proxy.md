# ADR-0014: A plugin-scoped outbound proxy in the settings page

- Status: Accepted for dsh-grok-provider 2.1.0
- Baseline: dsh-grok-provider 2.0.1

A signed-in account showed an unavailable model catalog and quota on a machine
whose only route to `cli-chat-proxy.grok.com` is a local Clash proxy. The three
upstream calls (`/v1/models`, `/v1/billing`, `/v1/responses`) run through the
host process's `fetch`, and Node's `fetch` reads neither the Windows system
proxy (`ProxyServer=127.0.0.1:7897`) nor any application setting — only the
`HTTP_PROXY`/`HTTPS_PROXY` family. Measured on that machine: a direct `fetch`
failed with `UND_ERR_CONNECT_TIMEOUT`, the same call with
`HTTPS_PROXY=http://127.0.0.1:7897` returned `401` (reached, unauthenticated),
and `installProxyFromEnvironment` produced the same `401` from a synthetic
launch environment. Sign-in had kept working throughout because it runs the
official `grok` CLI, which resolves the proxy itself.

Harness 0.2.0 already owns this problem for the whole process: its launcher
resolves one policy from the launch environment and installs undici's global
dispatcher, so every adapter that uses `fetch` is covered without touching its
code — but only when the launch environment carries a proxy. A host started from
an ordinary shortcut has none, and a plugin cannot invent one for the user.
`2.1.0` therefore gives the operator a place to state it, and keeps the Harness
policy authoritative:

- **The environment wins.** If `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY` is
  present, the plugin resolves the route to `environment` and does not layer its
  own setting on top of the dispatcher the launcher already installed. A
  settings field must not silently override a deployment's transport decision.
- **The plugin never takes over the process.** A configured proxy becomes a
  per-request `undici` `ProxyAgent` passed as that request's `dispatcher`. The
  plugin never calls `setGlobalDispatcher`, so other plugins and every other
  request in the host keep the route they had. The alternative — installing a
  process-wide dispatcher from a settings field — was rejected for exactly that
  reason, and `undici`'s fetch accepts a foreign-copy dispatcher only when the
  request and the dispatcher come from the same copy, which is why the route
  switches the whole request to `undici`'s fetch instead of passing a dispatcher
  to the global one (measured: `UND_ERR_INVALID_ARG`).
- **A local proxy that is not listening falls back; a remote one does not.** The
  default `http://127.0.0.1:7897` is a loopback address, so a user who installs
  this plugin without a local proxy must not lose the direct connection they had
  before. Loopback targets are judged by one bounded 400 ms TCP probe: a refused
  connection routes the request directly and reports `proxy-unavailable`, and a
  successful probe is trusted for 30 s (invalidated at once if a proxied request
  then fails at connect level). A non-loopback target is never probed and never
  bypassed: if it is unreachable the request fails closed rather than leaving
  through a route the operator did not choose, because sending traffic around a
  configured proxy is a policy violation, not a convenience.
- **Addresses carry no credentials.** Only a parseable `http:`/`https:` URL with
  an empty `username`/`password` is accepted; anything else is treated as
  direct and reported as `proxy-invalid`. A profile settings document is not a
  secret store, and the README states the rule.
- **The route is reported without the address.** The `diagnostics` outcome gains
  the closed `network` field (`environment`, `disabled`, `proxy`,
  `proxy-unavailable`, `proxy-invalid`) so the page can name the route the host
  actually resolved. It stays inside the existing promise never to return a
  proxy address or upstream URL; the page shows the configured address from its
  own config form, not from diagnostics.
- **Both fields are `Config` fields.** `proxyEnabled` (default `true`) and
  `proxyUrl` (default `http://127.0.0.1:7897`) are `.volatile()` and edited
  through the same `configForms` controller as the Search switches, so a write
  takes the normal Loader path and needs no new RPC, no restart, and no new
  surface.

Verification: `test/network-proxy.test.mjs` covers environment precedence, a
disabled setting, four unusable addresses, the loopback fallback and its
uncached negative probe, the cached positive probe with expiry, cache
invalidation after a refused connection, live config changes across requests,
disposal, and the absence of any probe for a non-local target. The client suite
covers the new panel, its writes, its refusal of a malformed address, the
fail-closed read-only state, and all five route labels. The `undici` dependency
is `^8.10.0`, the same library the Harness itself uses in
`@deepseek-ai/dsh-http-proxy`, and it has no native code.

Not verified: the plugin's own route has not yet carried a live conversation
through a real proxy from the desktop application, and the Settings page has not
been exercised on a real device beyond the local suite.
