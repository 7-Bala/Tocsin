"""
Tocsin Structured Claim Extraction
Extracts structured intelligence (claims, action items, risks, missing info)
from raw transcript utterances.

Extraction tiers (user-directed order, 2026-09-01):
  1. PRIMARY: Gemini API (google.genai SDK) with JSON schema enforcement.
  2. SECONDARY: Groq (OpenAI-compatible API, JSON schema structured outputs) — tried
     when Gemini is unavailable or fails, including quota exhaustion (Gemini's free
     tier is only 20 requests/day, observed exhausted live 2026-08-31, versus Groq's
     ~1000/day free tier). Explicitly a fallback for when Gemini's limit runs out,
     not a replacement for Gemini.
  3. FALLBACK (labeled): Keyword heuristic patterns — only when neither LLM is available
     or both return invalid JSON.
     - All fallback results tagged extraction_method: "heuristic_fallback"
     - Fallback claims always have status: UNVERIFIED; never promoted to CONFIRMED automatically

This module never auto-resolves conflicts. It only detects and flags them.
"""

import asyncio
import json
import logging
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

logger = logging.getLogger("tocsin.extraction")

# Hard ceiling on a single Gemini extraction call. Chosen to sit comfortably above
# normal latency (observed: low single-digit seconds) while still keeping a typed
# chat message's round trip well under what a human will wait for a reply. Overridable
# for environments with slower baseline network characteristics.
EXTRACTION_TIMEOUT_SECONDS = float(os.getenv("GEMINI_EXTRACTION_TIMEOUT_SECONDS", "12"))
GROQ_EXTRACTION_TIMEOUT_SECONDS = float(os.getenv("GROQ_EXTRACTION_TIMEOUT_SECONDS", "12"))

# ─── ClaimSet schema ─────────────────────────────────────────────────────────

EXTRACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "category": {
            "type": "string",
            "enum": [
                "FACT", "REPORT", "ASSUMPTION", "HYPOTHESIS", "DECISION",
                "ACTION_ITEM", "CONFLICT", "MISSING_INFO", "RISK", "UNCLASSIFIED"
            ],
            "description": "Primary category of this utterance"
        },
        "content": {
            "type": "string",
            "description": "Cleaned summary of the utterance, 10-80 words"
        },
        "confidence": {
            "type": "number",
            "minimum": 0.0,
            "maximum": 1.0,
            "description": "Confidence in the category classification"
        },
        "evidence_status": {
            "type": "string",
            "enum": ["CONFIRMED", "REPORTED", "ASSUMED", "UNVERIFIED"],
            "description": "Evidence strength"
        },
        "claims": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "claim_type": {
                        "type": "string",
                        "enum": [
                            "system_health", "error_rate", "resource_status",
                            "user_impact", "metric_value", "timeline_event",
                            "causal_attribution", "mitigation_action", "decision",
                            "escalation", "status", "other"
                        ]
                    },
                    "entity": {"type": "string", "description": "The specific component or entity being described (e.g. 'identity service', 'authentication database', 'water supply')"},
                    "value": {"type": "string", "description": "The claimed state or value (e.g. 'healthy', 'failing', 'down')"},
                    "confidence": {"type": "number", "minimum": 0.0, "maximum": 1.0}
                },
                "required": ["claim_type", "entity", "value", "confidence"]
            }
        },
        "action_items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "description": {"type": "string"},
                    "owner_name": {"type": "string"},
                    "due_minutes": {"type": "number"}
                },
                "required": ["description"]
            }
        },
        "missing_info": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Gaps in information that should be investigated"
        },
        "risks": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Forward-looking risks requiring attention"
        },
        "decisions": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Explicit decisions made"
        }
    },
    "required": ["category", "content", "confidence", "evidence_status", "claims"]
}


@dataclass
class RawClaimData:
    claim_type: str
    entity: str
    value: str
    confidence: float


@dataclass
class RawActionItemData:
    description: str
    owner_name: str | None = None
    due_minutes: float | None = None


@dataclass
class ClaimSet:
    """Structured extraction result from one utterance."""
    category: str
    content: str
    confidence: float
    evidence_status: str
    extraction_method: str
    claims: list[RawClaimData] = field(default_factory=list)
    action_items: list[RawActionItemData] = field(default_factory=list)
    missing_info: list[str] = field(default_factory=list)
    risks: list[str] = field(default_factory=list)
    decisions: list[str] = field(default_factory=list)


# ─── Gemini Extraction (Primary) ─────────────────────────────────────────────

