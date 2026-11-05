import { useMemo } from 'react';
import { useNavigate } from '@/lib/navigation';
import { CommandPalette, type Command } from '@/components/CommandPalette';
import { ShortcutsDialog, type StaticShortcutGroup } from '@/components/ShortcutsDialog';
import { useToast } from '@/components/Toast';
import { useBaseShortcuts, useKeyboard, useShortcuts } from '@/lib/keyboard';
import { useReindex } from '@/lib/queries';
import { useDateRange } from '@/lib/range';
import { THEME_LABELS, THEME_ORDER, useTheme } from '@/lib/theme';
import { useWhatIf } from '@/lib/whatif';

/** Keys handled by components rather than the global registry. */
const CONTEXTUAL: StaticShortcutGroup[] = [
  {
    group: 'Rows',
    items: [
      { keys: 'j', description: 'Next row (in a table)' },
      { keys: 'k', description: 'Previous row (in a table)' },
      { keys: 'enter', description: 'Open the focused row' },
      { keys: 'home', description: 'First row' },
      { keys: 'end', description: 'Last row' },
    ],
  },
  {
    group: 'Session',
    items: [
      { keys: '[', description: 'Previous turn' },
      { keys: ']', description: 'Next turn' },
    ],
  },
];

/** Registers the global shortcuts and renders the palette and the `?` sheet. */
export function AppCommands() {
  const navigate = useNavigate();
  const { paletteOpen, setPaletteOpen, helpOpen, setHelpOpen, shortcuts } = useKeyboard();
  const { theme, setTheme } = useTheme();
  const { toast } = useToast();
  const reindex = useReindex();
  const range = useDateRange();
  const whatIf = useWhatIf();

  useBaseShortcuts();
  useShortcuts([
    { id: 'go-overview', keys: 'g o', description: 'Go to overview', group: 'Navigation', run: () => navigate('/') },
    { id: 'go-sessions', keys: 'g s', description: 'Go to sessions', group: 'Navigation', run: () => navigate('/sessions') },
    { id: 'go-search', keys: 'g f', description: 'Go to search', group: 'Navigation', run: () => navigate('/search') },
    { id: 'go-analytics', keys: 'g a', description: 'Go to analytics', group: 'Navigation', run: () => navigate('/analytics/tools') },
    { id: 'go-insights', keys: 'g i', description: 'Go to insights', group: 'Navigation', run: () => navigate('/insights') },
    { id: 'go-compare', keys: 'g c', description: 'Go to compare', group: 'Navigation', run: () => navigate('/compare') },
    { id: 'go-settings', keys: 'g ,', description: 'Go to settings', group: 'Navigation', run: () => navigate('/settings') },
    { id: 'go-methodology', keys: 'g m', description: 'Go to methodology', group: 'Navigation', run: () => navigate('/methodology') },
    { id: 'go-how-it-works', keys: 'g w', description: 'Go to how it works', group: 'Navigation', run: () => navigate('/how-it-works') },
    {
      id: 'cycle-theme',
      keys: 't',
      description: 'Cycle theme',
      group: 'View',
      run: () => setTheme(THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length] ?? 'system'),
    },
  ]);

  const commands = useMemo<Command[]>(() => {
    const navigation: Command[] = [
      { id: 'nav-overview', title: 'Overview', group: 'Go', keys: 'g o', icon: 'overview', run: () => navigate('/') },
      { id: 'nav-sessions', title: 'Sessions', group: 'Go', keys: 'g s', icon: 'sessions', run: () => navigate('/sessions') },
      { id: 'nav-search', title: 'Search', group: 'Go', keys: 'g f', icon: 'search', run: () => navigate('/search') },
      { id: 'nav-tools', title: 'Analytics · Tools', group: 'Go', keys: 'g a', icon: 'tools', run: () => navigate('/analytics/tools') },
      { id: 'nav-models', title: 'Analytics · Models', group: 'Go', icon: 'model', run: () => navigate('/analytics/models') },
      { id: 'nav-hooks', title: 'Analytics · Hooks', group: 'Go', icon: 'hook', run: () => navigate('/analytics/hooks') },
      { id: 'nav-attribution', title: 'Analytics · Attribution', group: 'Go', icon: 'workflow', run: () => navigate('/analytics/attribution') },
      { id: 'nav-insights', title: 'Insights', group: 'Go', keys: 'g i', icon: 'insight', run: () => navigate('/insights') },
      { id: 'nav-compare', title: 'Compare sessions', group: 'Go', keys: 'g c', icon: 'table', run: () => navigate('/compare') },
      { id: 'nav-settings', title: 'Settings', group: 'Go', keys: 'g ,', icon: 'settings', run: () => navigate('/settings') },
      { id: 'nav-how-it-works', title: 'How it works', group: 'Go', keys: 'g w', icon: 'workflow', keywords: 'index updates automatic insights data source', run: () => navigate('/how-it-works') },
      { id: 'nav-methodology', title: 'Methodology', group: 'Go', keys: 'g m', icon: 'info', run: () => navigate('/methodology') },
      ...(import.meta.env.DEV
        ? [
            {
              id: 'nav-design',
              title: 'Component gallery',
              group: 'Go',
              icon: 'chart' as const,
              keywords: 'design system',
              run: () => navigate('/design'),
            },
          ]
        : []),
    ];

    const ranges: Command[] = [
      { id: 'range-today', title: 'Range: today', group: 'Range', icon: 'filter', run: () => range.setPreset('today') },
      { id: 'range-7d', title: 'Range: last 7 days', group: 'Range', icon: 'filter', run: () => range.setPreset('7d') },
      { id: 'range-30d', title: 'Range: last 30 days', group: 'Range', icon: 'filter', run: () => range.setPreset('30d') },
      { id: 'range-month', title: 'Range: this month', group: 'Range', icon: 'filter', run: () => range.setPreset('month') },
      { id: 'range-all', title: 'Range: all time', group: 'Range', icon: 'filter', run: () => range.setPreset('all') },
    ];

    const actions: Command[] = [
      {
        id: 'reindex',
        title: 'Re-index transcripts',
        subtitle: 'Incremental',
        group: 'Action',
        icon: 'download',
        run: () => {
          reindex.mutate(false, {
            onSuccess: () => toast({ title: 'Indexing started', tone: 'info' }),
            onError: (error) => toast({ title: 'Could not start indexing', description: error.message, tone: 'cost', duration: 0 }),
          });
        },
      },
      {
        id: 'reindex-full',
        title: 'Rebuild the index from scratch',
        subtitle: 'Full',
        group: 'Action',
        icon: 'download',
        run: () => {
          reindex.mutate(true, {
            onSuccess: () => toast({ title: 'Full re-index started', tone: 'info' }),
            onError: (error) => toast({ title: 'Could not start indexing', description: error.message, tone: 'cost', duration: 0 }),
          });
        },
      },
      { id: 'shortcuts', title: 'Keyboard shortcuts', keys: '?', group: 'Action', icon: 'info', run: () => setHelpOpen(true) },
      ...(whatIf.active
        ? [{ id: 'clear-whatif', title: 'Clear what-if pricing', group: 'Action', icon: 'close' as const, run: () => whatIf.clear() }]
        : []),
    ];

    const themes: Command[] = THEME_ORDER.map((choice) => ({
      id: `theme-${choice}`,
      title: THEME_LABELS[choice],
      group: 'Theme',
      icon: choice === 'slate' ? 'moon' : choice === 'paper' ? 'sun' : 'settings',
      run: () => setTheme(choice),
    }));

    return [...navigation, ...ranges, ...actions, ...themes];
  }, [navigate, range, reindex, toast, setHelpOpen, setTheme, whatIf]);

  return (
    <>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} commands={commands} />
      <ShortcutsDialog open={helpOpen} shortcuts={shortcuts} onClose={() => setHelpOpen(false)} extra={CONTEXTUAL} />
    </>
  );
}
