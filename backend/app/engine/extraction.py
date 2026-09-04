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
    "down", "failing", "failed", "error", "unavailable", "offline", "broken",
    "degraded", "unresponsive", "critical", "red", "dead", "crashed",
})


def normalize_value(value: str) -> str:
    """Map raw claim values to canonical equivalents for comparison."""
    v = value.lower().strip()
    if any(h in v for h in HEALTHY_VALUES):
        return "healthy"
    if any(u in v for u in UNHEALTHY_VALUES):
        return "unhealthy"
    return v


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


class HeuristicExtractor:
    """
    Keyword-pattern based fallback extractor.
    ALL outputs are tagged extraction_method='heuristic_fallback'.
    Heuristic claims are NEVER promoted to CONFIRMED automatically.
    """

    HEALTH_PATTERNS = [
        (r"(?:(?:reports|says|confirms|verified|stated|that|the)\s+)?([a-z0-9\s_-]+?)\s+(?:is\s+)?(?:down|failing|failed|unreachable|offline|unavailable|broken|crashed)", "system_health", "REPORT", "down"),
        (r"(?:(?:reports|says|confirms|verified|stated|that|the)\s+)?([a-z0-9\s_-]+?)\s+(?:is\s+)?(?:up|running|healthy|operational|stable|working|online)", "system_health", "REPORT", "healthy"),
        (r"(?:(?:reports|says|confirms|verified|stated|that|the)\s+)?([a-z0-9\s_-]+?)\s+(?:is\s+)?(?:returning\s+)?(\d+xx|errors?|timeouts?)", "error_rate", "REPORT", "error"),
        (r"(?:(?:reports|says|confirms|verified|stated|that|the)\s+)?([a-z0-9\s_-]+?)\s+(?:exceeded|reached|is at|dropped to|rose to)\s+([\d\w\s%]+)", "metric_value", "REPORT", "metric_reported"),
    ]
    ACTION_PATTERNS = [
        r"(?:i\'?ll|i will|i\'m going to|going to|will|let me|someone needs to|we need to|need to)\s+(.+?)(?:\.|$)",
        r"(\w+)\s+(?:will|is going to|should)\s+(.+?)(?:\.|$)",
    ]
    MISSING_PATTERNS = [
        r"(?:we don\'t know|unclear|not sure|need to check|unknown|we haven\'t|haven\'t confirmed)\s+(.+?)(?:\.|$)",
    ]
    ASSUMPTION_PATTERNS = [
        r"(?:i think|probably|might be|could be|maybe|possibly|assume|assuming)\s+(.+?)(?:\.|$)",
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
            pattern, claim_type, cat, def_val = item
            for m in re.finditer(pattern, text_lower):
                raw_ent = m.group(1).strip()
                entity = _clean_entity(raw_ent)
                if entity and len(entity) > 2:
                    claims.append(RawClaimData(
                        claim_type=claim_type,
                        entity=entity,
                        value=def_val,
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

        # Assumptions
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

        # Risks
        risk_pat = r"(?:risk of|if .+? (?:then|we|could)|danger of|warning)\s+(.+?)(?:\.|$)"
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
