export const groupSortingMigration = `
CREATE INDEX idx_groups_members_all ON dup_groups(match_run,member_count DESC,id);
CREATE INDEX idx_groups_members_kind ON dup_groups(match_run,kind,member_count DESC,id);
`;
