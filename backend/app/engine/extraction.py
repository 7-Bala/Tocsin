"""
Tocsin Structured Claim Extraction
Extracts structured intelligence (claims, action items, risks, missing info)
from raw transcript utterances.

Extraction tiers:
  1. PRIMARY: Gemini API (google.genai SDK) with JSON schema enforcement
  2. FALLBACK (labeled): Keyword heuristic patterns — only when Gemini unavailable or returns invalid JSON
     - All fallback results tagged extraction_method: "heuristic_fallback"
     - Fallback claims always have status: UNVERIFIED; never promoted to CONFIRMED automatically

This module never auto-resolves conflicts. It only detects and flags them.
"""

import json
import logging
import os
import re
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger("tocsin.extraction")

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
                    "entity": {"type": "string", "description": "The specific component or entity being described (e.g. 'payment gateway', 'water supply')"},
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
- Isolate the ENTITY cleanly (e.g., 'payment gateway', 'sector 4 culvert', 'auxiliary pump') without conversational filler.
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

        response = await client.aio.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config=config,
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
    except Exception as e:
        logger.warning(f"Gemini extraction failed: {type(e).__name__}: {e}. Falling back to heuristics.")
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
    Pipeline:
    1. Try Gemini LLM extraction (primary) via modern google.genai SDK.
    2. If unavailable or fails: use HeuristicExtractor (fallback, clearly labeled).
    """
    result = await extract_with_gemini(utterance, speaker, incident_context)
    if result is not None:
        return result

    logger.debug(f"Using heuristic fallback for utterance: {utterance[:60]}...")
    return _heuristic.extract(utterance, speaker)
