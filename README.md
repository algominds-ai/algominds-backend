# algo-backend

The Algominds go-to-market engine. It reads a seller's own website and writes the profile of their ideal customer, then finds companies that match, finds the decision makers at each one, and enriches them with contact details. It runs on Cloudflare Workers and Workflows, with Hono for HTTP, Zod for every shape, Drizzle on Postgres through Hyperdrive, and the AI SDK through Cloudflare AI Gateway.

Every route starts a Workflow and returns a run id. Nothing holds an HTTP connection open while a vendor works. You poll the run, then read its companies and people.

## The four routes

All four take an organization API key in the `x-api-key` header. The OpenAPI document is at `/openapi.json` and Swagger UI at `/docs`.

| Route | What it does | Providers it calls |
|---|---|---|
| `POST /icp/onboard` | Reads the seller's site and writes the ideal customer profile | Exa search, one model call |
| `POST /companies/find` | Finds companies that match a profile | Exa search or Exa agent, Exa contents, model |
| `POST /people/find` | Finds and verifies decision makers at companies | Clay, model, Exa agent, Exa search, Exa contents |
| `POST /enrich` | Adds an email to each verified person | Findymail, then an Exa agent as the last resort |

Reads: `GET /runs/:runId`, `/runs/:runId/rounds`, `/runs/:runId/companies`, `/runs/:runId/people`. Every read is scoped to the caller's organization.

### Onboard

The seller's domain and a short note go in. The profile that every later search reads comes out, including who buys.

```mermaid
flowchart LR
    A[POST /icp/onboard] --> B[open run, check daily spend]
    B --> C[Exa search reads the seller's pages]
    C --> D[model writes the profile and the buyer block]
    D --> E[(icp row)]
    E --> F[close run with cost]
```

### Find companies

The profile becomes a search plan. A profile defined by shape, such as an industry, a size and a place, goes to Exa search and finishes in seconds. A profile defined by an event, such as a company that hired a certain role last month, goes to the Exa agent. Every domain the account found in the last sixty days is excluded, so a second run never repeats the first.

```mermaid
flowchart LR
    A[POST /companies/find] --> B[load profile, open run]
    B --> C[exclude domains this account found in 60 days]
    C --> D[model writes a search plan]
    D --> E{plan source}
    E -->|shape| F[Exa search, fast]
    E -->|event| G[Exa agent run]
    F --> H[filter and gate]
    G --> H
    H --> I[Exa contents confirms the quoted page, agent rounds only]
    I --> J[model judges fit]
    J --> K{enough?}
    K -->|no, next round| D
    K -->|yes| L[(company rows and evidence)]
    L --> M[close run with cost]
```

### Find people

The request names either a companies run or a list of domains. For each company the engine resolves its identity, pulls the senior roster, dedupes it, lets the model pick candidates against the buyer rubric, then verifies each pick with two independent sources. A person is stored as verified only when both agree.

```mermaid
flowchart LR
    A[POST /people/find] --> B[load companies from a run or from domains]
    B --> C[resolve who buys: target, profile buyer, or roster mode]
    C --> D[per company]
    D --> E[Clay resolves the company identity]
    E --> F[Clay pulls the senior roster, one call per band, in parallel]
    F --> G[dedupe by LinkedIn URL then name]
    G --> H[model picks candidates by id]
    H --> I[per pick, in parallel]
    I --> J[Exa agent gives a verdict with a quoted page]
    I --> K[Exa people index gives a second opinion]
    K --> L[model says whether the two employers agree]
    J --> M[Exa contents confirms the quote is on the page]
    L --> N{both agree?}
    M --> N
    N -->|yes| O[(person row, verified)]
    N -->|no| P[(evidence only)]
    O --> Q[bank spend, next company]
    P --> Q
```

Roster mode is what you get with no buyer rubric: the senior roster is stored as is, with no selection and no verification, and it costs nothing in dollars.

### Enrich

The request names a source run. Each verified person gets an email from the first provider that finds one. A cached address inside its time to live is reused and costs nothing.

```mermaid
flowchart LR
    A[POST /enrich] --> B[load the source run and its verified people]
    B --> C{cached email still fresh?}
    C -->|yes| G[(keep)]
    C -->|no| D[Findymail providers, in order]
    D -->|miss| E[Exa agent finds the email]
    D -->|hit| F[(email with evidence)]
    E --> F
    F --> H[bank spend per batch, close run]
    G --> H
```

## Money and safety

Every paid call runs inside one Workflow step, so a retry never pays twice. Every step banks its spend on the run row, and a run stops starting new work once the organization reaches its daily ceiling. Every loop has a constant bound and every fetch has a timeout. Evidence is append-only: a value is never deleted, only given a lower confidence.

## Run it locally

You need Bun, a local Postgres, and the vendor keys.

```bash
createdb algo
bun install --frozen-lockfile
# write .env, see below
bun run db:migrate
bun run dev                  # http://localhost:8787/health
```

`.env` holds `DATABASE_URL` (`postgresql://postgres:postgres@localhost:5432/algo`), the four vendor secrets `EXA_API_KEY`, `CLAY_API_KEY`, `FINDYMAIL_API_KEY` and `CF_AIG_TOKEN`, and the AI Gateway variables named in `wrangler.jsonc`. Do not create a `.dev.vars` file: when it exists, Wrangler stops reading `.env`. The first log line of `bun run dev` says which file it loaded.

Sign up a user, create an organization, and mint an organization API key through the `/api/auth/*` routes. The test files `test/auth.spec.ts` and `test/auth-onboard.spec.ts` show the exact calls.

## Checks

`bun run gate` is the only check that counts. It runs the config generator, the type check, biome, the comment and language rules, the step-config rules, the test suite on the real Workers runtime, and a dry-run bundle. The tests use a separate database, `algo_test`; create it once with `bun run db:test:reset`.

A versioned pre-commit hook runs gitleaks and the lint step. CI runs the full gate; it can be started by hand from the Actions tab until push triggers are confirmed.

## Layout

```
src/core/            plain async functions, no HTTP, no Workflows
src/core/providers/  one file per vendor, the email waterfall, the MCP adapter
src/workflows/       one WorkflowEntrypoint per capability
src/routes.ts        Hono routes that start a Workflow and return a run id
docs/solutions/      one file per problem already solved
CONCEPTS.md          the shared vocabulary
```

`src/core/` never imports from the routes or the workflows.
