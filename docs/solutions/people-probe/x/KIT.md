# Kit for the find-people methodology experiment

WORKDIR: /private/tmp/claude-501/-Users-lahfir-Documents-Projects-Algominds-algo-backend/2469c29f-2264-46dd-a659-cf2872b41f70/scratchpad/x
Read DESIGN.md first. It is the contract. Everything below is how to execute it.

## Rules. Not optional.
1. PROBE ONLY. Never edit anything under /Users/lahfir/Documents/Projects/Algominds/algo-backend/src.
   Write only inside WORKDIR/<your-agent-name>/ plus your report file in WORKDIR.
2. USE providers.mjs FOR EVERY CALL. Its shapes are the ones verified working in this repo.
   Do not write your own fetch to any provider. If a function seems wrong, say so in your
   report; do not work around it.
3. NO REGEX, SUBSTRING OR WORD-OVERLAP FOR ANY JUDGMENT ABOUT MEANING. Who is a buyer, whether
   a page confirms employment, whether a title fits a persona: those are model calls that
   return a label from a closed set or a candidate id. Code reads fields; the model reads meaning.
4. SELECTION IS BY CANDIDATE ID. dedupe() from common.mjs assigns `id`. The model returns ids
   plus a closed-set basis; code copies name/title/url from the record. Unknown ids are
   counted and dropped. Never let the model emit a title string that reaches output.
5. A TIMEOUT OR PROVIDER ERROR IS UNKNOWN, NEVER EMPTY. Three silent-zero failure modes are
   already documented (wrong slug, wrong-identity slug, provider hang). Do not add a fourth.
6. REPORT MEASURED NUMBERS ONLY. Never project, never estimate. The ledger is the truth:
   ledger('<agent>').spent() and x/ledger/<agent>.jsonl.
7. STOP AT YOUR CAP. Check ledger(agent).spent() before every batch. Caps are in DESIGN.md.
8. The two wrong-identity companies (harbormsp.com, evergreensg.com) are intentional. Do not
   "fix" them. Report what your stage 1 did with them.

## What providers.mjs gives you
  ledger(agent)                       .bank(row) .spent()
  canonUrl(u) linkedinId(u)
  clay(agent, identifier, {bands, keywords})     identifier = domain OR linkedin company URL
        CLAY_SENIOR_BANDS = founder owner board-member partner c-suite vp head director
        one unfiltered query caps ~499; partition by band. free (annual quota).
  apollo(agent, domain, {seniorities, departments, perPage, page}) -> {total, rows}
        APOLLO_SENIORITIES. NEVER pass named titles. surnames are obfuscated. free.
  exaPeople(agent, query, {numResults})        structured workHistory; current role = dates.to null. $0.007
  exaWeb(agent, query, {includeDomains, numResults, maxCharacters})  page text. $0.007
  exaAgent(agent, query, outputSchema, {effort, systemPrompt})   multi-step research, ~$0.03 at low
  brightdataByUrl(agent, linkedinUrl)          collected row: activity[] posts, experience[], timestamp. $0.0025
  brightdataCount(agent, companySlug)          total_hits headcount signal. serialise these.
  llm(agent, messages, {model, json, maxTokens}) -> {text, dollars}   MODEL_STRONG / MODEL_FAST
common.mjs: nameKey, dedupe(rows) -> rows with id and seenBy[], sizeBand(n)
verify.mjs: verify(agent, {name,title,company,url}) -> {status: verified|contradicted|unknown, web, index}

## Fixture
  fixture/icp-aris.json fixture/icp-ondato.json     the ICP docs. doc.description is the profile.
  fixture/companies.json                             20 companies: seller, name, domain, linkedinUrl
  fixture/rubric-aris.md fixture/rubric-ondato.md    buyer rubric: positives AND hard negatives

## Output contract, so results are comparable
Write WORKDIR/<agent>/results.json as an array, one entry per company:
  { seller, company, domain, identity: {resolved: bool, how, note},
    headcountSignal, plan (if any), providers: {clay:{calls,rows}, apollo:{...}, exa:{...}, exaAgent:{...}},
    candidates: n, overlap: {clay_apollo: n, clay_exa: n, ...},
    selected: [{id, name, title, url, basis}], unknownIds,
    verified: [{name,title,url,status,web,index}],
    seconds, dollars }
Then WORKDIR/<agent>-report.md under 450 words with the measured headline numbers.
