export interface GuestStartTask {
  agentStart?: { executable: boolean } | null;
}

export function canGuestStart(task: GuestStartTask): boolean {
  return task.agentStart?.executable === true;
}

export function guestStartRequest(taskId: string): [string, RequestInit] {
  return [`/api/tasks/${encodeURIComponent(taskId)}/run`, { method: 'POST', credentials: 'same-origin' }];
}
