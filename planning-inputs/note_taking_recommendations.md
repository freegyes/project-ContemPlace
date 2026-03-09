# The best organizational ontology for AI-consumed heterogeneous notes

**No single established system solves this problem, but a specific hybrid does.** After deep analysis of 13 knowledge organization systems against your exact constraints — heterogeneous content, AI/LLM consumers, postgres+pgvector, scriptable rules — the answer converges on combining **Tana/Anytype's type system**, **org-roam's relational schema**, **SKOS's controlled vocabulary**, and **LATCH's metadata facets**, layered atop a capture-then-enrich pipeline. The critical insight: separate the *capture-time schema* (3 required fields, zero friction) from the *gardening-time schema* (rich typed metadata, auto-populated by scripts). This is not reinventing a wheel — it's bolting four proven wheels onto one chassis using established W3C standards.

The reason none of these systems works alone is architectural: Zettelkasten was designed for developing academic ideas, not storing bicycle wishlists. PARA has no inter-note linking. Johnny Decimal has no metadata model. But each contributes a specific, extractable organizational primitive that maps cleanly to postgres. What follows is the full comparative analysis, the specific hybrid recommendation, and a concrete schema.

---

## How each system handles the "bicycle wishlist meets spiritual reflection" problem

The core challenge is **heterogeneity** — your notes have no shared structure, no shared purpose, and no shared lifecycle. Systems designed around a single metaphor break when confronted with content that doesn't fit that metaphor.

**Zettelkasten** (heterogeneity: **4/10**) is optimized for *developing ideas through writing*. Its canonical pipeline — fleeting → literature → permanent note — assumes every captured item will become a polished atomic idea linked to other ideas. A bicycle wishlist is not an "atomic idea." A gift idea list doesn't benefit from linking to phenomenology notes. The Folgezettel debate is resolved for your use case: **use timestamp UIDs** (trivially automatable, no placement decisions) with explicit typed links and structure notes. Folgezettel's sequential numbering encoded a directed graph for free, parseable via Postgres `ltree`, but this comes at the cost of requiring manual placement decisions that destroy automation. The modern consensus at zettelkasten.de confirms: explicit links + structure notes provide strictly more information than positional encoding. What survives from Zettelkasten for your schema: **the graph of typed links between atomic nodes, the structure note concept as curated entry points for LLMs, and the principle of tags over categories**.

**PARA** (heterogeneity: **7/10**) handles variety better because it organizes by *actionability*, not idea type. The bicycle wishlist goes into Projects > "Buy new bicycle" or Resources > "Cycling." Spiritual thoughts go into Areas > "Spiritual practice." The decision algorithm is mechanical: start at Projects, work down to Areas, then Resources, then Archives. But PARA has **no inter-note linking** — devastating for AI systems that benefit from traversing knowledge graphs. It prescribes **no tags, no metadata beyond folder location**, and no atomicity principle. Its one transferable innovation is **progressive summarization** (5 layers of distillation), which maps perfectly to a gardening-time enrichment pipeline where an LLM auto-generates Layer 2-4 summaries.

**Johnny Decimal** (heterogeneity: **5/10**) is the most scriptable system at **8/10 automatability** — sequential ID assignment within categories is trivially deterministic, and multiple linting tools exist (jdlint, jdd, the Deno library). A formal machine-parsable spec exists at syntax.johnnydecimal.com, designed for "a central database which presents an API." But JD has **no inter-item relationships, no metadata model, no tags, no links**. The 10×10 category grid forces upfront taxonomic decisions that break when you add a new content type. What survives: **the ethos of deterministic, enforceable numbering** — useful for a JDex-style index layer, not as the primary organizational scheme.

