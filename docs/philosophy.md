# Product philosophy

*The design principles that constrain every decision in ContemPlace. Not aspirations — the actual rules the system is built against. Each principle includes its source and reasoning.*

---

## A commonplace book that becomes a PKM system

You use ContemPlace as you would a commonplace book. Send whatever is on your mind — a thought, a quote, a question, an observation. No processing obligation. No pressure to be atomic or complete. The input experience is accumulation, nothing more.

Under the hood, the system turns your commonplace book into a personal knowledge management system. A gardening layer adds structure: similarity links surface connections you didn't make explicitly. A synthesis layer (planned) will generate cluster summaries and make you re-encounter notes through accumulation alone — each new fragment triggering everything else down the line.

The MCP surface is what makes this different from every other PKM tool. Your memory lives in a database you own. Any MCP-capable agent can read and write it. Switch agents next year — the database doesn't care. That's the whole point.

The product's promise: the results of organized knowledge without the process of organizing it.

*Source: #116 design session (2026-03-14), commonplace book / PKM duality articulated 2026-03-14.*

---

## Core principles

### 1. Fragments, not atomic notes

The system captures idea fragments — whatever the user sends. A fragment can be a focused thought, a rough observation, a question, a quote, a reflection on life, a workflow suggestion. No pressure to be atomic or complete.

The capture pipeline structures each fragment (title, body, tags, links) and preserves the user's exact words. Focused fragments produce the best immediate structuring, but all fragments are valuable raw material. Atomic-like structures — focused claims, well-linked themes — are what emerges from fragments through accumulation, clustering, and synthesis. They are an output of the system, not an input requirement.

*Source: #116 (2026-03-14). Reverses the 2026-03-13 decision "atomic notes are the optimized input type." Literature basis: Sosa's accretion theory (ideas form from fragmentary "ideasimals"), Ahrens' clustering (the cluster itself becomes the developed idea), Milo's MOCs (synthesis layer above atoms).*

### 2. Fragments never get revised; they get synthesized

Raw input is the permanent record. Evolution happens through synthesis, not revision. No note merging, no in-place refinement. New captures are new fragments. The system builds understanding on top of them.

History matters. How you eventually got to an idea is part of the idea. The system can reflect back what you were thinking days or years ago, show how your ideas changed, and trace the path from early hunches to firm positions. Preserving that history is intrinsically valuable, not just a hedge against future reinterpretation.

*Source: #116 (2026-03-14). Extends the `raw_input` preservation principle established in Phase 1. Literature basis: Johnson's slow hunch (preserve original form, build surfacing mechanisms).*

### 3. The trust contract

The system is a faithful mirror, not a co-author. Four guarantees:

1. **No contamination.** Nothing in the system says something the user didn't say. The synthesis never contains inferred statements in the user's voice.
2. **No garbage.** Everything traces to real captured fragments. When the user retrieves something, they can rely on it being real — their actual thoughts, not hallucinated extensions.
3. **Full traceability.** Every structured or synthesized statement can trace back to the specific fragments it was built from. The synthesis is transparent, not opaque.
4. **Analytical, not creative.** The system organizes and connects. It doesn't generate new ideas, draw novel conclusions, or add meaning the fragments don't contain. The creativity is the user's. The system is a mirror.

The user must be able to trust the system deeply — that it doesn't contaminate their thinking, that what's in the box was somehow explicitly stated by them, that whenever they use the system it's a trusted and usable source of their recorded thoughts and ideas.

*Source: #116 product trust contract comment (2026-03-14). Extends "user voice is sacred" (#93, 2026-03-13) and the traceability rule (`capture-agent.md`). Formalization tracked in #118.*

### 4. Emergent structure through synthesis

The gardener builds a synthesis layer from accumulated fragments: MOC-like cluster summaries that curate and sequence related fragments into coherent themes. MOCs are notes themselves. They evolve as their clusters evolve. MOCs can break up when they become too dense. MOCs can reference other MOCs — hierarchical structure emerges organically over time.

This is how ideas evolve in the system. Not by revising old notes, but by accumulating new fragments that cluster, link, and eventually coalesce into something the synthesis layer can describe. The synthesis layer could also govern exports to human-readable formats.

*Source: #116 (2026-03-14). Design questions tracked in #120. Literature basis: Milo's MOCs (navigational superstructure that evolves with its cluster), Ahrens (look into the slip-box to see where ideas have built up to clusters).*

### 5. Maturity is computed, not assigned

No maturity labels. No judgment about how "done" a note is. Different ideas look different at different stages, and that's fine. Maturity is an analytical proxy inferred from density, clustering, and link patterns — descriptive analysis, not prescriptive lifecycle.

The system rejects the notion that all ideas should follow the same progression (seedling → budding → evergreen). That implies a finished state. Ideas don't finish; they keep evolving with every new fragment that connects to them.

*Source: #116 (2026-03-14). Schema implications tracked in #117.*

### 6. No final state

