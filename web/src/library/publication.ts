import type { SnapshotSummary } from '../api/types';

type PublicationEvidence = Pick<SnapshotSummary, 'format'> & { metadata: Pick<SnapshotSummary['metadata'], 'published'> };

/** Match the core catalogue reading without rewriting legacy imported fields. */
export function publicationReading(value: string | null | undefined, snapshots: readonly PublicationEvidence[] = []): string | null | undefined {
  return value === '0101-01-01' && snapshots.some(snapshot => snapshot.format === 'epub' && snapshot.metadata.published === value) ? null : value;
}
