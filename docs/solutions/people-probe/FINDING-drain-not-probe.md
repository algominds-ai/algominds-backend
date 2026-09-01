# Server-side title filtering cannot find the buyers. You must drain the roster.

Measured on Harbor IT (slug harbor-msp), 206 employees, roster drained and verified
against total_hits.

## The constraint

BrightData's dataset API cannot filter inside the `experience` array. Every dotted path
returns `unsupported filters: experience.company_id`. The only server-side title lever is
`position`, which is the LinkedIn HEADLINE, not the job title.

## Why that breaks

The headline is written by the person. The structured title is the job. They agree far
less often than assumed.

    of 61 people who have BOTH a structured title and a headline,
    the headline contains the title verbatim in 27 of them -> 44%

The failures are not edge cases. They are the buyers.

    person              structured title              headline (what the server searches)
    Johnny Lieberman    Chief Executive Officer       CEO of Harbor IT | Partner at Worklyn
    Hannah Paige        Chief Financial Officer       Director at Worklyn Partners, CFO Harbor IT
    Michael Sullivan    Chief Customer Officer        Harbor IT | CCO
    Charles F.          Director of Service Delivery  --
    Lynda Orsula        Director of Finance           Financial Professional

Three separate failure modes, all present in one company:
  1. the headline abbreviates    Chief Executive Officer -> CEO
  2. the headline is absent      Charles F.'s headline is literally "--"
  3. the headline is unrelated   Director of Finance -> "Financial Professional"

## The measurement that settles it

A model proposed 14 title fragments from the ICP, in full-word form. Against the drained
roster, those fragments match the headline of only

    5 of the 27 buyer-shaped people        19%

The 22 missed include the CEO, the CFO, the Chief Customer Officer and the Director of
Service Delivery. Adding abbreviations would recover some, never the ones with an absent
or unrelated headline, and the vocabulary would be a guess again -- which is the exact
failure this whole approach was meant to remove.

## Conclusion

Probe-then-fetch is dead. Drain the roster, read the structured title, and let the model
select from titles it can SEE.

    drain    206 records   $0.52    complete
    probe     ~20 records  $0.05    19% of the buyers

The cheap path costs 10x less and loses four fifths of the buyers. Pay the $2.50 CPM.
