import React from 'react';
import { Modal, Text, TextInput } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Task } from '@mindwtr/core';

import { BoardView } from './board-view';

const mocked = vi.hoisted(() => ({
  tasks: [] as Task[],
  projects: [] as Project[],
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  duplicateTask: vi.fn(),
  reorderBoardTasks: vi.fn(),
}));

vi.mock('@mindwtr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mindwtr/core')>();
  return {
    ...actual,
    shallow: Object.is,
    useTaskStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
      tasks: mocked.tasks,
      projects: mocked.projects,
      settings: {},
      updateTask: mocked.updateTask,
      deleteTask: mocked.deleteTask,
      duplicateTask: mocked.duplicateTask,
      reorderBoardTasks: mocked.reorderBoardTasks,
    }),
  };
});

vi.mock('react-native-gesture-handler', () => {
  const gesture = () => {
    const chain: Record<string, (...args: unknown[]) => unknown> = {};
    ['activateAfterLongPress', 'activeOffsetY', 'failOffsetX', 'onStart', 'onUpdate', 'onEnd']
      .forEach((method) => { chain[method] = () => chain; });
    return chain;
  };
  return {
    Gesture: { Pan: gesture, Tap: gesture, Race: (...items: unknown[]) => items },
    GestureDetector: (props: any) => React.createElement('GestureDetector', props, props.children),
    Swipeable: (props: any) => React.createElement('Swipeable', props, props.children),
  };
});

vi.mock('react-native-reanimated', () => ({
  default: {
    View: (props: any) => React.createElement('AnimatedView', props, props.children),
  },
  runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useSharedValue: (value: unknown) => ({ value }),
  withSpring: (value: unknown) => value,
}));

vi.mock('@/hooks/use-visible-tasks', () => ({
  useVisibleTaskContext: () => ({
    areaById: new Map(),
    resolvedAreaFilter: { included: [], excluded: [] },
    visibleTasks: mocked.tasks,
  }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#fff',
    border: '#ddd',
    cardBg: '#fff',
    danger: '#d00',
    filterBg: '#f5f5f5',
    inputBg: '#fff',
    onTint: '#fff',
    secondaryText: '#666',
    success: '#080',
    taskItemBg: '#fff',
    text: '#111',
    tint: '#06c',
    warning: '#c70',
  }),
}));

vi.mock('@/contexts/toast-context', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('@/lib/task-meta-navigation', () => ({
  openContextsScreen: vi.fn(),
  openProjectScreen: vi.fn(),
  openTaskScreen: vi.fn(),
}));

vi.mock('../../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string) => ({
      'bulk.selected': 'Selected',
      'common.all': 'All',
      'common.back': 'Back',
      'common.close': 'Close',
      'common.done': 'Done',
      'common.search': 'Search',
      'filters.active': 'Active filters',
      'filters.clear': 'Clear',
      'filters.contextMatchMode': 'Context match',
      'filters.contexts': 'Contexts & tags',
      'filters.datePreset.no_date': 'No date',
      'filters.datePreset.overdue': 'Overdue',
      'filters.datePreset.this_month': 'This month',
      'filters.datePreset.this_week': 'This week',
      'filters.datePreset.today': 'Today',
      'filters.excluded': 'Excluded',
      'filters.label': 'Filters',
      'filters.matchAny': 'Any',
      'filters.projects': 'Projects',
      'filters.remove': 'Remove filter',
      'filters.tagMatchMode': 'Tag match',
      'search.due.label': 'Due date',
      'search.noResults': 'No results',
      'taskEdit.noProjectOption': 'No project',
    }[key] ?? key),
  }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock('@/lib/use-android-keyboard-inset', () => ({ useKeyboardInset: () => 0 }));

vi.mock('../task-edit-modal', () => ({
  TaskEditModal: (props: any) => React.createElement('TaskEditModal', props),
}));

const makeTask = (id: string, title: string, overrides: Partial<Task> = {}): Task => ({
  id,
  title,
  status: 'next',
  contexts: [],
  tags: [],
  createdAt: '2026-09-17T12:00:00.000Z',
  updatedAt: '2026-09-17T12:00:00.000Z',
  ...overrides,
} as Task);

const makeProject = (id: string, title: string): Project => ({
  id,
  title,
  status: 'active',
  order: 0,
  createdAt: '2026-09-17T12:00:00.000Z',
  updatedAt: '2026-09-17T12:00:00.000Z',
} as Project);