EXTRACTION_SYSTEM_PROMPT = """You are an incident intelligence analyst embedded in a live incident command room.
Your role is to parse a single voice utterance from an incident participant and extract structured intelligence.

Rules:
- Extract claims only from what is EXPLICITLY STATED — do not infer or speculate beyond the utterance.
- Isolate the ENTITY cleanly (e.g., 'identity service', 'authentication database', 'sector 4 culvert') without conversational filler.
- If the speaker provides a value or status, it is REPORTED (not CONFIRMED) unless they cite an authoritative monitoring source.
- If the speaker says "I think", "probably", "maybe", "might be" — mark as ASSUMED.
- If the speaker says "we confirmed" or "verified" or "the monitoring system shows" — mark as CONFIRMED.
- Action items must have an explicit owner name if mentioned.
- Output ONLY valid JSON matching the provided schema — no markdown, no extra text."""


async def extract_with_gemini(
    utterance: str,
    speaker: str | None,
    incident_context: str = "",
) -> ClaimSet | None:
    """
    Primary extraction using modern google.genai SDK with JSON schema enforcement.
    Returns None if Gemini is unavailable or returns invalid JSON.
    """
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key:
        logger.debug("GEMINI_API_KEY not configured; skipping LLM extraction.")
        return None

    try:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=api_key)

        speaker_str = f"Speaker: {speaker}\n" if speaker else ""
        context_str = f"Incident context: {incident_context}\n" if incident_context else ""
        prompt = f"{EXTRACTION_SYSTEM_PROMPT}\n\n{context_str}{speaker_str}Utterance: \"{utterance}\""

        config = types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=EXTRACTION_SCHEMA,
            temperature=0.1,
        )

        # Model is configurable: Google retires model IDs on their own schedule, and a
        # retired ID returns 404, which this module correctly but *silently* degrades
        # into the labeled heuristic fallback. Observed 2026-08-31: gemini-2.5-flash
        # returned "no longer available to new users … use models/gemini-3.6-flash".
        # gemini-3.6-flash was then live-verified working, then later the same day hit
        # 429 RESOURCE_EXHAUSTED (per-model quota, not a global outage). Re-verified
        # live against gemini-3.7-flash (released 2026-08-13) — 200 OK — and switched
        # the default to it. Keeping this in an env var means a future retirement or
        # quota exhaustion is a config change, not a code change — but check the logs
        # for repeated fallback, because a dead/exhausted model looks exactly like a
        # working product with weak extraction.
        model_name = os.getenv("GEMINI_EXTRACTION_MODEL", "gemini-3.7-flash").strip()

        # Hard timeout around the whole call. Live-observed 2026-08-31: a single
        # generate_content call took 173 seconds to complete with no error — the SDK
        # has no default timeout, so a slow/degraded API backend or network condition
        # hangs the entire HTTP request (and therefore the whole chat-reply feature)
        # indefinitely instead of failing over to the heuristic fallback. A user typing
        # a message and waiting three minutes for zero feedback is exactly the
        # "fail proof" failure this project cannot ship with.
        response = await asyncio.wait_for(
            client.aio.models.generate_content(
                model=model_name,
                contents=prompt,
                config=config,
            ),
            timeout=EXTRACTION_TIMEOUT_SECONDS,
        )

        raw_json = response.text.strip()
        data = json.loads(raw_json)
        return _parse_claim_set(data, method="llm")

    except ImportError:
        logger.warning("google-genai not installed; falling back to heuristics.")
        return None
    except json.JSONDecodeError as e:
        logger.warning(f"Gemini returned invalid JSON: {e}. Falling back to heuristics.")
        return None
    except asyncio.TimeoutError:
        logger.warning(
            f"Gemini extraction exceeded {EXTRACTION_TIMEOUT_SECONDS}s timeout "
            "(GEMINI_EXTRACTION_TIMEOUT_SECONDS) — falling back to heuristics. "
            "Repeated timeouts indicate a degraded API backend or network path, "
            "not a code bug; check upstream status before assuming the model changed."
        )
        return None
    except Exception as e:
        _note_gemini_quota_exhausted(e)
        logger.warning(f"Gemini extraction failed: {type(e).__name__}: {e}. Falling back to heuristics.")
        return None


# ─── Gemini quota circuit breaker ────────────────────────────────────────────
#
# Gemini's free tier is 20 requests/day/model and its 429 response carries a
# retryDelay saying when the window reopens. Without this, every observation
# during an exhausted window still pays a full doomed round-trip to Gemini
# before failing over to Groq -- adding ~1-2s of latency to each utterance,
# which is visible on screen as every panel lagging behind the conversation.
# This is a latency optimization only: the fallback chain and the extraction
# labels are unchanged, and the breaker opens for at most _GEMINI_MAX_COOLDOWN.
_gemini_quota_blocked_until: float = 0.0
_GEMINI_MAX_COOLDOWN_SECONDS = 3600.0
_GEMINI_DEFAULT_COOLDOWN_SECONDS = 60.0


