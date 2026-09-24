import { CloudOff, HardDriveDownload, RotateCw, Trash2 } from "lucide-preact";
import { useConnectivity } from "../hooks/use-connectivity";
import { clearSavedFieldData } from "../offline";

export function OfflineBanner() {
  const { isOffline, usingSavedData, hasSavedData } = useConnectivity();
  const hasConnectionIssue = isOffline || usingSavedData;
  if (!hasConnectionIssue && !hasSavedData) return null;

  const clearSavedData = async () => {
    await clearSavedFieldData();
    if (hasConnectionIssue) window.location.reload();
  };

  return (
    <div class={`connection-banner ${hasConnectionIssue ? "" : "ready"}`} role="status">
      {hasConnectionIssue ? <CloudOff size={16} /> : <HardDriveDownload size={16} />}
      <span>
        {hasConnectionIssue
          ? `${isOffline ? "Offline" : "Connection issue"} — showing saved schedules and job packets when available. Changes need a connection.`
          : "Offline access ready — saved schedule and job packets are stored on this device."}
      </span>
      {hasConnectionIssue && <button class="btn btn-ghost" onClick={() => window.location.reload()}>
        <RotateCw size={14} /> Retry
      </button>}
      {hasSavedData && <button class="btn btn-ghost" onClick={clearSavedData}>
        <Trash2 size={14} /> Clear saved data
      </button>}
    </div>
  );
}
