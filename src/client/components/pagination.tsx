import { ChevronLeft, ChevronRight } from "lucide-preact";
import type { PaginatedState } from "../types";

interface Props {
  pag: PaginatedState;
  setPage: (page: number) => void;
}

export function Pagination({ pag, setPage }: Props) {
  const totalPages = Math.ceil(pag.total / pag.limit) || 1;
  if (totalPages <= 1) return null;

  return (
    <div class="pagination">
      <button
        class="pagination-btn"
        disabled={pag.page <= 1}
        onClick={() => setPage(pag.page - 1)}
        aria-label="Previous page"
      >
        <ChevronLeft size={14} />
      </button>
      <span class="pagination-info">
        Page {pag.page} of {totalPages} ({pag.total} total)
      </span>
      <button
        class="pagination-btn"
        disabled={pag.page >= totalPages}
        onClick={() => setPage(pag.page + 1)}
        aria-label="Next page"
      >
        <ChevronRight size={14} />
      </button>
    </div>
  );
}
