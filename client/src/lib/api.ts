// Barrel: the client API is split by domain; callers keep importing from here.
export { ApiError, apiErrorCode, getSystemHealth } from './apiBase';
export * from './apiChat';
export * from './apiWorkspace';
export * from './apiSystem';
