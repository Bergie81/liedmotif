import { primaryButtonClass } from '@/components/ui/form-styles';
import { LiedmotifLoader } from '@/components/ui/loading';
import { cn } from '@/lib/cn';

/** The one Load more control every paged list renders — same button, same busy
 * treatment, wherever a cursor page remains. */
export function LoadMoreButton({
  loading,
  disabled = false,
  onClick,
  className,
}: {
  loading: boolean;
  /** Held for a reason besides the fetch itself (e.g. a mutation still committing). */
  disabled?: boolean;
  onClick: () => void;
  /** Wrapper spacing/layout per surface (e.g. a grid's `col-span-full`). */
  className?: string;
}) {
  return (
    <div className={cn('text-center', className)}>
      <button
        type="button"
        className={primaryButtonClass}
        onClick={onClick}
        disabled={loading || disabled}
        aria-busy={loading}
      >
        {loading ? <LiedmotifLoader /> : null}
        Load more
      </button>
    </div>
  );
}
