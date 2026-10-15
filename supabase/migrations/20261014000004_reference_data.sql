-- Ammar Academy CRM · Phase 2 · starter reference data
-- Everything here can be renamed, reordered or archived later in Settings.

insert into public.app_settings (id) values (1) on conflict do nothing;

insert into public.programs (code, name, sort) values
  ('SAT', 'SAT', 1),
  ('IELTS', 'IELTS', 2)
on conflict (code) do nothing;

insert into public.stages (system_key, label, sort, is_closed, agent_selectable) values
  ('new', 'New', 1, false, true),
  ('contacting', 'Contacting', 2, false, true),
  ('qualified', 'Qualified', 3, false, true),
  ('awaiting_payment', 'Awaiting Payment', 4, false, true),
  ('enrolled', 'Enrolled', 5, true, false),
  ('lost', 'Lost', 6, true, true),
  ('invalid', 'Invalid', 7, true, true)
on conflict (system_key) do nothing;

insert into public.contact_outcomes (system_key, label, sort) values
  ('no_answer', 'No Answer', 1),
  ('busy', 'Busy', 2),
  ('reached', 'Reached', 3),
  ('requested_callback', 'Requested Callback', 4),
  ('wrong_number', 'Wrong Number', 5)
on conflict (system_key) do nothing;

insert into public.tags (name, color) values
  ('High Interest', 'orange'),
  ('Requested Callback', 'blue'),
  ('Future Intake', 'purple'),
  ('Needs Manager', 'red')
on conflict do nothing;

-- Starter custom fields. Optional by default; managers adjust them in Settings → Customer Fields.
insert into public.field_definitions (key, label, type, importance, required_from, program_ids, visible_to, editable_by, sort) values
  ('grade', 'Grade', 'dropdown', 'essential', 'never', '{}', '{manager,sales,support}', '{manager,sales}', 1),
  ('school', 'School', 'text', 'standard', 'never', '{}', '{manager,sales,support}', '{manager,sales,support}', 2),
  ('target_score', 'Target SAT score', 'number', 'standard', 'never',
     array[(select id from public.programs where code = 'SAT')], '{manager,sales,support}', '{manager,sales}', 3),
  ('ielts_type', 'IELTS type', 'dropdown', 'essential', 'never',
     array[(select id from public.programs where code = 'IELTS')], '{manager,sales,support}', '{manager,sales}', 4),
  ('exam_date', 'Planned exam date', 'date', 'standard', 'never', '{}', '{manager,sales,support}', '{manager,sales,support}', 5)
on conflict (key) do nothing;

insert into public.field_options (field_id, label, sort)
select f.id, o.label, o.sort
from public.field_definitions f
join (values
  ('grade', 'Grade 10', 1), ('grade', 'Grade 11', 2), ('grade', 'Grade 12', 3), ('grade', 'Gap year', 4),
  ('ielts_type', 'Academic', 1), ('ielts_type', 'General Training', 2)
) as o (key, label, sort) on o.key = f.key
where not exists (select 1 from public.field_options x where x.field_id = f.id);
