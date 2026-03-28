import type { DashboardKPIs } from '../../lib/api';
import { KPICard } from './KPICard';
import {
  Zap,
  CalendarCheck,
  Clock,
  Loader,
  AlertTriangle,
  DollarSign,
  Wallet,
  Cpu,
  CheckCircle,
  Hourglass,
} from 'lucide-react';

interface KPICardGridProps {
  kpis: DashboardKPIs;
}

export function KPICardGrid({ kpis }: KPICardGridProps) {
  return (
    <div data-testid="kpi-card-grid" className="grid grid-cols-5 gap-2">
      <KPICard
        label="Throughput (Today)"
        value={kpis.throughputDay}
        unit="tasks"
        icon={Zap}
        trend={kpis.throughputDay > 0 ? 'up' : 'flat'}
      />
      <KPICard
        label="Throughput (Week)"
        value={kpis.throughputWeek}
        unit="tasks"
        icon={CalendarCheck}
        trend={kpis.throughputWeek > 0 ? 'up' : 'flat'}
      />
      <KPICard
        label="Avg Cycle Time"
        value={kpis.avgCycleTimeHours}
        unit="hrs"
        icon={Clock}
        trend={kpis.avgCycleTimeHours > 0 ? 'down' : 'flat'}
        upIsGood={false}
      />
      <KPICard
        label="Work in Progress"
        value={kpis.wipCount}
        unit="tasks"
        icon={Loader}
        trend={kpis.wipCount > 0 ? 'up' : 'flat'}
      />
      <KPICard
        label="Error Rate"
        value={`${(kpis.errorRate * 100).toFixed(1)}%`}
        icon={AlertTriangle}
        trend={kpis.errorRate > 0.05 ? 'up' : kpis.errorRate > 0 ? 'flat' : 'flat'}
        upIsGood={false}
      />
      <KPICard
        label="Token Spend (Today)"
        value={`$${kpis.tokenSpendDay.toFixed(2)}`}
        icon={DollarSign}
        trend={kpis.tokenSpendDay > 0 ? 'up' : 'flat'}
        upIsGood={false}
      />
      <KPICard
        label="Token Spend (Week)"
        value={`$${kpis.tokenSpendWeek.toFixed(2)}`}
        icon={Wallet}
        trend={kpis.tokenSpendWeek > 0 ? 'up' : 'flat'}
        upIsGood={false}
      />
      <KPICard
        label="Agent Utilization"
        value={`${(kpis.agentUtilization * 100).toFixed(1)}%`}
        icon={Cpu}
        trend={kpis.agentUtilization > 0.5 ? 'up' : kpis.agentUtilization > 0 ? 'flat' : 'flat'}
      />
      <KPICard
        label="Approval Turnaround"
        value={kpis.approvalTurnaroundHours}
        unit="hrs"
        icon={Hourglass}
        trend={kpis.approvalTurnaroundHours > 0 ? 'down' : 'flat'}
        upIsGood={false}
      />
      <KPICard
        label="Pending Approvals"
        value={kpis.pendingApprovals}
        icon={CheckCircle}
        trend={kpis.pendingApprovals > 0 ? 'up' : 'flat'}
        upIsGood={false}
      />
    </div>
  );
}
