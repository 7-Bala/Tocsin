"""
Tocsin Conflict Detector
Detects conflicts between structured claims about the same entity.

Primary mechanism: structured claim comparison (entity + normalized value).
Heuristics used only as secondary check, clearly labeled.

The detector never auto-resolves conflicts. It only detects and recommends
a verification step for the Incident Commander to assess.
"""

import logging
import re
from typing import Any

from app.engine.extraction import normalize_value

logger = logging.getLogger("tocsin.conflict_detector")


def _entities_match(ent_a: str, ent_b: str) -> bool:
    """Return True if two entity strings refer to the same component/concept."""
    a = ent_a.lower().strip()
    b = ent_b.lower().strip()
    if not a or not b:
        return False
    if a == b:
        return True
    if a in b or b in a:
        return True
    return False


NUMERIC_DIVERGENCE_THRESHOLD = 0.2


def _values_conflict(val_a: str, val_b: str) -> bool:
    """
    Return True if two claim values for the same entity are semantically opposing.

    Deliberately CONSERVATIVE: two statements about the same entity are usually
    complementary, not contradictory. During a live incident, several people describe
    the same component from different angles ("login api returning 503" and
    "login api at 40% error rate" are the same investigation, not a disagreement).

    A conflict is raised ONLY on positive evidence of contradiction:
      1. Opposing health polarity (healthy vs unhealthy), or
      2. Numeric divergence beyond NUMERIC_DIVERGENCE_THRESHOLD on comparable numbers.

    Anything else returns False. Raising a conflict is an interrupt aimed at the
    Incident Commander; a detector that cries wolf destroys trust in the whole
    evidence record, which is precisely what Tocsin exists to protect.
    """
    # Measurement comparison runs FIRST, before normalization. A number is more
    # specific evidence than the fuzzy healthy/unhealthy bucket, and normalization
    # would destroy it: "40% error rate" and "5% error rate" both collapse to
    # "unhealthy" (both contain "error"), so any polarity-first ordering would call
    # them equal and silently miss a real quantitative disagreement.
    a_num = _extract_measurement(val_a)
    b_num = _extract_measurement(val_b)
    if a_num is not None and b_num is not None:
        max_val = max(abs(a_num), abs(b_num))
        if max_val == 0:
            return False
        return abs(a_num - b_num) / max_val > NUMERIC_DIVERGENCE_THRESHOLD

    norm_a = normalize_value(val_a)
    norm_b = normalize_value(val_b)

    # Same normalized value → no conflict
    if norm_a == norm_b:
        return False

    a_healthy = norm_a == "healthy"
    b_healthy = norm_b == "healthy"
    a_unhealthy = norm_a == "unhealthy"
    b_unhealthy = norm_b == "unhealthy"

    # Opposing polarity groups → genuine contradiction
    if (a_healthy and b_unhealthy) or (a_unhealthy and b_healthy):
        return True

    # No positive evidence of contradiction → treat as complementary evidence.
    # (Previously this fell through to "different strings ⇒ conflict", which made
    # every additional detail about an entity look like a disagreement.)
    return False


# A number is treated as a MEASUREMENT only when it stands alone as a quantity —
# optionally followed by a unit. Digits welded into an identifier ("us-east-1", "s3",
# "http/2", "v2") are names, not measurements, and comparing them produces nonsense
# conflicts like "us-east-1 contradicts eu-west-2".
_MEASUREMENT_RE = re.compile(
    r"(?<![\w./-])(\d+(?:\.\d+)?)\s*(%|percent|ms|s\b|sec|secs|seconds|min|mins|minutes|"
    r"rps|qps|gb|mb|kb|connections?|requests?|errors?|users?|nodes?|pods?|replicas?)?"
    r"(?![\w.-]*[a-z])",
    re.IGNORECASE,
)


def _extract_measurement(val: str) -> float | None:
    """
    Extract a comparable measurement from a claim value, or None if the string holds
    no standalone quantity. Returning None means "not numerically comparable" — the
    caller then falls back to polarity comparison rather than inventing a comparison.
    """
    m = _MEASUREMENT_RE.search(val)
    if m:
        try:
            return float(m.group(1))
        except ValueError:
            return None
    return None


def _recommended_action(entity: str, val_a: str, val_b: str, source_a: str, source_b: str) -> str:
    """Generate a specific verification recommendation for a detected conflict."""
    return (
        f"CONFLICT DETECTED on entity '{entity}': "
        f"{source_a} reports '{val_a}' but {source_b} reports '{val_b}'. "
        f"Recommend: Check authoritative monitoring source (dashboard/telemetry) "
        f"to determine ground truth before taking action on this entity."
    )


def detect_conflicts(
    new_entity: str,
    new_value: str,
    new_claim_id: str,
    new_source: str,
    new_speaker: str | None,
    existing_claims: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """
    Compare a new claim against existing claims for the same entity.
    Returns a list of conflict dicts (empty if no conflicts detected).

    This is the primary conflict detection mechanism — structural claim comparison.
    Results are deterministic and traceable.
    """
    conflicts = []

    for existing in existing_claims:
        existing_id = existing.get("id", "")
        existing_entity = existing.get("entity", "")
        existing_value = existing.get("value", "")
        existing_source = existing.get("source", "unknown")
        existing_speaker = existing.get("speaker")

        # Skip if same claim or same source
        if existing_id == new_claim_id:
            continue
        if existing_source == new_source and existing_speaker == new_speaker:
            continue

        if _entities_match(existing_entity, new_entity) and _values_conflict(existing_value, new_value):
            logger.info(
                f"Conflict detected on entity '{new_entity}' / '{existing_entity}': "
                f"'{existing_value}' (from {existing_source}) vs "
                f"'{new_value}' (from {new_source})"
            )
            conflicts.append({
                "entity": new_entity,
                "claim_a_id": existing_id,
                "claim_b_id": new_claim_id,
                "value_a": existing_value,
                "value_b": new_value,
                "source_a": existing_source,
                "source_b": new_source,
                "speaker_a": existing_speaker,
                "speaker_b": new_speaker,
                "recommended_action": _recommended_action(
                    new_entity, existing_value, new_value, existing_source, new_source
                ),
            })

    return conflicts
