type SendWS = (msg: any) => void;

export function sendFocusTopic(sendWS: SendWS | undefined, topicId: string | null): void {
  if (!sendWS) return;
  sendWS({ type: 'focus', topicId });
}

export function sendBlur(sendWS: SendWS | undefined): void {
  sendFocusTopic(sendWS, null);
}
