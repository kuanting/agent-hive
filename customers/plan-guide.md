<!--
House plan guide, loaded by packages/queen/src/planner/guide.ts and prepended to
the Queen's system prompt for every customer, ahead of customers/<id>.plan-guide.md.

ADVISORY ONLY. This shapes HOW a request is split into tasks, never WHERE they
run: tier and budget live in customers/<id>.yaml and are decided by QueenCore,
which never reads this file. Tiers, models and dollar amounts written here do
nothing.

Keep it SHORT. The default brain is a 4B model, and the budget is
HIVE_GUIDE_BUDGET_CHARS (1200) shared with the customer overlay, which is
guaranteed half. Over budget, whole trailing `##` sections are dropped — so put
the most valuable section first. HTML comments like this one are stripped before
budgeting and cost nothing.
-->

## Tools
A task carrying a tool's required keys in toolInput runs with no model at all and
costs zero tokens. Whenever the request supplies those values, pass them.

## Decomposition
Prefer ONE task. Split only when a step needs an earlier step's result, or when a
step can reach a tool. Never exceed 4 tasks.

## Skills
Use only tags listed as "Worker skills available". An unmatched tag falls back to
"general" and wastes the hint.

## Conventions
Titles under 60 characters, imperative. Task input must stand alone — a worker
sees the task, not the conversation. Mark proprietary or unpublished material
confidential; that keeps it on local models.
