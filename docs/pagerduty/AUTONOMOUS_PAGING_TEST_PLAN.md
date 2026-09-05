# Test plan — does the agent autonomously decide to page on-call?

**Written 2026-09-05. This file is the resume point for this task after any context reset.**

## The one question this answers

`page_oncall_engineer`'s own correctness is already `VERIFIED LIVE` (see
`docs/pagerduty/RESEARCH.md`): a real call through the real MCP server produced a
real PagerDuty incident, confirmed in their UI, then resolved cleanly.

**What is NOT proven:** whether the LLM, given real conversation context and no
explicit instruction to do so, *decides on its own* to call that tool. That is a
question about the agent's judgment, not about the tool. It is the last unverified
claim in the whole PagerDuty feature, and it is the one a judge is most likely to
ask about ("did it decide that, or did you tell it to?").

**Success is not "a page fired."** Success is knowing, with evidence, which of these
is true:
- (A) Agent autonomously calls the tool with a sensible severity → feature is real.
- (B) Agent never calls it despite SEV1-level input → prompt needs tuning; a real,
  publishable finding, not a failure to hide.
- (C) Agent tries to call it but the call fails in transit → an infrastructure bug
  (MCP reachability), NOT an agent-judgment result. Must be distinguished from (B),
  because (B) and (C) look identical from the UI. See Obstacle 3.

Record whichever one actually happens. A null result recorded honestly is worth more
to this project than a passing test that was steered.

## Rollback checkpoint

Last known-good commit before this work: **`1a98d14`**. Everything below is testing
and documentation; if any code change made during this task breaks something close
to the deadline:

```bash
git reset --hard 1a98d14
```

---

## Phase 0 — Pre-flight (cheap checks, no Agora quota spent)

Everything here is free. Do all of it before starting any agent, because every
agent session costs billed ConvoAI minutes (see Obstacle 7).

```bash
cd /Users/bala/Documents/Tocsin

# 1. Stack healthy?
docker compose ps
curl -sf http://localhost:8000/health && echo " backend OK"
curl -s -o /dev/null -w "mock-services: %{http_code}\n" --max-time 3 http://localhost:8001/mcp   # 406 is expected/fine

# 2. Is the PagerDuty key actually inside the container? (not just in .env)
docker compose exec -T mock-services sh -c 'echo "${PAGERDUTY_ROUTING_KEY:+KEY_PRESENT}"'

# 3. Is page_oncall_engineer actually reachable over MCP right now?
docker compose exec -T mock-services python3 -c "
import asyncio
from fastmcp import Client
async def m():
    async with Client('http://localhost:8001/mcp') as c:
        names=[t.name for t in await c.list_tools()]
        print(len(names),'tools; page_oncall_engineer present:', 'page_oncall_engineer' in names)
asyncio.run(m())"
```

**Gate:** all three must pass before spending a single Agora minute.

---

## Phase 1 — Fix MCP reachability (THE blocker)

**Current state as of writing: `MCP_SERVER_PUBLIC_URL` is a dead ngrok URL from an
earlier session, and ngrok is not running.** Agora's servers call our MCP endpoint
from the public internet — `localhost:8001` means nothing to them. Without a live
tunnel, the agent *cannot* call the tool even if it wants to, and the test would
produce outcome (C) misread as (B).

Good news: `start.sh` already automates this entire lifecycle — it starts ngrok,
extracts the public URL, writes it into BOTH `.env` and `backend/.env`, restarts the
backend with `--no-deps`, then reads the env var back *out of the running container*
and hard-exits if it doesn't match. That verification step is exactly what we want.

```bash
./start.sh
```

Then confirm independently:

```bash
docker compose exec -T backend env | grep MCP_SERVER_PUBLIC_URL
curl -s -o /dev/null -w "%{http_code}\n" "$(docker compose exec -T backend env | grep '^MCP_SERVER_PUBLIC_URL=' | cut -d= -f2- | tr -d '\r')/mcp"
```

**Gate:** the URL inside the container must be the *new* ngrok URL, and hitting
`<url>/mcp` from outside must not be a connection error.

---

## Phase 2 — Mic-free agent test (do this FIRST, before live voice)

This is the part that makes the whole test cheap and repeatable, and it is the part
that was missing from the earlier sketch of this plan.