def _gemini_quota_cooldown_active() -> bool:
    """True while Gemini's quota window is known to still be exhausted."""
    return time.monotonic() < _gemini_quota_blocked_until


def _note_gemini_quota_exhausted(error: Exception) -> None:
    """
    Record a 429 RESOURCE_EXHAUSTED so the next utterances skip Gemini.

    Prefers the server's own `retryDelay` when present; falls back to a
    conservative default when the message cannot be parsed. Never trusts the
    value beyond an hour -- a malformed or absurd delay must not disable Gemini
    for the rest of the process's life.
    """
    global _gemini_quota_blocked_until

    text = str(error)
    if "RESOURCE_EXHAUSTED" not in text and "429" not in text:
        return

    seconds = _GEMINI_DEFAULT_COOLDOWN_SECONDS
    match = re.search(r"'retryDelay':\s*'(\d+(?:\.\d+)?)s'", text)
    if match:
        try:
            seconds = float(match.group(1))
        except ValueError:
            pass

    seconds = max(0.0, min(seconds, _GEMINI_MAX_COOLDOWN_SECONDS))
    _gemini_quota_blocked_until = time.monotonic() + seconds
    logger.warning(
        f"Gemini quota exhausted; skipping Gemini for {seconds:.0f}s and using Groq. "
        "Extraction stays LLM-backed -- this is not a downgrade to heuristics."
    )


async def extract_with_groq(
    utterance: str,
    speaker: str | None,
    incident_context: str = "",
) -> ClaimSet | None:
    """
    Groq extraction via its OpenAI-compatible chat completions API, using
    structured-output JSON schema enforcement (response_format: json_schema).
    Returns None if Groq is unavailable or returns invalid JSON, so the caller
    can fall through to Gemini and then the heuristic extractor.

    Schema request shape confirmed against console.groq.com/docs/structured-outputs
    (2026-09-01) -- best-effort mode (strict: false) reuses the exact same
    EXTRACTION_SCHEMA Gemini uses, avoiding a second schema to keep in sync.
    Default model is openai/gpt-oss-120b, one of the models Groq's docs confirm
    support structured outputs; llama-3.3-70b-versatile (Groq's most commonly
    referenced model) is NOT in that supported list, so it is deliberately not
    the default here despite being well-known.
    """
    api_key = os.getenv("GROQ_API_KEY", "").strip()
    if not api_key:
        logger.debug("GROQ_API_KEY not configured; skipping Groq extraction.")
        return None

    model_name = os.getenv("GROQ_EXTRACTION_MODEL", "openai/gpt-oss-120b").strip()
    speaker_str = f"Speaker: {speaker}\n" if speaker else ""
    context_str = f"Incident context: {incident_context}\n" if incident_context else ""
    prompt = f"{EXTRACTION_SYSTEM_PROMPT}\n\n{context_str}{speaker_str}Utterance: \"{utterance}\""

    payload = {
        "model": model_name,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.1,
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "claim_extraction",
                "strict": False,
                "schema": EXTRACTION_SCHEMA,
            },
        },
    }

    try:
        async with httpx.AsyncClient(timeout=GROQ_EXTRACTION_TIMEOUT_SECONDS) as client:
            response = await client.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json=payload,
            )
        if response.status_code != 200:
            logger.warning(
                f"Groq extraction HTTP {response.status_code}: {response.text[:300]}. "
                "Falling back to Gemini/heuristics."
            )
            return None

        raw_json = response.json()["choices"][0]["message"]["content"].strip()
        data = json.loads(raw_json)
        return _parse_claim_set(data, method="llm")

    except httpx.TimeoutException:
        logger.warning(
            f"Groq extraction exceeded {GROQ_EXTRACTION_TIMEOUT_SECONDS}s timeout "
            "(GROQ_EXTRACTION_TIMEOUT_SECONDS) — falling back to Gemini/heuristics."
        )
        return None
    except (json.JSONDecodeError, KeyError, IndexError) as e:
        logger.warning(f"Groq returned unparseable response: {e}. Falling back to Gemini/heuristics.")
        return None
    except Exception as e:
        logger.warning(f"Groq extraction failed: {type(e).__name__}: {e}. Falling back to Gemini/heuristics.")
        return None


