# Same-name colleagues can merge under one identity

`groupByPersonIdentity` (`src/core/people/person-identity.ts`) falls back to
name, title and domain when a canonical LinkedIn URL does not match an
existing group. This merges two different colleagues who share a name and
title at the same company, whenever their LinkedIn URLs differ.

The fallback exists for real production data: one provider returns several
distinct LinkedIn URL slugs for one real person (see the "Tiffany Masse"
case in `test/people/person-identity.spec.ts` and
`test/people/verify-identity-dedupe.spec.ts`). That case and the colleague
case look identical from name, title, URL and domain alone.

No field in `CandidateIdentity` tells the two cases apart today. Splitting
them needs a second, differing hard fact on the candidate row, such as
location or a distinct headline, before name and title can be trusted to
mean one person.
