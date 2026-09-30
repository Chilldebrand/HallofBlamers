# Hall of Blamers route inventory

Source baseline: fc35fe6. All league pages require membership; admin routes require commissioner authorization. Page presence is not a claim of completed upstream functionality.

| Existing route | Pages route | Source | Query dependencies |
| --- | --- | --- | --- |
| /admin | /HallofBlamers/#/admin | src/app/(league)/admin/page.tsx |  |
| /admin/polls/[id] | /HallofBlamers/#/admin/polls/[id] | src/app/(league)/admin/polls/[id]/page.tsx | polls |
| /admin/polls | /HallofBlamers/#/admin/polls | src/app/(league)/admin/polls/page.tsx | polls |
| /admin/recaps/[id] | /HallofBlamers/#/admin/recaps/[id] | src/app/(league)/admin/recaps/[id]/page.tsx |  |
| /admin/recaps | /HallofBlamers/#/admin/recaps | src/app/(league)/admin/recaps/page.tsx |  |
| /admin/recaps/voice | /HallofBlamers/#/admin/recaps/voice | src/app/(league)/admin/recaps/voice/page.tsx |  |
| /belt | /HallofBlamers/#/belt | src/app/(league)/belt/page.tsx | belt |
| /franchises/[id] | /HallofBlamers/#/franchises/[id] | src/app/(league)/franchises/[id]/page.tsx | achievements, franchises, h2h, identity, records |
| /franchises | /HallofBlamers/#/franchises | src/app/(league)/franchises/page.tsx | franchises |
| /h2h/[a]/[b] | /HallofBlamers/#/h2h/[a]/[b] | src/app/(league)/h2h/[a]/[b]/page.tsx | h2h, identity |
| /h2h | /HallofBlamers/#/h2h | src/app/(league)/h2h/page.tsx | h2h, identity |
| /history | /HallofBlamers/#/history | src/app/(league)/history/page.tsx |  |
| /matchups/[year]/[week]/[matchupId] | /HallofBlamers/#/matchups/[year]/[week]/[matchupId] | src/app/(league)/matchups/[year]/[week]/[matchupId]/page.tsx | h2h, identity, matchups, records, standings |
| /matchups/[year]/[week] | /HallofBlamers/#/matchups/[year]/[week] | src/app/(league)/matchups/[year]/[week]/page.tsx | achievements, identity, matchups, seasons, standings |
| /matchups | /HallofBlamers/#/matchups | src/app/(league)/matchups/page.tsx | matchups |
| / | /HallofBlamers/#/ | src/app/(league)/page.tsx | belt, home, homepage, identity, recaps, standings, ticker |
| /pickem | /HallofBlamers/#/pickem | src/app/(league)/pickem/page.tsx | identity |
| /polls/[id] | /HallofBlamers/#/polls/[id] | src/app/(league)/polls/[id]/page.tsx | polls |
| /polls | /HallofBlamers/#/polls | src/app/(league)/polls/page.tsx | polls |
| /predictions | /HallofBlamers/#/predictions | src/app/(league)/predictions/page.tsx | identity, predictions |
| /recaps/[year]/[week] | /HallofBlamers/#/recaps/[year]/[week] | src/app/(league)/recaps/[year]/[week]/page.tsx | recaps |
| /recaps | /HallofBlamers/#/recaps | src/app/(league)/recaps/page.tsx | recaps |
| /records | /HallofBlamers/#/records | src/app/(league)/records/page.tsx | records |
| /seasons/[year] | /HallofBlamers/#/seasons/[year] | src/app/(league)/seasons/[year]/page.tsx | seasons |
| /seasons | /HallofBlamers/#/seasons | src/app/(league)/seasons/page.tsx | seasons |
| /standings | /HallofBlamers/#/standings | src/app/(league)/standings/page.tsx | identity, standings |
| /timeline | /HallofBlamers/#/timeline | src/app/(league)/timeline/page.tsx |  |
| /transactions | /HallofBlamers/#/transactions | src/app/(league)/transactions/page.tsx | identity, transactions |
| /what-if | /HallofBlamers/#/what-if | src/app/(league)/what-if/page.tsx | identity, standings, whatIf |
| /login | /HallofBlamers/#/login | src/app/login/page.tsx |  |

Other endpoints: /join/[token] becomes #/join?token=...; /api/live and /api/live/snapshot become authenticated polling; /api/health becomes a protected status query.

Baseline: 1,343 tests pass, TypeScript passes. Build blocked by Google Fonts network fetch. Identity audit fails in five existing analytics files using ffootball.

Database backup integrity: quick_check = ok. Six seasons, 15 franchises, 565 matchups, 1,503 transactions, 18,455 roster slots, 210 raw snapshots. Only one manager is provisioned.

Empty datasets at baseline: trade_ledger, waiver_acquisitions, draft_grades, draft_pick_values, playoff_odds, recaps, polls, predictions, pickem_picks. Preserve explicit unavailable/empty states until source coverage and rebuilt statistics establish real results.

Storage: consistent backup 210,407,424 bytes; raw snapshots occupy 206,233,600 bytes. Keep snapshots private and measure Postgres compression before considering archival.
