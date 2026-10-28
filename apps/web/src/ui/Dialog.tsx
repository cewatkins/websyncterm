import type { JSX } from 'react';
import { useEffect, useRef } from 'react';

/** Props for {@link Dialog}. */
export interface DialogProps {
	title: string;
	children: React.ReactNode;
	onClose: () => void;
	/** The label of the confirm button. */
	confirmLabel?: string;
	onConfirm?: () => void;
	/** Hide the cancel button. */
	hideCancel?: boolean;
}

/**
 * A modal dialog with a focus trap and an Escape handler.
 */
export function Dialog({
	title,
	children,
	onClose,
	confirmLabel,
	onConfirm,
	hideCancel,
}: DialogProps): JSX.Element {
	const ref = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const previous = document.activeElement as HTMLElement | null;
		ref.current?.focus();
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === 'Escape') {
				event.stopPropagation();
				onClose();
				return;
			}
			if (event.key !== 'Tab' || !ref.current) return;
			const focusable = ref.current.querySelectorAll<HTMLElement>(
				'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
			);
			if (focusable.length === 0) return;
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		};
		document.addEventListener('keydown', onKeyDown, true);
		return () => {
			document.removeEventListener('keydown', onKeyDown, true);
			previous?.focus();
		};
	}, [onClose]);

	return (
		<div
			className="dialog-backdrop"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div className="dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1}>
				<h2>{title}</h2>
				{children}
				<div className="dialog__actions">
					{!hideCancel ? (
						<button type="button" className="btn" onClick={onClose}>
							Cancel
						</button>
					) : null}
					{onConfirm ? (
						<button type="button" className="btn btn--primary" onClick={onConfirm}>
							{confirmLabel ?? 'OK'}
						</button>
					) : null}
				</div>
			</div>
		</div>
	);
}