def _parse_claim_set(data: dict[str, Any], method: str) -> ClaimSet:
    """Parse the raw JSON dict into a ClaimSet."""
    claims = [
        RawClaimData(
            claim_type=c.get("claim_type", "other"),
            entity=_clean_entity(c.get("entity", "unknown")),
            value=c.get("value", "unknown"),
            confidence=float(c.get("confidence", 0.5)),
        )
        for c in data.get("claims", [])
    ]
    action_items = [
        RawActionItemData(
            description=ai.get("description", ""),
            owner_name=ai.get("owner_name"),
            due_minutes=ai.get("due_minutes"),
        )
        for ai in data.get("action_items", [])
        if ai.get("description")
    ]
    return ClaimSet(
        category=data.get("category", "UNCLASSIFIED"),
        content=data.get("content", "")[:500],
        confidence=float(data.get("confidence", 0.5)),
        evidence_status=data.get("evidence_status", "UNVERIFIED"),
        extraction_method=method,
        claims=claims,
        action_items=action_items,
        missing_info=data.get("missing_info", []),
        risks=data.get("risks", []),
        decisions=data.get("decisions", []),
    )


# ─── Heuristic Extractor (Fallback) ─────────────────────────────────────────

HEALTHY_VALUES = frozenset({
    "healthy", "up", "operational", "running", "ok", "working", "stable", "normal",
    "resolved", "fixed", "online", "available", "green",
})
UNHEALTHY_VALUES = frozenset({
    "down", "failing", "failed", "error", "errors", "unavailable", "offline",
    "broken", "degraded", "unresponsive", "critical", "red", "dead", "crashed",
    # The heuristic health patterns now record the state word the speaker used
    # rather than a fixed constant, so every keyword they can match must have a
    # polarity here. Without these, "the order service pods are crash-looping"
    # normalizes to itself, contradicts nothing, and reads as neither healthy
    # nor unhealthy anywhere downstream.
    # "looping" is listed alongside the hyphenated forms because matching is
    # whole-word: "crash-looping" tokenizes to crash/looping, so the compound
    # spellings alone would never match.
    "crashing", "crash-looping", "crashlooping", "looping", "unreachable",
    "timeout", "timeouts", "oom", "restarting",
    # Live-caught 2026-09-05 through Deepgram: real speech doesn't come out
    # hyphenated ("crash-looping" was typed test fixture text; a person says
    # "crash looping"), and ASR transcribes some words the health pattern
    # never anticipated ("killed", "dying") at all. Zero claims were extracted
    # from "the Aura service parts are crash looping" and "getting OOM killed"
    # -- both real, unremarkable spoken sentences -- leaving the incident
    # titled "Untitled Incident — Awaiting Reports" despite five real
    # observations on the record.
    "killed", "dying",
    # Saturation / exhaustion. Added 2026-09-05: these are the most common way an
    # engineer describes a struggling dependency, and their absence is why
    # CLAUDE.md's own canonical contradiction ("the authentication database is
    # overloaded" vs "database CPU and connection usage look normal and healthy")
    # produced zero conflicts -- "overloaded" simply wasn't recognised as a health
    # term at all, so there was no polarity to oppose. "exhausted" was likewise
    # missing despite the seeded demo scenario using it verbatim.
    "overloaded", "overload", "exhausted", "exhaustion", "saturated", "saturation",
    "maxed", "throttled", "starved", "thrashing", "timeout", "timeouts",
    "timing", "unstable", "flapping", "stalled", "stuck", "backlogged",
})


# Words that flip the polarity of a health term. "no errors" is healthy;
# "not running" is unhealthy. Ignoring these inverted the classification of some
# of the most ordinary things an engineer says in an incident call.
_NEGATORS = frozenset({"no", "not", "never", "without", "zero", "free", "cleared"})

_WORD_RE = re.compile(r"[a-z0-9]+")


def normalize_value(value: str) -> str:
    """
    Map raw claim values to canonical equivalents for comparison.

    Matches on WHOLE WORDS and honors negation. Both matter, and both were
    live-observed broken on 2026-09-05 while fixing conflict detection:

      'corrupted'   -> 'healthy'   (naive substring found "up" inside it)
      'unsupported' -> 'healthy'   (same)
      'not running' -> 'healthy'   (negation ignored)
      'no errors'   -> 'unhealthy' (negation ignored)

    Every one of those feeds the conflict detector, so a service reported as
    "not running" was being recorded as healthy -- capable of both hiding a real
    contradiction and manufacturing a false one.
    """
    v = value.lower().strip()
    words = _WORD_RE.findall(v)
    if not words:
        return v

    word_set = set(words)
    has_healthy = bool(word_set & HEALTHY_VALUES)
    has_unhealthy = bool(word_set & UNHEALTHY_VALUES)

    if not has_healthy and not has_unhealthy:
        return v

    # A negator anywhere in a short claim value flips the reading. Claim values
    # here are fragments ("normal and healthy", "no errors"), not prose, so a
    # value-wide check is appropriate and keeps this explainable.
    negated = bool(word_set & _NEGATORS)

    if has_healthy and has_unhealthy:
        # Mixed signal ("degraded but running") -- not a clean polarity, so don't
        # claim one. Returning the raw value means the detector sees "not equal"
        # rather than a false contradiction.
        return v

    if has_healthy:
        return "unhealthy" if negated else "healthy"
    return "healthy" if negated else "unhealthy"


