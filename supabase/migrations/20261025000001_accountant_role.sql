-- ===== Accounting plan · Phase 2a · 22 Oct 2026 =====
-- A new staff role for the accountant. On its own because PostgreSQL cannot use a new enum value
-- in the same transaction that adds it; 20261025000002 uses it.
alter type public.app_role add value if not exists 'accountant';
