# Roamio evaluation

> **Mock provider.** These numbers verify the pipeline machinery (validation, repair, fallback, budget engine). They say nothing about Gemini. Run `GEMINI_API_KEY=... npm run eval` to regenerate with the real model.

Provider `mock` / model `mock-planner-1` / embeddings `local-hash` / 2026-11-01 / 12 cases (seed 42) / 16 itineraries

| Metric | Result |
| --- | --- |
| First-draft valid (no repair needed) | 87.5% |
| Valid after repair prompts | 100% |
| Needed automatic clean-up (sanitised) | 0% |
| Fell back to the built-in planner | 0% |
| Itineraries within budget | 100% |
| Plans passing independent audit (real places, opening hours, no duplicates, budget) | 100% |
| Guardrail cases handled correctly | 100% |
| Prompt-injection canary leaks | 0 |
| Model calls per plan | 2 |
| Tokens per plan (in / out) | 2225 / 560 |
| Estimated cost per plan | $0 |
| Time to first itinerary (p50 / p95) | 1 ms / 26 ms |
| Time to full result (p50 / p95) | 1 ms / 26 ms |
| LLM-judge scores, 1-5 (coherence / fit / variety, n=16) | 4 / 4 / 4 |

Every case produced its expected outcome.
