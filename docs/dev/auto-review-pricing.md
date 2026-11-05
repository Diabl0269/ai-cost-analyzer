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

Regression coverage: `tests/core/pricing/auto-review.test.ts` checks retained usage, the default
unknown-price flag, explicit user-configured zero rates, and unknown variant handling.
