"""
Agora Token 007 builder — vendored from the official AgoraIO/Tools repository
(https://github.com/AgoraIO/Tools/tree/master/DynamicKey/AgoraDynamicKey/python3/src,
MIT licensed) because the PyPI package this project otherwise depends on,
`agora-token-builder==1.0.0`, only implements the legacy Token 006 format —
it has no Token 007 equivalent at all, so this cannot be an upgrade of that
dependency, only an addition alongside it.

Why this is needed: a ConvoAI agent's combined RTC+RTM authorization
(`properties.token` in the /join payload, which Agora's docs say the agent
"reuses" to log into the RTM channel) requires Token 007, built via
`RtcTokenBuilder2.build_token_with_rtm()`. Token 007 embeds multiple
independent "services" (RTC bound to a channel+account, RTM bound to just an
account) in one signed blob. Token 006 (`agora_token_builder.AccessToken`,
still correct and still used elsewhere in this project for the RTC-only and
RTM-only tokens the *browser* uses) signs privileges against a single
(channelName, uid) pair — there is no way to express "RTC on channel X for
account Y" and "RTM login for account Y" (no channel) in one Token 006
signature. This project's agent-token code used to build a Token 006 and
manually add the `kRtmLogin` privilege bit to it; Agora confirmed live
(2026-09-04, via an Agora engineer inspecting the agent process directly)
that the resulting token is invalid for RTM login on the agent side — the
agent can speak (RTC still validates) but can never log into RTM, so it can
never publish a transcript message. See TODO.md and docs/agora/RESEARCH.md
for the fuller incident history.

Only `RtcTokenBuilder2.build_token_with_rtm` is used by this project
(`app/api/agora.py`); the unused builder methods here are kept only because
splitting them out of Agora's own file would make future upstream diffs
harder to apply. Do not hand-edit the cryptographic internals
(AccessToken2.py, Packer.py) — pull a fresh copy from the upstream repo above
if a fix is ever needed there.
"""

from app.vendor.agora_token007.RtcTokenBuilder2 import RtcTokenBuilder, Role_Publisher, Role_Subscriber

__all__ = ["RtcTokenBuilder", "Role_Publisher", "Role_Subscriber"]