def _clean_entity(raw: str) -> str:
    """Strip conversational boilerplate to isolate clean entity noun phrase."""
    ent = raw.lower().strip()
    prefixes = [
        r"^.*?\breports?\s+(?:that\s+)?(?:the\s+)?",
        r"^.*?\bsays?\s+(?:that\s+)?(?:the\s+)?",
        r"^.*?\bnoticed?\s+(?:that\s+)?(?:the\s+)?",
        r"^.*?\bconfirms?\s+(?:that\s+)?(?:the\s+)?",
        r"^(?:the|a|an)\s+",
    ]
    for p in prefixes:
        ent = re.sub(p, "", ent).strip()
    return ent if ent else raw.strip()


# Operational nouns. An entity with none of these is almost certainly a fragment
# of ordinary conversation that a loose regex happened to capture, not a system
# anyone is reporting on. The 2026-09-05 run filed `t hold`, `s wrap`,
# `standing`, `ending` and `nothing is staying` as system-health claims, and the
# whiteboard rendered every one of them as a node labelled "healthy".
#
# Deliberately small and scenario-shaped rather than general. It does not need to
# generalise -- it needs to be honest about what this fallback can actually
# recognise, and everything it emits is already labelled `heuristic_fallback` /
# UNVERIFIED. Rejecting a claim never discards the observation: the raw utterance
# and its provenance are still recorded, which is the part that matters.
_ENTITY_NOUNS = frozenset({
    "api", "apis", "service", "services", "system", "systems", "server", "servers",
    "endpoint", "endpoints", "component", "components", "subsystem",
    "temperature", "pressure", "level", "levels", "rate", "rates", "usage", "load",
    "database", "databases", "db", "cache", "queue", "broker", "cluster", "node", "nodes",
    "pod", "pods", "container", "containers", "instance", "instances", "replica", "replicas",
    "gateway", "proxy", "loadbalancer", "balancer", "cdn", "dns", "network",
    "login", "auth", "authentication", "authorization", "identity", "session", "sessions",
    "token", "tokens", "account", "accounts", "user", "users", "customer", "customers",
    "order", "orders", "checkout", "cart", "inventory", "billing", "subscription",
    "cpu", "memory", "ram", "heap", "disk", "storage", "volume", "bandwidth",
    "deployment", "deploy", "release", "rollout", "build", "image", "version", "dependency",
    "traffic", "request", "requests", "volume", "latency", "throughput", "error", "errors",
    "job", "jobs", "worker", "workers", "task", "tasks", "pipeline", "index", "bucket",
    "dashboard", "monitor", "alert", "log", "logs", "metric", "metrics", "region", "zone",
    "connection", "connections", "pool", "thread", "threads", "process", "processes",
    # Physical/emergency infrastructure. Tocsin's other scenario family is
    # disaster coordination, not just software incidents -- a tech-only lexicon
    # silently stopped extracting from "the main water pump is down", which is
    # exactly the sort of sentence this fallback exists to handle.
    "pump", "pumps", "generator", "generators", "valve", "valves", "sensor", "sensors",
    "dam", "levee", "bridge", "road", "roads", "tunnel", "shelter", "shelters",
    "hospital", "hospitals", "clinic", "boat", "boats", "vehicle", "vehicles", "truck",
    "radio", "power", "grid", "water", "gas", "fuel", "line", "lines", "main", "mains",
    "tower", "antenna", "camera", "cameras", "gate", "alarm", "siren", "supply",
})