**Key realisation:** the "Inject / Simulate utterance" button in the UI does **NOT**
work for this test. It posts an observation to *our* backend — the Agora agent never
hears it, so it cannot possibly influence the agent's tool-calling. Using it would
produce a false negative.

**What does work:** `POST /api/agora/think-into-channel` (`agent-think`) injects a
one-off instruction directly into a *running* agent's live conversation context.
That drives the agent's reasoning with no microphone at all — which matters because
Claude has no mic and cannot speak into the channel.

Sequence:
1. Join a channel in the browser with `voice_pipeline=composed_tools` (see Phase 3
   for why the browser must be involved even here — the agent needs a real RTC peer).
2. Start the agent.
3. Inject escalating context via `agent-think`, one step at a time, *without ever
   naming the tool*:
   - Step 1 (should NOT page): "Support says a few users mentioned slow logins."
   - Step 2 (borderline, SEV3/SEV2): "Login API is now returning 503s for about 40%
     of requests, started right after the identity-service deploy."
   - Step 3 (unambiguous SEV1): "Confirmed — login success rate has dropped to
     near zero for all customers, ongoing more than ten minutes, no fix in sight."
4. After each step, check whether a tool call fired (Phase 4 verification).

**Why step-wise matters:** if it pages at step 1, the agent is trigger-happy and the
severity guidance in the prompt isn't landing — that's a finding. If it only pages at
step 3, its judgment is calibrated correctly, which is a much stronger claim to make
to a judge than "it paged."

**Never** say "call page_oncall_engineer" or "page the on-call engineer" in the
injected text. That tests the plumbing (already proven), not the judgment. If the
only way to make it page is to tell it to page, the honest conclusion is (B).

---

## Phase 3 — Live browser test via Chrome (required, not optional)

The mic-free path proves judgment. The browser path proves it works the way a judge
will actually see it. Both are needed.

Claude drives Chrome via `mcp__claude-in-chrome__*` against `http://localhost:3002/voice-test`
(note: Claude's browser tool can only see tabs it opened itself — it cannot attach to
a tab you already have open; that is a tool limitation, not a bug).

Steps Claude can do unattended:
1. `navigate` to `/voice-test`
2. `form_input` the pipeline select to `composed_tools`
3. Verify the LLM vendor select appears and defaults to `openai`
4. Click **Join**, wait for CONNECTED, screenshot
5. Click **Start**, wait for agent RUNNING, screenshot
6. Drive the conversation via `agent-think` (Phase 2)
7. Screenshot the Live Situation / Timeline / whiteboard as evidence
8. Click **Leave** and confirm the wipe-on-leave still works

Steps that need Bala (Claude has no microphone):
9. Re-join and **speak** the Phase 2 escalation script aloud into the mic, to confirm
   the real end-to-end path (voice → ASR → LLM → tool call) works, not just the
   injected-instruction path.

---

## Phase 4 — Verification, from four independent angles

Never conclude from one signal. These four together distinguish (A)/(B)/(C):

| # | Signal | Command | What it tells us |
|---|---|---|---|
| 1 | Agora attempted a tool call | `docker compose logs backend --since 5m \| grep -iE "mcp\|tool"` | Whether the agent's LLM decided to invoke anything at all |
| 2 | Our MCP server actually received the call | `docker compose logs mock-services --since 5m \| grep -iE "page_oncall\|pagerduty"` | Distinguishes (B) "never tried" from (C) "tried, transit failed" |
| 3 | Real PagerDuty incident exists | Chrome → `https://ishowspeed.pagerduty.com/incidents` | Ground truth — did a human actually get paged |
| 4 | Agent said something about it | Screenshot the transcript / Live Situation panel | Whether the agent *believes* it paged (watch for it claiming success when signal 2/3 say otherwise — that would be a hallucination worth catching) |

**The critical pairing is 1 vs 2.** If Agora logs show a tool attempt but
mock-services never received it → outcome (C), an ngrok/MCP transit problem, and the
agent's judgment was actually fine. Do not report that as a judgment failure.

---

## Phase 5 — Cleanup (mandatory, do not skip)

If a real page fired, resolve it — do not leave a fake incident open, and do not let
the escalation policy keep escalating it:

```bash
source .env
curl -s -X POST https://events.pagerduty.com/v2/enqueue \
  -H 'Content-Type: application/json' \
  -d "{\"routing_key\":\"$PAGERDUTY_ROUTING_KEY\",\"event_action\":\"resolve\",\"dedup_key\":\"<incident_id used>\"}"
```

