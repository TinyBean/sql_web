---
name: test-oee-calculator
description: Precisely calculate or explain MT/ST Test OEE and query its underlying DataLens SQLite source tables using the fixed lot, machine-type, Machine_Running, Availability, DUT-On, and Yield rules. Use for Test OEE values, component breakdowns, comparisons, audits, or questions about its source schema and fields; do not use for Assembly OEE.
---

# Test OEE Calculator

Use deterministic code for every calculation. Do not recreate the classification CASE expressions or formulas ad hoc.

## Database

This Skill owns the context for its OEE SQLite database. Read
[references/database.md](references/database.md) before writing an ad hoc `execute_sql` query
or explaining source tables and fields. Use only the documented tables and columns.

## Web Agent

1. Resolve one inclusive `start_date` and `end_date` in `YYYY-MM-DD` format. Use the same bounds for Availability, DUT-On, and Yield.
2. Call `test_oee_calculator__calculate_test_oee`. Return both MT and ST unless the user asks for one kind.
3. For a single record's valid-LOT, MT/ST, platform fallback, or Machine_Running decision, call `test_oee_calculator__classify_test_oee_record`.
4. Report each component and Test OEE as percentages. State the machine counts and raw numerators/denominators when useful.
5. Surface nonzero unclassified-row diagnostics. A zero denominator means “无法计算”, not 0%.

## Project shell

Run the bundled deterministic CLI:

```bash
node --import tsx src/server/skills/test-oee-calculator/scripts/calculate-test-oee.ts START_DATE END_DATE [all|MT|ST]
```

The namespaced application tools and CLI both call the canonical implementation in
`assets/test-oee-calculator.ts`. Runtime source modules and other code resources live in
`assets/`; directly executable entrypoints live in `scripts/`.

## Explain or audit

Read [references/business-rules.md](references/business-rules.md) only when explaining the formula, reviewing a result, or changing the business rules. Keep the implementation and reference synchronized whenever a rule changes.
