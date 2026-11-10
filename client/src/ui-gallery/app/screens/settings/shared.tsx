/** The line that shows a simulated job while it runs, or why it failed. */
import { CircleAlert } from 'lucide-react';
import type { JobState } from '../../kit';
import { ProgressBar } from '../../../../ui/primitives/Progress';
import { Callout } from '../../../../ui/settings/Block';

/** The progress of a job while it runs, or why it failed; nothing when there is none or it is done. */
export function JobStatus({ job }: { job: JobState | undefined }) {
  if (!job) return null;
  if (job.status === 'running') return <ProgressBar value={job.progress} label={job.title} detail={job.current} />;
  if (job.status === 'failed') return <Callout icon={CircleAlert} tone="red">{job.failed ?? job.title}</Callout>;
  return null;
}
