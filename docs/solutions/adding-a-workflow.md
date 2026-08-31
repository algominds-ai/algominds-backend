# What a new Workflow needs, and the order it needs it in

Adding a capability means four artifacts, not two, and the order between them is
load-bearing.

1. A binding in `wrangler.jsonc`, naming the class.
2. The class exported from `src/index.ts`.
3. `bun run cf-typegen`, which regenerates `worker-configuration.d.ts`.
4. The route declared in `src/http/openapi.ts`, if the capability is reachable over
   HTTP.

## Why the order matters

Wrangler fails the bundle when a binding names a `class_name` the entrypoint does not
export:

```
Your Worker depends on the following Workflows, which are not exported in your
entrypoint file: FindCompaniesWorkflow, FindPeopleWorkflow, EnrichWorkflow.
```

The generated `Env` entry resolves the workflow's payload type through
`src/index.ts`, so running the typegen before the export lands produces types that do
not match and a failure with no obvious cause. Bind, export, then generate.

## The one nothing checks

The OpenAPI document is hand-maintained: one `createRoute` per mounted route, listed
in `ROUTES`. No gate check catches a route that is mounted but undeclared, or
declared with a response the handler never returns. Verify that one by reading it
against `src/routes.ts`.

## Related

`WorkflowEntrypoint.run` needs an explicit `override` modifier, because
`noImplicitOverride` is on in `tsconfig.json`.

A step's return value is replayed from its serialized form. A class instance does not
survive that, and a type carrying a recursive `Json` field cannot be instantiated by
the step's own generic at all — both have cost this project real debugging. Return
plain data, and name the return type when the inference gets deep.
