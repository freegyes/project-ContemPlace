-- seed_concepts.sql
-- Starter controlled vocabulary for ContemPlace concept normalization (SKOS).
--
-- ~25 concepts across four schemes:
--   domains  — subject areas and creative practices
--   tools    — software and hardware instruments
--   people   — recurring named references
--   places   — locations that recur in your notes
--
-- Philosophy:
--   This is a starting point, not a complete vocabulary. The gardener pipeline grows it:
--     1. Tags in notes.tags are matched against pref_label + alt_labels (lexical-first, semantic fallback).
--     2. Matched pref_labels are written to notes.refined_tags.
--     3. Unmatched tags are logged to enrichment_log (type = 'unmatched_tag') for periodic review.
--   Add new concepts whenever unmatched_tag logs surface a recurring cluster.
--
-- Hierarchy (broader_id):
--   The concepts table supports parent-child relationships via broader_id (self-referential FK).
--   This seed is intentionally flat. Add hierarchy via UPDATE after concepts are inserted, once
--   you can see which concepts naturally nest under others (e.g. coptic-stitch under bookbinding).
--
-- Idempotent: uses ON CONFLICT to update existing rows if re-run after the v2 migration seed.
-- To run: paste into Supabase SQL Editor, or run manually after migrations are applied.

insert into concepts (scheme, pref_label, alt_labels, definition) values

  -- ── DOMAINS: Digital Fabrication ─────────────────────────────────────────

  ('domains', 'digital-fabrication',
    '{"digital manufacturing", "fab lab", "cnc fabrication", "digital making"}',
    'Computer-aided physical fabrication — umbrella for laser cutting, CNC milling, and parametric design.'),

  ('domains', 'laser-cutting',
    '{"laser-cut", "laser engraving", "laser engraved", "lasercutting", "laser fabrication"}',
    'Cutting and engraving materials with a laser cutter, including kerf bending, layered work, and precision part fabrication.'),

  ('domains', 'pen-plotting',
    '{"pen plotter", "plotter", "axidraw", "generative plot", "plotter art", "generative art"}',
    'Machine-drawn artwork produced by pen plotters — generative patterns, ink experiments, and printed output on paper.'),

  ('domains', '3d-modeling',
    '{"3d design", "cad", "3d printing", "3d slicing", "parametric design", "3d cad"}',
    'Computer-aided 3D design and modeling for physical objects, using parametric CAD workflows.'),

  -- ── DOMAINS: Craft ────────────────────────────────────────────────────────

  ('domains', 'bookbinding',
    '{"book binding", "bookmaking", "hand binding", "book arts"}',
    'Constructing and binding books and notebooks by hand — structure, materials, paper handling, and cover design.'),

  ('domains', 'coptic-stitch',
    '{"coptic binding", "coptic stitch binding"}',
    'Exposed-spine bookbinding technique using a chain stitch through paired sewing stations, yielding a flat-opening book.'),

  ('domains', 'woodworking',
    '{"woodwork", "furniture making", "carpentry", "wood fabrication", "furniture"}',
    'Designing and building functional objects from wood — furniture, fixtures, storage, and structural pieces.'),

  ('domains', 'electronics',
    '{"microcontrollers", "embedded electronics", "diy electronics", "pcb design", "circuit design"}',
    'Hands-on electronics: microcontroller programming, PCB design, sensor wiring, and circuit prototyping.'),

  ('domains', 'instrument-building',
    '{"instrument making", "lutherie", "luthiery", "diy instrument", "instrument construction"}',
    'Designing and constructing acoustic, electro-acoustic, or hybrid musical instruments from raw materials.'),

  ('domains', 'synthesizer',
    '{"synth", "eurorack", "modular synth", "modular synthesizer", "audio synthesis"}',
    'Electronic sound synthesis — modular eurorack systems, standalone synth builds, and audio hardware.'),

  ('domains', 'photography',
    '{"photos", "photo project", "photobook", "film photography", "photo curation", "darkroom"}',
    'Film and digital photography — shooting, archiving, curation, and presenting work as prints or albums.'),

  -- ── DOMAINS: Technology ───────────────────────────────────────────────────

  ('domains', 'software-development',
    '{"programming", "coding", "software engineering", "dev", "web development", "backend", "code"}',
    'Writing, designing, and shipping software — spanning backend services, web apps, and developer tooling.'),

  ('domains', 'ai-tools',
    '{"llm tools", "ai workflow", "mcp tools", "pkm", "personal knowledge management", "second brain"}',
    'AI-augmented tools and workflows for knowledge management and productivity, including LLM integrations and MCP servers.'),

  -- ── DOMAINS: Creative Practice ────────────────────────────────────────────

  ('domains', 'creative-philosophy',
    '{"creative practice", "making philosophy", "craft identity", "making mindset", "creative process"}',
    'Reflections on the inner life of making — process, identity, motivation, and what it means to make things.'),

  ('domains', 'making-in-public',
    '{"building in public", "learning in public", "sharing work", "audience building", "portfolio sharing"}',
    'Sharing creative work and process publicly through video, posts, prints, and community engagement.'),

  ('domains', 'polymathy',
    '{"multiple interests", "generalism", "polymath", "multipotentiality", "multi-disciplinary"}',
    'Pursuing and integrating multiple distinct creative and technical interests within a single identity.'),

  -- ── DOMAINS: Personal ─────────────────────────────────────────────────────

  ('domains', 'mindfulness',
    '{"meditation", "presence", "awareness practice", "contemplation"}',
    'Meditation practice, present-moment awareness, and the relationship between stillness and creative work.'),

  ('domains', 'productivity',
    '{"workflow", "systems", "time management", "gtd", "task management"}',
    'Personal systems, workflows, and tools for managing attention, time, and output.'),

  ('domains', 'learning',
    '{"research", "study", "reading notes", "course notes", "tutorials", "reading"}',
    'Active learning — notes from books, courses, research, and skill acquisition.'),

  ('domains', 'writing',
    '{"blogging", "blog post", "essay", "long-form writing", "drafts", "documentation"}',
    'Writing as practice — blog posts, essays, documentation, and drafts.')

