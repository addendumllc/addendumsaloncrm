-- "Today's Priorities" (heading + follow-ups due, overdue follow-ups, ready to rebook) becomes its own dashboard
-- widget permission. Everyone who sees those tiles now keeps them: copied from "Follow-ups and tasks".
INSERT INTO role_permissions(role, permission)
  SELECT role, 'dashboard:priorities' FROM role_permissions WHERE permission = 'dashboard:followups'
  ON CONFLICT DO NOTHING;
INSERT INTO staff_permission_overrides(staff_id, permission, granted, set_by_staff_id)
  SELECT staff_id, 'dashboard:priorities', granted, set_by_staff_id FROM staff_permission_overrides WHERE permission = 'dashboard:followups'
  ON CONFLICT DO NOTHING;