**Org-roam** (heterogeneity: **9/10**) has the most mature database-backed schema of any PKM system. Its SQLite schema (7 tables: files, nodes, aliases, citations, refs, tags, links) is well-documented and directly translatable to Postgres. Every node gets a UUID. Links are typed (id, cite, https, custom protocols). The org-mode property system supports **arbitrary key-value metadata** per node — essentially a document store embedded in each note. Org-roam handles heterogeneous content because org-mode itself handles everything from GTD tasks to literate programming to LaTeX equations. The weakness: **properties are serialized as elisp S-expressions**, requiring custom deserialization, and external parsers (tree-sitter-org, orgparse for Python) are incomplete. The `olp` (outline path) field — storing ancestor headlines as an array — gives LLMs hierarchical context for free. What survives: **the entire relational schema model** (nodes + typed links + properties as JSONB + tags + aliases + refs).

**Logseq** (heterogeneity: **8/10**) contributes one critical primitive the others lack: **block-level granularity**. Every bullet point is an independently addressable, linkable, embeddable node with its own UUID, properties, and tags. A single journal page can contain a bicycle wishlist item, a spiritual thought, a project task, and a gift idea — each as individually tagged blocks. This is ideal for LLM retrieval: each block is a natural embedding chunk. Logseq's DB-graph mode adds a **typed property system** (~90 built-in properties + user-defined, with types including number, date, checkbox, URL, entity reference, class). The Datascript+SQLite dual architecture is complex to replicate, but the conceptual model is clean: blocks belong to pages, blocks reference other blocks/pages, blocks have typed properties, blocks have class tags. What survives: **block-level granularity as the atomic unit, and the typed property system concept**.

**Foam** (heterogeneity: **5/10**, automatability: **9/10**) is maximally simple: standard Markdown + standard YAML frontmatter + wikilinks. No database, no custom syntax, no tool dependency. A Python script can fully implement Foam's model in 100 lines. This makes it the most separable from its tool. But it has **no sub-file granularity** (the entire file is the unit), no type system, and name-based linking that's fragile. What survives: **the principle that capture format should be standard Markdown/YAML for maximum tooling compatibility**, and that organizational logic must be fully separable from any specific editor.

---

## What information science got right that PKM communities missed

The information science approaches provide formal ontologies that the PKM world has largely ignored — and they're exactly what a scriptable, machine-readable system needs.

**RDF/Linked Data with SKOS** (heterogeneity: **9/10**, automatability: **8/10**) is the most formally specified option. SKOS (Simple Knowledge Organization System, W3C Recommendation 2009) provides exactly what's needed for controlled vocabulary management: `skos:Concept` for tags/categories, `skos:broader`/`skos:narrower` for hierarchy, `skos:related` for association, `skos:prefLabel`/`skos:altLabel` for synonyms, and `skos:ConceptScheme` for organizing multiple taxonomies as facets. SKOS follows a "minimal ontological commitment" principle — it's deliberately lightweight. Combined with **Dublin Core** (15 metadata elements, ISO 15836), you get a standards-based metadata model where `dc:title`, `dc:subject`, `dc:type`, `dc:date`, `dc:relation`, and `dc:coverage` map directly to note fields. The **NEPOMUK PIMO** (Personal Information Model Ontology, EU FP6 project) is the most directly relevant prior art — it models Topics, Projects, Persons, Events, Notes, and Tasks specifically for personal desktop knowledge, with annotation and task management ontologies built on top. NEPOMUK was implemented in KDE using Virtuoso as the RDF store but was eventually replaced by Baloo due to **performance issues** — a cautionary tale. Full RDF is overkill; **SKOS + Dublin Core is the sweet spot**.

**LATCH** (Location, Alphabet, Time, Category, Hierarchy — Richard Saul Wurman, 1989) is not a system but a **meta-framework of universal facets**. Its power for your use case: every note, regardless of type, has a location (even if null), a time, can be categorized, and can be ranked. Three of five dimensions are **fully automatable**: Location via geotags/NLP (9/10), Alphabet via title sort key (10/10), Time via timestamps (10/10). Category requires LLM classification (6/10), and Hierarchy requires human judgment for importance (4/10). LATCH parallels Ranganathan's PMEST facets from library science — Personality (core subject), Matter (substance), Energy (action/process), Space, Time — revealing LATCH's gaps: it lacks "what is this note doing?" (intent/action) and "what is it made of?" (modality). **For your schema, extend LATCH to LATCH+IM**: Location, Alphabet, Time, Category, Hierarchy, **Intent** (reflect, plan, create, remember, wish), **Modality** (text, image, link, list, mixed).