let tree: ReactTestRenderer | null = null;

const renderBoard = () => {
  act(() => { tree = create(<BoardView />); });
};

const renderedText = (node: { props: { children?: React.ReactNode } }) => (
  React.Children.toArray(node.props.children).join('')
);

const findButtonByText = (label: string) => tree!.root.findAll((node) => (
  node.props.accessibilityRole === 'button'
  && node.findAllByType(Text).some((text) => renderedText(text) === label)
)).at(-1)!;

const findButtonByLabel = (label: string) => tree!.root.findAll((node) => (
  node.props.accessibilityRole === 'button'
  && node.props.accessibilityLabel === label
  && typeof node.props.onPress === 'function'
)).at(-1)!;

const taskIsVisible = (title: string) => tree!.root.findAllByType(Text)
  .some((node) => node.props.children === title);

const openFilters = async () => {
  const toggle = tree!.root.findAll((node) => (
    node.props.accessibilityRole === 'button'
    && node.findAllByType(Text).some((text) => String(text.props.children).startsWith('Filters'))
  ))[0];
  await act(async () => { toggle.props.onPress(); });
  expect(tree!.root.findByType(Modal).props.visible).toBe(true);
};

beforeEach(() => {
  mocked.tasks = [];
  mocked.projects = [];
  mocked.updateTask.mockReset();
  mocked.deleteTask.mockReset();
  mocked.duplicateTask.mockReset();
  mocked.reorderBoardTasks.mockReset();
});

afterEach(() => {
  act(() => { tree?.unmount(); });
  tree = null;
  vi.useRealTimers();
});

