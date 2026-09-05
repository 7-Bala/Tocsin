"""
Quality contract for the heuristic fallback extractor.

This path is not a corner case. On 2026-09-05 both LLM providers hit their daily
caps (Gemini free tier is 20 requests/day; Groq 200k tokens/day), so 33 of 34
claims in the live run came from here — and the whiteboard a judge would have
seen was built entirely from its output.

What it produced then: `"That doesn't hold up"` filed as entity `t hold` with
value `healthy`; `"standing down"` as entity `standing`, value `down`, which then
became the incident's own title, **"Ending — Down"**. Six action items were
created from the substring `ill` inside the word "still".

Two fixture sets, and the second one is the real contract:
  - CANONICAL: CLAUDE.md's own scenario lines must still extract.
  - ADVERSARIAL: the exact phrases that produced garbage must now produce none.

The failure mode to guard against while reading these is over-correction. An
extractor that emits nothing is not "safe" — a blank board looks like a product
that does nothing. Hence `test_an_unextractable_sentence_still_records_*`.
"""

import pytest

from app.engine.extraction import HeuristicExtractor


@pytest.fixture
def extractor() -> HeuristicExtractor:
    return HeuristicExtractor()


# ── Canonical: CLAUDE.md's identity-outage scenario ──────────────────────────


@pytest.mark.parametrize(
    "utterance,expected_entity,expected_value",
    [
        ("The login API is returning HTTP 503 errors for around 40% of requests.", "login api", "503 errors"),
        ("Database CPU and connection usage look normal and healthy.", "database cpu", "normal"),
        ("The order service pods are crash-looping and getting OOM killed.", "order service pods", "crash-looping"),
        ("The main water pump is down and failing.", "main water pump", "down"),
    ],
)
def test_canonical_reports_extract_a_sane_entity_and_the_spoken_value(
    extractor, utterance, expected_entity, expected_value
):
    """
    `value` must be what the speaker actually said. It used to be a fixed
    per-pattern constant, so every match of the health pattern recorded the
    literal string "healthy" no matter what was reported.
    """
    result = extractor.extract(utterance, "Dave")
    pairs = [(c.entity, c.value) for c in result.claims]
    assert (expected_entity, expected_value) in pairs, f"got {pairs}"


def test_suspicion_is_classified_as_hypothesis_not_report(extractor):
    """
    CLAUDE.md's own canonical hypothesis line. Until suspicion patterns existed
    the heuristic could not emit HYPOTHESIS at all, so `hypotheses` was empty in
    every live run ever recorded — the product's central "facts vs assumptions"
    claim was silently unfulfilled on any day the LLM quota ran out.
    """
    result = extractor.extract("I suspect the authentication database is overloaded.", "Dave")
    assert result.category == "HYPOTHESIS"
    assert result.evidence_status == "ASSUMED"


def test_attributed_suspicion_is_also_a_hypothesis(extractor):
    """Scenario B's line. Speculation stays speculation even when relayed."""
    result = extractor.extract(
        "One of the engineers thinks it is a traffic spike overwhelming the service.", "Operator"
    )
    assert result.category == "HYPOTHESIS"


def test_hypothesis_wins_over_a_report_classification(extractor):
    """
    "I suspect X is overloaded" matches a health pattern too. If REPORT won, a
    hunch would be filed as a report — precisely the fact/assumption collapse
    this product exists to prevent.
    """
    result = extractor.extract("I suspect the login API is down.", "Dave")
    assert result.category == "HYPOTHESIS", "speculation must not be recorded as a report"


def test_a_real_commitment_still_becomes_an_action_item(extractor):
    result = extractor.extract(
        "I will compare authentication error rates before and after the deployment.", "Priya"
    )
    assert len(result.action_items) == 1
    assert result.action_items[0].owner_name == "Priya"


# ── Adversarial: verbatim from the 2026-09-05 failing run ────────────────────


@pytest.mark.parametrize(
    "utterance",
    [
        "That doesn't hold up",            # -> entity 't hold', value 'healthy'
        "standing down",                    # -> entity 'standing', value 'down'
        "ending down and ready for any future support",  # -> became the incident title
        "is that still a theory? what if it is not",     # -> action item via 'ill' in 'still'
        "Let's wrap up",                    # -> entity 's wrap', value 'healthy'
        "Nothing is staying up long enough to serve traffic.",
        "We've got it.",
        "Just missed",
    ],
)
def test_conversational_fragments_produce_no_evidence(extractor, utterance):
    result = extractor.extract(utterance, "Operator")
    assert result.claims == [], f"{utterance!r} produced claims {[(c.entity, c.value) for c in result.claims]}"
    assert result.action_items == [], f"{utterance!r} produced action items"
    assert result.risks == [], f"{utterance!r} produced risks"


def test_a_bare_conditional_is_not_a_risk(extractor):
    """
    The old risk regex had an `if .+? (?:then|we|could)` arm, so any conditional
    became a risk. "if it gets worse then monitor the situation" was recorded as
    the risk "monitor the situation" — and since each open risk adds +1 pressure
    in derive_severity(), junk risks silently inflated the severity band.
    """
    result = extractor.extract("if it gets worse then monitor the situation", "Operator")
    assert result.risks == []


def test_an_explicit_risk_is_still_captured(extractor):
    """The other half of the trade: narrowing must not mean removing."""
    result = extractor.extract(
        "There is a risk of losing all in-flight orders if we restart now.", "Dave"
    )
    assert len(result.risks) == 1


def test_a_negated_state_word_is_not_read_as_that_state(extractor):
    """"twenty percent below normal" is not a report that traffic is normal."""
    result = extractor.extract(
        "Request volume is about twenty percent below normal for this hour.", "Operator"
    )
    assert all(c.value != "normal" for c in result.claims), f"{[(c.entity, c.value) for c in result.claims]}"


# ── The over-correction guard ────────────────────────────────────────────────


def test_an_unextractable_sentence_still_records_the_observation(extractor):
    """
    Failing to extract a *claim* must never mean the *observation* disappears.
    The raw utterance and its provenance are the product; the structured claim is
    a convenience on top. An empty board looks like a broken product, which is
    worse than a sparse one.
    """
    result = extractor.extract(
        "Login failures started shortly after the latest identity-service deployment.", "Dave"
    )
    assert result.category == "REPORT"
    assert result.content, "the utterance itself must always be preserved"
    assert result.extraction_method == "heuristic_fallback"
    assert result.evidence_status != "CONFIRMED", "heuristic output is never confirmed"