**Faceted classification** (Ranganathan's analytico-synthetic method) is the library science approach most applicable to heterogeneous personal content. Unlike Dewey Decimal's enumerative approach (one fixed classification per item — **3/10** for heterogeneity), faceted classification **analyzes** a subject into component facets and **synthesizes** a compound classification. A "bicycle wishlist reflecting on minimalism" isn't forced into one category — it's simultaneously `Personality:bicycle`, `Energy:wishlist`, `Category:spirituality+cycling`. This maps to **multiple tag arrays on a single note**, each representing a different facet. The controlled vocabulary for each facet can be validated by scripts, and LLMs can auto-assign facet values with ~80% accuracy against a constrained vocabulary.

**Memex associative trails** (Bush, 1945) contribute one primitive absent from all other systems: **named, ordered sequences of items forming narrative paths**. A trail called "my evolving thoughts on minimalism" could thread through a spiritual reflection, a bicycle wishlist (choosing simplicity), and a gift idea (giving experiences over objects). Trails are ideal for LLM consumption — they're pre-curated "chains of context" that an AI can follow to understand how disparate notes connect thematically. The schema is simple: a `trails` table with a `trail_steps` junction table ordering items. Bush's Memex II (1959) even envisioned machines building trails autonomously — which is exactly what embedding-based similarity can do.

---

## The type system question: Tana and Anytype solved the ontology problem

Two newer systems have independently converged on the same insight: **notes need a runtime type system with inheritance**.

**Tana's supertag model** treats tags as schema definitions. A `#meeting` supertag defines fields (Attendees, Date, Action Items); applying it to a node attaches that schema. Supertags inherit from parent supertags (`#work-task` extends `#task`). Multiple supertags on one node merge their fields — a form of mixin composition. This maps directly to postgres: a `note_types` table with JSON Schema for fields, validated against `metadata JSONB` at write time. Tana's "write first, structure later" philosophy is critical: you capture freely, then layer types retroactively. Not open-source, but **the concepts are fully implementable**.

**Anytype** is open-source (Go backend, anyproto/anytype-heart on GitHub) and implements a pure object-graph model: Objects have Types, Types define Relations (typed properties), Relations are global and reused across types. Built-in types include Page, Task, Note, Human, Book; user-defined types handle "Recipe", "Bicycle", "Gift Idea". The schema definitions live in `pkg/lib/bundle/` and constitute the most directly reusable codebase for building a custom typed-object PKM in Postgres. Anytype's type+relation model maps cleanly:

- `object_types(id, name, parent_type_id, default_relations JSONB)`
- `relations(id, name, data_type, options JSONB)`
- `objects(id, type_id, content, properties JSONB, embedding vector)`
- `object_relations(subject_id, relation_id, object_id)`

---

## Comparative scoreboard across all systems

| System | Heterogeneity | Automatability | Schema richness | AI/LLM value | Formal spec exists |
|--------|:---:|:---:|:---:|:---:|:---:|
| Zettelkasten | 4 | 7 | High (graph) | High | No |
| PARA | 7 | 6 | Low (folders) | Medium | No |
| Johnny Decimal | 5 | 8 | Low (hierarchy) | Low | Draft spec |
| Org-roam | 9 | 7 | **Highest** (7 tables) | High | SQLite schema |
| Logseq | 8 | 6 | High (Datascript) | High | Clojure schema |
| Foam | 5 | 9 | Low (in-memory) | Medium | No |
| Memex/Trails | 8 | 5 | Medium (trails) | High | No |
| RDF/SKOS | 9 | 8 | **Highest** (W3C) | **Highest** | **W3C Rec** |
| LATCH | 8 | 7 | Meta-framework | Medium | No |
| Faceted classification | 8 | 7 | High (facets) | Medium | Academic |
| Tana (supertags) | 9 | 8 | High (types) | High | No |
| Anytype | 9 | 8 | High (types) | High | Open-source |

The winners on the critical dimensions — **heterogeneity + automatability + formal spec + AI value** — are **SKOS/Dublin Core** (W3C standards, highly automatable, formally specified), **org-roam** (proven schema, rich metadata), and **Tana/Anytype** (type system with inheritance).

---

## The recommended hybrid: four wheels, one chassis

The ideal system combines exactly four extractable primitives from the systems above, unified by a concrete Postgres schema:

**Primitive 1 — Type system from Tana/Anytype**: Every note has a `note_type` from a controlled enum that can evolve. Types define expected metadata fields via JSON Schema. Types support inheritance (a `bicycle-wishlist` type extends `list`, which extends `note`). At capture: assign a type from ~10-12 options or default to `fleeting`. At gardening: an LLM refines the type against the controlled list.

**Primitive 2 — Relational graph from org-roam/Zettelkasten**: Notes connect via typed, bidirectional links stored in a `note_links` table. The minimum viable link type set (10 types, informed by semantic web and argumentation theory):

- **Structural**: `is_part_of`, `follows`
- **Associative**: `relates_to` (default catch-all), `is_similar_to` (auto-detected via embedding distance)
- **Derivation**: `is_inspired_by`, `is_derived_from`, `is_instance_of`
- **Epistemic**: `supports`, `contradicts`, `refines`

At capture: all links default to `relates_to`. At gardening: an LLM analyzes linking context and refines the type.

**Primitive 3 — Controlled vocabulary from SKOS**: Tags and categories are managed as a SKOS concept scheme — concepts with preferred labels, alternate labels (synonyms), broader/narrower relationships, and scheme membership. This solves the "bike" vs. "bicycle" vs. "cycling" normalization problem. The SKOS model maps to a `controlled_tags` table with aliases, hierarchy, and definitions. At capture: accept freeform user tags. At gardening: map them to canonical SKOS concepts via LLM matching.

**Primitive 4 — LATCH+IM facets as auto-populated metadata**: Every note gets seven facet fields, three of which are fully automatic:

- **Location**: auto from device geotag or NLP extraction
- **Time**: auto from `created_at` + NLP-extracted "about" date
- **Alphabet**: auto from normalized title
- **Category**: LLM-assigned from SKOS concept scheme
- **Hierarchy**: computed from link density + access frequency + maturity
- **Intent**: LLM-classified (reflect, plan, create, remember, wish, reference, log)
- **Modality**: auto-detected (text, image, link, list, mixed)

---

## The concrete schema for postgres + pgvector

This schema synthesizes all four primitives with the capture/gardening split:

```sql
-- Type system (Tana/Anytype-inspired)
CREATE TABLE note_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(50) UNIQUE NOT NULL,
  parent_type_id UUID REFERENCES note_types(id),
  field_schema JSONB DEFAULT '{}',  -- JSON Schema for expected metadata fields
  description TEXT
);

-- Core notes table
CREATE TABLE notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- CAPTURE-TIME (required: only content + timestamp)
  raw_content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- CAPTURE-TIME (optional, <5 seconds friction)
  title VARCHAR(500),
  note_type_id UUID REFERENCES note_types(id),
  user_tags TEXT[] DEFAULT '{}',
  source_url TEXT,
  capture_context JSONB DEFAULT '{}',  -- {device, app, location_coords}
  
  -- GARDENING-TIME (auto-populated by scripts)
  summary TEXT,
  executive_summary TEXT,
  categories TEXT[] DEFAULT '{}',      -- from SKOS concept scheme
  refined_tags TEXT[] DEFAULT '{}',    -- normalized from user_tags
  entities JSONB DEFAULT '[]',         -- [{name, type, salience}]
  metadata JSONB DEFAULT '{}',         -- type-specific structured fields
  
  -- LATCH+IM facets (auto-populated)
  location_name TEXT,
  event_date TIMESTAMPTZ,              -- what the note is "about" temporally
  intent VARCHAR(30),                  -- reflect|plan|create|remember|wish|reference|log
  modality VARCHAR(20),                -- text|image|link|list|mixed
  importance_score FLOAT,
  maturity VARCHAR(20) DEFAULT 'seedling',
  
  -- Embeddings
  embedding vector(1536),
  embedded_at TIMESTAMPTZ,
  
  -- Full-text search
  content_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title,'') || ' ' || raw_content)
  ) STORED
);

-- Typed links (org-roam/Zettelkasten graph)
CREATE TABLE note_links (
  source_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  target_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  link_type VARCHAR(30) NOT NULL DEFAULT 'relates_to',
  context TEXT,                        -- surrounding text explaining the link
  confidence FLOAT DEFAULT 1.0,       -- for auto-generated links
  created_by VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source_id, target_id, link_type)
);

-- SKOS-inspired controlled vocabulary
CREATE TABLE concepts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scheme VARCHAR(100) NOT NULL,        -- 'domains', 'intents', 'modalities'
  pref_label VARCHAR(100) NOT NULL,
  alt_labels TEXT[] DEFAULT '{}',      -- synonyms
  broader_id UUID REFERENCES concepts(id),
  definition TEXT,
  embedding vector(1536),
  UNIQUE(scheme, pref_label)
);

CREATE TABLE note_concepts (
  note_id UUID REFERENCES notes(id) ON DELETE CASCADE,
  concept_id UUID REFERENCES concepts(id),
  PRIMARY KEY (note_id, concept_id)
);

-- Associative trails (Memex-inspired)
CREATE TABLE trails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) UNIQUE NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE trail_steps (
  trail_id UUID REFERENCES trails(id) ON DELETE CASCADE,
  note_id UUID REFERENCES notes(id),
  position INTEGER NOT NULL,
  annotation TEXT,
  PRIMARY KEY (trail_id, position)
);

-- Chunks for RAG (long notes split for precise retrieval)
CREATE TABLE note_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding vector(1536),
  UNIQUE(note_id, chunk_index)
);

-- Enrichment audit log
CREATE TABLE enrichment_log (
  note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  enrichment_type VARCHAR(50) NOT NULL,
  model_used VARCHAR(100),
  completed_at TIMESTAMPTZ DEFAULT NOW()
);
```

The key design decisions: **JSONB `metadata` for type-specific fields** validated against `note_types.field_schema` via `pg_jsonschema`; **explicit columns for high-query fields** (note_type, tags, categories, intent, maturity) with GIN/B-tree indexes; **HNSW indexes on all embedding columns** for sub-linear vector search; and **`tsvector` for hybrid full-text + semantic search**.

---

## The capture-then-enrich pipeline makes automation realistic

The entire system's viability depends on the **capture/gardening split**. At capture, exactly three things are required: content, timestamp, UUID. Everything else is either optional quick input (<5 seconds) or auto-generated.

The gardening pipeline runs asynchronously on every new note:

| Step | What | How | When |
|---|---|---|---|
| 1 | Embedding generation | text-embedding-3-small or nomic-embed-text | On create/update |
| 2 | Auto-summary | LLM generates 1-2 sentence summary | On create |
| 3 | Entity extraction | LLM NER → entities JSONB | On create |
| 4 | Type classification | LLM + controlled type list → note_type | On create |
| 5 | Tag normalization | Map user_tags to SKOS concepts via LLM | On create |
| 6 | LATCH facet population | NLP for location/time, LLM for intent | On create |
| 7 | Link discovery | Embedding similarity → `is_similar_to` links | Nightly batch |
| 8 | Link type refinement | LLM analyzes link context → typed links | Nightly batch |
| 9 | Chunk generation | Split notes >500 tokens, embed chunks | On create/update |
| 10 | Maturity/importance scoring | Link density + access frequency + age | Weekly |

**Metadata-augmented embeddings** are critical: before embedding, prepend structured metadata to the text (`"[Type: reflection] [Intent: reflect] [Tags: spirituality, gratitude] {actual content}"`). This bakes organizational context into the vector space, so spirituality notes and bicycle notes occupy distinct regions even when their raw content might share vocabulary.

**Hybrid search** combines vector similarity with metadata pre-filtering:
```sql
SELECT id, title, raw_content,
       embedding <=> $query_embedding AS distance
FROM notes
WHERE note_type_id = $type_filter
  AND categories && $category_filter
  AND created_at > $since
ORDER BY embedding <=> $query_embedding
LIMIT 20;
```

This **20-40% precision improvement** over vector-only search (per Microsoft Azure AI Search research) is the payoff for maintaining structured metadata.

---

## Open-source starting points that actually exist today

Rather than building from scratch, four projects provide reusable foundations:

**Anytype** (anyproto/anytype-heart, Go, open-source) provides a complete object/type/relation model. The type and relation bundle definitions in `pkg/lib/bundle/` are directly extractable as a schema starting point. This is the closest thing to a "type system for personal notes" that exists as working code.

**Khoj** (khoj-ai/khoj, Python/Django, open-source) provides a production-ready Postgres+pgvector RAG pipeline with document ingestion, chunking, embedding, and semantic search. It handles Markdown, org-mode, PDF, and Notion ingestion. Self-hostable via Docker. Lacks the type system and organizational ontology but provides the retrieval infrastructure.

**Apache AGE** (Postgres extension) adds Cypher graph queries directly to PostgreSQL, coexisting with pgvector. This enables `MATCH (n:Note)-[:SUPPORTS]->(m:Note)` style traversal alongside vector similarity — giving you a property graph and vector store in a single database.

**Timescale pgai Vectorizer** auto-generates and syncs embeddings as source data changes, eliminating the need for a custom embedding pipeline. Combined with `pg_jsonschema` for metadata validation, this gives you the gardening infrastructure for free.

---

## Conclusion: enforcing proven rules without reinventing them

The key finding is that **no single established system provides a complete, automatable ontology for heterogeneous AI-consumed notes** — but the component primitives exist as formally specified, well-documented building blocks that can be composed. The recommended approach reuses four proven wheels: Tana/Anytype's type inheritance model for structural flexibility, org-roam's relational schema pattern for graph connectivity, SKOS's concept scheme for controlled vocabulary management, and LATCH's universal facets for auto-populated metadata.

The most underappreciated insight across all these systems is the **SKOS concept scheme** as the tagging layer. It's a W3C standard specifically designed for lightweight classification with synonyms, hierarchy, and association — exactly what an auto-tagger needs. Most PKM practitioners have never encountered SKOS because it comes from library science, not the note-taking world. But it solves the "bike vs. bicycle vs. cycling" problem with a formal, scriptable specification.

The second key insight: **block-level granularity** (from Logseq) is non-negotiable for LLM consumption. A single "note" should be embeddable as one chunk if short, or automatically split into chunks if long. The atomic unit for embedding and retrieval should be ~200-600 tokens — which maps to individual thoughts, not documents.

The system that comes closest to what the user wants — but doesn't yet exist as a single project — would combine Khoj's ingestion pipeline, Anytype's type definitions, Apache AGE's graph queries, pgvector's semantic search, and a SKOS concept scheme for the taxonomy, all in one Postgres database with a capture API that accepts raw content and returns a UUID, followed by an async enrichment pipeline that fills in everything else. The gap is roughly 2-4 weeks of engineering to wire these components together — far less than reinventing any of the wheels.