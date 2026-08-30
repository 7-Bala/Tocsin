"""
Tocsin Conflict Detector
Detects conflicts between structured claims about the same entity.

Primary mechanism: structured claim comparison (entity + normalized value).
Heuristics used only as secondary check, clearly labeled.

The detector never auto-resolves conflicts. It only detects and recommends
a verification step for the Incident Commander to assess.
"""

import logging
from typing import Any

from app.engine.extraction import HEALTHY_VALUES, UNHEALTHY_VALUES, normalize_value

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


def _values_conflict(val_a: str, val_b: str) -> bool:
    """
    Return True if two claim values for the same entity are semantically opposing.
    Uses structured semantic normalization (synonym groups), not regex heuristics.
    """
    norm_a = normalize_value(val_a)
    norm_b = normalize_value(val_b)

    # Same normalized value → no conflict
    if norm_a == norm_b:
        return False

    # Both in same polarity group → no conflict
    if norm_a in HEALTHY_VALUES and norm_b in HEALTHY_VALUES:
        return False
    if norm_a in UNHEALTHY_VALUES and norm_b in UNHEALTHY_VALUES:
        return False

    # Opposing polarity groups → conflict
    if (norm_a in HEALTHY_VALUES and norm_b in UNHEALTHY_VALUES) or \
       (norm_a in UNHEALTHY_VALUES and norm_b in HEALTHY_VALUES):
        return True

    # Numeric comparison for metric values (e.g., "40%" vs "5%")
    a_num = _extract_number(val_a)
    b_num = _extract_number(val_b)
    if a_num is not None and b_num is not None:
        max_val = max(abs(a_num), abs(b_num))
        if max_val > 0 and abs(a_num - b_num) / max_val > 0.2:
            return True

    # Values are clearly different strings → flag as potential conflict
    if norm_a != norm_b and len(norm_a) > 0 and len(norm_b) > 0:
        return True

    return False


def _extract_number(val: str) -> float | None:
    """Extract a numeric value from a claim value string."""
    import re
    m = re.search(r"(\d+(?:\.\d+)?)", val)
    if m:
        return float(m.group(1))
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