describe('Board compact filters', () => {
  it('swipes left to duplicate without trashing, even when copy is refused; right trashes only', async () => {
    mocked.tasks = [makeTask('a', 'A')];
    mocked.duplicateTask.mockResolvedValue({ success: false, error: 'Copy refused' });
    renderBoard();
    const swipe = tree!.root.findByType(Swipeable);
    const close = vi.fn();
    await act(async () => { swipe.props.onSwipeableOpen('left', { close }); });
    expect(close).toHaveBeenCalledTimes(1);
    expect(mocked.duplicateTask).toHaveBeenCalledWith('a', false);
    expect(mocked.deleteTask).not.toHaveBeenCalled();
    await act(async () => { swipe.props.onSwipeableOpen('right', { close }); });
    expect(close).toHaveBeenCalledTimes(2);
    expect(mocked.duplicateTask).toHaveBeenCalledTimes(1);
    expect(mocked.deleteTask).toHaveBeenCalledWith('a');
  });
  it('searches token options without searching tasks and cycles include, exclude, then remove', async () => {
    mocked.tasks = [
      makeTask('ideas', 'Keep visible while searching options', { tags: ['ideas'] }),
      makeTask('later', 'Other board task', { tags: ['later'] }),
    ];
    renderBoard();
    const compactControls = tree!.root.findByProps({ testID: 'board-filter-controls' });
    expect(compactControls.findAllByType(TextInput).some((input) => input.props.accessibilityLabel === 'Search')).toBe(true);
    expect(compactControls.findAll((node) => (
      node.props.accessibilityRole === 'button'
      && node.findAllByType(Text).some((text) => renderedText(text) === 'Filters')
    )).length).toBeGreaterThan(0);
    await openFilters();
    await act(async () => { findButtonByText('Contexts & tags').props.onPress(); });

    const optionSearch = tree!.root.findByProps({ accessibilityLabel: 'Search Contexts & tags' });
    await act(async () => { optionSearch.props.onChangeText('ideas'); });
    expect(taskIsVisible('Keep visible while searching options')).toBe(true);
    expect(taskIsVisible('Other board task')).toBe(true);

    await act(async () => { findButtonByText('#ideas').props.onPress(); });
    expect(taskIsVisible('Keep visible while searching options')).toBe(true);
    expect(taskIsVisible('Other board task')).toBe(false);

    await act(async () => { findButtonByLabel('Close').props.onPress(); });
    const activeToggle = tree!.root.findAll((node) => (
      node.props.accessibilityRole === 'button'
      && node.findAllByType(Text).some((text) => renderedText(text) === 'Filters (1)')
    ))[0];
    expect(activeToggle.props.accessibilityState).toEqual({ expanded: false });

    await act(async () => { activeToggle.props.onPress(); });
    await act(async () => { findButtonByText('Contexts & tags').props.onPress(); });
    await act(async () => { findButtonByText('#ideas').props.onPress(); });
    expect(taskIsVisible('Keep visible while searching options')).toBe(false);
    expect(taskIsVisible('Other board task')).toBe(true);

    await act(async () => { findButtonByText('Back').props.onPress(); });
    await act(async () => { findButtonByLabel('Remove filter: #ideas').props.onPress(); });
    expect(taskIsVisible('Keep visible while searching options')).toBe(true);
    expect(taskIsVisible('Other board task')).toBe(true);
    expect(mocked.updateTask).not.toHaveBeenCalled();
    expect(mocked.deleteTask).not.toHaveBeenCalled();
    expect(mocked.duplicateTask).not.toHaveBeenCalled();
    expect(mocked.reorderBoardTasks).not.toHaveBeenCalled();
  });

  it('preserves the Board any-match default while exposing the shared match-mode control', async () => {
    mocked.tasks = [
      makeTask('ideas', 'Ideas only', { tags: ['ideas'] }),
      makeTask('later', 'Later only', { tags: ['later'] }),
      makeTask('both', 'Ideas and later', { tags: ['ideas', 'later'] }),
    ];
    renderBoard();
    await openFilters();
    await act(async () => { findButtonByText('Contexts & tags').props.onPress(); });
    await act(async () => { findButtonByText('#ideas').props.onPress(); });
    await act(async () => { findButtonByText('#later').props.onPress(); });

    expect(findButtonByText('Any').props.accessibilityState).toEqual({ selected: true });
    expect(taskIsVisible('Ideas only')).toBe(true);
    expect(taskIsVisible('Later only')).toBe(true);
    expect(taskIsVisible('Ideas and later')).toBe(true);

    await act(async () => { findButtonByText('All').props.onPress(); });
    expect(taskIsVisible('Ideas only')).toBe(false);
    expect(taskIsVisible('Later only')).toBe(false);
    expect(taskIsVisible('Ideas and later')).toBe(true);
  });

  it('composes due and project/no-project filters and Clear resets Board criteria and task search', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T12:00:00.000Z'));
    mocked.projects = [makeProject('launch', 'Launch')];
    mocked.tasks = [
      makeTask('unassigned', 'No project idea', { dueDate: '2026-09-17' }),
      makeTask('launch-task', 'Launch task', { projectId: 'launch', dueDate: '2026-10-20' }),
    ];
    renderBoard();
    await openFilters();

    expect(findButtonByText('Due date').props.accessibilityState).toEqual({ expanded: false });
    await act(async () => { findButtonByText('Due date').props.onPress(); });
    expect(findButtonByText('Due date').props.accessibilityState).toEqual({ expanded: true });
    await act(async () => { findButtonByText('Today').props.onPress(); });
    expect(findButtonByText('Due date').props.accessibilityState).toEqual({ expanded: false });
    expect(taskIsVisible('No project idea')).toBe(true);
    expect(taskIsVisible('Launch task')).toBe(false);

    await act(async () => { findButtonByText('Projects').props.onPress(); });
    await act(async () => { findButtonByText('No project').props.onPress(); });
    await act(async () => { findButtonByLabel('Close').props.onPress(); });

    const taskSearch = tree!.root.findAllByType(TextInput)
      .find((input) => input.props.accessibilityLabel === 'Search');
    await act(async () => { taskSearch?.props.onChangeText('No project'); });
    expect(findButtonByText('Filters (3)')).toBeDefined();

    await openFilters();
    expect(findButtonByText('Due date').props.accessibilityState).toEqual({ expanded: false });
    await act(async () => { findButtonByText('Clear').props.onPress(); });
    expect(taskIsVisible('No project idea')).toBe(true);
    expect(taskIsVisible('Launch task')).toBe(true);

    await act(async () => { findButtonByText('Projects').props.onPress(); });
    await act(async () => { findButtonByText('Launch').props.onPress(); });
    expect(taskIsVisible('No project idea')).toBe(false);
    expect(taskIsVisible('Launch task')).toBe(true);
    expect(mocked.updateTask).not.toHaveBeenCalled();
    expect(mocked.deleteTask).not.toHaveBeenCalled();
    expect(mocked.duplicateTask).not.toHaveBeenCalled();
    expect(mocked.reorderBoardTasks).not.toHaveBeenCalled();
  });
});
