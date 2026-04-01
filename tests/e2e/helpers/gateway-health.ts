const BASE = "http://localhost:13334";

/** Check if the AI gateway is available for live chat tests */
export async function isGatewayAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/system/status`);
    if (!res.ok) return false;
    const data = await res.json();
    return data?.gateway?.online === true;
  } catch {
    return false;
  }
}
