export interface LoginRequest {
  password: string;
  rememberMe?: boolean;
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
  | 'excluded_by_size'
  | 'unsupported_type'
  | 'symlink_not_followed'
  | 'filesystem_boundary'
  | 'permission_denied'
  | 'inside_trash'
  | 'other';
export interface DirectoryEntry {
  name: string;
  type: 'folder' | 'file' | 'symlink';
  kind: 'folder' | 'image' | 'video' | 'audio' | 'other';
  size: number | null;
  decision: ScanDecision;
  decision_detail?: string;
}
export interface DirectoryEntries extends Page<DirectoryEntry> {
  path: string;
  has_more: boolean;
}
export interface BrowseResponse extends Page<{ name: string; path: string }> {
  path: string;
}
export type EntryFilter = 'media' | 'all';
export type CreateScanDirResponse = ScanDir;
export type UpdateScanDirResponse = ScanDir;
export type DeleteScanDirResponse = void;
export interface ScanProgressEvent {
  event: 'progress';
  data: ScanProgress;
}
export type ScanLogLevel = 'info' | 'warn' | 'error';
export type ScanLogStep = 'scan' | 'traversal' | 'hash' | 'sample' | 'match' | 'error' | 'complete';
export interface ScanLogEntry {
  /** Monotonically increasing within a server run; doubles as history cursor and SSE event id. */
  id: number;
  /** ISO 8601 timestamp with zone. */
  ts: string;
  scan_id: number;
  step: ScanLogStep;
  detail: string;
  level: ScanLogLevel;
  duration_ms?: number;
}
export type ScanLogsResponse = Page<ScanLogEntry>;
export interface ScanError {
  file_id: number;
  path: string;
  error: string;
}
export interface ScanErrorsResponse {
  items: ScanError[];
  next_cursor: string | null;
}
export type GroupKind = 'exact' | 'image' | 'video' | 'audio_partial';
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
  /** This member's side of a directional audio_partial relation; absent for other kinds. */
  role?: 'subset' | 'superset';
  /** Seconds into the superset where the subset begins; audio_partial groups only. */
  offset_seconds?: number | null;
}
export interface GroupListItem extends DuplicateGroup {
  representative: { file_id: number; kind: 'image' | 'video' } | null;
}
export type GroupsResponse = Page<GroupListItem>;
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
export type FileHashAlgorithm = 'sha256' | 'blake2b512';
export type MatchingMethod = {
  label: string;
  scope: string;
} & (
  | { id: 'exact'; enabled: true; threshold: null; algorithm: FileHashAlgorithm }
  | { id: 'image_dhash' | 'video_dhash'; enabled: boolean; threshold: number }
  | { id: 'audio_chromaprint'; enabled: boolean; threshold: null }
);
export interface FileSizePolicy {
  /** Inclusive MiB limits; zero disables that bound. */
  min_file_size_mb: number;
  max_file_size_mb: number;
}
export interface MatchingSettings extends FileSizePolicy {
  file_hash_algorithm: FileHashAlgorithm;
  methods: MatchingMethod[];
  video_frame_count: number;
  video_timeout_ms: number;
  audio_timeout_ms: number;
}
export interface RetentionSettings {
  retention_days: number;
  auto_purge_enabled: boolean;
}
export interface Settings extends RetentionSettings {
  matching: MatchingSettings;
}
export interface MatchingControls extends FileSizePolicy {
  file_hash_algorithm: FileHashAlgorithm;
  match_images_enabled: boolean;
  match_videos_enabled: boolean;
  match_audio_enabled: boolean;
  image_phash_threshold: number;
  video_phash_threshold: number;
  video_frame_count: number;
  video_timeout_ms: number;
  audio_timeout_ms: number;
}
export type UpdateSettingsRequest = Partial<RetentionSettings & MatchingControls>;
export type SettingsConsequence =
  | { type: 'rematch_required'; reason: 'threshold_change' }
  | {
      type: 'rematch_required';
      reason: 'match_enabled';
      kind: 'image' | 'video' | 'audio';
    }
  | {
      type: 'match_enabled' | 'match_disabled';
      kind: 'image' | 'video' | 'audio';
      message: string;
    }
  | { type: 'rescan_required'; reason: 'frame_count_change' }
  | { type: 'rehash_required'; message: string }
  | { type: 'future_sampling_only'; reason: 'timeout_change' }
  | { type: 'next_scan_required'; reason: 'size_filter_change' };
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
