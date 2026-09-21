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
