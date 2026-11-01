import { StructuredOutputError } from './errors.js';

/** Strip markdown fences and surrounding prose, then parse the outermost JSON object. */
export function extractJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error('empty response');
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object found');
  return JSON.parse(unfenced.slice(start, end + 1));
}

function check(text, schema, validate) {
  let json;
  try {
    json = extractJson(text);
  } catch (err) {
    return { ok: false, issues: [`Output was not valid JSON (${err.message}). Return one complete JSON object and nothing else.`], data: null };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    return { ok: false, issues, data: null };
  }
  const domain = validate ? validate(parsed.data) : [];
  return domain.length ? { ok: false, issues: domain, data: parsed.data } : { ok: true, issues: [], data: parsed.data };
}

/**
 * Ask the model for JSON and do not trust the answer.
 *
 *   1. parse        -> not JSON? ask again, quoting the parser error
 *   2. schema (Zod) -> wrong shape? ask again, quoting the Zod issues
 *   3. domain rules -> invented ids, duplicates, overspending? ask again, listing each violation
 *
 * Each retry is a "repair" call that shows the model its own previous output next to the exact
 * problems found. After `maxRepairs` the caller gets a StructuredOutputError that still carries
 * the last schema-valid object, so it can sanitise deterministically instead of failing.
 *
 * @template T
 * @param {import('./client.js').LLMClient} client
 * @param {object} o
 * @param {string} o.task label used for accounting ('plan')
 * @param {string} o.system
 * @param {string} o.prompt
 * @param {import('zod').ZodType<T>} o.schema
 * @param {(data:T)=>string[]} [o.validate] domain validation, returns human-readable issues
 * @param {(a:{prompt:string, previous:string, issues:string[]})=>string} o.repairPrompt
 * @param {object} [o.mock] structured context for the mock provider
 * @param {number} [o.maxRepairs]
 * @param {{stats?:object, signal?:AbortSignal}} [o.ctx]
 * @returns {Promise<{data:T, attempts:number, repaired:boolean}>}
 */
export async function generateStructured(client, { task, system, prompt, schema, validate, repairPrompt, mock, maxRepairs = 2, maxOutputTokens = 8192, ctx = {} }) {
  let req = { task, system, prompt, json: true, mock, maxOutputTokens };
  let lastText = '';
  let lastData = null;
  let issues = [];

  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const res = await client.generate(req, ctx);
    lastText = res.text;
    const result = check(res.text, schema, validate);
    if (result.ok) return { data: result.data, attempts: attempt + 1, repaired: attempt > 0 };
    issues = result.issues;
    if (result.data) lastData = result.data;
    if (attempt === maxRepairs) break;
    req = {
      task: 'repair',
      system,
      prompt: repairPrompt({ prompt, previous: lastText, issues }),
      json: true,
      maxOutputTokens,
      mock: { ...mock, repair: true, attempt: attempt + 1, issues },
    };
  }
  throw new StructuredOutputError(issues, { lastData, lastText });
}
