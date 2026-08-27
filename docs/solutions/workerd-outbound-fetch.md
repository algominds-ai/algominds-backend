# Why every wrangler command sets SFW_SHIM_DISABLE=1

Socket Firewall's shim wraps `bun`/`npx` and sets proxy environment variables for
the child process. Wrangler detects them and reports:

    Proxy environment variables detected. We'll use your proxy for fetch requests.

workerd cannot use that proxy. Every outbound `fetch` from inside the Worker then
fails with an opaque error:

    Error: internal error; reference = vlr2po55mjno9gd3im5psoo6

There is nothing in the message to connect it to a proxy, so it reads like a bug
in the Worker.

## How it was isolated

A twelve-line worker whose only job is `fetch("https://example.com")` failed the
same way, while `bun -e 'fetch(...)'` from the same shell succeeded. That ruled
out our code, our config, and the network, leaving the runtime's environment.

With the shim disabled the same worker returns `ok status=200` and the proxy
warning disappears.

## What it broke before it was found

- Every attempt to exercise a capability against live vendors, in the Vitest pool
  and under `wrangler dev` alike.
- The failure surfaced inside a Workflow step, so it looked like a defect in
  findCompanies rather than in the environment.

The unit tests never caught it because they mock `globalThis.fetch`; no test had
ever made a real outbound request from the Workers runtime.

## The fix

Every script in `package.json` that starts workerd sets `SFW_SHIM_DISABLE=1`:
`dev`, `deploy`, `build`, `test`, `gate`, `cf-typegen`. Package installs still go
through the firewall — only the Workers runtime is exempted, and only for
outbound requests it makes itself.

## A second effect, once the network worked

With outbound fetch restored, the route tests' Workflow instances began doing
real work instead of failing instantly. They share one Workers runtime with every
other test file, and the contention made an unrelated health check in
`test/bundle.spec.ts` fail — deterministically, and in a file that had done
nothing wrong.

Two changes fix it. Each route test terminates its instance immediately after
reading the 202, rather than waiting for `afterEach`. And `vitest.config.ts` sets
`fileParallelism: false`, because the Workers pool shares a runtime across files
and cannot honestly run them concurrently while any of them starts durable work.

Three consecutive full gate runs pass with both in place.