# Tokens that mark where a subject ends and a predicate begins. The health
# regexes make their connective words optional, so a lazy capture still absorbs
# them -- "The login API is returning HTTP 503 errors" yielded the entity
# `login api is returning http`. Cutting the phrase at the first of these
# recovers the noun phrase without needing a parser.
_ENTITY_STOP_TOKENS = frozenset({
    "is", "are", "was", "were", "be", "been", "being", "has", "have", "had",
    "looks", "look", "looking", "seems", "seem", "appears", "appear",
    "returning", "return", "returns", "returned", "showing", "shows", "showed",
    "getting", "get", "gets", "got", "going", "goes", "went", "will", "would",
    "keeps", "keep", "staying", "stay", "started", "start", "starts",
    "and", "but", "so", "that", "this", "it", "they", "we", "i", "he", "she",
    # Articles matter mid-phrase, not just at the head: "I suspect THE
    # authentication database" would otherwise yield 'the authentication
    # database', which no longer string-matches the 'authentication database'
    # recorded from another speaker -- and the contradiction is lost.
    "the", "a", "an", "our", "their", "its",
    "to", "of", "for", "in", "on", "at", "with", "from", "still", "now", "just",
    "compare", "check", "verify", "run", "pull", "restart", "rollback", "roll",
    "deploy", "monitor", "investigate", "analyze", "analyse", "confirm",
    # Reporting verbs. "We verified that the cooling system temperature..."
    # otherwise trims to the entity `verified`, which then fails the noun gate
    # and silently drops a perfectly good metric claim.
    "verified", "confirmed", "reported", "said", "says", "noticed", "observed",
    "stated", "mentioned", "told", "seeing", "see", "saw", "found",
})


def _trim_entity_phrase(entity: str) -> str:
    """
    Reduce a captured span to the noun phrase that names the subject.

    The span is split on stop tokens into candidate segments, and the FIRST
    segment that names something operational wins.

    Each alternative is wrong somewhere. Taking the first segment unconditionally
    reports the messenger: "Platform team confirmed that the order service pods
    are crash-looping" splits to ["platform team", "order service pods"], and the
    claim is about the pods. Taking the last unconditionally trails off into the
    predicate ("the login API is returning HTTP 503" ends in ["http"]) and, worse,
    picks the second subject of a coordination -- "Database CPU and connection
    usage look normal" would be filed under `connection usage`, which no longer
    matches `authentication database` and so silently breaks CLAUDE.md's own
    canonical contradiction. First-plausible skips non-operational lead-ins while
    still preferring the head of the phrase.
    """
    tokens = [t for t in re.split(r"\s+", entity.lower().strip()) if t]
    segments: list[list[str]] = [[]]
    for token in tokens:
        if token in _ENTITY_STOP_TOKENS:
            if segments[-1]:
                segments.append([])
        else:
            segments[-1].append(token)

    # Operational entities are one to three words ("login api", "database cpu").
    candidates = [" ".join(seg[-3:]) for seg in segments if seg]
    if not candidates:
        return ""
    for candidate in candidates:
        if _is_plausible_entity(candidate):
            return candidate
    return candidates[-1]


def _is_plausible_entity(entity: str) -> bool:
    """
    True when the phrase names something operational rather than being a scrap of
    conversation. Requires at least one recognised operational noun, or a
    hyphen/underscore compound (`identity-service`, `order_worker`) which is
    almost always a real system name.
    """
    if not entity or len(entity) < 3:
        return False
    tokens = [t for t in re.split(r"[^a-z0-9]+", entity.lower()) if t]
    if not tokens:
        return False
    if any(t in _ENTITY_NOUNS for t in tokens):
        return True
    # service-name shapes the lexicon cannot enumerate, e.g. "identity-service"
    return bool(re.search(r"[a-z0-9]+[-_][a-z0-9]+", entity.lower()))


