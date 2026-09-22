import { CloudOff, RotateCw, Trash2 } from "lucide-preact";
import { useConnectivity } from "../hooks/use-connectivity";
import { clearSavedFieldData } from "../offline";

export function OfflineBanner() {
  const { isOffline, usingSavedData } = useConnectivity();
  if (!isOffline && !usingSavedData) return null;

  return (
    <div class="connection-banner" role="status">
      <CloudOff size={16} />
      <span>
        {isOffline ? "Offline" : "Connection issue"} — showing saved schedules and job packets when available. Changes need a connection.
      </span>
      <button class="btn btn-ghost" onClick={() => window.location.reload()}>
        <RotateCw size={14} /> Retry
      </button>
      <button class="btn btn-ghost" onClick={async () => { await clearSavedFieldData(); window.location.reload(); }}>
        <Trash2 size={14} /> Clear saved data
      </button>
    </div>
  );
}
