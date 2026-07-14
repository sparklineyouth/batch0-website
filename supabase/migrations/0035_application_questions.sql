-- ============================================================================
-- 0035 — Admin-editable application questions.
--
-- Seeds a single site_settings row (key = 'application_questions') holding the
-- admin-editable CONTENT of each existing application field: label, help,
-- placeholder, required, hidden, and (for team_size) the option labels.
--
-- The field skeleton (keys, types, option VALUES, order) lives in code
-- (lib/application-questions.ts) and is NOT stored here — admins can only edit
-- content, never structure. The JSON below reproduces today's hardcoded form
-- byte-for-byte, so /apply renders identically until an admin makes an edit.
--
-- `on conflict do nothing` so re-running never clobbers admin edits. Readers
-- (getApplicationQuestions) deep-merge this onto the code defaults for known
-- keys only and tolerate a missing row.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- ============================================================================

insert into public.site_settings (key, value)
values (
  'application_questions',
  '{
    "full_name": {"label": "Full name", "help": "", "placeholder": "", "required": true, "hidden": false},
    "age": {"label": "Age", "help": "", "placeholder": "", "required": true, "hidden": false},
    "grade": {"label": "Grade", "help": "", "placeholder": "e.g. 11th", "required": false, "hidden": false},
    "school": {"label": "School", "help": "", "placeholder": "", "required": false, "hidden": false},
    "city": {"label": "City", "help": "", "placeholder": "", "required": false, "hidden": false},
    "country": {"label": "Country", "help": "", "placeholder": "", "required": false, "hidden": false},
    "parent_email": {"label": "Parent / guardian email", "help": "For applicants under 18, we email your parent/guardian a short note about the program once you submit.", "placeholder": "Optional — only needed if you''re under 18", "required": false, "hidden": false},
    "experience": {"label": "Tell us about your relevant experience", "help": "", "placeholder": "Past projects, clubs, jobs, hackathons, side hustles — anything.", "required": false, "hidden": false},
    "hours_per_week": {"label": "Hours per week you can commit", "help": "", "placeholder": "10", "required": false, "hidden": false},
    "referral_source": {"label": "How did you hear about us?", "help": "", "placeholder": "", "required": false, "hidden": false},
    "linkedin_url": {"label": "LinkedIn", "help": "", "placeholder": "https://linkedin.com/in/…", "required": false, "hidden": false},
    "resume_url": {"label": "Resume URL", "help": "", "placeholder": "https://… (Google Drive, Dropbox, your site)", "required": false, "hidden": false},
    "portfolio_url": {"label": "Portfolio / project link", "help": "", "placeholder": "https://…", "required": false, "hidden": false},
    "why_join": {"label": "Why batch0?", "help": "", "placeholder": "What do you want to get out of these 4 weeks?", "required": true, "hidden": false},
    "startup_idea": {"label": "Do you have a project idea? (optional)", "help": "", "placeholder": "It''s totally fine if you don''t. Tell us anything you''ve been thinking about.", "required": false, "hidden": false},
    "team_size": {"label": "Founding team size", "help": "How many of you are working on this together? You don''t need to list anyone — just the count, including yourself.", "placeholder": "", "required": true, "hidden": false, "optionLabels": {"1": "Solo (just me)", "2": "2 (me + 1 co-founder)", "3": "3", "4": "4", "5": "5+"}}
  }'::jsonb
)
on conflict (key) do nothing;

notify pgrst, 'reload schema';