class HeuristicExtractor:
    """
    Keyword-pattern based fallback extractor.
    ALL outputs are tagged extraction_method='heuristic_fallback'.
    Heuristic claims are NEVER promoted to CONFIRMED automatically.
    """

    # Each pattern captures the ENTITY in group 1 and the STATE WORD in group 2.
    # Group 2 exists because `value` used to be a fixed per-pattern constant: any
    # match of the "healthy" pattern recorded the literal string "healthy"
    # regardless of what was actually said, so "standing down" was filed as
    # entity `standing` / value `down`, and that claim became the incident title
    # "Ending — Down" on 2026-09-05. The value must be what the speaker said.
    #
    # The entity class now includes the apostrophe. Excluding it meant the regex
    # could not span a contraction, so "That doesn't hold up" matched from the
    # `t` after the apostrophe and yielded entity `t hold`, value `healthy`.
    # Keeping the word intact lets `_is_plausible_entity` reject it properly.
    HEALTH_PATTERNS = [
        (r"(?:(?:reports|says|confirms|verified|stated|that|the)\s+)?([a-z0-9'\s_-]+?)\s+(?:is\s+|are\s+|getting\s+)?(down|failing|failed|unreachable|offline|unavailable|broken|crashed|crashing|crash-looping|crash looping|crashlooping|killed|dying|dead|overloaded|saturated|exhausted|throttled|maxed out|at capacity)", "system_health", "REPORT"),
        (r"(?:(?:reports|says|confirms|verified|stated|that|the)\s+)?([a-z0-9'\s_-]+?)\s+(?:is\s+|are\s+)?(up|running|healthy|operational|stable|working|online|normal)", "system_health", "REPORT"),
        (r"(?:(?:reports|says|confirms|verified|stated|that|the)\s+)?([a-z0-9'\s_-]+?)\s+(?:is\s+|are\s+)?(?:returning\s+)?(\d+xx|\d{3}\s+errors?|errors?|timeouts?)", "error_rate", "REPORT"),
        (r"(?:(?:reports|says|confirms|verified|stated|that|the)\s+)?([a-z0-9'\s_-]+?)\s+(?:exceeded|reached|is at|dropped to|rose to)\s+([\d\w\s%]+)", "metric_value", "REPORT"),
    ]
    # Every trigger is word-bounded. Without \b, `i'?ll` matched the "ill" inside
    # "still", so "is that still a theory? what if it is not" was recorded as an
    # action item reading "a theory? what if it is not" — six such rows appeared
    # in the 2026-09-05 run.
    ACTION_PATTERNS = [
        r"(?:\bi\'?ll\b|\bi will\b|\bi\'m going to\b|\bgoing to\b|\blet me\b|\bsomeone needs to\b|\bwe need to\b|\bneed to\b)\s+(.+?)(?:\.|$)",
        r"\b(\w+)\s+(?:will|is going to|should)\s+(.+?)(?:\.|$)",
    ]
    MISSING_PATTERNS = [
        r"(?:we don\'t know|unclear|not sure|need to check|unknown|we haven\'t|haven\'t confirmed)\s+(.+?)(?:\.|$)",
    ]
    ASSUMPTION_PATTERNS = [
        r"(?:i think|probably|might be|could be|maybe|possibly|assume|assuming)\s+(.+?)(?:\.|$)",
    ]
    # Speculation attributed to a person, which is a HYPOTHESIS rather than a
    # bare assumption. Until these existed the heuristic could not emit
    # HYPOTHESIS at all, so `hypotheses` was empty in every live run ever
    # recorded and CLAUDE.md's own canonical line -- "I suspect the
    # authentication database is overloaded" -- produced nothing speculative.
    # That is the "distinguishes facts from assumptions" requirement, and this
    # delivers it with no LLM call, which matters on a quota-exhausted day.
    SUSPICION_PATTERNS = [
        r"\bi suspect\b\s+(.+?)(?:\.|$)",
        r"\bmy (?:hunch|gut|theory)\b[^.]*?\bis\b\s+(.+?)(?:\.|$)",
        r"\bit looks like\b\s+(.+?)(?:\.|$)",
        r"\b(?:he|she|they|someone|somebody|one of the engineers|an engineer)\s+(?:thinks|suspects|believes)\b\s+(?:it\'?s\s+)?(.+?)(?:\.|$)",
        r"\b(?:that\'?s|it\'?s)\s+(?:his|her|their|my)\s+(?:gut feeling|hunch|theory)\b",
    ]
    DECISION_PATTERNS = [
        r"(?:we decided|decision is|we are going to|we\'ve agreed|agreed to)\s+(.+?)(?:\.|$)",
    ]

    def extract(self, utterance: str, speaker: str | None = None) -> ClaimSet:
        text = utterance.strip()
        text_lower = text.lower()
        claims: list[RawClaimData] = []
        action_items: list[RawActionItemData] = []
        missing_info: list[str] = []
        risks: list[str] = []
        decisions: list[str] = []

        category = "UNCLASSIFIED"
        evidence_status = "UNVERIFIED"
        confidence = 0.3

        # Health claims
        for item in self.HEALTH_PATTERNS:
            pattern, claim_type, cat = item
            for m in re.finditer(pattern, text_lower):
                raw_ent = m.group(1).strip()
                entity = _trim_entity_phrase(_clean_entity(raw_ent))
                if not _is_plausible_entity(entity):
                    continue
                value = (m.group(2) or "").strip()
                if not value:
                    continue
                # A qualifier immediately before the state word inverts it:
                # "twenty percent below normal" is not a report that traffic is
                # normal. Cheaper and safer than trying to parse the comparison.
                preceding = text_lower[max(0, m.start(2) - 14):m.start(2)]
                if re.search(r"\b(?:below|above|under|over|not|far from|nowhere near)\b\s*$", preceding):
                    continue
                claims.append(RawClaimData(
                    claim_type=claim_type,
                    entity=entity,
                    value=value,
                    confidence=0.4,
                ))
                category = cat
                evidence_status = "REPORTED"
                confidence = 0.4
                break

        # Action items
        for pattern in self.ACTION_PATTERNS:
            m = re.search(pattern, text_lower)
            if m:
                desc = m.group(m.lastindex or 1).strip()
                if desc and len(desc) > 5:
                    action_items.append(RawActionItemData(
                        description=desc,
                        owner_name=speaker,
                    ))
                    if category == "UNCLASSIFIED":
                        category = "ACTION_ITEM"
                    break

        # Missing info
        for pattern in self.MISSING_PATTERNS:
            m = re.search(pattern, text_lower)
            if m:
                missing_info.append(m.group(1).strip())
                if category == "UNCLASSIFIED":
                    category = "MISSING_INFO"
                break

        # Attributed speculation -> HYPOTHESIS. This OVERRIDES an earlier REPORT
        # classification rather than deferring to it: "I suspect the
        # authentication database is overloaded" also matches a health pattern,
        # so leaving REPORT in place would file a hunch as a report -- exactly
        # the fact/assumption collapse the product exists to prevent.
        for pattern in self.SUSPICION_PATTERNS:
            if re.search(pattern, text_lower):
                category = "HYPOTHESIS"
                evidence_status = "ASSUMED"
                confidence = 0.25
                break

        # Assumptions
        if category != "HYPOTHESIS":
            for pattern in self.ASSUMPTION_PATTERNS:
                m = re.search(pattern, text_lower)
                if m:
                    if category == "UNCLASSIFIED":
                        category = "ASSUMPTION"
                    evidence_status = "ASSUMED"
                    confidence = 0.25
                    break

        # Decisions
        for pattern in self.DECISION_PATTERNS:
            m = re.search(pattern, text_lower)
            if m:
                decisions.append(m.group(1).strip())
                if category == "UNCLASSIFIED":
                    category = "DECISION"
                break

        # Risks. The old pattern included a bare `if .+? (?:then|we|could)` arm,
        # which made EVERY conditional sentence a risk -- "if it gets worse then
        # monitor the situation" was recorded as the risk "monitor the
        # situation" on 2026-09-05. That is not cosmetic: each open risk adds +1
        # pressure in derive_severity(), so junk risks silently inflate the
        # incident's severity band. An explicit risk lexeme is now required.
        risk_pat = (
            r"(?:\brisk of\b|\bdanger of\b|\bat risk of\b|\bcould cause\b|"
            r"\bmight cause\b|\bmight break\b|\bwe could lose\b|\bwe risk\b)\s+(.+?)(?:\.|$)"
        )
        m = re.search(risk_pat, text_lower)
        if m:
            risks.append(m.group(1).strip())
            if category == "UNCLASSIFIED":
                category = "RISK"

        if category == "UNCLASSIFIED" and speaker and len(text) > 10:
            category = "REPORT"
            evidence_status = "UNVERIFIED"

        return ClaimSet(
            category=category,
            content=text[:300],
            confidence=confidence,
            evidence_status=evidence_status,
            extraction_method="heuristic_fallback",
            claims=claims,
            action_items=action_items,
            missing_info=missing_info,
            risks=risks,
            decisions=decisions,
        )


