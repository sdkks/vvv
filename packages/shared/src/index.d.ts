export interface LoginRequest {
  password: string;
}
export type LoginResponse = void;
export type LogoutResponse = void;
export interface SessionResponse {
  authenticated: true;
}
export interface HealthResponse {
  status: 'ok';
  db: 'ok';
}
export interface ApiError {
  error: string;
}
export type ScanStatus = 'running' | 'interrupted' | 'done' | 'cancelled';
export interface ScanProgress {
  id: number;
  status: ScanStatus;
  started_at: string;
  finished_at?: string | null;
  discovered: number;
  processed: number;
  errors: number;
  current_file?: string;
}
export interface StartScanResponse {
  id: number;
}
export type CurrentScanResponse = ScanProgress | null;
export interface ScanDir {
  id: number;
  path: string;
  follow_symlinks: boolean;
  cross_filesystems: boolean;
  file_count: number;
}
export interface UpdateScanDirRequest {
  follow_symlinks?: boolean;
  cross_filesystems?: boolean;
}
export interface CreateScanDirRequest extends UpdateScanDirRequest {
  path: string;
}
export interface ScanDirsResponse {
  items: ScanDir[];
}
export type ScanDecision =
  | 'folder'
  | 'would_process'
  | 'unsupported_type'
  | 'symlink_not_followed'
  | 'filesystem_boundary'
  | 'permission_denied'
  | 'inside_trash'
  | 'other';
export interface DirectoryEntry {
  name: string;
  type: 'folder' | 'file' | 'symlink';
  kind: 'folder' | 'image' | 'video' | 'other';
  size: number | null;
  decision: ScanDecision;
  decision_detail?: string;
}
export interface DirectoryEntries extends Page<DirectoryEntry> {
  path: string;
  has_more: boolean;
}
export type EntryFilter = 'media' | 'all';
export type CreateScanDirResponse = ScanDir;
export type UpdateScanDirResponse = ScanDir;
export type DeleteScanDirResponse = void;
export interface ScanProgressEvent {
  event: 'progress';
  data: ScanProgress;
}
export interface ScanError {
  file_id: number;
  path: string;
  error: string;
}
export interface ScanErrorsResponse {
  items: ScanError[];
  next_cursor: string | null;
}
export type GroupKind = 'exact' | 'image' | 'video';
export interface StartMatchResponse {
  match_run: number;
}
export interface StaleCursorResponse {
  error: 'stale_cursor';
  match_run: number | null;
}
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}
export interface DuplicateGroup {
  id: number;
  kind: GroupKind;
  member_count: number;
  total_bytes: number;
  reclaimable_bytes: number;
}
export interface GroupMember {
  file_id: number;
  path: string;
  size: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  similarity: number | null;
  quarantined: false;
}
export type GroupsResponse = Page<DuplicateGroup>;
export interface GroupResponse extends DuplicateGroup {
  members: Page<GroupMember>;
}
export interface ExportGroup {
  id: number;
  kind: GroupKind;
  members: Omit<GroupMember, 'quarantined'>[];
}
export interface ExportResponse {
  groups: ExportGroup[];
}
export type MatchingMethod = {
  label: string;
  scope: string;
  enabled: true;
} & ({ id: 'exact'; threshold: null } | { id: 'image_dhash' | 'video_dhash'; threshold: number });
export interface MatchingSettings {
  methods: MatchingMethod[];
  video_frame_count: number;
  video_timeout_ms: number;
}
export interface RetentionSettings {
  retention_days: number;
  auto_purge_enabled: boolean;
}
export interface Settings extends RetentionSettings {
  matching: MatchingSettings;
}
export interface MatchingControls {
  image_phash_threshold: number;
  video_phash_threshold: number;
  video_frame_count: number;
  video_timeout_ms: number;
}
export type UpdateSettingsRequest = Partial<RetentionSettings & MatchingControls>;
export type SettingsConsequence =
  | { type: 'rematch_required'; reason: 'threshold_change' }
  | { type: 'rescan_required'; reason: 'frame_count_change' }
  | { type: 'future_sampling_only'; reason: 'timeout_change' };
export interface UpdateSettingsResponse extends Settings {
  consequences: SettingsConsequence[];
}
export interface QuarantineResponse {
  moved: { file_id: number; trash_id: number }[];
  failed: { file_id: number; error: string }[];
}
export interface RestoreResponse {
  restored: { trash_id: number; file_id: number }[];
  failed: { trash_id: number; error: string }[];
}
export interface PurgeResponse {
  purged: number;
  failed: { trash_id: number; error: string }[];
}
export interface TrashItem {
  id: number;
  file_id: number;
  scan_dir_id: number;
  path: string;
  trash_rel_path: string;
  size: number;
  quarantined_at: string;
  purge_after: string | null;
}
