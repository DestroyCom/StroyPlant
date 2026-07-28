Read the STROYPLANT_SPEC.md file at the root of the project in full before starting
anything — it's the complete spec and the source of truth for all architecture, stack, and
sequencing decisions.

For anything related to the Parrot Pot's BLE protocol, consult
PARROT_BLE_REVERSE_ENGINEERING.md and PARROT_BLE_DEEP_DIVE.md first (also at the root) — these
are direct decompilations of the official Parrot code, more reliable than any assumption.
Also consult the third-party repos listed in section 9 of the spec for everything else (other
devices, implementation patterns).

Strictly follow the collaboration rule in section 10: in case of doubt or technical
ambiguity, ask me directly rather than choosing on my behalf and continuing.

Start with Batch 0. Before writing a single line of code for this batch, ask me the
question indicated in section 6: whether I want you to work over a direct SSH connection to
my production server for this batch, or locally on my Mac with manual back-and-forth testing.

Do not move on to the next batch without explicit confirmation from me that the current
batch works as expected.
