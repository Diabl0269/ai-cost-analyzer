import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { NavLink } from '@/lib/navigation';
import type { ProjectSummary } from '@core/types';
import { pluralNoun } from '@core/pricing/format.js';
import { DateRange } from '@/components/DateRange';
import { Icon, type IconName } from '@/components/Icon';
import { IconButton } from '@/components/IconButton';
import { Money } from '@/components/Money';
import { Skeleton } from '@/components/Skeleton';
import { TreeNav, type TreeNode } from '@/components/TreeNav';
import { Tooltip } from '@/components/Tooltip';
import { formatCount } from '@/lib/format';
import { useOverview, useProjects } from '@/lib/queries';
import { useDateRange, rangeLabel } from '@/lib/range';
import { useRailSlotApi } from './rail';
import { useMediaQuery } from '@/lib/media';
import styles from './LeftRail.module.css';

/** Under this the top bar has no room for the range at all, so the rail carries it. */
const RANGE_IN_RAIL = '(max-width: 720px)';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
  children?: { to: string; label: string; icon: IconName }[];
}

const NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: 'overview', end: true },
  { to: '/sessions', label: 'Sessions', icon: 'sessions' },
  { to: '/search', label: 'Search', icon: 'search' },
  {
    to: '/analytics/tools',
    label: 'Analytics',
    icon: 'chart',
    children: [
      { to: '/analytics/tools', label: 'Tools', icon: 'tools' },
      { to: '/analytics/models', label: 'Models', icon: 'model' },
      { to: '/analytics/hooks', label: 'Hooks', icon: 'hook' },
      { to: '/analytics/attribution', label: 'Attribution', icon: 'workflow' },
    ],
  },
  { to: '/insights', label: 'Insights', icon: 'insight' },
  { to: '/compare', label: 'Compare', icon: 'table' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
  { to: '/how-it-works', label: 'How it works', icon: 'workflow' },
  { to: '/methodology', label: 'Methodology', icon: 'info' },
];

/**
 * A project row carries both numbers SPEC §8.4 asks for: how many sessions ran in it, then what
 * they cost. The count is muted and mono so the eye still lands on the money.
 */
function toTreeNode(project: ProjectSummary): TreeNode {
  const sessions = project.sessionCount;
  return {
    id: project.id,
    label: project.displayName,
    text: project.displayName,
    icon: project.isWorktree ? 'workflow' : undefined,
    meta: (
      <>
        {/* The tree item's accessible name is its contents, so the bare digits would run into
            the cost ("platform-infra 67 $672.38"). Spell the unit out for a screen reader and
            leave the compact form on screen. */}
        <span className="visually-hidden">{`${formatCount(sessions)} ${pluralNoun(sessions, 'session')} with requests in range, `}</span>
        <span className={`num ${styles.treeCount}`} aria-hidden="true">
          {formatCount(sessions)}
        </span>
        <Money usd={project.totalCost} />
      </>
    ),
    children: project.children?.map(toTreeNode),
  };
}

/** The rail's default bottom half: every project, nested worktrees, cost per project. */
function RailProjects() {
  const range = useDateRange();
  const [params] = useSearchParams();
  const selected = params.get('project');
  const projects = useProjects(range.query);

  const nodes = useMemo(() => (projects.data?.projects ?? []).map(toTreeNode), [projects.data]);

  if (projects.isPending) {
    return (
      <div className={styles.treeLoading}>
        <Skeleton lines={4} height={10} />
      </div>
    );
  }

  if (projects.isError || nodes.length === 0) {
    return <p className={styles.treeEmpty}>{projects.isError ? 'Projects unavailable' : 'No projects indexed yet'}</p>;
  }

  return (
    <TreeNav
      nodes={nodes}
      label="Projects"
      dense
      selectedId={selected}
      defaultExpandedIds={nodes.map((node) => node.id)}
      onSelect={(node) => range.setProject(node.id === selected ? undefined : node.id)}
    />
  );
}

export interface LeftRailProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** mobile drawer */
  drawerOpen: boolean;
  onCloseDrawer: () => void;
  /** false on a first run: there is nothing indexed to filter */
  showRange?: boolean;
}

export function LeftRail({ collapsed, onToggleCollapsed, drawerOpen, onCloseDrawer, showRange = true }: LeftRailProps) {
  const range = useDateRange();
  const overview = useOverview(range.query);
  const slot = useRailSlotApi();
  const rangeInRail = useMediaQuery(RANGE_IN_RAIL);
  // The shell must survive a malformed/partial response: a throw here takes the whole
  // frame down, not just one panel.
  const total = overview.data?.totals?.cost?.total ?? null;

  return (
    <nav
      className={[styles.rail, collapsed ? styles.collapsed : null, drawerOpen ? styles.drawerOpen : null].filter(Boolean).join(' ')}
      aria-label="Primary"
      data-app-rail
    >
      <ul className={styles.nav}>
        {NAV.map((item) => (
          <li key={item.to}>
            {collapsed ? (
              <Tooltip content={item.label} placement="right">
                <NavLink
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) => [styles.link, isActive ? styles.active : null].filter(Boolean).join(' ')}
                  onClick={onCloseDrawer}
                >
                  <Icon name={item.icon} />
                  <span className="visually-hidden">{item.label}</span>
                </NavLink>
              </Tooltip>
            ) : (
              <NavLink
                to={item.to}
                end={item.end}
                className={({ isActive }) => [styles.link, isActive ? styles.active : null].filter(Boolean).join(' ')}
                onClick={onCloseDrawer}
              >
                <Icon name={item.icon} />
                <span className={styles.linkLabel}>{item.label}</span>
              </NavLink>
            )}
            {item.children && !collapsed ? (
              <ul className={styles.subNav}>
                {item.children.map((child) => (
                  <li key={child.to}>
                    <NavLink
                      to={child.to}
                      className={({ isActive }) => [styles.subLink, isActive ? styles.active : null].filter(Boolean).join(' ')}
                      onClick={onCloseDrawer}
                    >
                      <Icon name={child.icon} size={13} />
                      <span>{child.label}</span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>

      {collapsed ? null : (
        <div className={styles.tree}>
          <p className={styles.treeHead}>{slot.content ? 'In this session' : 'Projects'}</p>
          <div className={styles.treeBody}>{slot.content ?? <RailProjects />}</div>
        </div>
      )}

      <div className={styles.footer}>
        {collapsed ? null : (
          <div className={styles.total}>
            {/* Under 720px this is the app's only date-range control, so it sits directly above
                the number it governs rather than being a label for it. */}
            {rangeInRail && showRange ? (
              <DateRange value={range.value} onPreset={range.setPreset} onBounds={range.setBounds} compact />
            ) : (
              <span className="eyebrow">{rangeLabel(range.value)}</span>
            )}
            {overview.isPending ? (
              <Skeleton width={120} height={26} />
            ) : (
              <Money usd={total} display className={styles.totalValue} />
            )}
          </div>
        )}
        <IconButton
          icon="chevron"
          rotate={collapsed ? 0 : 180}
          label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          onClick={onToggleCollapsed}
          className={styles.collapseButton}
        />
      </div>
    </nav>
  );
}
