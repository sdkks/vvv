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
