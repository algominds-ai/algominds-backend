# Why three Workflow classes exist before their units

`src/index.ts` exports `FindCompaniesWorkflow`, `FindPeopleWorkflow`, and `EnrichWorkflow`, all
of which throw. Their bodies land in U8, U12, and U13.

## Reason

`wrangler.jsonc` declares three workflow bindings. Wrangler fails the bundle when a binding
names a `class_name` the entrypoint does not export:

```
Your Worker depends on the following Workflows, which are not exported in your
entrypoint file: FindCompaniesWorkflow, FindPeopleWorkflow, EnrichWorkflow.
```

The alternative was to add the bindings later, which means editing config twice and running
without them in between. Throwing stubs keep config and code consistent from the first commit,
and the throw names the unit that will fill it in.

## Related

`WorkflowEntrypoint.run` needs an explicit `override` modifier because `noImplicitOverride` is
on in `tsconfig.json`.