Then confirm 0 triggered / 0 acknowledged in the PagerDuty UI, and stop the agent
(`Stop` button, or `POST /api/agora/stop-agent`) so it stops burning quota.

Also purge any Tocsin test incidents created during the run so the demo DB stays
clean (`DELETE /api/incidents/{id}`).

---

## Phase 6 — Record the result honestly

Update, whichever way it goes:
- `docs/pagerduty/RESEARCH.md` — the status table row for "Agent actually choosing to
  call this tool mid-conversation, unprompted"
- `TODO.md` — the `page_oncall_engineer` entry's "Still unverified" paragraph

If outcome (B), the finding to write is *"agent did not call the tool despite SEV1
input; prompt tuning required"* — plus what was tried. That is a legitimate,
publishable result and exactly the kind of thing CLAUDE.md's evidence discipline
exists to protect.

---

## Obstacles, and how each gets tackled

### Obstacle 1 — ngrok free-tier URL rotates every restart
The URL changes each time ngrok restarts, silently invalidating `MCP_SERVER_PUBLIC_URL`.
This is *already* what broke reachability before this plan was written.
**Tackle:** always re-run `./start.sh` at the start of a session (it rewrites both
.env files and verifies inside the container). Never assume a previously-working URL
is still valid. Re-check Phase 1's gate every single session.

### Obstacle 2 — ngrok's browser-warning interstitial
ngrok free tier can serve an HTML warning page instead of proxying, for requests with
browser-like User-Agents, which would break the MCP handshake.
**Tackle:** we have direct precedent that this does *not* block Agora — on 2026-09-03
a real `CallToolRequest` came through this same ngrok setup and reached USGS's live
API (`docs/agora/RESEARCH.md` §4). Agora's MCP client isn't browser-UA. If it ever
does bite, the fix is a static ngrok domain or `--request-header-add`.

### Obstacle 3 — (B) and (C) are indistinguishable from the UI
"No page appeared" could mean the agent chose not to, OR that it tried and the call
never arrived. Conflating them would produce a false, and unfair, conclusion about
the agent.
**Tackle:** Phase 4's signal-1-vs-signal-2 pairing exists precisely for this. Always
check *both* backend logs (did Agora attempt) and mock-services logs (did we receive)
before concluding anything.

### Obstacle 4 — MCP tools only exist under `composed_tools`
Under the default `gemini_live` (mllm) pipeline, `mcp_servers` is never sent — the
agent has no tools at all, and the test is meaningless.
**Tackle:** verify the pipeline select is on "Managed Tools" *in the UI* before
starting, and confirm the `/start-agent` response's `mcp_tool_calling_status` field
does not say `NOT_SUPPORTED`. That field was built for exactly this check.

### Obstacle 5 — Gemini quota (429) could take out the agent's brain
Gemini's free-tier quota is already exhausted in this project (extraction fell back to
Groq). If `composed_tools` is run with `llmVendor=gemini` (BYOK), the *agent's* LLM
could 429 mid-test and look like "the agent didn't decide to page."
**Tackle:** keep the LLM vendor on **`openai`** (the default), which uses
Agora-managed credentials and doesn't touch our exhausted Gemini quota at all.

### Obstacle 6 — transcripts under composed_tools are UNPROVEN
The RTM transcript fix (Token 007) was verified under **`gemini_live`**.
`composed_tools` is a different pipeline (ASR → LLM → TTS). Whether transcripts still
flow into the evidence record there has *never been tested*. The whiteboard/timeline
may stay empty even though the agent is working perfectly.
**Tackle:** treat this as a *separate* finding, not as a paging failure. If the
whiteboard is empty but signals 1–3 show a real page, the paging test still passed.
Log the transcript gap as its own TODO item.

### Obstacle 7 — every agent session burns billed ConvoAI quota
The project has a limited ConvoAI minute budget (300 min).
**Tackle:** do all of Phase 0 free-checks first; keep agent sessions short; hit
**Stop** as soon as the observation is made rather than letting `idle_timeout: 120`
run it out; prefer the mic-free `agent-think` path (Phase 2) for iteration and save
live-voice runs (Phase 3 step 9) for final confirmation only.