# ─── ExtractionService (orchestrator) ────────────────────────────────────────

_heuristic = HeuristicExtractor()


async def extract_intelligence(
    utterance: str,
    speaker: str | None = None,
    incident_context: str = "",
) -> ClaimSet:
    """
    Extract structured intelligence from a transcript utterance.
    Pipeline (user-directed order, 2026-09-01: Gemini stays primary; Groq is the
    fallback for when Gemini's tighter free-tier quota (20 req/day, observed
    exhausted live 2026-08-31) runs out, not a replacement for it):
    1. Try Gemini LLM extraction via modern google.genai SDK -- unless a
       recent 429 already told us its quota window is exhausted, in which
       case this call is skipped for that window (see
       _gemini_quota_cooldown_active) rather than paying a doomed round-trip
       on every single utterance.
    2. If unavailable or fails (including quota exhaustion): try Groq, if
       GROQ_API_KEY is configured.
    3. If both unavailable or fail: use HeuristicExtractor (fallback, clearly labeled).
    """
    if _gemini_quota_cooldown_active():
        # Skip a call that is known to fail. Gemini's 429 tells us exactly how
        # long its quota window has left; retrying inside that window costs a
        # round-trip per utterance and delays every panel on screen behind it.
        logger.debug("Gemini quota cooldown active; going straight to Groq.")
    else:
        result = await extract_with_gemini(utterance, speaker, incident_context)
        if result is not None:
            return result

    result = await extract_with_groq(utterance, speaker, incident_context)
    if result is not None:
        return result

    logger.debug(f"Using heuristic fallback for utterance: {utterance[:60]}...")
    return _heuristic.extract(utterance, speaker)
