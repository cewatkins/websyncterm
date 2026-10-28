import type { JSX } from 'react';
import type { TransfersApi } from '../transfer/useTransfers.js';

/** Props for {@link TransferPanel}. */
export interface TransferPanelProps {
	transfers: TransfersApi;
}

/**
 * The transfer panel: the running transfer plus the received-file locker.
 */
export function TransferPanel({ transfers }: TransferPanelProps): JSX.Element | null {
	const { state } = transfers;
	const progress = state.progress;
	const percent =
		progress && progress.bytesTotal > 0
			? Math.min(100, Math.round((progress.bytesTransferred / progress.bytesTotal) * 100))
			: null;

	if (!state.detected && state.files.length === 0 && !state.error) return null;

	return (
		<section className="panel" aria-label="File transfers">
			<h2 className="panel__title">Transfers</h2>

			{state.detected ? (
				<div className="panel__row">
					<span>
						{state.detected.toUpperCase()} {state.active ? 'in progress' : 'finished'}
						{progress?.fileName ? ` — ${progress.fileName}` : ''}
					</span>
					{percent !== null ? (
						<progress value={percent} max={100} aria-label="Transfer progress" />
					) : null}
					{state.active ? (
						<button type="button" className="btn btn--danger" onClick={transfers.abort}>
							Abort
						</button>
					) : null}
				</div>
			) : null}

			{state.error ? (
				<p className="panel__error" role="alert">
					{state.error.message}
				</p>
			) : null}

			{state.files.length > 0 ? (
				<>
					<ul className="panel__files">
						{state.files.map((file) => (
							<li key={file.id}>
								<span>
									{file.name} <small>({file.size} bytes)</small>
								</span>
								<button
									type="button"
									className="btn"
									onClick={() => transfers.downloadFile(file.id)}
								>
									Save
								</button>
								<button
									type="button"
									className="btn btn--danger"
									onClick={() => transfers.removeFile(file.id)}
								>
									Delete
								</button>
							</li>
						))}
					</ul>
					<button type="button" className="btn" onClick={transfers.clearFiles}>
						Clear all
					</button>
				</>
			) : null}
		</section>
	);
}