### Obstacle 8 — a real page fires a real notification
This tool deliberately has no approval gate (that was Nitin's explicit design call),
so a successful test *will* notify the on-call human — Bala, as default on-call.
**Tackle:** expect it; don't be alarmed; resolve immediately via Phase 5. Warn Bala
before each run so a 1am phone buzz isn't a surprise.

### Obstacle 9 — Claude cannot use a microphone, and cannot see your existing tabs
Two hard tool limitations.
**Tackle:** `agent-think` covers the no-mic gap for judgment testing (Phase 2);
Claude opens its own Chrome tab for the browser test (Phase 3); Bala performs only
the final spoken-voice confirmation (Phase 3 step 9).

### Obstacle 10 — the agent might *claim* it paged without actually paging
LLMs narrate actions they didn't take. The system prompt already forbids this
("Never claim to have checked telemetry... unless a tool call actually executed"),
but that's a prompt, not a guarantee.
**Tackle:** never trust the agent's spoken word as evidence. Signal 3 (a real
PagerDuty incident) is the only ground truth. If the agent says it paged and
PagerDuty shows nothing, that is itself an important finding worth reporting —
and exactly the kind of hallucination this project's evidence discipline is built
to catch.

---

## If outcome is (B) — agent won't call the tool: escalation ladder

Try in this order, re-testing after each, and record which rung was needed:
1. **Confirm it can see the tool at all** — check Agora logs for a `ListToolsRequest`.
   If the tool isn't even discovered, it's an infrastructure problem (back to Phase 1),
   not judgment.
2. **Strengthen the trigger context** — make the injected scenario more unambiguously
   SEV1 (explicit user impact, duration, no mitigation).
3. **Tune `MCP_TOOL_ROSTER_NOTICE`** in `backend/app/api/agora.py` — it already
   carries severity guidance; make the *when to call it* condition more explicit
   without making it unconditional.
4. **Ask Nitin.** He works at Agora and has already unblocked this project once (he
   diagnosed the Token 006/007 RTM bug from the agent side, which nothing on our side
   could see). If the agent discovers tools but never invokes them under
   `composed_tools`, that is precisely the class of problem he can see internally and
   we cannot. Hand him: the channel name, the `agent_id`, the exact time window, and
   the observation "ListTools succeeds, CallTool never fires."

---

## Session log

### 2026-09-05 — Phases 0 and 1 COMPLETE

`./start.sh` ran clean (it auto-launched Docker, rebuilt, health-checked, started a
fresh tunnel, rewrote both .env files, restarted backend, and self-verified).

Gates verified independently afterwards, not taken on start.sh's word:

| Gate | Result |
|---|---|
| Fresh ngrok URL inside backend container | `https://6105-2409-40f4-204e-c520-1572-ab50-183e-8dc8.ngrok-free.app` — confirmed NOT the old dead `f589…` URL |
| `GET <url>/mcp` through public tunnel | `406` — correct (FastMCP rejects plain GET) |
| `POST <url>/mcp` MCP `initialize` handshake through public tunnel | **`200`** — the actual protocol handshake completes from the public internet |
| Tool discovery **through the public tunnel** | **14 tools, `page_oncall_engineer` present** |
| `PAGERDUTY_ROUTING_KEY` inside mock-services container | present |

The tunnel probe went further than the plan asked for: rather than only checking the
tunnel was up, it ran a real MCP `initialize` and a real `list_tools` **against the
public URL** — the exact path Agora's servers take. This also empirically disproves
Obstacle 2 (ngrok browser-warning interstitial) for this session: the handshake was
not intercepted.

**Remaining risk unchanged:** this URL dies whenever ngrok restarts (Obstacle 1).
If resuming later, re-run `./start.sh` and re-check this table before anything else.

**Next:** Phase 2 (agent-think escalation). Not yet started — it spends billed Agora
quota and can fire a real page to Bala's phone, so it needs an explicit go-ahead.

## What "done" looks like

- [x] Phase 0 gates pass
- [x] Phase 1: fresh ngrok URL verified *inside* the backend container
- [ ] Phase 2: agent-think escalation run, step-by-step, tool never named
- [ ] Phase 3: browser run driven in Chrome with screenshots as evidence
- [ ] Phase 3 step 9: Bala's live spoken-voice confirmation
- [ ] Phase 4: all four verification signals collected and cross-checked
- [ ] Phase 5: PagerDuty resolved to 0/0, agent stopped, test incidents purged
- [ ] Phase 6: outcome (A), (B) or (C) written into RESEARCH.md + TODO.md
- [ ] Committed and pushed
