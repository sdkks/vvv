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