The knowledge base is a living organism. It never reaches a finished, perfect form. It keeps changing with every fragment captured. It can show you what you were thinking about days or years ago, how your ideas evolved, where they converged or contradicted each other. It should never try to reach a final state, because there is no such thing.

*Source: #116 (2026-03-14).*

### 7. Low friction, aware curator

The system makes capture easy and low-friction. The user acts as gatekeeper and curator — they decide what goes in. The system trusts the user is smart and capable. Guard rails and warnings are fine, but the user's editorial judgment keeps the system hygienic.

The user doesn't enjoy the administrative process of organizing and gardening notes. They do it in other systems because they value the results. ContemPlace's promise is that you get those results without the process.

*Source: "Low friction, aware curator" principle (#93, 2026-03-13). "Results without the process" framing (#116, 2026-03-14).*

### 8. User voice is sacred

The capture agent doesn't compress, interpret, or add inferred meanings. It transcribes, not synthesizes. Every sentence in the body traces back to something the user actually said. The body is a faithful presentation of the user's words, not an interpretation of them.

If the input is short, the body is short. If it contains questions, they stay as questions — never answered using related notes. If a word was misheard by voice dictation, the correction is logged transparently. If the user expresses a reaction or emotion — "I liked," "I'm missing," "it felt like" — that sentiment stays. The agent doesn't neutralize reactions into neutral descriptions. Titles use the user's vocabulary, not academic equivalents.

*Source: #93 storage philosophy decision (2026-03-13). Traceability rule in `capture-agent.md`. Anti-hallucination rules in SYSTEM_FRAME (PR #76). Sentiment and register rules from 2026-03-15 capture audit.*

### 9. Incremental formalization

Some structure helps. Too much is rigid and forces the system into a shape it may not be supposed to take. Anything that encourages the emergent nature of a living system is preferred — but not at the cost of being an entropic, unusable mess.

Good balance is the key. The system adds structure through capture (title, tags, links) and gardening (similarity links, and eventually synthesis) without requiring the user to impose it. Structure earns its keep through retrieval value, not through taxonomic completeness.

*Source: #116 (2026-03-14). Literature basis: Shipman & Marshall, "Formality Considered Harmful" (1999).*

### 10. Names are behavioral contracts

A tool called "undo" undoes. A tool called "archive" archives. A tool called "remove" removes. The name commits the system to specific behavior — any behavior that contradicts the name is a bug, even if it's technically useful.

This matters because agents and users read tool names before descriptions. A name that promises one thing but does another erodes trust. When a tool has time-dependent or context-dependent behavior, the name should be neutral enough to cover all paths, and the description should make the mechanics explicit. `remove_note` honestly describes what happens (the note leaves the active graph) without promising a specific mechanism. The description explains that recent notes are permanently deleted while older ones are soft-archived.

The same applies to bot commands. `/undo` means "take back what I just did" — not "archive something from last week." If the behavior doesn't match the name, rename the behavior or rename the command.

*Source: `/undo` design discussion (2026-03-16). `archive_note` → `remove_note` rename driven by the same principle — the old name promised archival but could permanently delete.*

### 11. Automate everything that isn't thinking

Setup, deployment, configuration registration, migration — anything the system can do for you, it should. Every manual step is a chance for a missed configuration and a tax on the user's attention. The deploy pipeline exists to eliminate that tax. If a step can be automated, it belongs in the pipeline, not in a setup guide.

This extends beyond operations. The capture pipeline structures your input so you don't have to. The gardener links notes so you don't have to. The system handles embedding, voice correction, tag assignment — all so the user's cognitive bandwidth is preserved for the thing that actually matters: thinking.

The user should never spend time on something the system could have handled. Guard rails and validation catch mistakes; automation prevents them from being possible in the first place.

*Source: deploy.sh bot command registration discussion (2026-03-16). Extends #7 (low friction) from capture to the entire system surface.*

### 12. Your data, any agent

The irreducible core of ContemPlace is the database + MCP surface + gardening pipeline. The gardener is what turns the commonplace book into a PKM system — without it, you have a note store; with it, you have a connected knowledge graph. Everything else — the Telegram bot, import tools, a dashboard — is an optional input or presentation layer.

Your memory lives in Postgres you can always query and export. Any MCP-capable agent can read and write it. You stop being locked into any single agent's ecosystem. Today's LLM interprets your words one way; tomorrow's can reinterpret the same raw input with better understanding. Enrichment is always additive, never destructive.

*Source: Product architecture crystallized during #27 design (2026-03-10). Reaffirmed in #93 (2026-03-13) and #116 (2026-03-14).*

---

## Meta-observation

Building ContemPlace follows the same pattern that using it would. Design sessions produce fragmented ideas captured in issues and conversations. Those fragments coalesce over time into firmer documents — ADRs, docs, this philosophy page — that reference the fragments as their source material. This document is itself a MOC: firm statements traced back to hypotheses, ideas, design sessions, and research. It evolves as the product evolves.

The product validates its own design philosophy by being built according to it.
