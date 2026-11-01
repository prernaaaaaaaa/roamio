# Interview guide: explaining Roamio

Use this to prepare. Everything below is something the code actually does; open the file named in brackets and be ready to walk through it.

## The 30-second pitch

"Roamio is a GenAI trip planner where the model is a proposer and code is the referee. The model picks places from a curated knowledge base and writes the text. Code validates every choice, schedules the day, and computes every rupee, so the plan is guaranteed to fit the budget and use only real places. I measured it with an evaluation harness instead of just eyeballing outputs."

## Questions you should expect

**Why not just prompt the model and print the answer?**
It invents places, gets prices wrong and ignores budgets. I made the system closed-world: the model can only choose ids from retrieved candidates, and budget math is done in code. [`planner/validate.js`, `planner/costs.js`]

**What is RAG here and why hybrid?**
Retrieval-augmented generation: I retrieve candidate places from my knowledge base and put them in the prompt. Hybrid = BM25 for exact terms plus embedding similarity for meaning, merged with Reciprocal Rank Fusion, which needs no score calibration. [`kb/retriever.js`] Honest note: with about 10 places per city, retrieval mostly ranks rather than filters; it matters more as the knowledge base grows.

**What happens when the model returns bad output?**
Three layers: parse JSON, validate shape with Zod, validate domain rules. On failure I send a repair prompt that quotes the model's own output and the exact violations (up to 2 rounds). If it still fails I drop the invalid picks with rules, and if that removes too much (or the API is down) a deterministic planner takes over. [`llm/structured.js`, `planner/pipeline.js`]

**How do you handle prompt injection?**
User text goes in a delimited `<user_notes>` block that the system prompt says is data. More importantly the output is validated structurally: even if the model is tricked, it cannot add a place that is not in the candidate list or break the budget. The eval includes a canary case. [`planner/prompts.js`, `eval/cases.js`]

**What is tool calling used for?**
The model can call functions for season data, weather (Open-Meteo) and currency conversion (Frankfurter). The handlers validate arguments because they come from the model, and the numbers shown to users come from tool results, not from the model's text. If the model skips a tool, the pipeline calls it and labels the source. Tool calling is a separate step because many model APIs do not allow function calling together with JSON mode. [`tools/registry.js`, `planner/research.js`]

**How is it fast?**
Server-Sent Events to stream each itinerary when ready; the three styles run in parallel; one call per style instead of per day; research is skipped when there is nothing to look up; a limiter keeps parallelism inside API rate limits; results are cached with a budget bucket. Be ready to say what you measured: use `npm run eval` numbers from your own Gemini run.

**How do you control cost and abuse?**
Per-request call cap, process-wide daily call cap, concurrency/RPM limiter, IP rate limits, input bounds, response caching, and graceful degradation to the deterministic planner when the allowance is spent. [`llm/client.js`, `middleware/common.js`]

**How do you know it works?**
38 automated tests, including a property test that corrupts 60% of model answers and still requires valid, within-budget plans, plus an eval harness that audits each plan independently against the knowledge base. [`test/`, `eval/run.js`]

**What would you improve next?**
Move cache and limiter to Redis for multi-instance; larger knowledge base with a vector database; user feedback loop to build a preference-based eval set; per-day regeneration; offline caching of embeddings; proper auth (refresh tokens, email verification).

## Trade-offs to be honest about

- Only 8 destinations. That is the price of never inventing a place.
- Prices are curated approximations; a production system would use a booking or places API.
- The mock model verifies the machinery, not model quality; quality numbers come from a real Gemini run.
- LLM-as-judge scores are biased toward the judging model's own style; treat them as a signal, not truth.

## Numbers to prepare from your own run

After `GEMINI_API_KEY=... npm run eval -- --judge`, note: first-draft valid %, valid after repair %, fallback %, time to first itinerary (p50), cost per plan, model calls per plan. Quote only what you measured.
