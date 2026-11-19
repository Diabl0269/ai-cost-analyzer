# Codex Auto-review pricing

`codex-auto-review` remains unpriced in the shipped defaults. A missing published tariff does
not establish that the service is free. Keep its requests and recorded token usage in statistics;
the existing unpriced status must remain until an authoritative billing source confirms a rate.

Checked on 2026-11-05:

- [Official OpenAI Auto-review documentation](https://learn.chatgpt.com/docs/sandboxing/auto-review)
  describes the separate reviewer used for sandbox-boundary approvals but does not state a
  billing exemption or a token tariff for `codex-auto-review`.
- [Official OpenAI pricing documentation](https://learn.chatgpt.com/docs/pricing) distinguishes
  GitHub Code Review usage from local reviews. It does not establish the billing treatment of
  the sandbox approval reviewer. Those categories must not be conflated.
- The installed Codex CLI package identifies itself as `0.166.0-alpha.5.1`; its available text
  resources did not provide authoritative billing evidence for this model.

An explicitly configured model price may be zero; that makes it a known price rather than an
unknown-price placeholder. Do not add a default zero price or suppress warnings solely because
an ID contains `review`, nor allow a future unknown variant to inherit a guessed tariff.

## Labeled estimate (`pricing.estimateAs`)

Users who want a number can set `pricing.estimateAs: { "codex-auto-review": "<model key>" }`
(Settings → Pricing → **Estimate as…** beside **Add price**). The model itself **stays unpriced**
and the default config ships no entry. Rules:

- Exact normalized model id only; variants and prefixes never inherit it. An explicit price row
  (even zero) wins; the estimate also takes precedence over `unknownModelPolicy`.
- `resolvePrice` returns the target's rates with `unpriced: true, estimated: true, modelKey: null,
  estimatedAs: <key>`. `costOfUsage` returns zero for such prices, so recorded totals never include
  it; `estimatedCostOf` computes the estimate, surfaced as `estimatedCost` on `ModelCostRow`,
  `SessionSummary`, `SessionsResponse.totalEstimatedCost` and `OverviewResponse.totals.estimatedCost`.
- CSV `costStatus` is `estimated` when a session's only cost is an estimate (recorded cost columns
  stay blank); the estimate is in the `estimatedCostUsd` column. Mixed sessions stay `partial`.
- UI shows it as `<EstimateBadge billedAs>` ("≈ $X if billed as …"), never as a plain price.

Regression coverage: `tests/core/pricing/auto-review.test.ts` checks retained usage, the default
unknown-price flag, explicit user-configured zero rates, and unknown variant handling, and `estimateAs` resolution (flagged, variants excluded, explicit zero wins);
`tests/core/db/auto-review.test.ts` checks separate aggregates and CSV `estimated`.
