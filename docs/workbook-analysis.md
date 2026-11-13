# Analysis of the supplied workbook

Source: `Tempo clubrecords 2026.xlsx`, read without modifying the original.

## Structure

| Sheet                 | Meaning                                          | Populated record rows |
| --------------------- | ------------------------------------------------ | --------------------: |
| Leeftijden            | Birth-year/competition-year matrix               |           Not records |
| Vlinder               | Butterfly 25/50/100/200m                         |                    73 |
| Rug                   | Backstroke 25/50/100/200m                        |                    77 |
| School                | Breaststroke 25/50/100/200m                      |                    80 |
| Vrij 25-200           | Freestyle 25/50/100/200m                         |                    86 |
| Vrij 300-2000         | Freestyle 300/400/600/800/1500/2000m             |                    89 |
| Wissel                | Individual medley 100/200/300/400m               |                    71 |
| Estafette jongens     | Men's/boys' relays                               |                    97 |
| Estafette meisjes     | Women's/girls' relays                            |                    96 |
| Estafette gemengd     | Mixed relays, including two special compositions |                    81 |
| Vlinder Masters       | Masters butterfly                                |                     7 |
| Rug Masters           | Masters backstroke                               |                     8 |
| School Masters        | Masters breaststroke                             |                     7 |
| Vrij 25-200 Masters   | Masters freestyle, shorter distances             |                    13 |
| Vrij 300-2000 Masters | Masters freestyle, longer distances              |                     4 |
| Wissel Masters        | Masters medley                                   |                     6 |
| **Total record rows** |                                                  |               **795** |

Individual and Masters sheets place men/boys in columns A:G and women/girls in I:O:

| Field                     | Men | Women |
| ------------------------- | --- | ----- |
| Category/event heading    | A   | I     |
| Record time               | C   | K     |
| Split/lead-off annotation | D   | L     |
| Swimmer name              | E   | M     |
| Race date                 | G   | O     |

Relay sheets use three independent horizontal event blocks:

| Field                  | First block | Second block | Third block |
| ---------------------- | ----------- | ------------ | ----------- |
| Category/event heading | A           | G            | M           |
| Record time            | C           | I            | O           |
| Race date/season       | E           | K            | Q           |

Relay seed sheets do not identify the team members. The application stores these as team performances with unknown members rather than inventing swimmers. The model can store complete lineups when LENEX provides them.

Individual blocks have rows 8–16, HR/DA, and AL. HR/DA maps to seniors aged 17+, AL to all ages. Mixed relays use D/H for seniors. Masters sheets contain 30+, 35+, …, 80+. Each record row is a category claim, not a complete meet result; the workbook does not contain the earlier history of improvements.

## Age allocation

`Leeftijden!A2:A32` contains birth years 2000–2030. `B1:J1` contains competition-year headings 2022–2030. Every intersection follows:

```text
year_age = competition_year - birth_year
year_age <= 0  → '-'
1..16         → numeric year_age
17+           → 'heren/Dames'
```

There are no formulas to recalculate here; the cells are stored values. The importer independently validates all 279 intersections. Example: birth year 2010 is age 16 throughout 2026 and senior throughout 2027. An October 2026 race by a December 2010-born swimmer belongs to age 16 even before their sixteenth birthday.

Masters use the same year-age, with five-year bands starting at 30. The last supplied 80+ band is open-ended in this implementation. Individual ages below 8 have no dedicated workbook slot, but can qualify for all-age records.

## Values, annotations and anomalies

Times are primarily text in `minutes.seconds.hundredths` format, e.g. `0.25.84` or `18.25.03`. Dates are mostly Excel date serials formatted as dates. Annotation legends include cumulative freestyle splits on 400m (`x`), 800m (`*`), 1500m (`+`), 2000m (`o`), and relay lead-offs (`I`/`T`). These markers are retained as source comments; baseline eligibility follows the existing row.

Two time strings have extra punctuation and normalize without changing numeric meaning:

- `Vlinder!K50`: `2.42.04.` → 2:42.04.
- `School!C45`: `4.01..33` → 4:01.33.

`Vrij 25-200!K9/M9/O9` contains one equal time and two swimmers/dates. The two date strings, 19-11-2011 and 3-7-2016, are parsed separately. They become two performances linked to the same source cell and category.

Six relay rows have season-only date labels. These remain exactly as given; the exact date field is null. The archive does not fabricate a meet, birthday or day within a season.

The mixed freestyle 8×50 sections at A31 and G31 are distinct from ordinary 8×50:

- Two swimmers under 12, two under 14, two under 16, and two over 16.
- Girls/boys paired in the sheet's prescribed under-/over-16 composition.

Descriptions are retained verbatim as independent discipline variants. The application does not guess those formats from an ordinary LENEX relay.

Three baseline all-age times conflict with faster age/senior rows: men's 100m freestyle, men's 600m freestyle, women's 100m medley. They are surfaced as warnings and preserved for club review. This avoids silently reinterpreting the association's source register.

## Reconciliation

- 795 source rows are linked to 796 category/performance assignments because of the shared record cell.
- Consolidating repeated senior/all-age performances produces 682 distinct baseline performances.
- 795 distinct record slots are occupied; one has two current holders.
- 1,101 additional slots have no baseline time.
- Exactly 100 normalized swimmer names occur in the seed. Historical relay members are unknown.
- No seed swimmer receives an invented birth date or license.
- No seed performance receives an invented pool length; every seed course is `UNKNOWN`.

The two LXF files add 28 actual Tempo race results from two meets, including one DSQ, and populate known swimmer identities/birth dates from LENEX. Shorter-distance freestyle candidates are derived separately from retained cumulative splits. All of these counts are asserted against the real input files by the integration suite.
