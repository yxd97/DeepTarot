# DeepSeek API — Advanced Integration Guide

*Last updated: 2026-05-30*

This guide is for developers who want **fine-grained control over how an LLM
behaves** — not a "hello world," but the full control surface of the DeepSeek
API: when and how hard the model thinks, how output streams back, how tool calls
are orchestrated, how to force machine-parseable output, and how to lay out
prompts so caching and cost work in your favor.

Everything here is **language-agnostic**. DeepSeek speaks plain HTTPS + JSON and
is *wire-compatible with the OpenAI Chat Completions API* (with an
Anthropic-compatible surface too), so the concepts map onto any HTTP client or
SDK. Examples are shown as raw requests and neutral pseudocode rather than tied
to one runtime.

**Audience.** Engineers building agents, chat backends, batch pipelines, or
tooling on top of DeepSeek who need to customize model interaction beyond a
default chat call.

**Prerequisites.** Comfort with HTTP, JSON, and the request/response model. We do
not re-explain what a POST is; we focus on the levers DeepSeek exposes.

See also: [User Guide](user-guide.md) · [Developer Guide](dev-guide.md).

> **Currency of this document.** API surfaces drift. Model names, prices, and
> exact limits below reflect the DeepSeek docs as of **May 2026**. The *shapes*
> (one endpoint, a `model` + `messages` body, token-based billing, cache-hit
> discounts, the thinking/reasoning controls) are stable; the *names and numbers*
> are the parts to re-verify against <https://api-docs.deepseek.com/> before you
> ship.

**Conventions used in this guide**

- Code identifiers, field names, and shell commands are shown `like this`.
- JSON bodies are illustrative; comments inside them are for the reader, not
  valid JSON.
- Where a value changes over time (prices, promo windows), it is marked
  approximate and the authoritative source is linked.

---

## Table of contents