on conflict (scheme, pref_label) do update set
  alt_labels = excluded.alt_labels,
  definition = excluded.definition;

-- ── TOOLS ─────────────────────────────────────────────────────────────────
-- Separate insert so ON CONFLICT applies per statement.

insert into concepts (scheme, pref_label, alt_labels, definition) values

  ('tools', 'lightburn',
    '{"LightBurn", "light burn"}',
    'LightBurn — laser cutter control and design software for settings, layout, and cut optimisation.'),

  ('tools', 'obsidian',
    '{"Obsidian", "obsidian md", "obsidian vault"}',
    'Obsidian — local-first markdown knowledge base used for note-taking and personal knowledge management.'),

  ('tools', 'fusion-360',
    '{"Fusion 360", "fusion360", "autodesk fusion"}',
    'Autodesk Fusion 360 — parametric CAD and CAM tool for 3D modeling and machining workflows.')

on conflict (scheme, pref_label) do update set
  alt_labels = excluded.alt_labels,
  definition = excluded.definition;

-- ── PEOPLE ────────────────────────────────────────────────────────────────

insert into concepts (scheme, pref_label, alt_labels, definition) values

  ('people', 'rick-rubin',
    '{"Rick Rubin"}',
    'Record producer and author of The Creative Act — recurring reference for ideas about creativity and artistic process.')

on conflict (scheme, pref_label) do update set
  alt_labels = excluded.alt_labels,
  definition = excluded.definition;

-- ── PLACES ────────────────────────────────────────────────────────────────
-- Add places that recur in your notes: studios, cities, communities, venues.
-- Example: ('places', 'your-city', '{}', 'Where you live and make — context for local events and projects.')
-- (No generic places seeded — these are always personal.)
