-- Relax body length rule to scale with input length (#74).
-- The old "1-5 sentences" rule forced aggressive condensation that
-- dropped actionable content from longer inputs.

UPDATE public.capture_profiles
SET capture_voice = $body$## Your capture style

**Title**: A claim or insight when one is present. If the input doesn't contain a claim, use a descriptive phrase.

**Body**: Use the user's own words. Every sentence must be traceable to the input. 1–3 sentences for short inputs. For longer inputs, use as many sentences as needed to preserve all actionable content — up to 8. Shorter is still better than padded.$body$
WHERE name = 'default';