1. [The control surface at a glance](#1-the-control-surface-at-a-glance)
2. [Endpoints, base URLs, and auth](#2-endpoints-base-urls-and-auth)
3. [The baseline request](#3-the-baseline-request)
4. [Request body: every lever](#4-request-body-every-lever)
5. [Response anatomy and `finish_reason`](#5-response-anatomy-and-finish_reason)
6. [Conversation state is yours to manage](#6-conversation-state-is-yours-to-manage)
7. [Streaming: the dual-channel SSE protocol](#7-streaming-the-dual-channel-sse-protocol)
8. [Thinking (reasoning) mode](#8-thinking-reasoning-mode)
9. [Structured / JSON output](#9-structured--json-output)
10. [Tool (function) calling and the agent loop](#10-tool-function-calling-and-the-agent-loop)
11. [Context caching: design prompts for cache hits](#11-context-caching-design-prompts-for-cache-hits)
12. [Cost model](#12-cost-model)
13. [Errors, retries, and idempotency](#13-errors-retries-and-idempotency)
14. [Utility endpoints](#14-utility-endpoints)
15. [Reference client (pseudocode)](#15-reference-client-pseudocode)
16. [Quick reference card](#16-quick-reference-card)

---

## 1. The control surface at a glance

Customizing LLM interaction with DeepSeek means manipulating a small, orthogonal
set of levers. The rest of this guide is one section per lever.

| You want to control… | The lever | Section |
|---|---|---|
| Which model / quality tier answers | `model` | [2](#2-endpoints-base-urls-and-auth) |
| Whether and how deeply it reasons first | `thinking`, `reasoning_effort` | [8](#8-thinking-reasoning-mode) |
| Randomness / determinism | `temperature`, `top_p` | [4](#4-request-body-every-lever) |
| How much it may output | `max_tokens`, `stop` | [4](#4-request-body-every-lever) |
| Latency / perceived responsiveness | `stream` | [7](#7-streaming-the-dual-channel-sse-protocol) |
| Output that machines parse | `response_format` | [9](#9-structured--json-output) |
| Letting the model call your code | `tools`, `tool_choice` | [10](#10-tool-function-calling-and-the-agent-loop) |
| Cost and latency of repeated prefixes | prompt layout → caching | [11](#11-context-caching-design-prompts-for-cache-hits) |
| Resilience under failure | status-code-aware retries | [13](#13-errors-retries-and-idempotency) |

Two facts shape almost every decision below:

- **The API is stateless.** It remembers nothing between calls; you own the
  conversation history and resend it every time (section 6).
- **Everything is tokens.** Limits, billing, the context window, and the
  thinking budget are all measured in tokens (~¾ of a word). The context window
  is up to **1,000,000 tokens**, of which up to **384K** can be output.

---

## 2. Endpoints, base URLs, and auth

### Models

| Model | What it is | Reach for it when |
|---|---|---|
| `deepseek-v4-flash` | Fast, very low cost. Thinks by default; thinking can be disabled. | Default workhorse — chat, extraction, classification, code, most agents. |
| `deepseek-v4-pro` | Highest quality, higher price. Thinking available. | Hard reasoning, complex multi-step agents, when flash isn't good enough. |

> **Legacy names.** `deepseek-chat` and `deepseek-reasoner` are **deprecated
> (removal scheduled 2026-07-24)** and now alias onto `deepseek-v4-flash`:
> `deepseek-chat` = flash with thinking *off*, `deepseek-reasoner` = flash with
> thinking *on*. New integrations should use the `deepseek-v4-*` names plus the
> thinking controls in section 8.

### Base URLs

| Base URL | Surface |
|---|---|
| `https://api.deepseek.com` | OpenAI-compatible. Default; used throughout this guide. |
| `https://api.deepseek.com/v1` | Same behavior; the `/v1` suffix exists only so OpenAI clients that hard-code `/v1` work. It is **not** an OpenAI-version marker. |
| `https://api.deepseek.com/anthropic` | Anthropic-compatible (Messages API shape), so Anthropic/Claude SDKs work by repointing their base URL here. |
| `https://api.deepseek.com/beta` | Opt-in beta features (e.g. Fill-In-the-Middle completion, strict-schema tools). |

The endpoint path is appended to the base, e.g. `https://api.deepseek.com` +
`/chat/completions`.

### Authentication

Every request carries a **bearer token** — your API key — in the `Authorization`
header:

```
Authorization: Bearer YOUR_API_KEY
```

The key carries billing and full account access. Keep it server-side in an env
var or secrets manager; never ship it in client code or a public repo; rotate it
immediately if it leaks. A wrong/missing key returns `401`; an empty balance
returns `402`.

---

## 3. The baseline request

Everything else is a variation on this. One `POST`, a `model`, a list of
`messages`; the answer comes back at `choices[0].message.content`.

```
POST https://api.deepseek.com/chat/completions
Authorization: Bearer sk-xxxxxxxxxxxxxxxxxxxx
Content-Type: application/json

{
  "model": "deepseek-v4-flash",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user",   "content": "Hello!" }
  ],
  "stream": false
}
```

As neutral pseudocode:

```
response = HTTP.post(
    url     = "https://api.deepseek.com/chat/completions",
    headers = {
        "Authorization": "Bearer " + env("DEEPSEEK_API_KEY"),
        "Content-Type":  "application/json"
    },
    body = json_encode({
        "model": "deepseek-v4-flash",
        "messages": [ { "role": "user", "content": "Hello!" } ]
    })
)
answer = json_decode(response.body).choices[0].message.content
```

> **Reusing an OpenAI SDK?** Construct the client with
> `base_url = "https://api.deepseek.com"` and your DeepSeek key, then call its
> normal chat-completion method with `model = "deepseek-v4-flash"`. For Anthropic
> SDKs, point `base_url` at `https://api.deepseek.com/anthropic`.

---

## 4. Request body: every lever

Two fields are required; the rest are how you customize behavior.

### Required

| Field | Type | Meaning |
|---|---|---|
| `model` | string | `"deepseek-v4-flash"` or `"deepseek-v4-pro"`. |
| `messages` | array | The conversation so far, oldest first. Each element is `{ "role", "content" }` (plus `tool_calls`/`tool_call_id` for tool turns). |

#### Message roles

| Role | Purpose |
|---|---|
| `system` | Standing instructions / persona. Usually first; sets behavior for the whole conversation. |
| `user` | Input from the human or calling application. |
| `assistant` | A previous model reply, included when continuing a conversation (section 6). |
| `tool` | The result of a tool the model asked you to run (section 10). |

### Optional levers

| Field | Type | Default | What it controls |
|---|---|---|---|
| `stream` | boolean | `false` | Stream the reply token-by-token as SSE (section 7). |
| `thinking` | object | enabled on V4 | Reasoning on/off: `{"type":"enabled"}` or `{"type":"disabled"}` (section 8). |
| `reasoning_effort` | string | `"high"` | Reasoning depth when enabled — `"high"` or `"max"`. Omit when thinking is disabled (section 8). |
| `max_tokens` | integer | model-dependent | Upper bound on **output** tokens — the answer *plus* the chain-of-thought. Can be very large (up to 384K). Does not limit input. |
| `temperature` | number | `1` | Randomness, 0–2. Low = focused/deterministic; high = creative. Little/no effect while thinking is active. |
| `top_p` | number | `1` | Nucleus sampling, 0–1. Alternative to `temperature` — tune one, not both. |
| `stop` | string/array | none | Up to 16 strings; generation halts when any appears. |
| `response_format` | object | `{"type":"text"}` | `{"type":"json_object"}` forces valid-JSON output (section 9). |
| `tools` | array | none | Function declarations the model may call (section 10). Up to 128. |
| `tool_choice` | string/object | `"auto"` | `"none"`, `"auto"`, `"required"`, or a named function. |
| `logprobs` | boolean | `false` | Return token log-probabilities. |
| `top_logprobs` | integer | none | 0–20 alternatives per position (requires `logprobs: true`). |

> **Deprecated, no-op:** `frequency_penalty` and `presence_penalty` are accepted
> but have **no effect**. Don't rely on them; steer repetition through prompting.

> **Temperature in practice.** `0`–`0.3` for code, extraction, and factual work;
> `0.7`–`1.0` for conversational/creative text. It barely matters in thinking
> mode, where sampling knobs are largely ignored (section 8).

---

## 5. Response anatomy and `finish_reason`

A non-streaming success is HTTP `200` with:

```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1748563200,
  "model": "deepseek-v4-flash",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "Hi!" },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 12,
    "completion_tokens": 2,
    "total_tokens": 14,
    "prompt_cache_hit_tokens": 0,
    "prompt_cache_miss_tokens": 12
  }
}
```

| Path | Meaning |
|---|---|
| `choices[0].message.content` | The answer — what you usually want. |
| `choices[0].message.reasoning_content` | The chain-of-thought, present only when thinking ran (section 8). |
| `choices[0].finish_reason` | Why generation stopped (below). |
| `usage.completion_tokens` | Output tokens billed (**includes** thinking tokens). |
| `usage.prompt_cache_hit_tokens` / `_miss_tokens` | Cache split of the input (section 11). |
| `id` | Unique id — log it for support/debugging. |

### `finish_reason`

| Value | Meaning | Action |
|---|---|---|
| `stop` | Finished naturally (or hit a `stop` string). | Use the content. |
| `length` | Hit `max_tokens`, output truncated. | Raise `max_tokens` or ask to continue. With thinking on, the CoT can eat the budget. |
| `tool_calls` | The model wants a tool run (section 10). | Execute and return results. |
| `content_filter` | Content filtered. | Adjust the prompt. |
| `insufficient_system_resource` | Server capacity issue. | Retry after a short wait. |

**Always check `finish_reason` before trusting `content`.** A `length` finish is
the most common silent bug — and in JSON mode it yields invalid, half-written
JSON.

---

## 6. Conversation state is yours to manage

The API is **stateless**: it remembers nothing across calls. To hold a
conversation, keep the message list yourself and resend the *entire history* each
round, appending the model's replies as `assistant` messages.

```
Round 1 messages: [ system, user#1 ]                    -> assistant#1
Round 2 messages: [ system, user#1, assistant#1, user#2 ] -> assistant#2
Round 3 messages: [ system, user#1, assistant#1, user#2, assistant#2, user#3 ]
```

```json
{
  "model": "deepseek-v4-flash",
  "messages": [
    { "role": "system",    "content": "You are a helpful assistant." },
    { "role": "user",      "content": "What is the capital of France?" },
    { "role": "assistant", "content": "Paris." },
    { "role": "user",      "content": "And its population?" }
  ]
}
```

Implications you must design around:

- Every token of history is **re-sent and re-billed** each round. Long
  conversations grow in cost and march toward the 1M-token limit — trim or
  summarize old turns.
- Caching (section 11) makes the repeated prefix cheap automatically, so the
  marginal cost is mostly the newest turn.
- **Thinking-mode rule:** whether you carry `reasoning_content` into the next
  request is conditional — resend it on turns that called tools, drop it on
  plain-answer turns (section 8).

---

## 7. Streaming: the dual-channel SSE protocol

Set `stream: true` to receive **Server-Sent Events**: a sequence of `data:`
lines, each a JSON *chunk* carrying an incremental `delta`.

```json
{ "model": "deepseek-v4-flash",
  "messages": [ { "role": "user", "content": "Count to three." } ],
  "stream": true }
```

```
data: {"choices":[{"delta":{"role":"assistant","content":""}}]}

data: {"choices":[{"delta":{"content":"One"}}]}

data: {"choices":[{"delta":{"content":", two"}}]}

data: {"choices":[{"delta":{"content":", three."}}]}

data: {"choices":[{"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

Consume it language-agnostically:

```
open a streaming HTTP connection (do NOT buffer the whole body)
full_text = ""
for each line in response:
    if not line.startsWith("data: "):  continue
    payload = line after "data: "
    if payload == "[DONE]":  break          # sentinel, not JSON
    chunk = json_decode(payload)
    piece = chunk.choices[0].delta.content   # may be absent/empty
    if piece:  full_text += piece; render(piece)
```

What advanced integrators must get right:

- Text lives at `choices[0].delta.content` (note **`delta`**, not `message`).
  Concatenate deltas to rebuild the answer.
- `data: [DONE]` is the end sentinel — it is **not** JSON.
- The final real chunk carries `finish_reason`.
- **Dual channel in thinking mode:** the chain-of-thought streams first in
  `choices[0].delta.reasoning_content`, then the answer streams in
  `delta.content`. Route them to separate UI regions to show the model
  "thinking," then "answering."
- `usage` may appear only in a final chunk depending on options; for exact
  accounting prefer a non-streamed call or sum what you receive.
- Your HTTP client must read incrementally; a client that buffers until close
  silently defeats streaming.

---

## 8. Thinking (reasoning) mode

DeepSeek V4 can **reason step-by-step before answering**. This is the single
biggest lever on answer quality vs. latency/cost, and it is controlled by two
parameters (not a separate model, as it was with the old `deepseek-reasoner`):

- `thinking` — an **object** toggling reasoning:
  `{"type": "enabled"}` or `{"type": "disabled"}`. V4 is **enabled by default**,
  so in practice you set this mainly to *disable* thinking for fast replies.
- `reasoning_effort` — depth when enabled: `"high"` (default) or `"max"`
  (deepest, longest chain-of-thought). For cross-vendor compatibility the API
  also accepts `"low"`/`"medium"` (treated as `"high"`) and `"xhigh"` (treated
  as `"max"`). Omit it when thinking is disabled.

This yields three practical modes:

| Mode | `thinking` | `reasoning_effort` | Use for |
|---|---|---|---|
| **Non-think** | `{"type":"disabled"}` | (omit) | Low latency, simple/structured tasks, high throughput. |
| **Think-High** | `{"type":"enabled"}` | `"high"` | The default; most reasoning-bearing tasks. |
| **Think-Max** | `{"type":"enabled"}` | `"max"` | Hardest math/logic/planning; willing to pay tokens + latency. |

Example — ask flash to think hard:

```json
{
  "model": "deepseek-v4-flash",
  "messages": [
    { "role": "user", "content": "Is 2027 a prime number? Show your work." }
  ],
  "thinking": { "type": "enabled" },
  "reasoning_effort": "high"
}
```

When thinking runs, the response carries an **extra field**,
`reasoning_content`, beside the normal `content`:

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "reasoning_content": "Check divisibility by primes up to sqrt(2027)~45 ...",
        "content": "Yes, 2027 is prime."
      },
      "finish_reason": "stop"
    }
  ]
}
```

`reasoning_content` is the chain-of-thought (can be long); `content` is the final
answer to show the user.

### Rules that bite

1. **Carry `reasoning_content` back only on tool-call turns** — the rule is
   conditional, and getting it wrong is a common 400:
   - **Plain-answer turn** (the assistant reply had no `tool_calls`): drop its
     `reasoning_content`. You don't need it next turn, and V4 ignores it if you
     send it anyway.
   - **Tool-call turn** (the reply emitted `tool_calls`): you **must** send that
     turn's `reasoning_content` back — together with its `tool_calls` and the
     matching `tool` results — on every following request until the model
     returns its final answer. Omitting it then returns **HTTP 400**.
   - **Legacy `deepseek-reasoner`** is stricter: it never accepts
     `reasoning_content` in the input at all, so always strip it there.

   Either way, never put the CoT into what you *display* as the answer.
2. **Sampling knobs are largely ignored** while thinking (`temperature`,
   `top_p`, the deprecated penalties). Don't rely on them to steer a
   thinking-mode answer.
3. **Budget for the CoT.** It counts as output — billed as output, counted
   against `max_tokens` and the context window. Set `max_tokens` high enough to
   cover *both* the reasoning and the answer, or you get a `length` finish with
   no usable result.

> **OpenAI-SDK note.** `thinking` is a DeepSeek-specific field standard OpenAI
> clients don't model, so pass it through the library's escape hatch (e.g.
> `extra_body={"thinking": {"type": "enabled"}}`). `reasoning_effort` is a
> standard field and can be passed normally.

---

## 9. Structured / JSON output

For machine-parseable output, force valid JSON with `response_format`:

```json
{
  "model": "deepseek-v4-flash",
  "messages": [
    { "role": "system", "content": "Extract the data and reply as JSON." },
    { "role": "user",   "content": "Invoice #42 from Acme totals $19.99." }
  ],
  "response_format": { "type": "json_object" }
}
```

`content` is then guaranteed valid JSON *syntax*, e.g.
`{ "invoice_number": 42, "vendor": "Acme", "total": 19.99 }`.

Rules that make it reliable:

- **Also instruct JSON in the prompt** and describe/show the exact shape you
  want. `response_format` guarantees syntax, **not your schema** — include the
  word "JSON" somewhere in the prompt.
- Keep `max_tokens` generous: a `length` truncation produces invalid,
  half-written JSON.
- **Validate the parsed object against your schema anyway.** Treat the model as a
  fast-but-fallible producer; missing/renamed fields happen.
- For schema-strict tool arguments specifically, the `/beta` surface supports a
  `strict` flag on function definitions (section 10).

---

## 10. Tool (function) calling and the agent loop

Tool calling lets the model invoke **your** code: you declare functions, the
model emits a structured call with arguments, you execute it and feed the result
back, and the model continues. DeepSeek never runs anything itself — it only
emits the request. This is the backbone of agents.

The loop has four steps; an agent repeats it until `finish_reason == "stop"`.

### Step 1 — Declare tools (JSON-Schema parameters)

```json
{
  "model": "deepseek-v4-flash",
  "messages": [ { "role": "user", "content": "What's the weather in Paris?" } ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get the current weather for a city.",
        "parameters": {
          "type": "object",
          "properties": { "city": { "type": "string", "description": "City name" } },
          "required": ["city"]
        }
      }
    }
  ]
}
```

### Step 2 — The model requests a call

`finish_reason` becomes `"tool_calls"`; `arguments` is a **JSON string**:

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_abc123",
            "type": "function",
            "function": { "name": "get_weather", "arguments": "{\"city\": \"Paris\"}" }
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ]
}
```

### Step 3 — Run it, append the result

Append the assistant message **verbatim** (with its `tool_calls`), then one
`tool` message per call echoing the `tool_call_id`:

```json
{
  "model": "deepseek-v4-flash",
  "messages": [
    { "role": "user", "content": "What's the weather in Paris?" },
    {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        { "id": "call_abc123", "type": "function",
          "function": { "name": "get_weather", "arguments": "{\"city\": \"Paris\"}" } }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_abc123",
      "content": "{\"temp_c\": 18, \"condition\": \"cloudy\"}"
    }
  ],
  "tools": [ /* same declarations */ ]
}
```

### Step 4 — The model answers

```json
{ "choices": [ { "message": { "role": "assistant",
  "content": "It's currently 18°C and cloudy in Paris." },
  "finish_reason": "stop" } ] }
```

What advanced integrators must handle:

- `tool_call_id` must match between the request and your `tool` reply, or the
  history is rejected.
- `arguments` is a **string of JSON** — parse *and validate* it; the model can
  hallucinate fields or emit malformed JSON.
- The model may request **several calls at once** — run them all, append one
  `tool` message per `id`.
- A single user turn may take **multiple tool rounds** before a final answer.
  Loop on `finish_reason`.
- `tool_choice`: `"required"` forces some call, `"none"` forbids them, a named
  function forces a specific one. Use this to constrain agent behavior.
- The `/beta` surface adds `"strict": true` on a function to enforce strict
  JSON-Schema compliance of `arguments`.
- Combining tools with thinking mode is an advanced combination — confirm
  current behavior against the live docs, since the legacy reasoner did not
  support tools at all.

---

## 11. Context caching: design prompts for cache hits

DeepSeek **automatically** caches the prefix of your prompt server-side
(disk-backed, on by default — nothing to enable). When a later request begins
with the same tokens — same `system` prompt, same earlier turns, same few-shot
block — those leading tokens bill at a **much cheaper cache-hit rate**.

Every response reports the split:

```json
"usage": {
  "prompt_tokens": 1024,
  "prompt_cache_hit_tokens": 900,
  "prompt_cache_miss_tokens": 124,
  "completion_tokens": 200,
  "total_tokens": 1224
}
```

**The design rule: constant first, variable last.**

- Put the long, stable `system` prompt, instructions, and few-shot examples at
  the **start** of `messages`.
- Put the user's changing input at the **end**.
- Keep the prefix byte-identical between calls — even a reworded system prompt or
  a reordered few-shot block busts the cache.
- In multi-turn chats this happens for free: each round's prefix matches the
  previous request (cache hit); only the newest turn misses.

Caching changes price and latency only — never the content of the answer.

---

## 12. Cost model

Billing is per token, separately for input and output, quoted **per 1,000,000
tokens (USD)**. Input has two rates: cheap **cache-hit** vs. full **cache-miss**.

Approximate published rates (per 1M tokens, USD, May 2026):

| Model | Input — cache hit | Input — cache miss | Output |
|---|---|---|---|
| `deepseek-v4-flash` | ~$0.0028 | ~$0.14 | ~$0.28 |
| `deepseek-v4-pro` (standard) | ~$0.0145 | ~$1.74 | ~$3.48 |
| `deepseek-v4-pro` (promo, ends 2026-05-31 15:59 UTC) | ~$0.003625 | ~$0.435 | ~$0.87 |

> **Verify before relying on numbers.** Two time-boxed changes are baked into the
> table: a launch-promo **75% discount** on `deepseek-v4-pro` ending
> **2026-05-31 15:59 UTC**, and a permanent **cache-hit cut to 1/10 of launch
> price** effective **2026-04-26 12:15 UTC**. DeepSeek has historically also run
> **off-peak discounts** (~50–75% off, roughly **16:30–00:30 UTC**) on earlier
> generations, but off-peak pricing for V4 was **not officially confirmed** at
> writing — test it, don't assume it. Live numbers:
> <https://api-docs.deepseek.com/quick_start/pricing>.

Stable takeaways that should drive architecture: cache hits are ~1–2 orders of
magnitude cheaper than misses (so optimize prompt layout, section 11); output
costs more than input (so cap `max_tokens` and remember thinking spends output);
flash is far cheaper than pro (so route only the hard requests to pro).

---

## 13. Errors, retries, and idempotency

On failure the API returns a non-`200` status and a JSON body describing the
problem. Split them into "fix your request" vs. "transient, retry."

| Status | Name | Cause | Class |
|---|---|---|---|
| `400` | Invalid Format | Malformed body, or mishandled `reasoning_content` across turns (§8). | Fix — no retry |
| `401` | Authentication Fails | Bad/missing key. | Fix — no retry |
| `402` | Insufficient Balance | Out of funds. | Fix — no retry |
| `422` | Invalid Parameters | Parameter out of range/invalid. | Fix — no retry |
| `429` | Rate Limit Reached | Sending too fast. | Transient — retry |
| `500` | Server Error | Server-side problem. | Transient — retry |
| `503` | Server Overloaded | High traffic. | Transient — retry |

### Retry strategy

Retry only the transient classes (`429`/`500`/`503` and network timeouts) with
**exponential backoff + jitter** and a cap:

```
attempt = 0; max_attempts = 5
loop:
    r = send_request()
    if r.status == 200:                       return r
    if r.status in (400, 401, 402, 422):      fail_fast(r)   # your bug
    if attempt >= max_attempts:               fail(r)
    delay = min(60s, base * 2^attempt) + random(0, 1s)
    wait(delay); attempt += 1
```

- DeepSeek publishes no fixed RPM; its guidance is to "pace requests reasonably."
  Treat `429` as the signal to slow down rather than hard-coding a rate.
- **Idempotency:** a `500` may mean the request did *or* didn't complete
  server-side. If a model turn drives an external side effect, design so a retry
  can't double-act (dedupe keys, check-before-write).
- Log the response `id` and any error body for support.

---

## 14. Utility endpoints

| Method + path | Purpose |
|---|---|
| `GET /models` | List available model names — confirm `deepseek-v4-flash` / `deepseek-v4-pro` are current. |
| `GET /user/balance` | Remaining account balance/credits. |
| `POST /beta/completions` | **Fill-In-the-Middle (FIM)**: give a `prompt` (prefix) and `suffix`, get the middle filled in. Requires the `/beta` base URL. Useful for code-completion tooling. |

All use the same `Authorization: Bearer` header.

```bash
curl https://api.deepseek.com/user/balance \
  -H "Authorization: Bearer $DEEPSEEK_API_KEY"
```

---

## 15. Reference client (pseudocode)

A minimal, language-neutral client that holds a conversation, optionally thinks,
and retries transient failures — the skeleton you would build a real integration
on.

```
function deepseek_chat(history, user_text,
                       model = "deepseek-v4-flash",
                       think = false):
    history.append({ "role": "user", "content": user_text })

    body = { "model": model, "messages": history, "stream": false, "max_tokens": 4096 }
    if think:
        body["thinking"]         = { "type": "enabled" }
        body["reasoning_effort"] = "high"               # or "max" for the deepest
    else:
        body["thinking"]    = { "type": "disabled" }
        body["temperature"] = 0.7      # only meaningful when not thinking

    response = post_with_retry(
        url     = "https://api.deepseek.com/chat/completions",
        headers = { "Authorization": "Bearer " + env("DEEPSEEK_API_KEY"),
                    "Content-Type":  "application/json" },
        body = json_encode(body)
    )

    choice = json_decode(response.body).choices[0]
    if choice.finish_reason == "length":
        warn("truncated; raise max_tokens (thinking spends output tokens too)")

    # This minimal client makes no tool calls, so dropping reasoning_content is
    # safe. If you add tools, you MUST keep reasoning_content on any assistant
    # turn that emitted tool_calls and resend it until that turn finishes (§8).
    history.append({ "role": "assistant", "content": choice.message.content })

    return { "answer":    choice.message.content,
             "reasoning": choice.message.reasoning_content }   # set only when thinking ran


function post_with_retry(url, headers, body):
    for attempt in 0 .. 4:
        r = HTTP.post(url, headers, body)
        if r.status == 200:                       return r
        if r.status in (400, 401, 402, 422):      raise FatalApiError(r)
        wait( min(60, 0.5 * 2^attempt) + random(0,1) )   # backoff + jitter
    raise RetriesExhausted()
```

```
history = [ { "role": "system", "content": "You are concise." } ]
print( deepseek_chat(history, "Name a primary color.").answer )                 # "Blue."
print( deepseek_chat(history, "Prove sqrt(2) is irrational.", think=true).answer )
```

---

## 16. Quick reference card

```
ENDPOINT   POST https://api.deepseek.com/chat/completions
AUTH       Authorization: Bearer YOUR_API_KEY
BODY       { "model": "...", "messages": [ {role, content}, ... ] }
ANSWER     response.choices[0].message.content

MODELS     deepseek-v4-flash   fast, cheap, thinks by default
           deepseek-v4-pro     most capable, pricier
           (legacy deepseek-chat / deepseek-reasoner: deprecated 2026-07-24)

ROLES      system | user | assistant | tool

THINKING   thinking:{"type":"enabled"|"disabled"}   step-by-step reasoning on/off
           reasoning_effort:"high"|"max"            depth (default "high")
           -> adds choices[0].message.reasoning_content
              (resend only on tool-call turns; see §8)

KEY FLAGS  stream:true            -> SSE token stream, ends with "data: [DONE]"
           response_format:{type:"json_object"}  -> valid JSON output
           tools:[...]            -> function calling (finish_reason "tool_calls")
           max_tokens:N           -> cap output (thinking counts as output)
           temperature:0..2       -> randomness (little effect while thinking)
           frequency_penalty / presence_penalty  -> DEPRECATED, no effect

LIMITS     context up to 1,000,000 tokens; up to 384K output tokens

STATELESS  resend full message history every call

CACHING    automatic; stable prefix first, variable text last
           usage.prompt_cache_hit_tokens / _miss_tokens shows the split
           cache hits ~1-2 orders of magnitude cheaper than misses

ERRORS     400/401/402/422 = fix it (no retry)
           429/500/503      = back off + retry with jitter
```

---

### Where to go next

- **Official docs:** <https://api-docs.deepseek.com/> — authoritative for current
  model names, `reasoning_effort` values, live pricing, and limits.
- **OpenAI compatibility:** point any OpenAI client's base URL at
  `https://api.deepseek.com`. **Anthropic compatibility:** use
  `https://api.deepseek.com/anthropic`.
