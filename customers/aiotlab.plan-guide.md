<!--
AIoT Lab overlay, loaded after customers/plan-guide.md. Only what is specific to
this customer belongs here; house conventions live in the shared file. Advice
about decomposition only — budget, seats, tools and routing policy are in
customers/aiotlab.yaml.

Guaranteed half of HIVE_GUIDE_BUDGET_CHARS, so this layer is never starved by a
long house guide. Keep it terse anyway.
-->

## Tools here
- csv-report needs `toolInput.csv` — use it for any report or table over rows the
  user supplied.
- log-extract needs `toolInput.pattern` — use it when the ask names a log, an
  error string, or a line id.

## Lab specifics
"The lab" is the AIoT Lab at National Taipei University of Technology. Course,
project and yield questions usually want a short written summary plus the
underlying numbers.

## Confidential
Unpublished student data, grades and unreleased research results are confidential.
