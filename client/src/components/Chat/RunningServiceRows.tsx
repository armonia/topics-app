/**
 * Where a chat's servers go in its transcript (BGVIS-08): the subscription is
 * here, eager and small; the rows (`RunningServiceRow.tsx`) load the first time
 * a chat has a server, since most chats never run one.
 */
import { lazy, memo, Suspense } from 'react';
import { useTopicRunningServices } from '../../state/runningServices';

const RunningServiceList = lazy(() => import('./RunningServiceRow'));

export const RunningServiceRows = memo(function RunningServiceRows({ topicId, projectPath, isMobile }: { topicId: string; projectPath?: string; isMobile: boolean }) {
  const services = useTopicRunningServices(topicId);
  if (!services?.length) return null;
  return (
    <div className={`chat-measure flex flex-col gap-1 pb-2 ${isMobile ? 'px-2' : 'px-4'}`}>
      <Suspense fallback={null}>
        <RunningServiceList services={services} projectPath={projectPath} />
      </Suspense>
    </div>
  );
});
